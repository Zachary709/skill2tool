import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobRecord, JobToolInput, ToolEnvelope, ToolManifest, ToolMode } from "../types.ts";
import {
	appendJobEvent,
	atomicWrite,
	jobDir,
	jobFilePath,
	readJobRecord,
	writeJobRecord,
	writeJobResult,
} from "./store.ts";

export interface JobManagerOptions {
	root: string;
	agentDir: string;
	notify: (job: JobRecord) => void;
	log: (message: string) => void;
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);

function newJobId(tool: string): string {
	return `job_${tool}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function isAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class JobManager {
	private readonly records = new Map<string, JobRecord>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly workerEntry = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
	private readonly options: JobManagerOptions;

	constructor(options: JobManagerOptions) {
		this.options = options;
	}

	private async persist(record: JobRecord): Promise<void> {
		this.records.set(record.id, record);
		await writeJobRecord(this.options.root, record);
	}

	private async read(id: string): Promise<JobRecord | undefined> {
		const record = (await readJobRecord(this.options.root, id)) ?? this.records.get(id);
		if (record) this.records.set(id, record);
		return record;
	}

	async create(options: {
		manifest: ToolManifest;
		input: Record<string, unknown>;
		mode: ToolMode;
		cwd: string;
		projectTrusted: boolean;
		requester?: JobRecord["requester"];
	}): Promise<JobRecord> {
		const record: JobRecord = {
			id: newJobId(options.manifest.name),
			tool: options.manifest.name,
			toolVersion: options.manifest.version,
			agentId: "",
			agentSource: "embedded",
			cwd: options.cwd,
			toolDir: options.manifest.dir,
			projectTrusted: options.projectTrusted,
			input: options.input,
			mode: options.mode,
			state: "queued",
			createdAt: new Date().toISOString(),
			requester: options.requester,
		};
		await this.persist(record);
		await appendJobEvent(this.options.root, record, { state: "queued" });

		if (options.mode === "status" || options.mode === "result" || options.mode === "cancel") {
			return record;
		}

		this.enqueue(record);
		return record;
	}

	private enqueue(record: JobRecord): void {
		const queueKey = `${record.tool}:${record.cwd}`;
		const previous = this.queues.get(queueKey) ?? Promise.resolve();
		let next: Promise<void>;
		next = previous
			.catch(() => {})
			.then(() => this.run(record.id))
			.finally(() => {
				if (this.queues.get(queueKey) === next) this.queues.delete(queueKey);
			});
		this.queues.set(queueKey, next);
	}

	private async run(id: string): Promise<void> {
		const record = await this.read(id);
		if (!record || record.state !== "queued") return;

		const dir = jobDir(this.options.root, record.id);
		await fs.mkdir(dir, { recursive: true });
		const stdout = await fs.open(path.join(dir, "stdout.log"), "a");
		const stderr = await fs.open(path.join(dir, "stderr.log"), "a");
		const child = spawn(process.execPath, [this.workerEntry, jobFilePath(this.options.root, id)], {
			cwd: record.cwd,
			env: {
				...process.env,
				PI_TOOL_RUNTIME_AGENT_DIR: this.options.agentDir,
				NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-transform-types"].filter(Boolean).join(" "),
				NODE_NO_WARNINGS: "1",
			},
			detached: true,
			stdio: ["ignore", stdout.fd, stderr.fd],
		});
		await stdout.close();
		await stderr.close();

		record.state = "running";
		record.pid = child.pid;
		record.startedAt = new Date().toISOString();
		record.heartbeatAt = record.startedAt;
		await this.persist(record);
		await appendJobEvent(this.options.root, record, { state: "running", pid: child.pid });

		child.on("error", (error) => {
			this.options.log(`worker process failed for ${id}: ${error.message}`);
		});

		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.once("error", () => resolve());
		});

		let finished = (await this.read(id)) ?? record;
		if (!TERMINAL_STATES.has(finished.state)) {
			finished.state = "failed";
			finished.error = "worker process exited without writing a terminal job state";
			finished.result = { status: "failed", summary: finished.error, jobId: id };
			finished.finishedAt = new Date().toISOString();
			finished.heartbeatAt = finished.finishedAt;
			await this.persist(finished);
			await writeJobResult(this.options.root, finished);
			await appendJobEvent(this.options.root, finished, { state: finished.state, message: finished.error });
		}
		if (finished.mode === "start") {
			try {
				this.options.notify(finished);
			} catch (error) {
				this.options.log(`job notification failed: ${String(error)}`);
			}
		}
	}

	async get(id: string): Promise<JobRecord | undefined> {
		return this.read(id);
	}

	async list(): Promise<JobRecord[]> {
		await fs.mkdir(this.options.root, { recursive: true });
		let entries: string[] = [];
		try {
			entries = await fs.readdir(this.options.root);
		} catch {
			return [...this.records.values()];
		}
		const records: JobRecord[] = [];
		for (const entry of entries) {
			const record = await this.read(entry);
			if (record) records.push(record);
		}
		return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async wait(id: string, timeoutMs?: number): Promise<JobRecord | undefined> {
		const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
		while (true) {
			const record = await this.read(id);
			if (!record) return undefined;
			if (TERMINAL_STATES.has(record.state)) return record;
			if (Date.now() >= deadline) return record;
			await sleep(200);
		}
	}

	async handle(input: JobToolInput): Promise<ToolEnvelope> {
		if (input.action === "list") {
			const jobs = (await this.list()).slice(0, 50);
			return {
				status: "ok",
				summary: `${jobs.length} job(s) known to this runtime.`,
				result: { jobs },
			};
		}
		if (!input.jobId) {
			return { status: "failed", summary: "jobId is required for this action." };
		}
		const record = await this.read(input.jobId);
		if (!record) {
			return { status: "failed", summary: `Unknown job: ${input.jobId}` };
		}
		if (input.action === "cancel") {
			if (TERMINAL_STATES.has(record.state)) {
				return {
					status: "ok",
					summary: `Job ${record.id} is already ${record.state}.`,
					result: { job: record },
				};
			}
			if (record.pid && isAlive(record.pid)) {
				try {
					process.kill(record.pid, "SIGTERM");
				} catch {
					// ignore
				}
			}
			record.state = "cancelled";
			record.finishedAt = new Date().toISOString();
			record.result = { status: "cancelled", summary: "Job cancelled.", jobId: record.id };
			await this.persist(record);
			await writeJobResult(this.options.root, record);
			await appendJobEvent(this.options.root, record, { state: "cancelled" });
			return {
				status: "ok",
				summary: `Cancellation requested for ${input.jobId}.`,
				result: { job: record },
			};
		}
		if (input.action === "wait") {
			const job = await this.wait(input.jobId, input.timeoutMs);
			return {
				status: "ok",
				summary: job ? `Job ${job.id} is ${job.state}.` : `Unknown job: ${input.jobId}`,
				result: { job },
			};
		}
		if (input.action === "result") {
			return {
				status: "ok",
				summary: `Job ${record.id} is ${record.state}.`,
				result: { job: record, result: record.result ?? null },
			};
		}
		if (input.action === "logs") {
			try {
				const events = await fs.readFile(path.join(jobDir(this.options.root, input.jobId), "events.jsonl"), "utf8");
				const stderr = await fs
					.readFile(path.join(jobDir(this.options.root, input.jobId), "stderr.log"), "utf8")
					.catch(() => "");
				return {
					status: "ok",
					summary: `Events for ${input.jobId}.`,
					result: {
						job: record,
						events: events.trim().split("\n").slice(-100),
						stderr: stderr.split("\n").slice(-50).join("\n"),
					},
				};
			} catch {
				return { status: "ok", summary: `No events for ${input.jobId}.`, result: { job: record } };
			}
		}
		return {
			status: "ok",
			summary: `Job ${record.id} is ${record.state}.`,
			result: { job: record },
		};
	}

	async recover(): Promise<void> {
		await fs.mkdir(this.options.root, { recursive: true });
		let entries: string[] = [];
		try {
			entries = await fs.readdir(this.options.root);
		} catch {
			return;
		}
		for (const entry of entries) {
			const record = await this.read(entry);
			if (!record) continue;
			if (record.state === "running" && !isAlive(record.pid)) {
				record.state = "lost";
				record.error = "runtime restarted while the job was running";
				record.result = { status: "failed", summary: record.error, jobId: record.id };
				record.finishedAt = new Date().toISOString();
				record.heartbeatAt = record.finishedAt;
				await this.persist(record);
				await writeJobResult(this.options.root, record);
				await appendJobEvent(this.options.root, record, { state: "lost", message: record.error });
			} else if (record.state === "queued") {
				this.enqueue(record);
			}
		}
	}
}
