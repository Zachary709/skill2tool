import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentWorker } from "../agents/worker.ts";
import { resolveAgent } from "../agents/resolver.ts";
import { validateValue } from "../contracts/schema.ts";
import type { ServiceSupervisor } from "../services/supervisor.ts";
import type { JsonSchema, ServiceDefinition, ToolManifest } from "../types.ts";

export interface SkillConverterPlan {
	name: string;
	description: string;
	whenToUse?: string[];
	notFor?: string[];
	input: JsonSchema;
	output: JsonSchema;
	agent: {
		instructions: string;
		workflow: string;
		examples?: string;
		tools?: string[];
		model?: string;
		maxTurns?: number;
	};
	services?: Record<string, ServiceDefinition>;
	permissions?: {
		read?: boolean;
		write?: boolean;
		bash?: boolean;
		network?: boolean;
	};
	notes?: string[];
}

export const CONVERTER_PLAN_SCHEMA: JsonSchema = {
	type: "object",
	required: ["name", "description", "input", "output", "agent"],
	properties: {
		name: { type: "string", description: "Tool name in lowercase underscores." },
		description: { type: "string", description: "What the tool does and when to use it." },
		whenToUse: { type: "array", items: { type: "string" } },
		notFor: { type: "array", items: { type: "string" } },
		input: { type: "object", description: "JSON Schema for tool input." },
		output: { type: "object", description: "JSON Schema for the business result." },
		agent: {
			type: "object",
			required: ["instructions", "workflow"],
			properties: {
				instructions: { type: "string" },
				workflow: { type: "string" },
				examples: { type: "string" },
				tools: { type: "array", items: { type: "string" } },
				model: { type: "string" },
				maxTurns: { type: "number" },
			},
		},
		services: { type: "object" },
		permissions: {
			type: "object",
			properties: {
				read: { type: "boolean" },
				write: { type: "boolean" },
				bash: { type: "boolean" },
				network: { type: "boolean" },
			},
		},
		notes: { type: "array", items: { type: "string" } },
	},
};

const TEMPLATE_DIR = fileURLToPath(new URL("../../agents/skill-converter", import.meta.url));

async function readIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function ensureUserConverterAgent(agentDir: string): Promise<void> {
	const agentsDir = path.join(agentDir, "agents");
	await fs.mkdir(agentsDir, { recursive: true });
	const userAgentPath = path.join(agentsDir, "skill_converter.md");
	const userWorkflowPath = path.join(agentsDir, "skill_converter.workflow.md");

	const instructions = await readIfExists(path.join(TEMPLATE_DIR, "AGENT.md"));
	const workflow = await readIfExists(path.join(TEMPLATE_DIR, "WORKFLOW.md"));
	const examples = await readIfExists(path.join(TEMPLATE_DIR, "EXAMPLES.md"));
	if (!instructions || !workflow) {
		throw new Error(`converter template is incomplete: ${TEMPLATE_DIR}`);
	}

	if ((await readIfExists(userWorkflowPath)) === undefined) {
		await fs.writeFile(userWorkflowPath, workflow, "utf8");
	}
	if ((await readIfExists(userAgentPath)) === undefined) {
		const userAgent = [
			"---",
			"name: skill_converter",
			"tool: skill_converter",
			'version: "1.0.0"',
			'contract: "*"',
			'tools: ["read", "grep", "find", "ls"]',
			"workflow: skill_converter.workflow.md",
			"override: false",
			"---",
			"",
			instructions.trim(),
			...(examples ? ["", "## Examples", examples.trim()] : []),
			"",
		].join("\n");
		await fs.writeFile(userAgentPath, userAgent, "utf8");
	}
}

async function listSkillFiles(skillDir: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dir: string, depth: number) => {
		if (depth > 4 || files.length >= 200) return;
		let entries: Array<{ name: string; isDirectory(): boolean }>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const absolute = path.join(dir, entry.name);
			const relative = path.relative(skillDir, absolute);
			if (entry.isDirectory()) {
				files.push(`${relative}/`);
				await walk(absolute, depth + 1);
			} else {
				files.push(relative);
			}
			if (files.length >= 200) return;
		}
	};
	await walk(skillDir, 0);
	return files;
}

function converterManifest(): ToolManifest {
	return {
		name: "skill_converter",
		version: "1.0.0",
		contractVersion: "1.0.0",
		description: "Convert a skill directory into a tool manifest.",
		kind: "agent",
		input: {
			type: "object",
			properties: {
				task: { type: "string" },
				context: { type: "string" },
			},
			required: ["task"],
		},
		output: CONVERTER_PLAN_SCHEMA,
		agent: {
			instructions: "AGENT.md",
			workflow: "WORKFLOW.md",
			tools: ["read", "grep", "find", "ls"],
			maxTurns: 30,
			sessionScope: "project",
			memoryScope: "project",
			resolution: "user-first",
			createProjectIfMissing: false,
			requireProjectTrust: false,
			contractRange: "*",
		},
		permissions: { read: true, write: false, bash: false, network: false },
		limits: { maxInputBytes: 5_000_000, maxResultBytes: 200_000, jobTimeoutMs: 600_000 },
		execution: { defaultMode: "sync", notifyOnIdle: false },
		exposure: "hidden",
		namespace: "tool",
		dir: TEMPLATE_DIR,
	};
}

export async function runSkillConverter(options: {
	skillDir: string;
	skillFile: string;
	content: string;
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	supervisor: ServiceSupervisor;
	log: (message: string) => void;
}): Promise<SkillConverterPlan> {
	await ensureUserConverterAgent(options.agentDir);
	const userAgentPath = path.join(options.agentDir, "agents", "skill_converter.md");
	const userAgent = await readIfExists(userAgentPath);
	if (!userAgent) throw new Error(`failed to install user-level converter agent: ${userAgentPath}`);

	const provisional = converterManifest();
	const resolution = await resolveAgent({
		tool: provisional,
		cwd: options.cwd,
		agentDir: options.agentDir,
		projectTrusted: false,
		allowCreateProject: false,
	});
	if (!resolution.agent) {
		throw new Error(`user-level converter agent is not usable: ${resolution.error ?? "unknown error"}`);
	}

	const manifest = converterManifest();
	const worker = new AgentWorker(
		manifest,
		resolution.agent,
		options.cwd,
		options.agentDir,
		options.modelRuntime,
		options.supervisor,
		options.log,
	);
	try {
		const files = await listSkillFiles(options.skillDir);
		const task = [
			"Convert this skill directory into a tool plan.",
			"",
			`Skill directory: ${options.skillDir}`,
			`Skill file: ${options.skillFile}`,
			"",
			"Files:",
			...files.map((file) => `- ${file}`),
			"",
			"SKILL.md:",
			"```markdown",
			options.content,
			"```",
			"",
			"Inspect supporting files with the read tool when they affect execution.",
			"Return the complete plan through submit_result.",
		].join("\n");
		const result = await worker.run({ task, context: `Working directory: ${options.cwd}` });
		if (result.envelope.status !== "ok") {
			throw new Error(`converter agent failed: ${result.envelope.summary}`);
		}
		const plan = result.envelope.result as SkillConverterPlan;
		const errors = validateValue(CONVERTER_PLAN_SCHEMA, plan);
		if (errors.length > 0) {
			throw new Error(`converter plan is invalid:\n${errors.join("\n")}`);
		}
		return plan;
	} finally {
		await worker.dispose();
	}
}
