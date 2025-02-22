/* eslint-disable @typescript-eslint/no-explicit-any */
/*---------------------------------------------------------
 * Copyright 2021 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'child_process';
import stream = require('stream');
import vscode = require('vscode');
import { OutputEvent, TerminatedEvent } from 'vscode-debugadapter';
import { killProcessTree } from './utils/processUtils';
import getPort = require('get-port');
import path = require('path');
import * as fs from 'fs';
import * as net from 'net';
import { getTool } from './goTools';

export class GoDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	public createDebugAdapterDescriptor(
		session: vscode.DebugSession,
		executable: vscode.DebugAdapterExecutable | undefined
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		if (session.configuration.debugAdapter === 'dlv-dap') {
			return this.createDebugAdapterDescriptorDlvDap(session.configuration);
		}
		return executable;
	}

	public async dispose() {
		console.log('GoDebugAdapterDescriptorFactory.dispose');
	}

	private createDebugAdapterDescriptorDlvDap(
		configuration: vscode.DebugConfiguration
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		if (configuration.port) {
			return new vscode.DebugAdapterServer(configuration.port, configuration.host ?? '127.0.0.1');
		}
		const d = new DelveDAPOutputAdapter(configuration);
		return new vscode.DebugAdapterInlineImplementation(d);
	}
}

// TODO(hyangah): Code below needs refactoring to avoid using vscode API
// so we can use from a separate debug adapter executable in testing.

const TWO_CRLF = '\r\n\r\n';

// Proxies DebugProtocolMessage exchanges between VSCode and a remote
// process or server connected through a duplex stream, after its
// start method is called.
export class ProxyDebugAdapter implements vscode.DebugAdapter {
	private messageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	// connection to server.
	private conn?: stream.Duplex;

	constructor() {
		this.onDidSendMessage = this.messageEmitter.event;
	}

	// Implement vscode.DebugAdapter (VSCodeDebugAdapter) interface.
	// Client will call handleMessage to send messages, and
	// listen on onDidSendMessage to receive messages.
	onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;
	async handleMessage(message: vscode.DebugProtocolMessage): Promise<void> {
		// TODO(hyangah): dlv dap often terminates before us
		// receiving the disconnect response, which causes
		// vscode to hang forever. Either generate a disconnect
		// respond after timeout so vscode completes the normal
		// debug session teardown including the call to this
		// thin adapter's dispose() or change dlv dap not to
		// kill itself until the client connection is closed.
		await this.sendMessageToServer(message);
	}

	// Methods for proxying.
	protected sendMessageToClient(msg: vscode.DebugProtocolMessage) {
		this.messageEmitter.fire(msg);
	}
	protected sendMessageToServer(message: vscode.DebugProtocolMessage): void {
		const json = JSON.stringify(message) ?? '';
		if (this.conn) {
			this.conn.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}${TWO_CRLF}${json}`, 'utf8', (err) => {
				if (err) {
					console.log(`error sending message: ${err}`);
					this.sendMessageToClient(new TerminatedEvent());
				}
			});
		} else {
			console.log(`stream is closed; dropping ${json}`);
		}
	}

	public async start(server: stream.Duplex) {
		if (this.conn) {
			throw new Error('start was called more than once');
		}
		this.conn = server;
		this.conn.on('data', (data: Buffer) => {
			this.handleDataFromServer(data);
		});
		this.conn.once('close', () => {
			console.log('stream closed');
			this.conn.destroy();
			this.conn = undefined;
		});
		this.conn.on('error', (err) => {
			console.log(`stream error: ${err}`);
			if (err) {
				this.sendMessageToClient(new OutputEvent(`socket to network closed: ${err}`, 'console'));
			}
			this.sendMessageToClient(new TerminatedEvent());
		});
	}

	async dispose() {
		if (this.conn) {
			// TODO(hyangah): not sure if sleep is necessary.
			await sleep(500);
			this.conn?.destroy();
		}
	}

	private rawData = Buffer.alloc(0);
	private contentLength = -1;
	// Implements parsing of the DAP protocol. We cannot use ProtocolClient
	// from the vscode-debugadapter package, because it's not exported and
	// is not meant for external usage.
	// See https://github.com/microsoft/vscode-debugadapter-node/issues/232
	private handleDataFromServer(data: Buffer): void {
		this.rawData = Buffer.concat([this.rawData, data]);

		// eslint-disable-next-line no-constant-condition
		while (true) {
			if (this.contentLength >= 0) {
				if (this.rawData.length >= this.contentLength) {
					const message = this.rawData.toString('utf8', 0, this.contentLength);
					this.rawData = this.rawData.slice(this.contentLength);
					this.contentLength = -1;
					if (message.length > 0) {
						const rawMessage = JSON.parse(message);
						this.sendMessageToClient(rawMessage);
					}
					continue; // there may be more complete messages to process
				}
			} else {
				const idx = this.rawData.indexOf(TWO_CRLF);
				if (idx !== -1) {
					const header = this.rawData.toString('utf8', 0, idx);
					const lines = header.split('\r\n');
					for (const line of lines) {
						const pair = line.split(/: +/);
						if (pair[0] === 'Content-Length') {
							this.contentLength = +pair[1];
						}
					}
					this.rawData = this.rawData.slice(idx + TWO_CRLF.length);
					continue;
				}
			}
			break;
		}
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// DelveDAPOutputAdapter is a ProxyDebugAdapter that proxies between
// VSCode and a dlv dap process spawned and managed by this adapter.
// It turns the process's stdout/stderrr into OutputEvent.
export class DelveDAPOutputAdapter extends ProxyDebugAdapter {
	constructor(private config: vscode.DebugConfiguration, private outputToConsole?: boolean) {
		super();
	}

	private connected: Promise<void>;
	private dlvDapServer: ChildProcess;
	private port: number;
	private socket: net.Socket;

	protected async sendMessageToServer(message: vscode.DebugProtocolMessage): Promise<void> {
		if (!this.connected) {
			this.connected = this.startAndConnectToServer();
		}
		await this.connected;
		super.sendMessageToServer(message);
	}

	async dispose() {
		console.log(`DelveDAPOutputAdapter.dispose ${this.dlvDapServer?.pid}`);
		super.dispose();
		if (this.connected) {
			killProcessTree(this.dlvDapServer);
			this.connected = undefined;
		}
	}

	private async startAndConnectToServer() {
		const { port, host, dlvDapServer } = await startDapServer(
			this.config,
			(msg) => this.stdoutEvent(msg),
			(msg) => this.stderrEvent(msg)
		);
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			// eslint-disable-next-line prefer-const
			let timer: NodeJS.Timeout;
			const s = net.createConnection(port, host, () => {
				clearTimeout(timer);
				resolve(s);
			});
			timer = setTimeout(() => {
				reject('connection timeout');
				console.log('failed to connect within 1s');
				s?.destroy();
				killProcessTree(dlvDapServer);
			}, 1000);
		});

		this.dlvDapServer = dlvDapServer;
		this.port = port;
		this.socket = socket;
		this.start(this.socket);
	}

	stdoutEvent(output: string, data?: any) {
		this.sendMessageToClient(new OutputEvent(output, 'stdout', data));
		if (this.outputToConsole) {
			console.log(output);
		}
	}

	stderrEvent(output: string, data?: any) {
		this.sendMessageToClient(new OutputEvent(output, 'stderr', data));
		if (this.outputToConsole) {
			console.error(output);
		}
	}
}

export async function startDapServer(
	configuration: vscode.DebugConfiguration,
	log?: (msg: string) => void,
	logErr?: (msg: string) => void
): Promise<{ port: number; host: string; dlvDapServer?: ChildProcessWithoutNullStreams }> {
	if (!configuration.host) {
		configuration.host = '127.0.0.1';
	}

	if (configuration.port) {
		// If a port has been specified, assume there is an already
		// running dap server to connect to.
		return { port: configuration.port, host: configuration.host };
	} else {
		configuration.port = await getPort();
	}
	if (!log) {
		log = appendToDebugConsole;
	}
	if (!logErr) {
		logErr = appendToDebugConsole;
	}
	const dlvDapServer = await spawnDlvDapServerProcess(configuration, log, logErr);
	return { dlvDapServer, port: configuration.port, host: configuration.host };
}

async function spawnDlvDapServerProcess(
	launchArgs: vscode.DebugConfiguration,
	log: (msg: string) => void,
	logErr: (msg: string) => void
): Promise<ChildProcess> {
	const launchArgsEnv = launchArgs.env || {};
	const env = Object.assign({}, process.env, launchArgsEnv);

	const dlvPath = launchArgs.dlvToolPath ?? getTool('dlv');

	if (!fs.existsSync(dlvPath)) {
		const envPath = process.env['PATH'] || (process.platform === 'win32' ? process.env['Path'] : null);
		logErr(
			`Couldn't find dlv at the Go tools path, ${process.env['GOPATH']}${
				env['GOPATH'] ? ', ' + env['GOPATH'] : ''
			} or ${envPath}`
		);
		throw new Error(
			'Cannot find Delve debugger. Install from https://github.com/go-delve/delve & ensure it is in your Go tools path, "GOPATH/bin" or "PATH".'
		);
	}
	const dlvArgs = new Array<string>();
	dlvArgs.push('dap');
	// add user-specified dlv flags first. When duplicate flags are specified,
	// dlv doesn't mind but accepts the last flag value.
	if (launchArgs.dlvFlags && launchArgs.dlvFlags.length > 0) {
		dlvArgs.push(...launchArgs.dlvFlags);
	}
	dlvArgs.push(`--listen=${launchArgs.host}:${launchArgs.port}`);
	if (launchArgs.showLog) {
		dlvArgs.push('--log=' + launchArgs.showLog.toString());
	}
	if (launchArgs.logOutput) {
		dlvArgs.push('--log-output=' + launchArgs.logOutput);
	}
	log(`Running: ${dlvPath} ${dlvArgs.join(' ')}`);

	const dir = parseProgramArgSync(launchArgs).dirname;
	// TODO(hyangah): determine the directories:
	//    run `dlv` => where dlv will create the default __debug_bin. (This won't work if the directory is not writable. Fix it)
	//    build program => 'program' directory. (This won't work for multimodule workspace. Fix it)
	//    run program => cwd or wd (If test, make sure to run in the package directory.)
	return await new Promise<ChildProcess>((resolve, reject) => {
		const p = spawn(dlvPath, dlvArgs, {
			cwd: dir,
			env
		});
		let started = false;
		const timeoutToken: NodeJS.Timer = setTimeout(
			() => reject(new Error('timed out while waiting for DAP server to start')),
			5_000
		);

		const stopWaitingForServerToStart = (err?: string) => {
			clearTimeout(timeoutToken);
			started = true;
			if (err) {
				killProcessTree(p); // We do not need to wait for p to actually be killed.
				reject(new Error(err));
			} else {
				resolve(p);
			}
		};

		p.stdout.on('data', (chunk) => {
			if (!started) {
				if (chunk.toString().startsWith('DAP server listening at:')) {
					stopWaitingForServerToStart();
				} else {
					stopWaitingForServerToStart(
						`Expected 'DAP server listening at:' from debug adapter got '${chunk.toString()}'`
					);
				}
			}
			log(chunk.toString());
		});
		p.stderr.on('data', (chunk) => {
			if (!started) {
				stopWaitingForServerToStart(`Unexpected error from dlv dap on start: '${chunk.toString()}'`);
			}
			logErr(chunk.toString());
		});
		p.on('close', (code) => {
			if (!started) {
				stopWaitingForServerToStart(`dlv dap closed with code: '${code}' signal: ${p.killed}`);
			}
			if (code) {
				logErr(`Process exiting with code: ${code} signal: ${p.killed}`);
			} else {
				log(`Process exited normally: ${p.killed}`);
			}
		});
		p.on('error', (err) => {
			if (!started) {
				stopWaitingForServerToStart(`Unexpected error from dlv dap on start: '${err}'`);
			}
			if (err) {
				logErr(`Error: ${err}`);
			}
		});
	});
}

function parseProgramArgSync(
	launchArgs: vscode.DebugConfiguration
): { program: string; dirname: string; programIsDirectory: boolean } {
	const program = launchArgs.program;
	if (!program) {
		throw new Error('The program attribute is missing in the debug configuration in launch.json');
	}
	let programIsDirectory = false;
	try {
		programIsDirectory = fs.lstatSync(program).isDirectory();
	} catch (e) {
		// TODO(hyangah): why can't the program be a package name?
		throw new Error('The program attribute must point to valid directory, .go file or executable.');
	}
	if (!programIsDirectory && launchArgs.mode !== 'exec' && path.extname(program) !== '.go') {
		throw new Error('The program attribute must be a directory or .go file in debug and test mode');
	}
	const dirname = programIsDirectory ? program : path.dirname(program);
	return { program, dirname, programIsDirectory };
}

// appendToDebugConsole is declared as an exported const rather than a function, so it can be stubbbed in testing.
export const appendToDebugConsole = (msg: string) => {
	console.error(msg);
};
