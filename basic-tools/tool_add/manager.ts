import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readManifestFile } from "../../src/discovery/manifest.ts";
import { validateManifest, validateValue } from "../../src/contracts/schema.ts";
import type { JsonSchema, ToolAddInput, ToolEnvelope, ToolManifest } from "../../src/types.ts";
import { TOOL_PLAN_SCHEMA, planErrors, type ToolPlan } from "./plan.ts";
import { registerExternalServices } from "./registry.ts";
import {
	atomicWrite,
	defaultAgentInstructions,
	defaultWorkflow,
	ensureAgentFiles,
	safeToolName,
	writeToolArtifacts,
} from "./artifacts.ts";

export interface ToolAddHost {
	agentDir: string;
	listTools(): ToolManifest[];
	getTool(name: string): ToolManifest | undefined;
	register(manifest: ToolManifest, activate: boolean): void;
	setEnabled(name: string, enabled: boolean, activate: boolean): Promise<void>;
	isReserved(name: string): boolean;
}

type AddContext = { cwd: string; isProjectTrusted(): boolean };

const DEFAULT_INPUT: JsonSchema = {
	type: "object",
	properties: {
		task: {
			type: "string",
			maxLength: 8000,
			description: "The task for the worker, including everything it needs to start.",
		},
		context: {
			type: "string",
			maxLength: 4000,
			description: "Optional background from the caller, such as an error message.",
		},
	},
	required: ["task"],
	additionalProperties: false,
};

const DEFAULT_OUTPUT: JsonSchema = {
	type: "object",
	properties: {
		outcome: {
			type: "string",
			maxLength: 2000,
			description: "The conclusion the caller needs, without process narration.",
		},
		facts: {
			type: "array",
			items: { type: "string", maxLength: 500 },
			maxItems: 20,
			description: "Supporting facts, at most 20 short entries.",
		},
	},
	required: ["outcome"],
	additionalProperties: false,
};

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function toolSummary(manifest: ToolManifest) {
	return { name: manifest.name, description: manifest.description };
}

function inspectResult(manifest: ToolManifest) {
	return {
		action: "inspect" as const,
		tools: [
			{
				...toolSummary(manifest),
				input: manifest.input,
				output: manifest.output,
			},
		],
	};
}

/**
 * Bundle the source skill with the generated tool. Relative service paths and
 * instructions then resolve from the tool directory, and the tool keeps working
 * after the source checkout moves.
 */
