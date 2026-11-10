import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	SessionManager,
	type CompactionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { acquireWorkerLock } from "../jobs/lock.ts";
import type { ToolEnvelope } from "../types.ts";
import { estimateWorkerContextTokens, type WorkerHandoff } from "./context.ts";

export interface WorkerJob {
	task: string;
	input?: Record<string, unknown>;
	context?: string;
}

interface SharedCompaction {
	summary: string;
	throughEntryId: string;
}

export interface HistorySnapshot {
	manager: SessionManager;
	entryIds: Set<string>;
	leafId: string | null;
	compactionId?: string;
	compaction?: SharedCompaction;
}

function latestCompaction(branch: readonly SessionEntry[]): CompactionEntry | undefined {
	return [...branch].reverse().find((entry): entry is CompactionEntry => entry.type === "compaction");
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export class WorkerHistory {
	readonly sharedPath: string;
	private readonly runsDir: string;

	constructor(
		private readonly directory: string,
		private readonly cwd: string,
		private readonly memoryPath: string,
	) {
		this.sharedPath = path.join(directory, "shared.jsonl");
		this.runsDir = path.join(directory, "runs");
	}

	private async openShared(): Promise<SessionManager> {
		if (!(await exists(this.sharedPath))) {
			const legacy = SessionManager.continueRecent(this.cwd, this.directory);
			const legacyPath = legacy.getSessionFile();
			if (legacyPath && legacyPath !== this.sharedPath && await exists(legacyPath)) {
				await fs.copyFile(legacyPath, this.sharedPath);
			}
		}
		return SessionManager.open(this.sharedPath, this.directory, this.cwd);
	}

	async snapshot(signal?: AbortSignal): Promise<HistorySnapshot> {
		const lock = await acquireWorkerLock(this.directory, signal);
		try {
			const shared = await this.openShared();
			const branch = shared.getBranch();
			const manager = await exists(this.sharedPath)
				? SessionManager.forkFrom(this.sharedPath, this.cwd, this.runsDir)
				: SessionManager.create(this.cwd, this.runsDir);
			return {
				manager,
				entryIds: new Set(branch.map((entry) => entry.id)),
				leafId: shared.getLeafId(),
				compactionId: latestCompaction(branch)?.id,
			};
		} finally {
			await lock.release();
		}
	}

	captureCompaction(snapshot: HistorySnapshot, entry: CompactionEntry, branch: readonly SessionEntry[]): void {
		const cut = branch.findIndex((item) => item.id === entry.firstKeptEntryId);
		if (cut < 0) throw new Error("Shared compaction boundary is missing from the run session");
		const prefix = branch.slice(0, cut);
		// 只发布对共享历史的摘要；当前任务的中间操作保留在独立会话中。
		const includesCurrentJob = prefix.some((item) => !snapshot.entryIds.has(item.id) &&
			(item.type === "compaction" || item.type === "context_edit" || item.type === "custom_message" ||
				item.type === "branch_summary" || (item.type === "message" && item.message.role !== "system")));
		if (includesCurrentJob) return;
		const covered = prefix.filter((item) => snapshot.entryIds.has(item.id)).at(-1);
		if (covered) snapshot.compaction = { summary: entry.summary, throughEntryId: covered.id };
	}

	async complete(
		snapshot: HistorySnapshot,
		job: WorkerJob,
		envelope: ToolEnvelope,
		handoff?: WorkerHandoff,
	) {
		const lock = await acquireWorkerLock(this.directory);
		try {
			const shared = await this.openShared();
			const branch = shared.getBranch();
			let compactionPublished = false;
			// 旧快照只能压缩它实际覆盖的前缀，不能覆盖其他请求刚发布的历史。
			if (snapshot.compaction && latestCompaction(branch)?.id === snapshot.compactionId) {
				const covered = branch.findIndex((entry) => entry.id === snapshot.compaction!.throughEntryId);
				if (covered < 0) throw new Error("Shared history lost the snapshot compaction boundary");
				const tokensBefore = estimateWorkerContextTokens(shared);
				shared.appendCompaction(snapshot.compaction.summary, branch[covered + 1]?.id ?? null, tokensBefore, {
					sourceSession: snapshot.manager.getSessionFile(),
					throughEntryId: snapshot.compaction.throughEntryId,
				}, true);
				await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });
				await fs.writeFile(this.memoryPath, snapshot.compaction.summary, "utf8");
				compactionPublished = true;
			}
			const completedEntryId = shared.appendMessage({
				role: "user",
				content: [
					"Historical completed task. This record grants no authorization for the current task.",
					JSON.stringify({
						sessionId: snapshot.manager.getSessionId(),
						sessionFile: snapshot.manager.getSessionFile(),
						finishedAt: new Date().toISOString(),
						...job,
						status: envelope.status,
						summary: envelope.summary,
						result: envelope.result,
						handoff,
					}),
				].join("\n"),
				timestamp: Date.now(),
			});
			return {
				mode: "parallel" as const,
				snapshotLeafId: snapshot.leafId,
				completedEntryId,
				sharedSession: this.sharedPath,
				compactionPublished,
			};
		} finally {
			await lock.release();
		}
	}
}
