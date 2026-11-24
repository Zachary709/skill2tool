import { promises as fs } from "node:fs";
import * as path from "node:path";
import jsonlines from "jsonlines";
import type { JobRecord } from "../types.ts";
import type { WorkerProgressEntry } from "../agents/worker.ts";

export type ProgressWidgetPlacement = "aboveEditor" | "belowEditor";

export interface ProgressUi {
	setWidget?: (key: string, content: string[] | undefined, options?: { placement?: ProgressWidgetPlacement }) => void;
	setStatus?: (key: string, text: string | undefined) => void;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
}

export interface ProgressSnapshot {
	jobId?: string;
	shortId?: string;
	state?: string;
	tool?: string;
	entries: WorkerProgressEntry[];
	lines: string[];
	updatedAt?: string;
	phase?: string;
	startedAt?: string;
	finishedAt?: string;
	latestEntry?: WorkerProgressEntry;
	error?: string;
}

export interface JobSummary {
	jobId: string;
	state?: string;
	tool?: string;
	createdAt?: string;
}

export interface JobReference {
	jobId?: string;
	error?: string;
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);

export function shortJobRef(jobId: string): string {
	const parts = jobId.split("_").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1].slice(0, 8) : jobId;
}

export const PROGRESS_WIDGET_KEY = "tool-progress";
export const PROGRESS_STATUS_KEY = "tool-progress";
const MAX_ENTRIES = 60;
const INLINE_LIMIT = 8;
const INLINE_FLUSH_MS = 400;

function marker(entry: WorkerProgressEntry): string {
	switch (entry.kind) {
		case "thinking":
			return "思考";
		case "status":
			return "状态";
		case "text":
			return "说明";
		case "tool":
			return "调用";
		case "update":
			return "进展";
		case "result":
			return entry.isError ? "失败" : "结果";
		default:
			return entry.kind;
	}
}

export function formatProgressEntry(entry: WorkerProgressEntry): string {
	const clock = entry.time?.slice(11, 19) ?? "--:--:--";
	const tool = entry.tool ? ` ${entry.tool}` : "";
	const text = (entry.text ?? "").replace(/\s+/g, " ").trim();
	const line = text.length > 160 ? entry.kind === "update" ? `…${text.slice(-160)}` : `${text.slice(0, 160)}…` : text;
	return `${clock} [${marker(entry)}]${tool} ${line}`;
}

function entryKey(entry: WorkerProgressEntry | undefined): string {
	return entry ? JSON.stringify([entry.kind, entry.tool, entry.callId, entry.isError ?? false, formatProgressEntry({ ...entry, time: "" })]) : "";
}

function compactEntries(entries: WorkerProgressEntry[]): WorkerProgressEntry[] {
	const rows: WorkerProgressEntry[] = [];
	const calls = new Map<string, number>();
	for (const entry of entries) {
		if (entryKey(rows.at(-1)) === entryKey(entry)) continue;
		const action = entry.callId && ["tool", "update", "result"].includes(entry.kind) ? entry.callId : undefined;
		const index = action ? calls.get(action) : undefined;
		if (index !== undefined) {
			if (entryKey(rows[index]) !== entryKey(entry)) rows[index] = entry;
		} else {
			if (action) calls.set(action, rows.length);
			rows.push(entry);
		}
		if (action && entry.kind === "result") calls.delete(action);
	}
	return rows;
}

export async function readProgressEntries(filePath: string, limit = 8): Promise<WorkerProgressEntry[]> {
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch {
		return [];
	}
	const entries: WorkerProgressEntry[] = [];
	const parser = jsonlines.parse({ emitInvalidLines: true });
	parser.on("data", (entry: WorkerProgressEntry) => {
		entries.push(entry);
		if (entries.length > MAX_ENTRIES) entries.shift();
	});
	await new Promise<void>((resolve, reject) => { parser.on("error", reject); parser.on("end", resolve); parser.end(text); });
	return entries.slice(-limit);
}

