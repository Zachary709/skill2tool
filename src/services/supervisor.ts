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

function serviceKey(tool: ToolManifest, name: string): string {
	return `${tool.name}:${name}`;
}

function resolveCwd(tool: ToolManifest, service: ServiceDefinition): string {
	return service.cwd ? path.resolve(tool.dir ?? process.cwd(), service.cwd) : (tool.dir ?? process.cwd());
}

function spawnDaemon(
	service: ServiceDefinition,
	cwd: string,
	log: (message: string) => void,
): ChildProcess {
	if (!service.command) throw new Error("daemon service has no command");
	const child = spawn(service.command, service.args ?? [], {
		cwd,
		env: { ...process.env, ...(service.env ?? {}) },
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

function createStdioClient(tool: ToolManifest, service: ServiceDefinition, key: string, log: (message: string) => void): DaemonHandle {
	if (!service.command) throw new Error(`daemon service "${key}" has no command`);
	const child = spawn(service.command, service.args ?? [], {
		cwd: resolveCwd(tool, service),
		env: { ...process.env, ...(service.env ?? {}) },
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

async function createUnixClient(
	tool: ToolManifest,
	service: ServiceDefinition,
	key: string,
	log: (message: string) => void,
): Promise<DaemonHandle> {
	const socketPath = service.socket;
	if (!socketPath) throw new Error(`daemon service "${key}" has no socket`);
	const child = service.command ? spawnDaemon(service, resolveCwd(tool, service), log) : undefined;
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

async function createHttpClient(
	tool: ToolManifest,
	service: ServiceDefinition,
	key: string,
	log: (message: string) => void,
): Promise<DaemonHandle> {
	if (!service.url) throw new Error(`daemon service "${key}" has no url`);
	const child = service.command ? spawnDaemon(service, resolveCwd(tool, service), log) : undefined;
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
	};
}

export class ServiceSupervisor {
	private daemons = new Map<string, DaemonHandle>();

	constructor(private readonly log: (message: string) => void = () => {}) {}

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
			return this.runScript(tool, service, params);
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
		service: ServiceDefinition,
		params: Record<string, unknown>,
	): Promise<ServiceResult> {
		if (!service.command) return { ok: false, error: "script service has no command" };
		const cwd = resolveCwd(tool, service);
		const timeoutMs = service.timeoutMs ?? 60_000;

		return new Promise<ServiceResult>((resolve) => {
			const child = spawn(service.command!, service.args ?? [], {
				cwd,
				env: { ...process.env, ...(service.env ?? {}) },
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
		const key = serviceKey(tool, name);
		const existing = this.daemons.get(key);
		if (existing && !existing.closed) return existing;

		const protocol = service.protocol ?? "jsonl-stdio";
		let handle: DaemonHandle;
		if (protocol === "jsonl-stdio") {
			handle = createStdioClient(tool, service, key, this.log);
		} else if (protocol === "unix-jsonl") {
			handle = await createUnixClient(tool, service, key, this.log);
		} else if (protocol === "http-json") {
			handle = await createHttpClient(tool, service, key, this.log);
		} else {
			throw new Error(`unsupported daemon protocol for "${key}": ${protocol}`);
		}
		this.daemons.set(key, handle);
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

	async close(): Promise<void> {
		for (const [key, handle] of this.daemons) {
			handle.close();
			this.log(`[${key}] daemon closed`);
		}
		this.daemons.clear();
	}
}
