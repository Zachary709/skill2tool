import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerProgressEntry, WorkerRunResult } from "../agents/worker.ts";
import type { AgentConfig, JobRecord, JobToolInput, ToolEnvelope, ToolManifest, ToolMode } from "../types.ts";
import { validateValue } from "../contracts/schema.ts";
import { appendJobEvent, jobDir, jobFilePath, readJobRecord, writeJobRecord, writeJobResult } from "./store.ts";
import { CLEANUP_GRACE_MS } from "./processes.ts";
import type { ManagementTool, ParentMessage, WorkerMessage } from "./ipc.ts";
import { abortable } from "./abort.ts";
import { acquireWorkerLock, tryAcquireWorkerLock } from "./lock.ts";

export const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);
interface Task {
	record: JobRecord;
	controller: AbortController;
	requestAbort: AbortController;
	manifest: ToolManifest;
	tools: ManagementTool[];
	child?: ChildProcess;
	result?: WorkerRunResult;
	cleaned?: boolean;
	operations: Set<Promise<void>>;
	owned: Set<number>;
	writes: Promise<void>;
	done?: Promise<void>;
	exited?: Promise<void>;
	escalation?: NodeJS.Timeout;
	listeners: Set<(entry?: WorkerProgressEntry) => void>;
	entries: WorkerProgressEntry[];
}

export interface JobManagerOptions {
	root: string;
	agentDir: string;
	notify: (job: JobRecord) => void;
	log: (message: string) => void;
	service?: (manifest: ToolManifest, name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}

export class JobManager {
	private readonly tasks = new Map<string, Task>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly workerEntry = fileURLToPath(new URL("./supervisor-entry.ts", import.meta.url));
	constructor(private readonly options: JobManagerOptions) {}

	private persist(task: Task): Promise<void> {
		const snapshot = structuredClone(task.record);
		task.writes = task.writes.then(() => writeJobRecord(this.options.root, snapshot));
		return task.writes;
	}
	private auditFailed(task: Task, error: unknown): void {
		task.record.auditError = String(error);
		this.options.log(`任务审计失败 ${task.record.id}: ${String(error)}`);
		if (!TERMINAL_STATES.has(task.record.state)) this.cancel(task.record.id);
		this.publish(task);
	}
	private track(task: Task, pending: Promise<void>): void {
		task.operations.add(pending);
		void pending.catch((error) => this.auditFailed(task, error)).finally(() => task.operations.delete(pending));
	}
	private publish(task: Task, entry?: WorkerProgressEntry): void {
		for (const listener of task.listeners) listener(entry);
	}
	subscribe(id: string, listener: (entry?: WorkerProgressEntry) => void): () => void {
		const task = this.tasks.get(id);
		if (!task) return () => {};
		task.listeners.add(listener);
		return () => task.listeners.delete(listener);
	}