async function copySkillBundle(sourceDir: string, targetDir: string): Promise<void> {
	const skip = new Set([".git", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache"]);
	await fs.cp(sourceDir, targetDir, {
		recursive: true,
		force: true,
		filter: (source) => {
			const relative = path.relative(sourceDir, source);
			if (!relative) return true;
			return !relative.split(path.sep).some((part) => skip.has(part));
		},
	});
}

export class ToolAddManager {
	constructor(private readonly host: ToolAddHost) {}

	async handle(input: ToolAddInput, ctx: AddContext): Promise<ToolEnvelope> {
		switch (input.action) {
			case "list":
				return this.list();
			case "inspect":
				return this.inspect(input);
			case "validate":
				return this.validate(input);
			case "add":
				return this.add(input, ctx);
			case "convert_skill":
				return this.convertSkill(input, ctx);
			case "create_tool":
				return this.createTool(input, ctx);
			case "disable":
			case "enable":
				return this.setEnabled(input);
			default:
				return { status: "failed", summary: `Unsupported action: ${String(input.action)}` };
		}
	}

	private list(): ToolEnvelope {
		const tools = this.host.listTools().map((manifest) => toolSummary(manifest));
		return {
			status: "ok",
			summary: `${tools.length} tool(s) registered.`,
			result: { action: "list", tools },
		};
	}

	private inspect(input: ToolAddInput): ToolEnvelope {
		const manifest = input.name ? this.host.getTool(input.name) : undefined;
		if (!manifest) return { status: "failed", summary: `Unknown tool: ${input.name ?? "(none)"}` };
		return { status: "ok", summary: `Tool ${manifest.name}.`, result: inspectResult(manifest) };
	}

	private validate(input: ToolAddInput): ToolEnvelope {
		if (!input.manifest) return { status: "failed", summary: "manifest is required for validate." };
		const result = validateManifest(input.manifest);
		return {
			status: result.errors.length ? "failed" : "ok",
			summary: result.errors.length ? "Manifest validation failed." : "Manifest is valid.",
			result: { action: "validate", errors: result.errors },
			warnings: result.warnings,
		};
	}

	private async setEnabled(input: ToolAddInput): Promise<ToolEnvelope> {
		const manifest = input.name ? this.host.getTool(input.name) : undefined;
		if (!manifest) return { status: "failed", summary: `Unknown tool: ${input.name ?? "(none)"}` };
		if (manifest.scope === "package") {
			return {
				status: "needs_input",
				summary: `Tool ${manifest.name} ships with the runtime and cannot be disabled or enabled.`,
			};
		}
		await this.host.setEnabled(manifest.name, input.action === "enable", true);
		return {
			status: "ok",
			summary: `Tool ${manifest.name} ${input.action === "enable" ? "enabled" : "disabled"}.`,
			result: { action: input.action, tools: [toolSummary(manifest)] },
		};
	}

	private scopeRoot(scope: "project" | "user", ctx: AddContext): string {
		return scope === "user"
			? path.join(this.host.agentDir, "tools")
			: path.join(ctx.cwd, ".pi", "tools");
	}

	private async add(input: ToolAddInput, ctx: AddContext): Promise<ToolEnvelope> {
		let manifest: ToolManifest;
		let sourceDir: string | undefined;
		if (input.manifest) {
			const result = validateManifest(input.manifest);
			if (!result.manifest || result.errors.length > 0) {
				return { status: "failed", summary: "Manifest validation failed.", warnings: result.errors };
			}
			manifest = result.manifest;
		} else if (input.sourcePath) {
			const absolute = path.resolve(input.sourcePath);
			const stats = await fs.stat(absolute).catch(() => undefined);
			if (!stats) return { status: "failed", summary: `Source not found: ${absolute}` };
			const manifestPath = stats.isDirectory() ? path.join(absolute, "TOOL.json") : absolute;
			sourceDir = path.dirname(manifestPath);
			const result = await readManifestFile(manifestPath);
			if (!result.manifest || result.errors.length > 0) {
				return { status: "failed", summary: "Manifest validation failed.", warnings: result.errors };
			}
			manifest = result.manifest;
		} else {
			return { status: "failed", summary: "manifest or sourcePath is required for add." };
		}

		const scope = input.scope ?? "project";
		if (this.host.isReserved(manifest.name)) {
			return { status: "failed", summary: `Tool name "${manifest.name}" is reserved by the runtime.` };
		}
		if (scope === "project" && !ctx.isProjectTrusted()) {
			return { status: "needs_input", summary: "Project is not trusted; cannot create a project tool." };
		}
		const dir = path.join(this.scopeRoot(scope, ctx), manifest.name);
		try {
			await fs.access(dir);
			return { status: "failed", summary: `Tool directory already exists: ${dir}` };
		} catch {
			// the directory does not exist yet
		}
		await fs.mkdir(dir, { recursive: true });
		if (sourceDir && path.resolve(sourceDir) !== path.resolve(dir)) {
			await fs.cp(sourceDir, dir, { recursive: true, force: true });
		}
		const persisted = { ...manifest };
		delete persisted.dir;
		await atomicWrite(path.join(dir, "TOOL.json"), `${JSON.stringify(persisted, null, 2)}\n`);
		await ensureAgentFiles(dir, manifest);
		manifest.dir = dir;
		manifest.scope = scope;
		const validation = validateManifest(manifest, dir);
		if (!validation.manifest || validation.errors.length > 0) {
			return { status: "failed", summary: "Generated tool failed validation.", warnings: validation.errors };
		}
		this.host.register(validation.manifest, true);
		return {
			status: "ok",
			summary: `Tool ${manifest.name} added.`,
			result: { action: "add", tools: [toolSummary(manifest)] },
			warnings: validation.warnings,
		};
	}

	private async convertSkill(input: ToolAddInput, ctx: AddContext): Promise<ToolEnvelope> {
		const skillPath = input.sourcePath;
		if (!skillPath) return { status: "failed", summary: "sourcePath is required for convert_skill." };
		const absolute = path.resolve(skillPath);
		let content: string;
		try {
			content = await fs.readFile(absolute, "utf8");
		} catch (error) {
			return { status: "failed", summary: `Failed to read skill: ${String(error)}` };
		}
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		const scope = input.scope ?? "project";
		if (scope === "project" && !ctx.isProjectTrusted()) {
			return { status: "needs_input", summary: "Project is not trusted; cannot create a project tool." };
		}

		const warnings: string[] = [];
		let plan: ToolPlan | undefined;
		if (input.plan !== undefined) {
			plan = input.plan as ToolPlan;
			if (input.name) plan.name = safeToolName(input.name);
			const errors = this.validatePlan(plan);
			const sourceDir = path.dirname(absolute);
			const repoRoot = path.dirname(sourceDir);
			if (errors.length === 0 && JSON.stringify(plan).includes(sourceDir)) {
				errors.push(
					`plan must use skill/... paths relative to the tool directory, not the source path ${sourceDir}`,
				);
			}
			if (errors.length === 0 && JSON.stringify(plan).includes(repoRoot)) {
				errors.push(
					`plan must use service/... paths relative to the tool directory, not the source path ${repoRoot}`,
				);
			}
			const scriptsDir = path.join(sourceDir, "scripts");
			const hasScripts = await fs.access(scriptsDir).then(() => true).catch(() => false);
			if (errors.length === 0 && hasScripts && !JSON.stringify(plan).includes("skill/scripts/")) {
				errors.push(
					"the skill ships scripts; declare a service or reference skill/scripts/... in the plan",
				);
			}
			if (errors.length > 0) {
				return {
					status: "failed",
					summary: "The supplied tool plan is invalid. Correct the plan and call tool_add_manage again.",
					warnings: errors,
				};
			}
		} else {
			warnings.push("no plan supplied; using deterministic conversion");
		}

		const frontmatterName =
			typeof parsed.frontmatter.name === "string" ? safeToolName(parsed.frontmatter.name) : undefined;
		const name = input.name ?? plan?.name ?? frontmatterName ?? safeToolName(path.basename(path.dirname(absolute)));
		if (!name) return { status: "failed", summary: `Cannot derive a tool name from ${absolute}.` };
		if (this.host.isReserved(name)) {
			return { status: "failed", summary: `Tool name "${name}" is reserved by the runtime.` };
		}
		const dir = path.join(this.scopeRoot(scope, ctx), name);
		try {
			await fs.access(dir);
			return { status: "failed", summary: `Tool directory already exists: ${dir}` };
		} catch {
			// the directory does not exist yet
		}

		const built = plan
			? this.manifestFromPlan(plan, name, scope, dir)
			: this.manifestFromFallback(parsed.frontmatter, parsed.body, absolute, name, scope, dir);
		let usedPlan = Boolean(plan);
		await fs.mkdir(dir, { recursive: true });
		const sourceRoot = path.dirname(path.dirname(absolute));
		await copySkillBundle(path.dirname(absolute), path.join(dir, "skill"));
		for (const name of ["service", "services"]) {
			const serviceRoot = path.join(sourceRoot, name);
			const exists = await fs.access(serviceRoot).then(() => true).catch(() => false);
			if (exists && content.includes(`${name}/`)) {
				await copySkillBundle(serviceRoot, path.join(dir, name));
			}
		}

		let manifest = built.manifest;
		let validation = validateManifest(manifest, dir);
		if (plan && (!validation.manifest || validation.errors.length > 0)) {
			warnings.push(`builder plan produced an invalid manifest; using deterministic conversion: ${validation.errors.join("; ")}`);
			const fallback = this.manifestFromFallback(parsed.frontmatter, parsed.body, absolute, name, scope, dir);
			built.files = fallback.files;
			manifest = fallback.manifest;
			usedPlan = false;
			validation = validateManifest(manifest, dir);
		}
		if (!validation.manifest || validation.errors.length > 0) {
			return {
				status: "failed",
				summary: "Generated tool failed validation.",
				warnings: [...warnings, ...validation.errors],
			};
		}

		await writeToolArtifacts(dir, validation.manifest, built.files);
		this.host.register(validation.manifest, true);
		const registry = await registerExternalServices(
			this.host.agentDir,
			name,
			plan?.externalServices ?? [],
		);
		warnings.push(...registry.errors.map((error) => `service registry: ${error}`));
		return {
			status: "ok",
			summary: `Skill ${absolute} converted to tool ${name} using the ${usedPlan ? "builder agent" : "deterministic fallback"}.`,
			result: { action: "convert_skill", tools: [toolSummary(validation.manifest)] },
			warnings: [...warnings, ...validation.warnings],
		};
	}

	private async createTool(input: ToolAddInput, ctx: AddContext): Promise<ToolEnvelope> {
		const name = input.name ? safeToolName(input.name) : "";
		if (!name) return { status: "failed", summary: "name is required for create_tool." };
		const requirements = input.requirements?.trim() ?? "";
		if (requirements.length < 20) {
			return {
				status: "failed",
				summary:
					"requirements must state what the tool does, its inputs, its outputs, and any service or path it uses.",
			};
		}
		if (this.host.isReserved(name)) {
			return { status: "failed", summary: `Tool name "${name}" is reserved by the runtime.` };
		}
		const scope = input.scope ?? "project";
		if (scope === "project" && !ctx.isProjectTrusted()) {
			return { status: "needs_input", summary: "Project is not trusted; cannot create a project tool." };
		}
		const dir = path.join(this.scopeRoot(scope, ctx), name);
		try {
			await fs.access(dir);
			return { status: "failed", summary: `Tool directory already exists: ${dir}` };
		} catch {
			// the directory does not exist yet
		}

		if (input.plan === undefined) {
			return {
				status: "failed",
				summary: "create_tool requires a plan produced by the tool_add worker.",
			};
		}
		const plan = input.plan as ToolPlan;
		plan.name = name;
		const planValidation = this.validatePlan(plan);
		if (planValidation.length > 0) {
			return {
				status: "failed",
				summary: "The supplied tool plan is invalid. Correct the plan and call tool_add_manage again.",
				warnings: planValidation,
			};
		}
		const warnings: string[] = [];
		const built = this.manifestFromPlan(plan, name, scope, dir);
		const validation = validateManifest(built.manifest, dir);
		if (!validation.manifest || validation.errors.length > 0) {
			return {
				status: "failed",
				summary: "Built tool failed validation.",
				warnings: [...warnings, ...validation.errors],
			};
		}
		await fs.mkdir(dir, { recursive: true });
		await writeToolArtifacts(dir, validation.manifest, built.files);
		this.host.register(validation.manifest, true);
		const registry = await registerExternalServices(
			this.host.agentDir,
			name,
			plan.externalServices ?? [],
		);
		warnings.push(...registry.errors.map((error) => `service registry: ${error}`));
		return {
			status: "ok",
			summary: `Built tool ${name}.`,
			result: { action: "create_tool", tools: [toolSummary(validation.manifest)] },
			warnings: [...warnings, ...validation.warnings],
		};
	}

	private validatePlan(plan: ToolPlan): string[] {
		const schemaErrors = validateValue(TOOL_PLAN_SCHEMA, plan);
		if (schemaErrors.length > 0) return schemaErrors;
		return planErrors(plan);
	}

	private manifestFromPlan(
		plan: ToolPlan,
		name: string,
		scope: "project" | "user",
		dir: string,
	): { manifest: ToolManifest; files: { instructions: string; workflow: string; examples?: string } } {
		const manifest: ToolManifest = {
			name,
			version: "0.1.0",
			contractVersion: "0.1.0",
			description: plan.description,
			whenToUse: plan.whenToUse,
			notFor: plan.notFor ?? [],
			kind: "agent",
			input: plan.input,
			output: plan.output,
			agent: {
				instructions: "AGENT.md",
				workflow: "WORKFLOW.md",
				examples: plan.agent.examples ? "EXAMPLES.md" : undefined,
				tools: plan.agent.tools,
				maxTurns: plan.agent.maxTurns ?? 30,
				sessionScope: "project",
				memoryScope: "project",
				resolution: "user-first",
				createProjectIfMissing: true,
				requireProjectTrust: true,
				contractRange: "^0.1.0",
			},
			permissions: {
				read: plan.permissions?.read ?? true,
				write: plan.permissions?.write ?? false,
				bash: plan.permissions?.bash ?? false,
				network: plan.permissions?.network ?? false,
			},
			limits: { maxInputBytes: 1_048_576, maxResultBytes: 20_000, jobTimeoutMs: 600_000 },
			execution: { defaultMode: "start", notifyOnIdle: true, asyncByDefault: true },
			exposure: "direct",
			namespace: "tool",
			dir,
			scope,
		};
		if (plan.services && Object.keys(plan.services).length > 0) {
			manifest.services = plan.services;
		}
		return {
			manifest,
			files: {
				instructions: plan.agent.instructions,
				workflow: plan.agent.workflow,
				examples: plan.agent.examples,
			},
		};
	}

	private manifestFromFallback(
		frontmatter: Record<string, unknown>,
		body: string,
		absolute: string,
		name: string,
		scope: "project" | "user",
		dir: string,
	): {
		manifest: ToolManifest;
		files: { instructions: string; workflow: string };
	} {
		const frontmatterDescription =
			typeof frontmatter.description === "string" && frontmatter.description.trim().length >= 20
				? frontmatter.description.trim()
				: `Skill-backed tool converted from ${absolute}. Use when the task matches the original skill description.`;
		const whenToUse = stringArray(frontmatter.whenToUse);
		const notFor = stringArray(frontmatter.notFor);
		const manifest: ToolManifest = {
			name,
			version: "0.1.0",
			contractVersion: "0.1.0",
			description: frontmatterDescription,
			whenToUse:
				whenToUse && whenToUse.length > 0
					? whenToUse
					: ["Use when the task matches the original skill description."],
			notFor: notFor ?? [],
			kind: "agent",
			input: DEFAULT_INPUT,
			output: DEFAULT_OUTPUT,
			agent: {
				instructions: "AGENT.md",
				workflow: "WORKFLOW.md",
				tools: ["read", "grep", "find", "ls"],
				maxTurns: 30,
				sessionScope: "project",
				memoryScope: "project",
				resolution: "user-first",
				createProjectIfMissing: true,
				requireProjectTrust: true,
				contractRange: "^0.1.0",
			},
			permissions: { read: true, write: false, bash: false, network: false },
			limits: { maxInputBytes: 1_048_576, maxResultBytes: 20_000, jobTimeoutMs: 600_000 },
			execution: { defaultMode: "start", notifyOnIdle: true, asyncByDefault: true },
			exposure: "direct",
			namespace: "tool",
			dir,
			scope,
		};
		const instructions = [
			defaultAgentInstructions(manifest),
			"",
			"## Skill instructions",
			"",
			"<skill_instructions>",
			body.trim(),
			"</skill_instructions>",
			"",
			"The original skill package is bundled under `skill/` inside this tool directory.",
			"Read `skill/SKILL.md` and run its scripts from that bundled directory.",
			"When the tool directory also contains `service/` or `services/`, that deployment code is part of the tool; use those relative paths.",
		].join("\n");
		const workflow = [
			defaultWorkflow(manifest),
			"",
			"## Skill procedure",
			"",
			"Follow the skill instructions in the system prompt for the concrete steps.",
			"Return only the declared result fields: outcome and, when useful, facts.",
			"",
			"Finish with submit_result.",
		].join("\n");
		return { manifest, files: { instructions, workflow } };
	}
}
