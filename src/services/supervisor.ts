import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import * as path from "node:path";
import type { ServiceDefinition, ToolManifest } from "../types.ts";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface DaemonHandle {
	child: ChildProcessWithoutNullStreams;
	pending: Map<string, PendingRequest>;
	nextId: number;
	stderr: string;
	closed: boolean;
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
		return this.callDaemon(tool, serviceName, service, params);
	}

	private async runScript(
		tool: ToolManifest,
		service: ServiceDefinition,
		params: Record<string, unknown>,
	): Promise<ServiceResult> {
		if (!service.command) return { ok: false, error: "script service has no command" };
		const cwd = service.cwd ? path.resolve(tool.dir ?? process.cwd(), service.cwd) : (tool.dir ?? process.cwd());
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

			const payload = JSON.stringify(params) ?? "{}";
			child.stdin.write(payload);
			child.stdin.end();
		});
	}

	private async ensureDaemon(tool: ToolManifest, name: string, service: ServiceDefinition): Promise<DaemonHandle> {
		const key = serviceKey(tool, name);
		const existing = this.daemons.get(key);
		if (existing && !existing.closed) return existing;
		if (!service.command) throw new Error(`daemon service "${name}" has no command`);
		if ((service.protocol ?? "jsonl-stdio") !== "jsonl-stdio") {
			throw new Error(`daemon service "${name}" only supports jsonl-stdio in this version`);
		}

		const cwd = service.cwd ? path.resolve(tool.dir ?? process.cwd(), service.cwd) : (tool.dir ?? process.cwd());
		const child = spawn(service.command, service.args ?? [], {
			cwd,
			env: { ...process.env, ...(service.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const handle: DaemonHandle = {
			child,
			pending: new Map(),
			nextId: 1,
			stderr: "",
			closed: false,
		};
		this.daemons.set(key, handle);

		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			if (!line.trim()) return;
			let message: { id?: string; status?: string; result?: unknown; error?: string };
			try {
				message = JSON.parse(line);
			} catch {
				this.log(`[${key}] invalid daemon stdout line: ${line.slice(0, 200)}`);
				return;
			}
			if (!message.id) return;
			const pending = handle.pending.get(message.id);
			if (!pending) return;
			handle.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.status === "ok") pending.resolve(message.result);
			else pending.reject(new Error(message.error ?? "daemon request failed"));
		});
		child.stderr.on("data", (chunk) => {
			handle.stderr += chunk.toString();
			if (handle.stderr.length > 20_000) handle.stderr = handle.stderr.slice(-20_000);
		});
		child.on("exit", (code) => {
			handle.closed = true;
			const error = new Error(`daemon exited with code ${code}\n${handle.stderr}`);
			for (const pending of handle.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			handle.pending.clear();
		});
		child.on("error", (error) => {
			handle.closed = true;
			this.log(`[${key}] daemon error: ${error.message}`);
		});

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
	): Promise<ServiceResult> {
		const handle = await this.ensureDaemon(tool, name, service);
		const id = String(handle.nextId++);
		const timeoutMs = service.timeoutMs ?? 60_000;
		return new Promise<ServiceResult>((resolve) => {
			const timer = setTimeout(() => {
				handle.pending.delete(id);
				resolve({ ok: false, error: `daemon request timed out after ${timeoutMs}ms` });
			}, timeoutMs);
			handle.pending.set(id, {
				resolve: (result) => resolve({ ok: true, result }),
				reject: (error) => resolve({ ok: false, error: error.message }),
				timer,
			});
			handle.child.stdin.write(`${JSON.stringify({ id, ...params })}\n`);
		});
	}

	async close(): Promise<void> {
		for (const [key, handle] of this.daemons) {
			handle.closed = true;
			try {
				handle.child.kill("SIGTERM");
			} catch {
				// ignore
			}
			this.log(`[${key}] daemon closed`);
		}
		this.daemons.clear();
	}
}