	async create(options: {
		manifest: ToolManifest; input: Record<string, unknown>; mode: ToolMode; cwd: string; projectTrusted: boolean;
		requester?: JobRecord["requester"]; model?: string; thinkingLevel?: AgentConfig["thinkingLevel"];
		signal?: AbortSignal; managementTools?: ManagementTool[];
	}): Promise<JobRecord> {
		options.signal?.throwIfAborted();
		const record: JobRecord = {
			id: `job_${options.manifest.name}_${crypto.randomUUID()}`,
			tool: options.manifest.name, toolVersion: options.manifest.version, agentId: "", agentSource: "embedded",
			cwd: options.cwd, toolDir: options.manifest.dir, toolScope: options.manifest.scope,
			projectTrusted: options.projectTrusted, input: structuredClone(options.input), mode: options.mode,
			state: "queued", phase: "排队", createdAt: new Date().toISOString(), requester: options.requester,
			model: options.model, thinkingLevel: options.thinkingLevel,
			concurrency: options.manifest.handler ? "serial" : options.manifest.agent?.concurrency ?? "serial",
			managementTools: options.managementTools?.map(({ name, label, description, parameters }) => ({ name, label, description, parameters })),
		};
		const ownership = await acquireWorkerLock(path.join(jobDir(this.options.root, record.id), "owner"), options.signal);
		const task: Task = { record, controller: new AbortController(), requestAbort: new AbortController(), manifest: structuredClone(options.manifest),
			tools: options.managementTools ?? [], owned: new Set(), operations: new Set(), writes: Promise.resolve(), listeners: new Set(), entries: [] };
		this.tasks.set(record.id, task);
		const abort = () => { this.cancel(record.id); };
		options.signal?.addEventListener("abort", abort, { once: true });
		ownership.signal.addEventListener("abort", abort, { once: true });
		const release = async () => {
			options.signal?.removeEventListener("abort", abort);
			ownership.signal.removeEventListener("abort", abort);
			try { await task.writes; }
			finally { await ownership.release(); }
		};
		if (options.signal?.aborted || ownership.signal.aborted) abort();
		const saved = this.persist(task).then(() => appendJobEvent(this.options.root, record, { state: record.state, requester: record.requester }));
		try { await abortable(saved, task.controller.signal); }
		catch (error) {
			try {
				if (task.controller.signal.aborted) return record;
				this.auditFailed(task, error); throw error;
			} finally { await release(); }
		}
		if (TERMINAL_STATES.has(record.state) || ["status", "result", "cancel"].includes(options.mode)) {
			await release();
			return record;
		}
		const queueKey = record.concurrency === "parallel" ? record.id
			: JSON.stringify([record.tool, record.cwd, record.requester?.sessionId]);
		const previous = this.queues.get(queueKey) ?? Promise.resolve();
		const next = previous.catch((error) => this.options.log(String(error))).then(() => this.run(task));
		task.done = next.finally(async () => {
			try { await release(); }
			finally { if (this.queues.get(queueKey) === task.done) this.queues.delete(queueKey); }
		});
		this.queues.set(queueKey, task.done);
		void task.done.catch((error) => this.options.log(`任务清理失败 ${record.id}: ${String(error)}`));
		return record;
	}

	private async progress(task: Task, entry: WorkerProgressEntry): Promise<void> {
		if (TERMINAL_STATES.has(task.record.state)) return;
		task.entries.push(entry);
		if (task.entries.length > 60) task.entries.shift();
		task.record.heartbeatAt = entry.time;
		if (entry.event === "model_request") task.record.modelRequests = (task.record.modelRequests ?? 0) + 1;
		if (entry.sessionFile) task.record.sessionFile = entry.sessionFile;
		if (entry.sessionId) task.record.sessionId = entry.sessionId;
		if (entry.kind === "update") task.record.outputEvents = (task.record.outputEvents ?? 0) + 1;
		if (entry.kind === "tool" || entry.kind === "result" || entry.kind === "update") {
			await appendJobEvent(this.options.root, task.record, { operation: entry.tool, toolCallId: entry.callId, phase: entry.kind === "tool" ? "preflight" : entry.kind === "update" ? "output" : "finished", detail: entry.text, isError: entry.isError });
		}
		if (TERMINAL_STATES.has(task.record.state)) return;
		if (!entry.internal && task.record.state !== "cancelling") task.record.phase = entry.kind === "tool" || entry.kind === "update" ? `执行 ${entry.tool}`
			: entry.kind === "result" ? `${entry.tool} ${entry.isError ? "执行失败" : "已完成"}`
			: entry.kind === "text" ? "模型说明" : entry.text.slice(0, 100);
		task.writes = task.writes.then(() => fs.appendFile(path.join(jobDir(this.options.root, task.record.id), "progress.jsonl"), `${JSON.stringify(entry)}\n`));
		await this.persist(task);
		if (!entry.internal) this.publish(task, entry);
	}

