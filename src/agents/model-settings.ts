import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../types.ts";

type ThinkingLevel = NonNullable<AgentConfig["thinkingLevel"]>;

export function resolveWorkerThinking(
	model: Model<Api>,
	preferred: ThinkingLevel | undefined,
	caller: ThinkingLevel | undefined,
) {
	if (preferred === undefined) return { thinkingLevel: caller, fallbackReason: undefined };
	if (getSupportedThinkingLevels(model).includes(preferred)) {
		return { thinkingLevel: preferred, fallbackReason: undefined };
	}
	return {
		thinkingLevel: caller,
		fallbackReason: `${model.provider}/${model.id} does not advertise support for thinking level ${preferred}; using caller settings`,
	};
}

export function isUnsupportedThinkingError(message: string): boolean {
	return /(?:reasoning(?:[._\s-]+effort)?|thinking(?:[._\s-]+(?:level|budget))?)[^\n]{0,160}(?:unsupported|not supported|does not support|must be|only supports|allowed values)/i.test(message) ||
		/(?:unsupported|unknown|invalid)[^\n]{0,100}(?:reasoning(?:[._\s-]+effort)?|thinking(?:[._\s-]+(?:level|budget))?)/i.test(message);
}
