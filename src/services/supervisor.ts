import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ServiceDefinition, ToolManifest } from "../types.ts";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface DaemonHandle {
	child?: ChildProcess;
	closed: boolean;
	stderr: string;
	stateDir?: string;
	request: (method: string | undefined, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
	close: () => void;
}

interface ServiceResult {
	ok: boolean;
	result?: unknown;
	error?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
}

export interface ServicePlacement {
	cwd: string;
	stateDir: string;
	env: Record<string, string>;
	key: string;
}

export interface ServiceSupervisorOptions {
	log?: (message: string) => void;
	projectCwd?: string;
	agentDir?: string;
}

/**
 * Resolve where a service runs. Every service is rooted at the tool directory
 * and keeps its state under `services/<tool>/<name>` in the agent directory.
 * The daemon key names the tool and service, so every project shares one handle.
 */
export function resolveServicePlacement(options: {
	tool: ToolManifest;
	name: string;
	service: ServiceDefinition;
	agentDir: string;
}): ServicePlacement {
	const { tool, name, service, agentDir } = options;
	const baseDir = tool.dir ?? agentDir;
	const cwd = service.cwd ? path.resolve(baseDir, service.cwd) : baseDir;
	const stateDir = path.join(agentDir, "services", tool.name, name);
	return {
		cwd,
		stateDir,
		env: {
			PI_TOOL_NAME: tool.name,
			PI_SERVICE_NAME: name,
			PI_SERVICE_STATE_DIR: stateDir,
		},
		key: `user:${tool.name}:${name}`,
	};
}

function spawnDaemon(
	service: ServiceDefinition,
	cwd: string,
	env: Record<string, string>,
	log: (message: string) => void,
): ChildProcess {
	if (!service.command) throw new Error("daemon service has no command");
	const child = spawn(service.command, service.args ?? [], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr?.on("data", (chunk) => log(chunk.toString()));
	return child;
}

function makeJsonLineClient(options: {
	key: string;
	write: (line: string) => void;
	close: () => void;
	child?: ChildProcess;
	onLine: (handler: (line: string) => void) => void;
	log: (message: string) => void;
}): DaemonHandle {
	const pending = new Map<string, PendingRequest>();
	let nextId = 1;
	let closed = false;
	const handle: DaemonHandle = {
		child: options.child,
		closed: false,
		stderr: "",
		request: (method, params, timeoutMs) => {
			if (handle.closed) return Promise.reject(new Error("daemon is closed"));
			const id = String(nextId++);
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`daemon request timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				try {
					options.write(`${JSON.stringify({ id, method, params })}\n`);
				} catch (error) {
					pending.delete(id);
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		},
		close: () => {
			handle.closed = true;
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error("daemon closed"));
			}
			pending.clear();
			options.close();
		},
	};

	options.onLine((line) => {
		if (!line.trim()) return;
		let message: { id?: string; status?: string; result?: unknown; error?: string };
		try {
			message = JSON.parse(line);
		} catch {
			options.log(`[${options.key}] invalid daemon output line: ${line.slice(0, 200)}`);
			return;
		}
		if (!message.id) return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		clearTimeout(request.timer);
		if (message.status === "ok") request.resolve(message.result);
		else request.reject(new Error(message.error ?? "daemon request failed"));
	});

	return handle;
}

function createStdioClient(
	service: ServiceDefinition,
	key: string,
	cwd: string,
	env: Record<string, string>,
	log: (message: string) => void,
): DaemonHandle {
	if (!service.command) throw new Error(`daemon service "${key}" has no command`);
	const child = spawn(service.command, service.args ?? [], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const handle = makeJsonLineClient({
		key,
		child,
		write: (line) => child.stdin.write(line),
		close: () => child.kill("SIGTERM"),
		onLine: (handler) => createInterface({ input: child.stdout }).on("line", handler),
		log,
	});
	child.stderr.on("data", (chunk) => {
		handle.stderr += chunk.toString();
		if (handle.stderr.length > 20_000) handle.stderr = handle.stderr.slice(-20_000);
	});
	child.on("exit", (code) => {
		handle.closed = true;
		log(`[${key}] daemon exited with code ${code}\n${handle.stderr}`);
	});
	return handle;
}

async function waitForSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fs.access(socketPath);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(`timed out waiting for socket: ${socketPath}`);
}

async function canConnect(socketPath: string, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		setTimeout(() => finish(false), timeoutMs);
	});
}

async function httpReachable(url: string, timeoutMs = 2_000): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { method: "GET", signal: controller.signal });
		return response.status < 500;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function writeServiceState(stateDir: string, payload: Record<string, unknown>): Promise<void> {
	const file = path.join(stateDir, "state.json");
	try {
		await fs.mkdir(stateDir, { recursive: true });
		let current: Record<string, unknown> = {};
		try {
			current = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		} catch {
			// a missing or unreadable state file starts from an empty object
		}
		// drop a level recorded by an older runtime
		delete current.level;
		await fs.writeFile(file, `${JSON.stringify({ ...current, ...payload }, null, 2)}\n`, "utf8");
	} catch {
		// state is advisory; a failed write must not break the service call
	}
}

async function createUnixClient(options: {
	service: ServiceDefinition;
	key: string;
	socketPath: string;
	cwd: string;
	env: Record<string, string>;
	stateDir: string;
	spawn: boolean;
	log: (message: string) => void;
}): Promise<DaemonHandle> {
	const { service, key, socketPath, cwd, env, stateDir, log } = options;
	let child: ChildProcess | undefined;
	if (options.spawn) {
		if (!service.command) throw new Error(`daemon service "${key}" has no command`);
		child = spawnDaemon(service, cwd, env, log);
	}
	await waitForSocket(socketPath);
	const socket = net.createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const handle = makeJsonLineClient({
		key,
		child,
		write: (line) => socket.write(line),
		close: () => {
			socket.end();
			child?.kill("SIGTERM");
		},
		onLine: (handler) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					handler(line);
					index = buffer.indexOf("\n");
				}
			});
		},
		log,
	});
	handle.stateDir = stateDir;
	socket.on("error", (error) => log(`[${key}] socket error: ${error.message}`));
	socket.on("close", () => {
		handle.closed = true;
	});
	return handle;
}

async function waitForHttp(url: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { method: "GET" });
			if (response.status < 500) return;
		} catch {
			// retry
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`timed out waiting for HTTP service: ${url}`);
}

async function createHttpClient(options: {
	service: ServiceDefinition;
	key: string;
	cwd: string;
	env: Record<string, string>;
	stateDir: string;
	spawn: boolean;
	log: (message: string) => void;
}): Promise<DaemonHandle> {
	const { service, key, cwd, env, stateDir, log } = options;
	if (!service.url) throw new Error(`daemon service "${key}" has no url`);
	const child = options.spawn
		? spawnDaemon(service, cwd, env, log)
		: undefined;
	await waitForHttp(service.url);
	let closed = false;
	return {
		child,
		closed: false,
		stderr: "",
		request: async (method, params, timeoutMs) => {
			if (closed) throw new Error("daemon is closed");
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetch(service.url!, {
					method: service.method ?? "POST",
					headers: { "content-type": "application/json", ...(service.headers ?? {}) },
					body: JSON.stringify({ method, params }),
					signal: controller.signal,
				});
				const text = await response.text();
				if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
				let parsed: { status?: string; result?: unknown; error?: string };
				try {
					parsed = JSON.parse(text);
				} catch {
					throw new Error(`invalid JSON response: ${text.slice(0, 500)}`);
				}
				if (parsed.status === "ok") return parsed.result;
				throw new Error(parsed.error ?? "HTTP service request failed");
			} finally {
				clearTimeout(timer);
			}
		},
		close: () => {
			closed = true;
			child?.kill("SIGTERM");
		},
		stateDir,
	};
}

export interface DaemonStatus {
	tool: string;
	service: string;
	protocol: string;
	stateDir: string;
	pid?: number;
	alive: boolean;
	reachable: boolean;
}

async function processMatchesService(pid: number, service: ServiceDefinition): Promise<boolean> {
	if (!service.command) return false;
	try {
		const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
		const parts = raw.split("\0").filter(Boolean);
		if (parts.length === 0) return false;
		if (parts[0] === service.command) return true;
		if (path.basename(parts[0]) === path.basename(service.command)) return true;
		return parts.includes(service.command);
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class ServiceSupervisor {
	private daemons = new Map<string, DaemonHandle>();
	private persistentKeys = new Map<string, string>();
	private readonly log: (message: string) => void;
	private readonly projectCwd: string;
	private readonly agentDir: string;

	constructor(options: ServiceSupervisorOptions | ((message: string) => void) = {}) {
		const normalized = typeof options === "function" ? { log: options } : options;
		this.log = normalized.log ?? (() => {});
		this.projectCwd = path.resolve(normalized.projectCwd ?? process.cwd());
		this.agentDir = path.resolve(
			normalized.agentDir ?? process.env.PI_TOOL_RUNTIME_AGENT_DIR ?? path.join(this.projectCwd, ".pi", "agent"),
		);
	}

	placement(tool: ToolManifest, name: string, service: ServiceDefinition): ServicePlacement {
		return resolveServicePlacement({
			tool,
			name,
			service,
			agentDir: this.agentDir,
		});
	}

	async startEager(tool: ToolManifest): Promise<void> {
		for (const [name, service] of Object.entries(tool.services ?? {})) {
			if (service.type === "daemon" && (service.start ?? "lazy") === "eager") {
				await this.ensureDaemon(tool, name, service);
			}
		}
	}

	async call(
		tool: ToolManifest,
		serviceName: string,
		params: Record<string, unknown>,
	): Promise<ServiceResult> {
		const service = tool.services?.[serviceName];
		if (!service) {
			return { ok: false, error: `unknown service "${serviceName}"` };
		}
		if (service.type === "script") {
			return this.runScript(tool, serviceName, service, params);
		}
		try {
			const result = await this.callDaemon(tool, serviceName, service, params);
			return { ok: true, result };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async runScript(
		tool: ToolManifest,
		name: string,
		service: ServiceDefinition,
		params: Record<string, unknown>,
	): Promise<ServiceResult> {
		if (!service.command) return { ok: false, error: "script service has no command" };
		const placement = this.placement(tool, name, service);
		const timeoutMs = service.timeoutMs ?? 60_000;
		await fs.mkdir(placement.stateDir, { recursive: true }).catch(() => {});

		return new Promise<ServiceResult>((resolve) => {
			const child = spawn(service.command!, service.args ?? [], {
				cwd: placement.cwd,
				env: { ...process.env, ...placement.env, ...(service.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (result: ServiceResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				finish({ ok: false, error: `script timed out after ${timeoutMs}ms`, stdout, stderr });
			}, timeoutMs);

			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => finish({ ok: false, error: error.message, stdout, stderr }));
			child.on("close", (code) => {
				if (code !== 0) {
					finish({ ok: false, error: `script exited with code ${code}`, stdout, stderr, exitCode: code });
					return;
				}
				const text = stdout.trim();
				if (!text) {
					finish({ ok: true, result: null, stdout, stderr, exitCode: code });
					return;
				}
				try {
					finish({ ok: true, result: JSON.parse(text), stdout, stderr, exitCode: code });
				} catch {
					finish({ ok: true, result: text, stdout, stderr, exitCode: code });
				}
			});

			child.stdin.write(JSON.stringify(params) ?? "{}");
			child.stdin.end();
		});
	}

	private async ensureDaemon(tool: ToolManifest, name: string, service: ServiceDefinition): Promise<DaemonHandle> {
		const placement = this.placement(tool, name, service);
		const key = placement.key;
		const existing = this.daemons.get(key);
		if (existing && !existing.closed) return existing;

		const protocol = service.protocol ?? "jsonl-stdio";
		const env = { ...placement.env, ...(service.env ?? {}) };
		let handle: DaemonHandle;
		if (protocol === "jsonl-stdio") {
			handle = createStdioClient(service, key, placement.cwd, env, this.log);
			handle.stateDir = placement.stateDir;
		} else if (protocol === "unix-jsonl") {
			const socketPath = path.resolve(placement.cwd, service.socket ?? path.join(placement.stateDir, "service.sock"));
			const reuse = await canConnect(socketPath);
			handle = await createUnixClient({
				service,
				key,
				socketPath,
				cwd: placement.cwd,
				env,
				stateDir: placement.stateDir,
				spawn: !reuse,
				log: this.log,
			});
		} else if (protocol === "http-json") {
			const reuse = service.url ? await httpReachable(service.url) : false;
			handle = await createHttpClient({
				service,
				key,
				cwd: placement.cwd,
				env,
				stateDir: placement.stateDir,
				spawn: !reuse,
				log: this.log,
			});
		} else {
			throw new Error(`unsupported daemon protocol for "${key}": ${protocol}`);
		}
		this.daemons.set(key, handle);
		if (service.lifecycle === "persistent") this.persistentKeys.set(key, protocol);
		if (handle.child) {
			await writeServiceState(placement.stateDir, {
				tool: tool.name,
				service: name,
				pid: handle.child.pid ?? null,
				cwd: placement.cwd,
				stateDir: placement.stateDir,
				startedAt: new Date().toISOString(),
			});
		}
		if (service.healthCheck) {
			await this.callDaemon(tool, name, service, { method: service.healthCheck.method, params: {} });
		}
		return handle;
	}

	private async callDaemon(
		tool: ToolManifest,
		name: string,
		service: ServiceDefinition,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const handle = await this.ensureDaemon(tool, name, service);
		const timeoutMs = service.timeoutMs ?? 60_000;
		return handle.request(typeof params.method === "string" ? params.method : undefined, params.params as Record<string, unknown> ?? {}, timeoutMs);
	}

	async daemonStatus(tool: ToolManifest, name: string): Promise<DaemonStatus> {
		const service = tool.services?.[name];
		if (!service || service.type !== "daemon") {
			throw new Error(`tool "${tool.name}" has no daemon service "${name}"`);
		}
		const placement = this.placement(tool, name, service);
		const protocol = service.protocol ?? "jsonl-stdio";
		let pid: number | undefined;
		try {
			const state = JSON.parse(await fs.readFile(path.join(placement.stateDir, "state.json"), "utf8")) as {
				pid?: unknown;
			};
			if (typeof state.pid === "number") pid = state.pid;
		} catch {
			// the state file is advisory
		}
		const handle = this.daemons.get(placement.key);
		const alive = pid !== undefined ? isProcessAlive(pid) : Boolean(handle && !handle.closed);
		let reachable = alive;
		if (protocol === "unix-jsonl") {
			const socketPath = path.resolve(
				placement.cwd,
				service.socket ?? path.join(placement.stateDir, "service.sock"),
			);
			reachable = await canConnect(socketPath);
		} else if (protocol === "http-json" && service.url) {
			reachable = await httpReachable(service.url);
		}
		return {
			tool: tool.name,
			service: name,
			protocol,
			stateDir: placement.stateDir,
			pid,
			alive,
			reachable,
		};
	}

	/**
	 * Stop the recorded daemon process and start it again through the normal
	 * ensure path. The runtime owns the protocol client, so a restart must run
	 * here and not in a separate process.
	 */
	async restartDaemon(tool: ToolManifest, name: string): Promise<DaemonStatus> {
		const service = tool.services?.[name];
		if (!service || service.type !== "daemon") {
			throw new Error(`tool "${tool.name}" has no daemon service "${name}"`);
		}
		const placement = this.placement(tool, name, service);
		const key = placement.key;
		const protocol = service.protocol ?? "jsonl-stdio";
		let pid: number | undefined;
		try {
			const state = JSON.parse(await fs.readFile(path.join(placement.stateDir, "state.json"), "utf8")) as {
				pid?: unknown;
			};
			if (typeof state.pid === "number") pid = state.pid;
		} catch {
			// no recorded process
		}
		if (pid !== undefined && isProcessAlive(pid)) {
			if (!(await processMatchesService(pid, service))) {
				throw new Error(
					`recorded pid ${pid} for ${tool.name}/${name} does not match the declared command; refusing to restart it`,
				);
			}
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// the process may have exited between the check and the signal
			}
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && isProcessAlive(pid)) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (isProcessAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		}
		const handle = this.daemons.get(key);
		handle?.close();
		this.daemons.delete(key);
		this.persistentKeys.delete(key);

		// Wait briefly for the old listener to disappear before spawning a new one.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const reachable =
				protocol === "unix-jsonl"
					? await canConnect(
							path.resolve(placement.cwd, service.socket ?? path.join(placement.stateDir, "service.sock")),
						)
					: protocol === "http-json" && service.url
						? await httpReachable(service.url)
						: false;
			if (!reachable) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (protocol === "unix-jsonl") {
			// A killed server can leave its socket path behind; a new bind needs
			// the path gone so readiness reflects the new listener.
			await fs.rm(
				path.resolve(placement.cwd, service.socket ?? path.join(placement.stateDir, "service.sock")),
				{ force: true },
			);
		}

		await this.ensureDaemon(tool, name, service);
		return this.daemonStatus(tool, name);
	}

	async close(): Promise<void> {
		for (const [key, handle] of this.daemons) {
			const protocol = this.persistentKeys.get(key);
			if (protocol && protocol !== "jsonl-stdio") {
				// A socket or HTTP daemon survives the session and is attached again
				// on the next start. A stdio daemon owns its pipes, so it is closed.
				this.log(`[${key}] persistent daemon left running`);
				continue;
			}
			handle.close();
			if (handle.stateDir && handle.child) {
				await writeServiceState(handle.stateDir, {
					stoppedAt: new Date().toISOString(),
				});
			}
			this.log(`[${key}] daemon closed`);
		}
		this.daemons.clear();
		this.persistentKeys.clear();
	}
}
