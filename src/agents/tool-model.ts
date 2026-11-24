import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../types.ts";

export const DEFAULT_TOOL_MODEL = "lqy-阿里云节省计划/deepseek-v4.1-flash-1017";
export const TOOL_CONFIG_FILE = "tool-runtime.json";

export type ToolThinkingLevel = NonNullable<AgentConfig["thinkingLevel"]>;

const THINKING_LEVELS: readonly ToolThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ToolModelSelection {
	model: string;
	thinkingLevel?: ToolThinkingLevel;
	source: "env" | "config" | "default";
	path: string;
}

export interface ToolModelChoice {
	model: string;
	thinkingLevel?: ToolThinkingLevel;
}

export function toolConfigPath(agentDir: string): string {
	return path.join(agentDir, TOOL_CONFIG_FILE);
}

export function parseToolModel(value: string): { model: string; provider: string; id: string } {
	const model = value.trim();
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) {
		throw new Error(`模型必须写成 provider/model 或模型 id：${value}`);
	}
	return { model, provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function parseThinkingLevel(value: unknown, filePath: string): ToolThinkingLevel {
	if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ToolThinkingLevel)) {
		throw new Error(`${filePath}: thinkingLevel 必须是 ${THINKING_LEVELS.join("、")} 之一`);
	}
	return value as ToolThinkingLevel;
}

async function readConfig(filePath: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${filePath} 必须是 JSON 对象`);
	}
	return parsed as Record<string, unknown>;
}

async function writeConfig(filePath: string, agentDir: string, config: Record<string, unknown>): Promise<void> {
	if (Object.keys(config).length === 0) {
		await fs.rm(filePath, { force: true });
		return;
	}
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function readToolModel(agentDir: string): Promise<ToolModelSelection> {
	const filePath = toolConfigPath(agentDir);
	const config = await readConfig(filePath);
	const thinkingLevel = config.thinkingLevel === undefined
		? undefined
		: parseThinkingLevel(config.thinkingLevel, filePath);
	const fromEnv = process.env.PI_TOOL_MODEL?.trim();
	if (fromEnv) return { model: parseToolModel(fromEnv).model, thinkingLevel, source: "env", path: filePath };
	if (config.model === undefined) return { model: DEFAULT_TOOL_MODEL, thinkingLevel, source: "default", path: filePath };
	if (typeof config.model !== "string") throw new Error(`${filePath}: model 必须是 provider/model 字符串`);
	return { model: parseToolModel(config.model).model, thinkingLevel, source: "config", path: filePath };
}

export async function writeToolModel(agentDir: string, choice: ToolModelChoice | undefined): Promise<ToolModelChoice> {
	const filePath = toolConfigPath(agentDir);
	const config = await readConfig(filePath);
	if (choice === undefined) {
		delete config.model;
		delete config.thinkingLevel;
		await writeConfig(filePath, agentDir, config);
		return { model: DEFAULT_TOOL_MODEL };
	}
	const model = parseToolModel(choice.model).model;
	config.model = model;
	if (choice.thinkingLevel === undefined) delete config.thinkingLevel;
	else config.thinkingLevel = parseThinkingLevel(choice.thinkingLevel, filePath);
	await writeConfig(filePath, agentDir, config);
	return { model, thinkingLevel: choice.thinkingLevel };
}