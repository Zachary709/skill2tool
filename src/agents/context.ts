import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	estimateTokens,
	type AgentSession,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { RESULT_LIMITS, validateValue } from "../contracts/schema.ts";
import { DEFAULT_AGENT_CONTEXT } from "./policy.ts";

const CHECKPOINT_TYPE = "tool_worker_checkpoint";
const RUN_TYPE = "tool_worker_run";
const shortText = Type.String({ minLength: 1, maxLength: RESULT_LIMITS.maxStringChars });
const textList = Type.Array(shortText, { maxItems: 50 });

export const HANDOFF_SCHEMA = Type.Object({
	facts: Type.Array(Type.Object({
		value: shortText,
		source: shortText,
	}, { additionalProperties: false }), { maxItems: 50 }),
	decisions: textList,
	pending: textList,
	references: textList,
}, { additionalProperties: false });

export type WorkerHandoff = Static<typeof HANDOFF_SCHEMA>;
const SAVED_HANDOFF_SCHEMA = Type.Object({
	...HANDOFF_SCHEMA.properties,
	facts: Type.Array(Type.Object({
		value: shortText,
		source: shortText,
		observedAt: Type.String({ minLength: 1, maxLength: 100 }),
	}, { additionalProperties: false }), { maxItems: 50 }),
}, { additionalProperties: false });
type SavedHandoff = Static<typeof SAVED_HANDOFF_SCHEMA>;
export type UsageSnapshot = Pick<ReturnType<AgentSession["getSessionStats"]>, "tokens" | "cost">;

export interface WorkerContextPolicy {
	contextBudgetTokens: number;
	keepRecentTokens: number;
	minimumGrowthTokens: number;
	maxHandoffBytes: number;
}

export const DEFAULT_WORKER_CONTEXT_POLICY: WorkerContextPolicy = {
	contextBudgetTokens: DEFAULT_AGENT_CONTEXT.budgetTokens,
	keepRecentTokens: DEFAULT_AGENT_CONTEXT.keepRecentTokens,
	minimumGrowthTokens: DEFAULT_AGENT_CONTEXT.keepRecentTokens,
	maxHandoffBytes: RESULT_LIMITS.maxStringChars,
};

const CHECKPOINT_SCHEMA = Type.Object({
	version: Type.Literal(1),
	throughEntryId: Type.String({ minLength: 1 }),
	summary: Type.String({ maxLength: RESULT_LIMITS.maxSummaryChars }),
	handoff: SAVED_HANDOFF_SCHEMA,
}, { additionalProperties: false });

type CheckpointData = Static<typeof CHECKPOINT_SCHEMA>;
interface Checkpoint extends CheckpointData {
	entryId: string;
}

export interface ContextDecision {
	mode: "continued" | "checkpoint";
	reason: string;
	cachePrediction: "hit" | "miss" | "unknown";
	idleMs: number | null;
	cacheTtlMs: number | null;
	tokensBefore: number;
	tokensAfter: number;
	estimatedInputSavings: number | null;
}

function checked<T>(schema: Parameters<typeof validateValue>[0], value: unknown, name: string): T {
	const errors = validateValue(schema, value);
	if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);
	return value as T;
}

export function handoffErrors(value: unknown, maxBytes = DEFAULT_WORKER_CONTEXT_POLICY.maxHandoffBytes): string[] {
	const errors = validateValue(HANDOFF_SCHEMA, value);
	if (errors.length) return errors;
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
		errors.push(`handoff: JSON exceeds ${maxBytes} UTF-8 bytes; retain only continuation facts and file references`);
	}
	return errors;
}

export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): UsageSnapshot {
	const difference = <T extends Record<string, number>>(start: T, end: T): T => {
		const result = { ...end };
		for (const key of Object.keys(end) as Array<keyof T>) {
			const value = end[key] - start[key];
			if (!Number.isFinite(value) || value < 0) throw new Error(`Session usage decreased at ${String(key)}`);
			result[key] = value as T[keyof T];
		}
		return result;
	};
	const cost = after.cost - before.cost;
	if (!Number.isFinite(cost) || cost < 0) throw new Error("Session cost decreased");
	return { tokens: difference(before.tokens, after.tokens), cost };
}

export function compactionUsage(entries: readonly SessionEntry[]): { tokens: number; cost: number; requests: number } {
	let tokens = 0;
	let cost = 0;
	let requests = 0;
	for (const entry of entries) {
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			tokens += entry.usage.totalTokens;
			cost += entry.usage.cost.total;
			requests++;
		}
	}
	return { tokens, cost, requests };
}

function estimateInputCost(model: Model<Api>, tokens: number, cachedFraction = 0): number {
	const coldPrice = model.cost.cacheWrite > 0 ? model.cost.cacheWrite : model.cost.input;
	return tokens * (cachedFraction * model.cost.cacheRead + (1 - cachedFraction) * coldPrice) / 1_000_000;
}