	private async request(task: Task, message: Extract<WorkerMessage, { type: "request" }>): Promise<void> {
		const { record } = task;
		const signal = AbortSignal.any([task.controller.signal, task.requestAbort.signal]);
		let value: unknown;
		let error: string | undefined;
		try {
			signal.throwIfAborted();
			if (task.result) throw new Error("worker 已提交最终结果，禁止新的操作");
			if (message.method === "audit") {
				await appendJobEvent(this.options.root, record, { operation: message.name, requestId: message.id, phase: "authorized", input: message.input });
				if (message.name === "bash" && typeof message.input.outputPath === "string") {
					record.outputFiles = [...new Set([...(record.outputFiles ?? []), message.input.outputPath])];
					await this.persist(task);
				}
				signal.throwIfAborted();
				this.send(task, { type: "reply", id: message.id, value: { accepted: true } }); return;
			}
			await appendJobEvent(this.options.root, record, { operation: message.name, requestId: message.id, phase: "requested", input: message.input });
			signal.throwIfAborted();
			await this.progress(task, { time: new Date().toISOString(), kind: "status", text: `等待服务或管理操作 ${message.name}` });
			signal.throwIfAborted();
			if (message.method === "service") {
				if (!this.options.service) throw new Error("未配置服务管理器");
				value = await this.options.service(task.manifest, message.name, message.input, signal);
			} else {
				const tool = task.tools.find((tool) => tool.name === message.name);
				if (!tool) throw new Error(`未授权的管理操作: ${message.name}`);
				const errors = validateValue(tool.parameters as never, message.input);
				if (errors.length) throw new Error(errors.join("; "));
				if (message.name === "service_keeper_manage" && message.input.action === "restart" && record.input.allowRepair !== true) {
					throw new Error("本次调用未授权重启");
				}
				value = await tool.execute(message.id, message.input, signal);
			}
			await appendJobEvent(this.options.root, record, { operation: message.name, phase: "completed", requestId: message.id, value });
			signal.throwIfAborted();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
			try { await appendJobEvent(this.options.root, record, { operation: message.name, requestId: message.id, phase: signal.aborted ? "interrupted" : "failed", error, partialEffectsPossible: true }); }
			catch (auditError) { this.auditFailed(task, auditError); }
		}
		this.send(task, { type: "reply", id: message.id, value, error });
	}

	private send(task: Task, message: ParentMessage): void {
		if (task.child?.connected) task.child.send(message, (error) => {
			if (error && !task.controller.signal.aborted) this.options.log(`IPC ${task.record.id}: ${error.message}`);
		});
	}

	private async run(task: Task): Promise<void> {
		try { await this.runProcess(task); }
		catch (error) {
			this.options.log(`任务 ${task.record.id} 失败: ${String(error)}`);
			if (TERMINAL_STATES.has(task.record.state)) return;
			task.record.error = String(error);
			task.controller.abort(error);
			if (task.child?.exitCode === null) this.stopProcess(task);
			await task.exited;
			task.record.state = !task.child || task.cleaned ? (task.record.cancelRequestedAt ? "cancelled" : "failed") : "cancelling";
			task.record.result = { status: task.record.state === "cancelled" ? "cancelled" : "failed", summary: String(error), jobId: task.record.id };
			task.record.phase = task.record.state;
			if (task.record.state !== "cancelling") task.record.finishedAt = new Date().toISOString();
			await this.persist(task); this.publish(task);
		}
	}