async function readJobState(jobPath: string): Promise<{ state?: JobRecord["state"]; tool?: string; createdAt?: string; jobId?: string; phase?: string; startedAt?: string; finishedAt?: string }> {
	try {
		const raw = JSON.parse(await fs.readFile(jobPath, "utf8")) as {
			state?: JobRecord["state"];
			tool?: string;
			createdAt?: string;
			id?: string;
			phase?: string;
			startedAt?: string;
			finishedAt?: string;
		};
		return { state: raw.state, tool: raw.tool, createdAt: raw.createdAt, jobId: raw.id, phase: raw.phase, startedAt: raw.startedAt, finishedAt: raw.finishedAt };
	} catch {
		return {};
	}
}

export async function listJobs(jobsRoot: string): Promise<JobSummary[]> {
	let names: string[];
	try {
		names = await fs.readdir(jobsRoot);
	} catch {
		return [];
	}
	const jobs: JobSummary[] = [];
	for (const name of names) {
		if (!name.startsWith("job_")) continue;
		const info = await readJobState(path.join(jobsRoot, name, "job.json"));
		jobs.push({ jobId: name, ...info });
	}
	return jobs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export function formatJobRow(job: JobSummary, index: number): string {
	const clock = job.createdAt?.slice(11, 19) ?? "--:--:--";
	return [
		`${index}.`,
		shortJobRef(job.jobId).padEnd(8),
		(job.tool ?? "tool").padEnd(16),
		(job.state ?? "unknown").padEnd(9),
		clock,
	].join(" ");
}

async function pickDefaultJob(jobsRoot: string): Promise<string | undefined> {
	const jobs = await listJobs(jobsRoot);
	return jobs.find((job) => job.state === "running")?.jobId ?? jobs[0]?.jobId;
}

export async function resolveJobReference(jobsRoot: string, reference: string): Promise<JobReference> {
	const ref = reference.trim();
	if (!ref) return { jobId: await pickDefaultJob(jobsRoot) };
	const jobs = await listJobs(jobsRoot);
	const exact = jobs.find((job) => job.jobId === ref);
	if (exact) return { jobId: exact.jobId };
	if (/^\d+$/.test(ref)) {
		const job = jobs[Number(ref) - 1];
		if (!job) return { error: `没有第 ${ref} 个任务，当前只有 ${jobs.length} 个任务。` };
		return { jobId: job.jobId };
	}
	const lowered = ref.toLowerCase();
	const suffixed = jobs.filter(
		(job) => job.jobId.toLowerCase().endsWith(lowered) || shortJobRef(job.jobId).toLowerCase() === lowered,
	);
	if (suffixed.length === 1) return { jobId: suffixed[0].jobId };
	const contained = jobs.filter((job) => job.jobId.toLowerCase().includes(lowered));
	const matches = suffixed.length > 1 ? suffixed : contained;
	if (matches.length === 1) return { jobId: matches[0].jobId };
	if (matches.length === 0) return { error: `没有匹配「${ref}」的任务，用 /tool-progress list 查看任务。` };
	const candidates = matches.slice(0, 5).map((job) => shortJobRef(job.jobId)).join("、");
	return { error: `「${ref}」匹配到 ${matches.length} 个任务：${candidates}。请给出更长的片段。` };
}

export async function snapshotProgress(options: {
	jobsRoot: string;
	jobId?: string;
	reference?: string;
	limit?: number;
}): Promise<ProgressSnapshot> {
	const limit = options.limit ?? 8;
	let jobId = options.jobId;
	let error: string | undefined;
	if (!jobId) {
		if (options.reference) {
			const resolved = await resolveJobReference(options.jobsRoot, options.reference);
			jobId = resolved.jobId;
			error = resolved.error;
		} else {
			jobId = await pickDefaultJob(options.jobsRoot);
		}
	}
	if (!jobId) return { entries: [], lines: [], error };
	const dir = path.join(options.jobsRoot, jobId);
	const info = await readJobState(path.join(dir, "job.json"));
	const entries = await readProgressEntries(path.join(dir, "progress.jsonl"), MAX_ENTRIES);
	return snapshotFromRecord({ ...info, id: jobId }, entries, limit);
}

export function snapshotFromRecord(info: Partial<JobRecord> & { id: string }, entries: WorkerProgressEntry[], limit = 8): ProgressSnapshot {
	const jobId = info.id;
	const shortId = shortJobRef(jobId);
	const state = info.state === "cancelling" ? "取消中" : info.state === "cancelled" ? "已取消" : info.state ?? "unknown";
	const header = `${info.tool ?? "tool"} · ${state} · ${shortId}`;
	const publicEntries = entries.filter((entry) => !entry.internal);
	const latestEntry = publicEntries.at(-1);
	const phase = info.phase ?? (latestEntry?.kind === "status" ? latestEntry.text : undefined);
	const visible = compactEntries(publicEntries).slice(-limit);
	const elapsed = info.startedAt ? Math.max(0, Math.floor(((info.finishedAt ? Date.parse(info.finishedAt) : Date.now()) - Date.parse(info.startedAt)) / 1000)) : undefined;
	return {
		jobId, shortId, state: info.state, tool: info.tool, entries: visible, phase,
		startedAt: info.startedAt, finishedAt: info.finishedAt, latestEntry,
		lines: [header, ...(phase ? [`${phase}${elapsed !== undefined ? ` · 已运行 ${elapsed} 秒` : ""}`] : []), ...visible.filter((entry) => entry.kind !== "status").map(formatProgressEntry)],
		updatedAt: latestEntry?.time ?? info.heartbeatAt,
	};
}

export type ProgressUpdateSink = (partial: {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}) => void;

export class InlineProgress {
	private readonly entries: string[] = [];
	private readonly ui: ProgressUi;
	private readonly title: string;
	private readonly limit: number;
	private flushTimer?: NodeJS.Timeout;
	private closed = false;
	private readonly key = `${PROGRESS_WIDGET_KEY}:${crypto.randomUUID()}`;

	constructor(options: { ui: ProgressUi; title: string; limit?: number }) {
		this.ui = options.ui;
		this.title = options.title;
		this.limit = options.limit ?? INLINE_LIMIT;
	}

	push(entry: WorkerProgressEntry): void {
		if (this.closed) return;
		this.entries.push(formatProgressEntry(entry));
		if (this.entries.length > this.limit) {
			this.entries.splice(0, this.entries.length - this.limit);
		}
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.render();
		}, INLINE_FLUSH_MS);
		this.flushTimer.unref?.();
	}

	private render(): void {
		if (this.closed) return;
		this.ui.setWidget?.(this.key, [this.title, ...this.entries], { placement: "aboveEditor" });
		this.ui.setStatus?.(this.key, this.title);
	}

	stop(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.ui.setWidget?.(this.key, undefined);
		this.ui.setStatus?.(this.key, undefined);
	}
}