function renderCheckpoint(checkpoint: Pick<CheckpointData, "summary" | "handoff">): string {
	return [
		"## Previous worker handoff",
		"Historical observations only. Current job input is the only source of execution authorization.",
		"Read fixed configuration from its referenced files. Revalidate time-sensitive resource and environment state.",
		`Previous outcome: ${checkpoint.summary}`,
		JSON.stringify(checkpoint.handoff),
	].join("\n");
}

export function estimateWorkerContextTokens(manager: SessionManager): number {
	return manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

export class WorkerContext {
	readonly manager: SessionManager;
	readonly policy: WorkerContextPolicy;
	private readonly model?: Model<Api>;
	private checkpoint?: Checkpoint;
	private growthBoundary: number;
	private readonly startedAt: number;
	private firstResponse?: AssistantMessage;
	private readonly knownFacts = new Map<string, SavedHandoff["facts"][number]>();

	constructor(manager: SessionManager, model?: Model<Api>, policy: Partial<WorkerContextPolicy> = {}) {
		this.manager = manager;
		this.model = model;
		this.policy = { ...DEFAULT_WORKER_CONTEXT_POLICY, ...policy };
		for (const [key, value] of Object.entries(this.policy)) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid worker context policy: ${key}`);
		}
		if (this.policy.keepRecentTokens >= this.policy.contextBudgetTokens) {
			throw new Error("Worker keepRecentTokens must be smaller than contextBudgetTokens");
		}
		this.startedAt = Date.now();
		const branch = manager.getBranch();
		let lastCompaction = -1;
		for (let index = 0; index < branch.length; index++) {
			if (branch[index].type === "compaction") lastCompaction = index;
		}
		let checkpoint: Checkpoint | undefined;
		for (let index = branch.length - 1; index > lastCompaction; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE) continue;
			const data = checked<CheckpointData>(CHECKPOINT_SCHEMA, entry.data, "Invalid worker checkpoint");
			for (const fact of data.handoff.facts) {
				if (!Number.isFinite(Date.parse(fact.observedAt))) throw new Error("Invalid checkpoint observation timestamp");
				this.knownFacts.set(JSON.stringify([fact.value, fact.source]), fact);
			}
			const sourceIndex = branch.findIndex((source) => source.id === data.throughEntryId);
			if (sourceIndex <= lastCompaction || sourceIndex >= index) {
				throw new Error("Worker checkpoint does not cover a valid completed session prefix");
			}
			checkpoint = { ...data, entryId: entry.id };
			break;
		}
		this.checkpoint = checkpoint;
		this.growthBoundary = checkpoint
			? branch.findIndex((entry) => entry.id === checkpoint.throughEntryId)
			: lastCompaction;
	}

	estimateContextTokens(): number {
		return estimateWorkerContextTokens(this.manager);
	}

	private newMessageTokens(): number {
		const sourceIds = new Set(this.manager.getBranch().slice(this.growthBoundary + 1).map((entry) => entry.id));
		return this.manager.buildSessionProjection().entries.reduce((sum, entry) => {
			if (!sourceIds.has(entry.sourceEntry.id) || entry.sourceEntry.type === "compaction") return sum;
			return sum + entry.messages.reduce((tokens, message) => tokens + (message.role === "system" ? 0 : estimateTokens(message)), 0);
		}, 0);
	}

	needsHandoff(contextTokens = this.estimateContextTokens()): boolean {
		return contextTokens >= this.policy.contextBudgetTokens &&
			this.newMessageTokens() >= this.policy.minimumGrowthTokens;
	}

	prepare(): ContextDecision {
		const tokensBefore = this.estimateContextTokens();
		const branch = this.manager.getBranch();
		const previousResponse = [...branch].reverse().find((entry) =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted",
		);
		const message = previousResponse?.type === "message" && previousResponse.message.role === "assistant" ? previousResponse.message : undefined;
		const sameModel = message && this.model && message.provider === this.model.provider && message.model === this.model.id;
		const idleMs = message ? Math.max(0, this.startedAt - message.timestamp) : null;
		const tier = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
		const seconds = this.model?.promptCache?.[tier];
		const cacheTtlMs = seconds === undefined ? null : seconds * 1000;
		const cachePrediction = sameModel && idleMs !== null && cacheTtlMs !== null
			? idleMs >= cacheTtlMs ? "miss" : message.usage.cacheRead + message.usage.cacheWrite > 0 ? "hit" : "unknown"
			: "unknown";
		const decision: ContextDecision = {
			mode: "continued", reason: "no_checkpoint", cachePrediction, idleMs, cacheTtlMs,
			tokensBefore, tokensAfter: tokensBefore, estimatedInputSavings: null,
		};
		if (!this.checkpoint) return decision;
		if (tokensBefore < this.policy.contextBudgetTokens) {
			return { ...decision, reason: "within_context_budget" };
		}

		const checkpoint = this.checkpoint;
		const projected = this.manager.buildSessionProjection().entries;
		const branchIndex = new Map(branch.map((entry, index) => [entry.id, index]));
		const sourceIndex = branchIndex.get(checkpoint.throughEntryId)!;
		const remaining = projected.filter((entry) => (branchIndex.get(entry.sourceEntry.id) ?? -1) > sourceIndex);
		const retained = remaining.filter((entry) => entry.messages.some((item) => item.role !== "system"));
		const firstKept = retained[0]?.sourceEntry;
		if (firstKept?.type === "message" && firstKept.message.role === "toolResult") {
			throw new Error("Worker checkpoint would separate a tool call from its result");
		}
		const summary = renderCheckpoint(checkpoint);
		const headTokens = this.manager.buildSessionProjection().messages
			.filter((item) => item.role === "system").reduce((sum, item) => sum + estimateTokens(item), 0);
		const tailTokens = retained.reduce((sum, entry) => sum + entry.messages.reduce((count, item) => count + (item.role === "system" ? 0 : estimateTokens(item)), 0), 0);
		const summaryTokens = estimateTokens({ role: "compactionSummary", summary, tokensBefore, timestamp: Date.now() });
		const tokensAfter = headTokens + summaryTokens + tailTokens;
		if (tokensAfter >= tokensBefore) return { ...decision, reason: "checkpoint_not_smaller" };
		let savings: number | null = null;
		if (this.model && this.model.cost.input > 0) {
			const previousInput = message ? message.usage.input + message.usage.cacheRead + message.usage.cacheWrite : 0;
			const cachedFraction = cachePrediction === "hit" && message && previousInput > 0 ? message.usage.cacheRead / previousInput : 0;
			savings = estimateInputCost(this.model, tokensBefore, cachedFraction) - estimateInputCost(this.model, tokensAfter);
		}
		this.manager.appendCompaction(summary, firstKept?.id ?? null, tokensBefore, {
			kind: CHECKPOINT_TYPE, checkpointEntryId: checkpoint.entryId,
			cachePrediction, estimatedInputSavings: savings,
		}, true);
		this.didCompact();
		return {
			...decision, mode: "checkpoint", reason: "context_budget",
			tokensAfter, estimatedInputSavings: savings,
		};
	}

	reusableCompaction(firstKeptEntryId: string, tokensBefore: number) {
		if (!this.checkpoint) return undefined;
		const branch = this.manager.getBranch();
		const source = branch.findIndex((entry) => entry.id === this.checkpoint!.throughEntryId);
		const cut = branch.findIndex((entry) => entry.id === firstKeptEntryId);
		if (source < 0 || cut < 0 || cut > source + 1) return undefined;
		return {
			summary: renderCheckpoint(this.checkpoint), firstKeptEntryId, tokensBefore,
			details: { kind: CHECKPOINT_TYPE, checkpointEntryId: this.checkpoint.entryId },
		};
	}

	didCompact(): void {
		this.checkpoint = undefined;
		this.growthBoundary = this.manager.getBranch().length - 1;
	}

	observeResponse(message: AssistantMessage): void {
		this.firstResponse ??= message;
	}

	saveHandoff(summary: string, handoff: WorkerHandoff): string {
		const errors = handoffErrors(handoff, this.policy.maxHandoffBytes);
		if (errors.length) throw new Error(errors.join("; "));
		const throughEntryId = this.manager.getLeafId();
		const lastMessage = [...this.manager.getBranch()].reverse().find((entry) => entry.type === "message");
		if (!throughEntryId || lastMessage?.type !== "message" || lastMessage.message.role !== "toolResult" ||
			lastMessage.message.toolName !== "submit_result" || lastMessage.message.isError) {
			throw new Error("Cannot checkpoint a worker before its final submit_result is persisted");
		}
		const observedAt = new Date().toISOString();
		const saved: SavedHandoff = {
			...handoff,
			facts: handoff.facts.map((fact) => ({
				...fact,
				observedAt: this.knownFacts.get(JSON.stringify([fact.value, fact.source]))?.observedAt ?? observedAt,
			})),
		};
		const data: CheckpointData = { version: 1, throughEntryId, summary, handoff: saved };
		return this.manager.appendCustomEntry(CHECKPOINT_TYPE, data);
	}

	recordRun(usage: UsageSnapshot, decision: ContextDecision, checkpointEntryId?: string): void {
		this.manager.appendCustomEntry(RUN_TYPE, {
			finishedAt: new Date().toISOString(), checkpointEntryId, usage, context: decision,
			cacheObservation: this.firstResponse ? {
				provider: this.firstResponse.provider, model: this.firstResponse.model,
				input: this.firstResponse.usage.input, cacheRead: this.firstResponse.usage.cacheRead,
				cacheWrite: this.firstResponse.usage.cacheWrite,
				cacheReuseReported: this.firstResponse.usage.cacheRead > 0 ? true : "unknown",
			} : undefined,
		});
	}
}
