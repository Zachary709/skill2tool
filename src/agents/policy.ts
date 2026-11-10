import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentContextConfig, JsonSchema } from "../types.ts";

export const DEFAULT_AGENT_CONTEXT = {
	budgetTokens: 272_000,
	keepRecentTokens: 6_000,
} as const;

export const AGENT_CONTEXT_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		budgetTokens: { type: "integer", minimum: 2 },
		keepRecentTokens: { type: "integer", minimum: 1 },
	},
	additionalProperties: false,
};

export function resolveAgentContext(config: AgentContextConfig = {}): Required<AgentContextConfig> {
	const budgetTokens = config.budgetTokens ?? DEFAULT_AGENT_CONTEXT.budgetTokens;
	const keepRecentTokens = config.keepRecentTokens ?? Math.min(
		DEFAULT_AGENT_CONTEXT.keepRecentTokens,
		Math.max(1, Math.floor(budgetTokens / 4)),
	);
	if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 2) {
		throw new Error("agent.context.budgetTokens must be a safe integer of at least 2");
	}
	if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 1 || keepRecentTokens >= budgetTokens) {
		throw new Error("agent.context.keepRecentTokens must be positive and smaller than budgetTokens");
	}
	return { budgetTokens, keepRecentTokens };
}

export function compactionForModel(model: Model<Api>, config: Required<AgentContextConfig>) {
	const budgetTokens = Math.min(config.budgetTokens, model.contextWindow);
	if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 2) {
		throw new Error(`Invalid context window for ${model.provider}/${model.id}`);
	}
	return {
		reserveTokens: model.contextWindow - budgetTokens,
		keepRecentTokens: Math.min(config.keepRecentTokens, Math.max(1, Math.floor(budgetTokens / 2))),
	};
}