	private async runProcess(task: Task): Promise<void> {
		if (task.controller.signal.aborted) return;
		const { record } = task;
		const directory = jobDir(this.options.root, record.id);
		await fs.mkdir(directory, { recursive: true });
		const intermediate = path.join(directory, "intermediate");
		await fs.mkdir(intermediate, { recursive: true, mode: 0o700 });
		const stdout = await fs.open(path.join(directory, "stdout.log"), "a");
		const stderr = await fs.open(path.join(directory, "stderr.log"), "a");
		if (task.controller.signal.aborted) { await stdout.close(); await stderr.close(); return; }
		const child = spawn(process.execPath, [this.workerEntry, jobFilePath(this.options.root, record.id)], {
			cwd: record.cwd, detached: process.platform !== "win32",
			env: { ...process.env, PI_TOOL_RUNTIME_AGENT_DIR: this.options.agentDir,
				PI_TOOL_PROCESS_JOURNAL: path.join(directory, "processes.jsonl"),
				PI_TOOL_JOB_DIRECTORY: intermediate, TMPDIR: intermediate,
				NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-transform-types"].filter(Boolean).join(" "), NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", stdout.fd, stderr.fd, "ipc"], serialization: "advanced",
		});
		task.child = child;
		record.pid = child.pid;
		record.state = "running";
		record.phase = "准备 worker";
		record.startedAt = record.heartbeatAt = new Date().toISOString();
		const exited = new Promise<void>((resolve) => {
			child.once("close", () => resolve());
			child.once("error", (error) => { record.error = error.message; resolve(); });
		});
		task.exited = exited;
		child.on("message", (raw) => {
			const message = raw as WorkerMessage;
			if (message.type === "ready") this.send(task, { type: "configure", manifest: task.manifest, tools: record.managementTools ?? [] });
			if (message.type === "owned") {
				task.owned.add(message.pid); record.ownedPids = [...task.owned];
				this.track(task, this.persist(task));
			}
			if (message.type === "progress") this.track(task, this.progress(task, message.entry));
			if (message.type === "result") {
				task.result = message.result;
				if (record.state !== "cancelling") record.phase = "保存结果并清理子进程";
				this.track(task, appendJobEvent(this.options.root, record, { phase: "worker_result", envelope: message.result.envelope, sessionFile: message.result.sessionFile }));
				void this.persist(task).catch((error) => this.options.log(String(error))); this.publish(task);
			}
			if (message.type === "cleaned") { task.cleaned = true; record.cleanupError = undefined; }
			if (message.type === "forcing") {
				record.forcedTermination = true; record.phase = "强制终止并回收子进程";
				void this.persist(task).catch((error) => this.options.log(String(error))); this.publish(task);
			}
			if (message.type === "cleanup_error") {
				record.cleanupError = message.error; record.state = "cancelling"; record.phase = `清理未完成：${message.error}`;
				void this.persist(task).catch((error) => this.options.log(String(error))); this.publish(task);
			}
			if (message.type === "worker_error") record.error = message.error;
			if (message.type === "resolved") {
				record.agentId = message.agentId; record.agentSource = message.agentSource as JobRecord["agentSource"];
			}
			if (message.type === "request") this.track(task, this.request(task, message));
		});
		await stdout.close(); await stderr.close();
		await this.persist(task);
		this.publish(task);
		if (task.controller.signal.aborted) this.stopProcess(task);
		await exited;
		if (task.escalation) clearTimeout(task.escalation);
		task.requestAbort.abort(new Error("worker 已退出，停止尚未结束的请求"));
		await Promise.allSettled([...task.operations]);
		if (!task.cleaned) {
			record.state = "cancelling";
			record.cleanupError = record.cleanupError ?? "监督进程未确认任务子进程已全部回收";
			record.phase = record.cleanupError;
			await this.persist(task); this.publish(task);
			return;
		}
		const result = task.result;
		const cancelled = Boolean(record.cancelRequestedAt) || result?.envelope.status === "cancelled";
		record.state = cancelled ? "cancelled" : result?.envelope.status === "failed" || !result ? "failed" : "succeeded";
		record.result = cancelled ? { status: "cancelled", summary: "任务已取消；已完成的操作未撤销，详见任务事件。", jobId: record.id }
			: result ? { ...result.envelope, jobId: record.id } : { status: "failed", summary: record.error ?? "worker 未提交结果即退出", jobId: record.id };
		record.usage = result?.usage; record.sessionFile = result?.sessionFile ?? record.sessionFile; record.sessionId = result?.sessionId ?? record.sessionId;
		record.artifacts = result?.envelope.artifacts; record.message = record.result.summary;
		record.finishedAt = record.heartbeatAt = new Date().toISOString(); record.phase = record.state;
		await this.persist(task); await writeJobResult(this.options.root, record);
		await appendJobEvent(this.options.root, record, { state: record.state });
		this.publish(task);
		if (record.mode === "start" && !cancelled) this.options.notify(record);
	}

	private stopProcess(task: Task): void {
		this.send(task, { type: "cancel" });
		if (task.escalation || !task.child?.pid || task.child.exitCode !== null || task.child.signalCode !== null) return;
		task.child.kill("SIGTERM");
		task.escalation = setTimeout(() => {
			if (task.child?.exitCode === null && task.child.signalCode === null) task.child.kill("SIGUSR2");
		}, CLEANUP_GRACE_MS);
	}

