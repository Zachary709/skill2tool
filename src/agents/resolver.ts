import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ResolvedAgent, ToolManifest } from "../types.ts";

interface AgentFileData {
	name?: string;
	tool?: string;
	version?: string;
	contract?: string;
	tools?: string[];
	thinkingLevel?: AgentConfig["thinkingLevel"];
	workflow?: string;
	examples?: string;
	override?: boolean;
	permissions?: Record<string, unknown>;
	body: string;
}

function toStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function versionSatisfies(range: string | undefined, version: string): boolean {
	if (!range || range === "*") return true;
	const clean = range.trim();
	if (clean === version) return true;
	if (clean.startsWith("^")) {
		const wanted = clean.slice(1);
		return wanted.split(".")[0] === version.split(".")[0];
	}
	if (clean.startsWith("~")) {
		const wanted = clean.slice(1).split(".");
		const actual = version.split(".");
		return wanted[0] === actual[0] && wanted[1] === actual[1];
	}
	return false;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function loadAgentFile(filePath: string): Promise<AgentFileData | undefined> {
	const content = await readIfExists(filePath);
	if (content === undefined) return undefined;
	const parsed = parseFrontmatter<Record<string, unknown>>(content);
	const frontmatter = asRecord(parsed.frontmatter);
	return {
		name: typeof frontmatter.name === "string" ? frontmatter.name : undefined,
		tool: typeof frontmatter.tool === "string" ? frontmatter.tool : undefined,
		version: typeof frontmatter.version === "string" ? frontmatter.version : undefined,
		contract: typeof frontmatter.contract === "string" ? frontmatter.contract : undefined,
		tools: toStringArray(frontmatter.tools),
		thinkingLevel:
			typeof frontmatter.thinkingLevel === "string"
				? (frontmatter.thinkingLevel as AgentConfig["thinkingLevel"])
				: undefined,
		workflow: typeof frontmatter.workflow === "string" ? frontmatter.workflow : undefined,
		examples: typeof frontmatter.examples === "string" ? frontmatter.examples : undefined,
		override: frontmatter.override === true,
		permissions: asRecord(frontmatter.permissions),
		body: parsed.body,
	};
}

function resolveRelative(baseDir: string, value: string | undefined): string | undefined {
 if (!value) return undefined;
 return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

async function toResolvedAgent(options: {
	tool: ToolManifest;
	data: AgentFileData;
	source: ResolvedAgent["source"];
	filePath?: string;
	baseDir: string;
}): Promise<{ agent?: ResolvedAgent; error?: string }> {
	const { tool, data, source, filePath, baseDir } = options;
	if (data.tool && data.tool !== tool.name) {
		return { error: `agent is for tool "${data.tool}", expected "${tool.name}"` };
	}
	if (data.name && data.name !== tool.name) {
		return { error: `agent name "${data.name}" must match the tool name "${tool.name}"` };
	}
	const contract = data.contract ?? tool.agent?.contractRange ?? "*";
	if (!versionSatisfies(contract, tool.contractVersion ?? tool.version)) {
		return { error: `agent contract "${contract}" does not include tool version "${tool.contractVersion ?? tool.version}"` };
	}

	const tools = data.tools ?? tool.agent?.tools ?? [];
	const allowed = new Set(tool.agent?.tools ?? []);
	const extra = tools.filter((name) => allowed.size > 0 && !allowed.has(name));
	if (extra.length > 0) {
		return { error: `agent requires tools not declared by the tool: ${extra.join(", ")}` };
	}

	const workflowPath = resolveRelative(baseDir, data.workflow);
	const workflow = workflowPath ? await readIfExists(workflowPath) : undefined;
	if (workflow === undefined && tool.kind === "agent") {
		return { error: `agent workflow file is missing${workflowPath ? `: ${workflowPath}` : ""}` };
	}
	const examplesPath = resolveRelative(baseDir, data.examples);
	const examples = examplesPath ? await readIfExists(examplesPath) : undefined;

	return {
		agent: {
			name: tool.name,
			tool: tool.name,
			version: data.version ?? tool.version,
			contract,
			source,
			path: filePath,
			instructions: data.body,
			workflow: workflow ?? "",
			examples,
			tools,
			thinkingLevel: data.thinkingLevel ?? tool.agent?.thinkingLevel,
			maxTurns: tool.agent?.maxTurns ?? 30,
			overrides: data.override === true,
		},
	};
}

async function loadEmbeddedAgent(tool: ToolManifest): Promise<{ agent?: ResolvedAgent; error?: string }> {
	if (!tool.agent) return { error: "tool has no agent configuration" };
	const baseDir = tool.dir ?? process.cwd();
	const instructionsPath = resolveRelative(baseDir, tool.agent.instructions ?? "AGENT.md");
	const workflowPath = resolveRelative(baseDir, tool.agent.workflow ?? "WORKFLOW.md");
	const instructions = instructionsPath ? await readIfExists(instructionsPath) : undefined;
	const workflow = workflowPath ? await readIfExists(workflowPath) : undefined;
	if (instructions === undefined) return { error: `embedded agent instructions not found: ${instructionsPath}` };
	if (workflow === undefined) return { error: `embedded agent workflow not found: ${workflowPath}` };
	const examplesPath = resolveRelative(baseDir, tool.agent.examples);
	const examples = examplesPath ? await readIfExists(examplesPath) : undefined;
	return {
		agent: {
			name: tool.name,
			tool: tool.name,
			version: tool.version,
			contract: tool.agent.contractRange ?? "*",
			source: "embedded",
			path: instructionsPath,
			instructions,
			workflow,
			examples,
			tools: tool.agent.tools ?? [],
			thinkingLevel: tool.agent.thinkingLevel,
			maxTurns: tool.agent.maxTurns ?? 30,
			overrides: false,
		},
	};
}

async function createProjectAgent(tool: ToolManifest, cwd: string): Promise<{ agent?: ResolvedAgent; error?: string }> {
	const embedded = await loadEmbeddedAgent(tool);
	if (!embedded.agent) return embedded;
	const dir = path.join(cwd, ".pi", "agents");
	await fs.mkdir(dir, { recursive: true });
	const agentPath = path.join(dir, `${tool.name}.md`);
	const workflowPath = path.join(dir, `${tool.name}.workflow.md`);
	try {
		await fs.writeFile(workflowPath, embedded.agent.workflow, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const frontmatter = [
		"---",
		`name: ${tool.name}`,
		`tool: ${tool.name}`,
		`version: ${tool.version}`,
		`contract: "${tool.agent?.contractRange ?? "*"}"`,
		`tools: [${embedded.agent.tools.map((name) => JSON.stringify(name)).join(", ")}]`,
		`workflow: ${path.basename(workflowPath)}`,
		`override: false`,
		"---",
		"",
		embedded.agent.instructions,
	].join("\n");
	try {
		await fs.writeFile(agentPath, frontmatter, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const loaded = await loadAgentFile(agentPath);
	if (!loaded) return { error: `failed to read created project agent: ${agentPath}` };
	return toResolvedAgent({
		tool,
		data: loaded,
		source: "created-project",
		filePath: agentPath,
		baseDir: dir,
	});
}

export async function resolveAgent(options: {
	tool: ToolManifest;
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	allowCreateProject: boolean;
}): Promise<{ agent?: ResolvedAgent; warnings: string[]; error?: string }> {
	const { tool, cwd, agentDir, projectTrusted, allowCreateProject } = options;
	const warnings: string[] = [];

	const userPath = path.join(agentDir, "agents", `${tool.name}.md`);
	const projectPath = path.join(cwd, ".pi", "agents", `${tool.name}.md`);

	const userData = await loadAgentFile(userPath);
	let userResult: { agent?: ResolvedAgent; error?: string } = {};
	if (userData) {
		userResult = await toResolvedAgent({
			tool,
			data: userData,
			source: "user",
			filePath: userPath,
			baseDir: path.dirname(userPath),
		});
		if (userResult.error) warnings.push(`user agent ignored: ${userResult.error}`);
	}

	const projectData = projectTrusted ? await loadAgentFile(projectPath) : undefined;
	let projectResult: { agent?: ResolvedAgent; error?: string } = {};
	if (projectData) {
		projectResult = await toResolvedAgent({
			tool,
			data: projectData,
			source: "project",
			filePath: projectPath,
			baseDir: path.dirname(projectPath),
		});
		if (projectResult.error) warnings.push(`project agent ignored: ${projectResult.error}`);
	} else if (!projectTrusted) {
		warnings.push("project agent skipped because the project is not trusted");
	}

	if (projectResult.agent?.overrides) {
		return { agent: projectResult.agent, warnings };
	}
	if (userResult.agent) {
		return { agent: userResult.agent, warnings };
	}
	if (projectResult.agent) {
		return { agent: projectResult.agent, warnings };
	}

	if (allowCreateProject) {
		if (!projectTrusted) {
			return {
				warnings,
				error: "no usable user or project agent; project is not trusted so a project agent cannot be created",
			};
		}
		const created = await createProjectAgent(tool, cwd);
		if (created.agent) return { agent: created.agent, warnings };
		if (created.error) warnings.push(`failed to create project agent: ${created.error}`);
	}

	const embedded = await loadEmbeddedAgent(tool);
	if (embedded.agent) return { agent: embedded.agent, warnings };
	return { warnings, error: embedded.error ?? "no usable agent" };
}

export async function listAgentCandidates(tool: ToolManifest, cwd: string, agentDir: string): Promise<string[]> {
	const candidates = [
		path.join(agentDir, "agents", `${tool.name}.md`),
		path.join(cwd, ".pi", "agents", `${tool.name}.md`),
	];
	const results: string[] = [];
	for (const candidate of candidates) {
		if ((await readIfExists(candidate)) !== undefined) results.push(candidate);
	}
	return results;
}
