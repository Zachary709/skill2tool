import type { JsonSchema, ToolManifest } from "../types.ts";

export const TASK_INPUT_DESCRIPTION = "直接写用户任务及必要条件，不扩写工具规则。";

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
	const guidelines = (manifest.whenToUse ?? []).map((rule) => `${manifest.name}: ${rule}`);
	const fields = manifest.kind === "agent" ? taskFields(manifest.input) : [];
	if (fields.length > 0) {
		guidelines.push(
			`${manifest.name} 的 ${fields.join("、")} 在用户任务完整时直接使用任务原句，禁止扩写为操作指南；仅补 worker 无法自行取得的必要背景、路径及用户明确条件和授权限制，不得新增任务范围、步骤、核实、输出或安全要求。工具已有流程由 worker 执行。`,
		);
	}
	return guidelines;
}
