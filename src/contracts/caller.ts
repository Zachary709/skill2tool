import type { JsonSchema, ToolManifest } from "../types.ts";

export const TASK_INPUT_DESCRIPTION = "本轮目标及新增条件；已有背景和配置只给引用。";

function taskFields(input: JsonSchema): string[] {
	return ["request", "task"].filter((name) => {
		const field = input.properties?.[name];
		return field?.type === "string" && field.enum === undefined && field.const === undefined &&
			field.format === undefined && field.pattern === undefined && field.contentMediaType === undefined;
	});
}

export function compactTaskInputSchema(input: JsonSchema): JsonSchema {
	const fields = taskFields(input);
	if (fields.length === 0) return input;
	const properties = { ...input.properties };
	for (const name of fields) {
		properties[name] = { ...properties[name], description: TASK_INPUT_DESCRIPTION };
	}
	return { ...input, properties };
}

export function callerPromptGuidelines(manifest: ToolManifest): string[] {
	const guidelines = [
		...(manifest.whenToUse ?? []).map((rule) => `${manifest.name}: ${rule}`),
		...(manifest.notFor ?? []).map((rule) => `${manifest.name} 不用于：${rule}`),
	];
	const fields = manifest.kind === "agent" ? taskFields(manifest.input) : [];
	if (fields.length > 0) {
		guidelines.push(
			`${manifest.name} 的 ${fields.join("、")} 通常只需一句“本轮动作、明确对象、必要新增条件”。已有任务仅给足以唯一定位的最少入口，用任务标识或文件路径引用；不要罗列相关文档和记录。未变更的输入、配置和资源约束由 worker 继承，不复述参数值，也不追加“沿用、保持既定设置”等确认句。`,
			`${manifest.name} 的 ${fields.join("、")} 必须消解指代，但不照抄用户消息，不复述 worker 已知历史、文件内容或固定参数。不得新增用户未要求的检查、步骤、输出指标、格式或限制；仅补 worker 确实无法取得的新事实，保留本轮授权限制。`,
		);
	}
	return guidelines;
}
