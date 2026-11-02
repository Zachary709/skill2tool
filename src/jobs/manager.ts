import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { JobRecord, JobState, JobToolInput, ToolEnvelope, ToolManifest, ToolMode } from "../types.ts";
import type { WorkerRunResult } from "../agents/worker.ts";

interface JobEntry {
	record: JobRecord;
	controller: AbortController;
	done: Promise<void>;
	resolveDone: () => void;
}

export interface JobManagerOptions {
	root: string;
	runJob: (job: JobRecord, signal: AbortSignal) => Promise<WorkerRunResult>;
	notify: (job: JobRecord) => void;
	log: (message: string) => void;
}

function newJobId(tool: string): string {
	return `job_${tool}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	await fs.writeFile(temp, content, "utf8");
	await fs.rename(temp, filePath);
}

export class JobManager {
	private readonly jobs = new Map<string, JobEntry>();
	private readonly queues = new Map<string, Promise<void>>();

	constructor(private readonly options: JobManagerOptions) {}

	private jobDir(id: string): string {
		return path.join(this.options.root, id);
	}

	private async persist(record: JobRecord): Promise<void> {
		await atomicWrite(path.join(this.jobDir(record.id), "job.json"), `${JSON.stringify(record, null, 2)}\n`);
	}

	private async event(record: JobRecord, event: Record<string, unknown>): Promise<void> {
		try {
			await fs.mkdir(this.jobDir(record.id), { recursive: true });
			await fs.appendFile(
				path.join(this.jobDir(record.id), "events.jsonl"),
				`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`,
				"utf8",
			);
		} catch (error) {
			this.options.log(`failed to append job event: ${String(error)}`);
		}
	}

	async create(options: {
		manifest: ToolManifest;
		input: Record<string, unknown>;
		mode: ToolMode;
		cwd: string;
		requester?: JobRecord["requester"];
	}): Promise<JobRecord> {
		const record: JobRecord = {
			id: newJobId(options.manifest.name),
			tool: options.manifest.name,
			toolVersion: options.manifest.version,
			agentId: "",
			agentSource: "embedded",
			cwd: options.cwd,
			input: options.input,
			mode: options.mode,
			state: "queued",
			createdAt: new Date().toISOString(),
			requester: options.requester,
		};
		const controller = new AbortController();
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		this.jobs.set(record.id, { record, controller, done, resolveDone });
		await this.persist(record);
		await this.event(record, { state: "queued" });

		if (options.mode === "status" || options.mode === "result" || options.mode === "cancel") {
			return record;
		}

		const queueKey = `${options.manifest.name}:${options.cwd}`;
		const previous = this.queues.get(queueKey) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(() => this.run(record.id))
			.finally(() => {
				if (this.queues.get(queueKey) === next) this.queues.delete(queueKey);
			});
		this.queues.set(queueKey, next);
		return record;
	}

	private async run(id: string): Promise<void> {
		const entry = this.jobs.get(id);
		if (!entry) return;
		if (entry.record.state !== "queued") return;
		const { record, controller } = entry;
		record.state = "running";
		record.startedAt = new Date().toISOString();
		record.heartbeatAt = record.startedAt;
		await this.persist(record);
		await this.event(record, { state: "running" });

		try {
			const result = await this.options.runJob(record, controller.signal);
			record.state = result.envelope.status === "cancelled" ? "cancelled" : "succeeded";
			if (result.envelope.status === "failed") record.state = "failed";
			record.result = { ...result.envelope, jobId: record.id } as ToolEnvelope;
			record.usage = result.usage;
			record.artifacts = result.envelope.artifacts;
			record.message = result.envelope.summary;
		} catch (error) {
			record.state = controller.signal.aborted ? "cancelled" : "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.result = {
				status: record.state === "cancelled" ? "cancelled" : "failed",
				summary: record.error,
				jobId: record.id,
			};
		} finally {
			record.finishedAt = new Date().toISOString();
			record.heartbeatAt = record.finishedAt;
			await this.persist(record);
			await this.event(record, { state: record.state, message: record.message ?? record.error });
			if (record.result) {
				await atomicWrite(
					path.join(this.jobDir(record.id), "result.json"),
					`${JSON.stringify(record.result, null, 2)}\n`,
				);
			}
			entry.resolveDone();
			try {
				this.options.notify(record);
			} catch (error) {
				this.options.log(`job notification failed: ${String(error)}`);
			}
		}
	}

	get(id: string): JobRecord | undefined {
		return this.jobs.get(id)?.record;
	}

	list(): JobRecord[] {
		return [...this.jobs.values()]
			.map((entry) => entry.record)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async wait(id: string, timeoutMs?: number): Promise<JobRecord | undefined> {
		const entry = this.jobs.get(id);
		if (!entry) return undefined;
		if (["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(entry.record.state)) {
			return entry.record;
		}
		if (!timeoutMs || timeoutMs <= 0) {
			await entry.done;
			return entry.record;
		}
		await Promise.race([
			entry.done,
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, timeoutMs);
				timer.unref?.();
			}),
		]);
		return entry.record;
	}

	async handle(input: JobToolInput): Promise<ToolEnvelope> {
		if (input.action === "list") {
			const jobs = this.list().slice(0, 50);
			return {
				status: "ok",
				summary: `${jobs.length} job(s) known to this runtime.`,
				result: { jobs },
			};
		}
		if (!input.jobId) {
			return { status: "failed", summary: "jobId is required for this action." };
		}
		const entry = this.jobs.get(input.jobId);
		if (!entry) {
			return { status: "failed", summary: `Unknown job: ${input.jobId}` };
		}
		if (input.action === "cancel") {
			entry.controller.abort();
			if (entry.record.state === "queued") {
				entry.record.state = "cancelled";
				entry.record.finishedAt = new Date().toISOString();
				await this.persist(entry.record);
				entry.resolveDone();
			}
			return {
				status: "ok",
				summary: `Cancellation requested for ${input.jobId}.`,
				result: { job: entry.record },
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
				summary: `Job ${entry.record.id} is ${entry.record.state}.`,
				result: { job: entry.record, result: entry.record.result ?? null },
			};
		}
		if (input.action === "logs") {
			try {
				const events = await fs.readFile(path.join(this.jobDir(input.jobId), "events.jsonl"), "utf8");
				return {
					status: "ok",
					summary: `Events for ${input.jobId}.`,
					result: { job: entry.record, events: events.trim().split("\n").slice(-100) },
				};
			} catch {
				return { status: "ok", summary: `No events for ${input.jobId}.`, result: { job: entry.record } };
			}
		}
		return {
			status: "ok",
			summary: `Job ${entry.record.id} is ${entry.record.state}.`,
			result: { job: entry.record },
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
			const jobPath = path.join(this.options.root, entry, "job.json");
			try {
				const record = JSON.parse(await fs.readFile(jobPath, "utf8")) as JobRecord;
				if (record.state === "running") {
					record.state = "lost";
					record.error = "runtime restarted while the job was running";
					record.finishedAt = new Date().toISOString();
					await this.persist(record);
				}
			} catch {
				// ignore malformed job directories
			}
		}
	}
}

export function jobStoreKey(tool: string, cwd: string): string {
	return createHash("sha256").update(`${tool}|${cwd}`).digest("hex").slice(0, 12);
}