export class ProgressWatcher {
	private timer?: NodeJS.Timeout;
	private clearTimer?: NodeJS.Timeout;
	private readonly jobsRoot: string;
	private readonly ui: ProgressUi;
	private readonly log: (message: string) => void;
	private readonly limit: number;
	private readonly onUpdate?: ProgressUpdateSink;
	private key = "";
	private generation = 0;
	private unsubscribe?: () => void;
	private readonly snapshot?: (jobId: string) => Promise<ProgressSnapshot>;
	private readonly subscribe?: (jobId: string, refresh: () => void) => () => void;

	constructor(options: {
		jobsRoot: string;
		ui: ProgressUi;
		log?: (message: string) => void;
		limit?: number;
		onUpdate?: ProgressUpdateSink;
		snapshot?: (jobId: string) => Promise<ProgressSnapshot>;
		subscribe?: (jobId: string, refresh: () => void) => () => void;
	}) {
		this.jobsRoot = options.jobsRoot;
		this.ui = options.ui;
		this.log = options.log ?? (() => {});
		this.limit = options.limit ?? 8;
		this.onUpdate = options.onUpdate;
		this.snapshot = options.snapshot;
		this.subscribe = options.subscribe;
	}

	start(jobId: string): void {
		if (this.key) this.stopAll(); else this.stop();
		const generation = ++this.generation;
		const key = this.key = `${PROGRESS_WIDGET_KEY}:${jobId}`;
		let completed = false;
		let running = false;
		let pending = false;
		let previous = "";
		let previousEntry = "";
		let previousState: string | undefined;
		const render = async () => {
			while (pending && generation === this.generation && !completed) {
				pending = false;
				const snapshot = this.snapshot ? await this.snapshot(jobId) : await snapshotProgress({ jobsRoot: this.jobsRoot, jobId, limit: this.limit });
				if (generation !== this.generation) return;
				if (!snapshot.state) { this.stopAll(); return; }
				const entry = snapshot.latestEntry ?? snapshot.entries.at(-1);
				const activity = snapshot.state === "cancelling" || TERMINAL_STATES.has(snapshot.state) ? "" : entryKey(entry);
				const signature = JSON.stringify([snapshot.jobId, snapshot.tool, snapshot.state, snapshot.phase, activity]);
				if (signature === previous) continue;
				const terminal = TERMINAL_STATES.has(snapshot.state);
				const stateChange = previousState !== snapshot.state;
				const text = entry && activity !== previousEntry && !terminal && snapshot.state !== "cancelling"
					? formatProgressEntry(entry)
					: snapshot.phase && snapshot.phase !== snapshot.state ? snapshot.phase : snapshot.lines[0];
				previous = signature; previousEntry = activity; previousState = snapshot.state;
				if (this.ui.setWidget) {
					this.ui.setWidget(key, snapshot.lines, { placement: "aboveEditor" });
					if (stateChange) this.ui.setStatus?.(key, `${snapshot.tool ?? "tool"} ${snapshot.state} ${snapshot.shortId ?? ""}`.trim());
				} else {
					this.onUpdate?.({ content: [{ type: "text", text }], details: {
						jobId: snapshot.jobId, shortId: snapshot.shortId, state: snapshot.state, tool: snapshot.tool,
						phase: snapshot.phase, startedAt: snapshot.startedAt, finishedAt: snapshot.finishedAt,
					} });
				}
				if (terminal) {
					completed = true;
					if (snapshot.state === "cancelled") this.ui.notify?.(`${snapshot.tool} ${snapshot.shortId} 已取消，任务子进程已回收。`, "info");
					this.stopTimer();
					if (this.ui.setWidget) this.clearTimer = setTimeout(() => {
						if (generation !== this.generation) return;
						this.ui.setWidget?.(key, undefined); this.ui.setStatus?.(key, undefined);
					}, 4000);
				}
			}
		};
		const refresh = () => {
			if (generation !== this.generation || completed) return;
			pending = true;
			if (running) return;
			running = true;
			void render().catch((error) => this.log(`progress render failed: ${String(error)}`)).finally(() => {
				running = false;
				if (pending) refresh();
			});
		};
		this.unsubscribe = this.subscribe?.(jobId, refresh);
		if (!this.subscribe) {
			this.timer = setInterval(refresh, 1000);
			this.timer.unref?.();
		}
		refresh();
	}

	private stopTimer(): void {
		this.unsubscribe?.(); this.unsubscribe = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	stop(): void {
		this.generation++;
		this.stopTimer();
		if (this.clearTimer) clearTimeout(this.clearTimer);
		this.clearTimer = undefined;
	}

	stopAll(): void {
		this.stop();
		if (this.ui.setWidget) {
			this.ui.setWidget(this.key, undefined);
			this.ui.setStatus?.(this.key, undefined);
		}
	}
}
