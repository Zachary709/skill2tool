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
	state?: string;
	tool?: string;
	entries: WorkerProgressEntry[];
	lines: string[];
	updatedAt?: string;
}

export const PROGRESS_WIDGET_KEY = "tool-progress";
export const PROGRESS_STATUS_KEY = "tool-progress";
const MAX_ENTRIES = 60;

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

export async function listJobs(
	jobsRoot: string,
): Promise<Array<{ jobId: string; state?: string; tool?: string; createdAt?: string }>> {
	let names: string[];
	try {
		names = await fs.readdir(jobsRoot);
	} catch {
		return [];
	}
	const jobs: Array<{ jobId: string; state?: string; tool?: string; createdAt?: string }> = [];
	for (const name of names) {
		if (!name.startsWith("job_")) continue;
		const info = await readJobState(path.join(jobsRoot, name, "job.json"));
		jobs.push({ jobId: name, ...info });
	}
	return jobs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export async function snapshotProgress(options: {
	jobsRoot: string;
	jobId?: string;
	limit?: number;
}): Promise<ProgressSnapshot> {
	const limit = options.limit ?? 8;
	let jobId = options.jobId;
	if (!jobId) {
		const jobs = await listJobs(options.jobsRoot);
		jobId = jobs.find((job) => job.state === "running")?.jobId ?? jobs[0]?.jobId;
	}
	if (!jobId) return { entries: [], lines: [] };
	const dir = path.join(options.jobsRoot, jobId);
	const info = await readJobState(path.join(dir, "job.json"));
	const entries = await readProgressEntries(path.join(dir, "progress.jsonl"), limit);
	const header = `${info.tool ?? "tool"} ${jobId} · ${info.state ?? "unknown"}`;
	return {
		jobId,
		state: info.state,
		tool: info.tool,
		entries,
		lines: entries.length > 0 ? [header, ...entries.map(formatProgressEntry)] : [header, "（尚无进展记录）"],
		updatedAt: entries[entries.length - 1]?.time,
	};
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);

export type ProgressUpdateSink = (partial: {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}) => void;

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
			if (snapshot.lines.length === 0) return;
			this.ui.setWidget?.(PROGRESS_WIDGET_KEY, snapshot.lines, { placement: "aboveEditor" });
			this.onUpdate?.({
				content: [{ type: "text", text: snapshot.lines.join("\n") }],
				details: { jobId: snapshot.jobId, state: snapshot.state, tool: snapshot.tool },
			});
			this.ui.setStatus?.(
				PROGRESS_STATUS_KEY,
				`${snapshot.tool ?? "tool"} ${snapshot.state ?? ""}`.trim(),
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
