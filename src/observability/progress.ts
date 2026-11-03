import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { WorkerProgressEntry } from "../agents/worker.ts";

export type ProgressWidgetPlacement = "aboveEditor" | "belowEditor";

export interface ProgressUi {
	setWidget?: (key: string, content: string[] | undefined, options?: { placement?: ProgressWidgetPlacement }) => void;
	setStatus?: (key: string, text: string | undefined) => void;
}

export interface ProgressSnapshot {
	jobId?: string;
	shortId?: string;
	state?: string;
	tool?: string;
	entries: WorkerProgressEntry[];
	lines: string[];
	updatedAt?: string;
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
	return parts.length > 0 ? parts[parts.length - 1] : jobId;
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
		case "text":
			return "说明";
		case "tool":
			return "调用";
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
	const line = text.length > 160 ? `${text.slice(0, 160)}…` : text;
	return `${clock} [${marker(entry)}]${tool} ${line}`;
}

export async function readProgressEntries(filePath: string, limit = 8): Promise<WorkerProgressEntry[]> {
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch {
		return [];
	}
	const lines = text.split("\n").filter((line) => line.trim());
	const entries: WorkerProgressEntry[] = [];
	for (const line of lines.slice(-MAX_ENTRIES)) {
		try {
			entries.push(JSON.parse(line) as WorkerProgressEntry);
		} catch {
			// a partially written trailing line is skipped
		}
	}
	return entries.slice(-limit);
}

async function readJobState(jobPath: string): Promise<{ state?: string; tool?: string; createdAt?: string; jobId?: string }> {
	try {
		const raw = JSON.parse(await fs.readFile(jobPath, "utf8")) as {
			state?: string;
			tool?: string;
			createdAt?: string;
			id?: string;
		};
		return { state: raw.state, tool: raw.tool, createdAt: raw.createdAt, jobId: raw.id };
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
	const entries = await readProgressEntries(path.join(dir, "progress.jsonl"), limit);
	const shortId = shortJobRef(jobId);
	const header = `${info.tool ?? "tool"} · ${info.state ?? "unknown"} · ${shortId}`;
	return {
		jobId,
		shortId,
		state: info.state,
		tool: info.tool,
		entries,
		lines: entries.length > 0 ? [header, ...entries.map(formatProgressEntry)] : [header, "（尚无进展记录）"],
		updatedAt: entries[entries.length - 1]?.time,
		error,
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
		this.ui.setWidget?.(PROGRESS_WIDGET_KEY, [this.title, ...this.entries], { placement: "aboveEditor" });
		this.ui.setStatus?.(PROGRESS_STATUS_KEY, this.title);
	}

	stop(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.ui.setWidget?.(PROGRESS_WIDGET_KEY, undefined);
		this.ui.setStatus?.(PROGRESS_STATUS_KEY, undefined);
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

	constructor(options: {
		jobsRoot: string;
		ui: ProgressUi;
		log?: (message: string) => void;
		limit?: number;
		onUpdate?: ProgressUpdateSink;
	}) {
		this.jobsRoot = options.jobsRoot;
		this.ui = options.ui;
		this.log = options.log ?? (() => {});
		this.limit = options.limit ?? 8;
		this.onUpdate = options.onUpdate;
	}

	start(jobId: string): void {
		this.stop();
		const render = async () => {
			const snapshot = await snapshotProgress({ jobsRoot: this.jobsRoot, jobId, limit: this.limit });
			if (!snapshot.state) {
				this.stopAll();
				return;
			}
			if (snapshot.lines.length === 0) return;
			this.ui.setWidget?.(PROGRESS_WIDGET_KEY, snapshot.lines, { placement: "aboveEditor" });
			this.onUpdate?.({
				content: [{ type: "text", text: snapshot.lines.join("\n") }],
				details: {
					jobId: snapshot.jobId,
					shortId: snapshot.shortId,
					state: snapshot.state,
					tool: snapshot.tool,
				},
			});
			this.ui.setStatus?.(
				PROGRESS_STATUS_KEY,
				`${snapshot.tool ?? "tool"} ${snapshot.state ?? ""} ${snapshot.shortId ?? ""}`.trim(),
			);
			if (snapshot.state && TERMINAL_STATES.has(snapshot.state)) {
				this.stopTimer();
				this.clearTimer = setTimeout(() => {
					this.ui.setWidget?.(PROGRESS_WIDGET_KEY, undefined);
					this.ui.setStatus?.(PROGRESS_STATUS_KEY, undefined);
				}, 4000);
			}
		};
		void render();
		this.timer = setInterval(() => {
			void render().catch((error) => this.log(`progress render failed: ${String(error)}`));
		}, 1000);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	stop(): void {
		this.stopTimer();
		if (this.clearTimer) clearTimeout(this.clearTimer);
		this.clearTimer = undefined;
	}

	stopAll(): void {
		this.stop();
		this.ui.setWidget?.(PROGRESS_WIDGET_KEY, undefined);
		this.ui.setStatus?.(PROGRESS_STATUS_KEY, undefined);
	}
}