	cancel(id: string): JobRecord | undefined {
		const task = this.tasks.get(id);
		if (!task || TERMINAL_STATES.has(task.record.state) || task.controller.signal.aborted) return task?.record;
		const { record } = task;
		record.cancelRequestedAt = new Date().toISOString();
		record.state = task.child ? "cancelling" : "cancelled";
		record.phase = task.child ? "取消中" : "已取消排队";
		if (!task.child) { record.finishedAt = record.cancelRequestedAt; record.result = { status: "cancelled", summary: "任务在启动前已取消", jobId: id }; }
		task.controller.abort(new Error("任务已请求取消"));
		this.stopProcess(task);
		void this.persist(task).catch((error) => this.options.log(String(error)));
		void appendJobEvent(this.options.root, record, { state: record.state, cancelRequestedAt: record.cancelRequestedAt }).catch((error) => this.auditFailed(task, error));
		this.publish(task);
		return record;
	}
	cancelRun(sessionId: string, runId?: string): JobRecord[] {
		return [...this.tasks.values()].filter(({ record }) => record.requester?.sessionId === sessionId &&
			(!runId || record.requester.runId === runId) && !TERMINAL_STATES.has(record.state))
			.map(({ record }) => this.cancel(record.id)!);
	}
	active(sessionId: string): JobRecord[] {
		return [...this.tasks.values()].map((task) => task.record).filter((job) => job.requester?.sessionId === sessionId && !TERMINAL_STATES.has(job.state));
	}
	recent(id: string): WorkerProgressEntry[] | undefined { return this.tasks.get(id)?.entries.slice(); }
	async get(id: string): Promise<JobRecord | undefined> { return this.tasks.get(id)?.record ?? readJobRecord(this.options.root, id); }
	async list(): Promise<JobRecord[]> {
		await fs.mkdir(this.options.root, { recursive: true });
		const records = await Promise.all((await fs.readdir(this.options.root)).filter((id) => id.startsWith("job_")).map((id) => this.get(id)));
		return records.filter((record): record is JobRecord => Boolean(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
	async wait(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<JobRecord | undefined> {
		const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
		const local = this.tasks.get(id)?.controller.signal;
		const combined = signal && local ? AbortSignal.any([signal, local]) : signal ?? local;
		while (true) {
			const record = await this.get(id);
			if (!record || TERMINAL_STATES.has(record.state) || Date.now() >= deadline) return record;
			combined?.throwIfAborted();
			await sleep(200, undefined, { signal: combined });
		}
	}
	async handle(input: JobToolInput): Promise<ToolEnvelope> {
		if (input.action === "list") return { status: "ok", summary: "任务列表", result: { jobs: (await this.list()).slice(0, 50) } };
		if (!input.jobId) return { status: "failed", summary: "需要 jobId" };
		let record = await this.get(input.jobId);
		if (!record) return { status: "failed", summary: `未知任务: ${input.jobId}` };
		if (input.action === "cancel") {
			if (!this.tasks.has(record.id) && !TERMINAL_STATES.has(record.state)) return { status: "failed", summary: "该任务不由本运行时持有；拒绝仅凭历史 PID 终止进程。" };
			record = this.cancel(record.id) ?? record;
		} else if (input.action === "wait") record = await this.wait(record.id, input.timeoutMs) ?? record;
		if (input.action === "logs") {
			const events = await fs.readFile(path.join(jobDir(this.options.root, record.id), "events.jsonl"), "utf8");
			return { status: "ok", summary: `任务 ${record.id} 事件`, result: { job: record, events } };
		}
		return { status: "ok", summary: `任务 ${record.id}: ${record.state}`, result: { job: record, result: record.result ?? null } };
	}
	async recover(): Promise<void> {
		for (const candidate of await this.list()) {
			if (this.tasks.has(candidate.id) || TERMINAL_STATES.has(candidate.state)) continue;
			const ownership = await tryAcquireWorkerLock(path.join(jobDir(this.options.root, candidate.id), "owner"));
			if (!ownership) continue;
			try {
				// 加锁后重新读取，避免覆盖另一个对话刚保存的终态。
				const record = await readJobRecord(this.options.root, candidate.id);
				if (!record || TERMINAL_STATES.has(record.state)) continue;
				ownership.signal.throwIfAborted();
				// 只处理已失去所有权的任务，不继承授权或操作历史 PID。
				record.state = "lost"; record.error = "运行时已重启，任务所有权丢失";
				record.result = { status: "failed", summary: record.error, jobId: record.id };
				record.finishedAt = new Date().toISOString();
				await writeJobRecord(this.options.root, record); await writeJobResult(this.options.root, record);
			} finally { await ownership.release(); }
		}
	}
	async close(): Promise<void> {
		for (const id of this.tasks.keys()) this.cancel(id);
		await Promise.allSettled([...this.tasks.values()].map((task) => task.done));
		await Promise.all([...this.tasks.values()].map((task) => task.writes));
	}
}
