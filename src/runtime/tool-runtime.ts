import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	parseFrontmatter,
	SettingsManager,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadTools, readManifestFile, type ToolLoadDiagnostic, type ToolSource } from "../discovery/manifest.ts";
import { validateManifest, validateValue, envelopeSchema } from "../contracts/schema.ts";
import { JobManager } from "../jobs/manager.ts";
import { ServiceSupervisor } from "../services/supervisor.ts";
import { executeDirectTool } from "./direct-executor.ts";
import { runSkillConverter, type SkillConverterPlan } from "../conversion/converter.ts";
import {
	ProgressWatcher,
	snapshotProgress,
	type ProgressSnapshot,
	type ProgressUi,
	type ProgressUpdateSink,
} from "../observability/progress.ts";
import type {
	JobRecord,
	JobToolInput,
	ToolAddInput,
	ToolEnvelope,
	ToolManifest,
	ToolMode,
} from "../types.ts";

interface ToolRuntimeOptions {
	pi: ExtensionAPI;
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	modelRuntime: ModelRuntime;
	log: (message: string) => void;
}

interface RegisteredTool {
	manifest: ToolManifest;
	definition: ToolDefinition;
}

const RESERVED_TOOL_NAMES = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"tool_add",
	"job",
]);

function atomicWrite(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	return fs
		.mkdir(dir, { recursive: true })
		.then(() => fs.writeFile(temp, content, "utf8"))
		.then(() => fs.rename(temp, filePath));
}

function safeToolName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
}

function facadeInputSchema(manifest: ToolManifest) {
	const properties: Record<string, unknown> = {
		...(manifest.input.properties ?? {}),
	};
	if (manifest.kind === "agent") {
		properties.mode = {
			type: "string",
			enum: ["sync", "start", "wait", "status", "result", "cancel"],
			description:
				"sync waits for a new job, start returns a job handle, wait waits for a job, status/result/cancel operate on an existing job.",
		};
		properties.timeoutMs = {
			type: "number",
			description: "Maximum wait time in milliseconds for wait mode.",
		};
		properties.jobId = {
			type: "string",
			description: "Existing job id for wait, status, result, or cancel.",
		};
	}
	return {
		...manifest.input,
		type: "object",
		properties,
	};
}

function truncate(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	return `${Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - 80)).toString("utf8")}\n...[truncated]`;
}

function formatToolDescription(manifest: ToolManifest): string {
	const lines = [manifest.description.trim()];
	if (manifest.whenToUse?.length) lines.push(`Use when: ${manifest.whenToUse.join("; ")}`);
	if (manifest.notFor?.length) lines.push(`Do not use for: ${manifest.notFor.join("; ")}`);
	if (manifest.kind === "agent") {
		lines.push("This tool delegates to a persistent worker. It accepts mode=start to return a job handle.");
	}
	return lines.join("\n");
}

export class ToolRuntime {
	private readonly tools = new Map<string, RegisteredTool>();
	private readonly supervisor: ServiceSupervisor;
	private readonly jobs: JobManager;
	private readonly progressWatchers = new Map<string, ProgressWatcher>();
	private settingsManager?: SettingsManager;
	private lastIsIdle?: () => boolean;

	private readonly options: ToolRuntimeOptions;

	constructor(options: ToolRuntimeOptions) {
		this.options = options;
		this.supervisor = new ServiceSupervisor({
			log: options.log,
			projectCwd: options.cwd,
			agentDir: options.agentDir,
		});
		this.jobs = new JobManager({
			root: path.join(options.cwd, ".pi", "jobs"),
			agentDir: options.agentDir,
			notify: (job) => this.notify(job),
			log: options.log,
		});
	}

	get diagnostics(): ToolLoadDiagnostic[] {
		return this.loadDiagnostics;
	}

	private loadDiagnostics: ToolLoadDiagnostic[] = [];

	private sources(): ToolSource[] {
		const sources: ToolSource[] = [
			{ root: path.join(this.options.agentDir, "tools"), scope: "user" },
			{ root: path.join(this.options.cwd, ".pi", "tools"), scope: "project" },
		];
		return sources;
	}

	async initialize(): Promise<void> {
		await this.jobs.recover();
		const { tools, diagnostics } = await loadTools(this.sources());
		this.loadDiagnostics = diagnostics;
		for (const diagnostic of diagnostics) {
			this.options.log(`${diagnostic.type}: ${diagnostic.path}: ${diagnostic.message}`);
		}
		for (const tool of tools) {
			if (tool.scope === "project" && !this.options.projectTrusted) {
				this.options.log(`project tool skipped because the project is not trusted: ${tool.manifest.name}`);
				continue;
			}
			try {
				this.register(tool.manifest, true);
			} catch (error) {
				this.options.log(`failed to register tool ${tool.manifest.name}: ${String(error)}`);
			}
		}
	}

	register(manifest: ToolManifest, activate = true): RegisteredTool {
		if (RESERVED_TOOL_NAMES.has(manifest.name) && !this.tools.has(manifest.name)) {
			throw new Error(`tool name "${manifest.name}" is reserved by the runtime`);
		}
		const definition = this.createFacade(manifest);
		this.options.pi.registerTool(definition);
		if (activate) {
			const active = this.options.pi.getActiveTools();
			if (!active.includes(manifest.name)) {
				this.options.pi.setActiveTools([...active, manifest.name]);
			}
		}
		const registered = { manifest, definition };
		this.tools.set(manifest.name, registered);
		void this.supervisor.startEager(manifest).catch((error) => {
			this.options.log(`failed to start eager services for ${manifest.name}: ${String(error)}`);
		});
		return registered;
	}

	private createFacade(manifest: ToolManifest): ToolDefinition {
		return {
			name: manifest.name,
			label: manifest.name,
			description: formatToolDescription(manifest),
			promptSnippet: manifest.description,
			promptGuidelines: manifest.whenToUse ?? [],
			parameters: Type.Unsafe(facadeInputSchema(manifest)),
			outputSchema: envelopeSchema(manifest.output),
			exposure: manifest.exposure ?? "direct",
			namespace: manifest.namespace
				? { name: manifest.namespace, description: "Tools registered by pi-tool-runtime" }
				: undefined,
			annotations: manifest.annotations,
			executionMode: "parallel",
			execute: async (_id, params, signal, onUpdate, ctx) => {
				this.lastIsIdle = () => ctx.isIdle();
				const input = params as Record<string, unknown>;
				return this.execute(manifest, input, signal, ctx, (partial) => {
					onUpdate?.(partial as never);
				});
			},
		};
	}

	private defaultModel(): string | undefined {
		try {
			this.settingsManager ??= SettingsManager.create(this.options.cwd, this.options.agentDir);
			const provider = this.settingsManager.getDefaultProvider();
			const model = this.settingsManager.getDefaultModel();
			return provider && model ? `${provider}/${model}` : undefined;
		} catch (error) {
			this.options.log(`failed to read the default model from settings: ${String(error)}`);
			return undefined;
		}
	}

	private progressRoot(): string {
		return path.join(this.options.cwd, ".pi", "jobs");
	}

	private watchProgress(jobId: string, ui?: ProgressUi, onUpdate?: ProgressUpdateSink): void {
		if (!ui || this.progressWatchers.has(jobId)) return;
		const watcher = new ProgressWatcher({
			jobsRoot: this.progressRoot(),
			ui,
			log: this.options.log,
			onUpdate,
		});
		this.progressWatchers.set(jobId, watcher);
		watcher.start(jobId);
	}

	async progress(jobId?: string, limit = 8): Promise<ProgressSnapshot> {
		return snapshotProgress({ jobsRoot: this.progressRoot(), jobId, limit });
	}

	private async execute(
		manifest: ToolManifest,
		input: Record<string, unknown>,
		signal: AbortSignal | undefined,
		ctx: {
			isIdle(): boolean;
			sessionManager?: { getSessionId?(): string };
			cwd?: string;
			ui?: ProgressUi;
			hasUI?: boolean;
		},
		onUpdate?: ProgressUpdateSink,
	) {
		const schema = facadeInputSchema(manifest);
		const errors = validateValue(schema as never, input);
		const declared = new Set(Object.keys(schema.properties ?? {}));
		for (const key of Object.keys(input)) {
			if (!declared.has(key)) {
				errors.push(`${key}: not declared by the tool input contract`);
			}
		}
		if (errors.length > 0) {
			const envelope: ToolEnvelope = {
				status: "failed",
				summary: `Input does not match the tool contract for ${manifest.name}. Send only the declared input fields.`,
				warnings: errors,
			};
			return this.toolResult(envelope, manifest, undefined, true);
		}

		const mode = (input.mode as ToolMode | undefined) ?? manifest.execution?.defaultMode ?? "sync";
		const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
		const existingJobId = typeof input.jobId === "string" ? input.jobId : undefined;
		const jobInput = { ...input };
		delete jobInput.mode;
		delete jobInput.timeoutMs;
		delete jobInput.jobId;

		if (manifest.kind === "direct") {
			const envelope = await executeDirectTool(manifest, jobInput, this.supervisor);
			return this.toolResult(envelope, manifest, undefined, envelope.status === "failed");
		}

		if (existingJobId && (mode === "status" || mode === "result" || mode === "cancel" || mode === "wait")) {
			if (mode === "cancel") {
				const envelope = await this.jobs.handle({ action: "cancel", jobId: existingJobId });
				return this.toolResult(envelope, manifest, await this.jobs.get(existingJobId), envelope.status === "failed");
			}
			if (mode === "wait") this.watchProgress(existingJobId, ctx.ui, onUpdate);
			const record =
				mode === "wait"
					? await this.jobs.wait(existingJobId, timeoutMs)
					: await this.jobs.get(existingJobId);
			if (!record) {
				return this.toolResult(
					{ status: "failed", summary: `Unknown job: ${existingJobId}` },
					manifest,
					undefined,
					true,
				);
			}
			const terminal = ["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(record.state);
			if (terminal && record.result) {
				return this.toolResult(record.result, manifest, record, record.result.status === "failed");
			}
			return this.toolResult(
				{
					status: "accepted",
					summary: `Job ${record.id} is ${record.state}.`,
					jobId: record.id,
				},
				manifest,
				record,
				false,
			);
		}

		const job = await this.jobs.create({
			manifest,
			input: jobInput,
			mode,
			cwd: ctx.cwd ?? this.options.cwd,
			projectTrusted: this.options.projectTrusted,
			requester: { sessionId: ctx.sessionManager?.getSessionId?.(), idle: ctx.isIdle() },
			model: this.defaultModel(),
		});
		this.watchProgress(job.id, ctx.ui, onUpdate);

		if (mode === "start") {
			return this.toolResult(
				{
					status: "accepted",
					summary: `Job ${job.id} accepted. Use ${manifest.name} with mode=status, wait, result, or cancel and jobId=${job.id}.`,
					jobId: job.id,
				},
				manifest,
				job,
				false,
			);
		}

		const finished = await this.jobs.wait(job.id, mode === "wait" ? timeoutMs : undefined);
		if (!finished) {
			return this.toolResult(
				{ status: "failed", summary: `Job ${job.id} was not found.` },
				manifest,
				job,
				true,
			);
		}
		if (finished.state === "succeeded" || finished.state === "failed" || finished.state === "cancelled") {
			const envelope = finished.result ?? {
				status: finished.state === "succeeded" ? "ok" : "failed",
				summary: finished.error ?? finished.message ?? `Job ${finished.id} is ${finished.state}.`,
				jobId: finished.id,
			};
			return this.toolResult(envelope, manifest, finished, envelope.status === "failed");
		}
		return this.toolResult(
			{
				status: "accepted",
				summary: `Job ${job.id} is still ${finished.state}.`,
				jobId: job.id,
			},
			manifest,
			finished,
			false,
		);
	}

	private toolResult(
		envelope: ToolEnvelope,
		manifest: ToolManifest,
		job?: JobRecord,
		isError = false,
	) {
		const maxBytes = manifest.limits?.maxResultBytes ?? 20_000;
		const text = truncate(
			[
				envelope.summary,
				envelope.warnings?.length ? `Warnings:\n- ${envelope.warnings.join("\n- ")}` : "",
				envelope.result !== undefined ? `Result:\n${JSON.stringify(envelope.result, null, 2)}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
			maxBytes,
		);
		return {
			content: [{ type: "text" as const, text }],
			structuredContent: envelope as never,
			details: {
				tool: manifest.name,
				version: manifest.version,
				jobId: job?.id ?? envelope.jobId,
				jobState: job?.state,
				sessionFile: (job as JobRecord & { sessionFile?: string })?.sessionFile,
			},
			isError,
		};
	}

	private notify(job: JobRecord): void {
		if (job.mode !== "start") return;
		const registered = this.tools.get(job.tool);
		if (!registered?.manifest.execution?.notifyOnIdle) return;
		const message = {
			customType: "tool_job_completed",
			content: `Job ${job.id} for tool ${job.tool} is ${job.state}. ${job.message ?? job.error ?? ""} Use ${job.tool} with mode=result and jobId=${job.id} to read it.`.trim(),
			display: true,
			details: { jobId: job.id, tool: job.tool, state: job.state },
		};
		if (this.lastIsIdle?.()) {
			this.options.pi.sendMessage(message, { triggerTurn: true });
		} else {
			this.options.pi.sendMessage(message, { deliverAs: "followUp" });
		}
	}

	async handleJobTool(input: JobToolInput): Promise<ToolEnvelope> {
		return this.jobs.handle(input);
	}

	async handleToolAdd(input: ToolAddInput, ctx: { cwd: string; isProjectTrusted(): boolean }): Promise<ToolEnvelope> {
		if (input.action === "list") {
			return {
				status: "ok",
				summary: `${this.tools.size} tool(s) registered.`,
				result: {
					tools: [...this.tools.values()].map(({ manifest }) => ({
						name: manifest.name,
						version: manifest.version,
						kind: manifest.kind,
						description: manifest.description,
					})),
				},
			};
		}
		if (input.action === "inspect") {
			const registered = input.name ? this.tools.get(input.name) : undefined;
			if (!registered) return { status: "failed", summary: `Unknown tool: ${input.name ?? "(none)"}` };
			return { status: "ok", summary: `Tool ${registered.manifest.name}.`, result: registered.manifest };
		}

		if (input.action === "convert_skill") {
			const skillPath = input.source?.path;
			if (!skillPath) return { status: "failed", summary: "source.path is required for convert_skill." };
			return this.convertSkill(skillPath, input, ctx);
		}

		if (input.action === "add") {
			return this.addTool(input, ctx);
		}

		if (input.action === "disable" || input.action === "enable") {
			const registered = input.name ? this.tools.get(input.name) : undefined;
			if (!registered) return { status: "failed", summary: `Unknown tool: ${input.name ?? "(none)"}` };
			const dir = registered.manifest.dir;
			if (!dir) return { status: "failed", summary: `Tool ${registered.manifest.name} has no directory.` };
			const marker = path.join(dir, ".disabled");
			if (input.action === "disable") {
				await fs.writeFile(marker, new Date().toISOString(), "utf8");
				this.options.pi.registerTool({ ...registered.definition, exposure: "hidden" });
				const active = this.options.pi.getActiveTools().filter((name) => name !== registered.manifest.name);
				this.options.pi.setActiveTools(active);
				return { status: "ok", summary: `Tool ${registered.manifest.name} disabled.` };
			}
			await fs.rm(marker, { force: true });
			this.register(registered.manifest, input.activate ?? true);
			return { status: "ok", summary: `Tool ${registered.manifest.name} enabled.` };
		}

		if (input.action === "validate") {
			const result = validateManifest(input.manifest, undefined);
			return {
				status: result.errors.length ? "failed" : "ok",
				summary: result.errors.length ? "Manifest validation failed." : "Manifest is valid.",
				result: { errors: result.errors, warnings: result.warnings },
				warnings: result.warnings,
			};
		}

		return { status: "failed", summary: `Unsupported action: ${input.action}` };
	}

	private scopeRoot(scope: "project" | "user", ctx: { cwd: string }): string {
		return scope === "user"
			? path.join(this.options.agentDir, "tools")
			: path.join(ctx.cwd, ".pi", "tools");
	}

	private async addTool(input: ToolAddInput, ctx: { cwd: string; isProjectTrusted(): boolean }): Promise<ToolEnvelope> {
		let manifest: ToolManifest;
		let sourceDir: string | undefined;
		if (input.manifest) {
			const result = validateManifest(input.manifest);
			if (!result.manifest || result.errors.length > 0) {
				return { status: "failed", summary: "Manifest validation failed.", warnings: result.errors };
			}
			manifest = result.manifest;
		} else if (input.source?.path) {
			const absolute = path.resolve(input.source.path);
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
			return { status: "failed", summary: "manifest or source.path is required for add." };
		}

		const scope = input.scope ?? "project";
		if (RESERVED_TOOL_NAMES.has(manifest.name) && !this.tools.has(manifest.name)) {
			return { status: "failed", summary: `Tool name "${manifest.name}" is reserved by the runtime.` };
		}
		if (scope === "project" && !ctx.isProjectTrusted()) {
			return { status: "needs_input", summary: "Project is not trusted; cannot create a project tool." };
		}
		const dir = path.join(this.scopeRoot(scope, ctx), manifest.name);
		if (!input.replace) {
			try {
				await fs.access(dir);
				return { status: "failed", summary: `Tool directory already exists: ${dir}` };
			} catch {
				// expected
			}
		}
		await fs.mkdir(dir, { recursive: true });
		if (sourceDir && path.resolve(sourceDir) !== path.resolve(dir)) {
			await fs.cp(sourceDir, dir, { recursive: true, force: true });
		}
		const persisted = { ...manifest };
		delete persisted.dir;
		await atomicWrite(path.join(dir, "TOOL.json"), `${JSON.stringify(persisted, null, 2)}\n`);
		if (manifest.kind === "agent") {
			await this.ensureAgentFiles(dir, manifest, input);
		}
		manifest.dir = dir;
		manifest.scope = scope;
		this.register(manifest, input.activate ?? true);
		return {
			status: "ok",
			summary: `Tool ${manifest.name} added.`,
			result: { name: manifest.name, version: manifest.version, kind: manifest.kind, dir, scope },
		};
	}

	private async ensureAgentFiles(dir: string, manifest: ToolManifest, input: ToolAddInput): Promise<void> {
		const agentPath = path.join(dir, manifest.agent?.instructions ?? "AGENT.md");
		const workflowPath = path.join(dir, manifest.agent?.workflow ?? "WORKFLOW.md");
		const agentExists = await fs.access(agentPath).then(() => true).catch(() => false);
		if (!agentExists) {
			const instructions =
				input.instructions ??
				[
					`You are the persistent worker for the tool "${manifest.name}".`,
					"",
					manifest.description,
					"",
					"Work on one job at a time. Use only the tools listed in the tool contract.",
					"Finish by calling submit_result with a structured result.",
				].join("\n");
			await atomicWrite(agentPath, `${instructions}\n`);
		}
		const workflowExists = await fs.access(workflowPath).then(() => true).catch(() => false);
		if (!workflowExists) {
			const workflow =
				input.workflow ??
				[
					"# Workflow",
					"",
					"1. Read the delegated task and optional input.",
					"2. Follow the agent instructions in the system prompt.",
					"3. Use the declared tools and services when needed.",
					"4. If required information is missing, submit status needs_input.",
					"5. Call submit_result with a short summary and the structured result.",
				].join("\n");
			await atomicWrite(workflowPath, `${workflow}\n`);
		}
		if (input.examples) {
			await atomicWrite(path.join(dir, manifest.agent?.examples ?? "EXAMPLES.md"), `${input.examples}\n`);
		}
	}

	private async convertSkill(
		skillPath: string,
		input: ToolAddInput,
		ctx: { cwd: string; isProjectTrusted(): boolean },
	): Promise<ToolEnvelope> {
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
		let plan: SkillConverterPlan | undefined;
		try {
			plan = await runSkillConverter({
				skillDir: path.dirname(absolute),
				skillFile: absolute,
				content,
				cwd: ctx.cwd,
				agentDir: this.options.agentDir,
				modelRuntime: this.options.modelRuntime,
				supervisor: this.supervisor,
				log: this.options.log,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`converter agent failed; using deterministic conversion: ${message}`);
			this.options.log(warnings[warnings.length - 1]);
		}

		const fallbackName = safeToolName(path.basename(path.dirname(absolute)));
		const frontmatterName =
			typeof parsed.frontmatter.name === "string" ? safeToolName(parsed.frontmatter.name) : fallbackName;
		const name = input.name ?? plan?.name ?? frontmatterName;
		const description =
			plan?.description ??
			(typeof parsed.frontmatter.description === "string"
				? parsed.frontmatter.description
				: `Skill-backed tool converted from ${absolute}. Use when the task matches the original skill.`);
		if (RESERVED_TOOL_NAMES.has(name) && !this.tools.has(name)) {
			return { status: "failed", summary: `Tool name "${name}" is reserved by the runtime.` };
		}
		const dir = path.join(this.scopeRoot(scope, ctx), name);
		if (!input.replace) {
			try {
				await fs.access(dir);
				return { status: "failed", summary: `Tool directory already exists: ${dir}` };
			} catch {
				// expected
			}
		}
		await fs.mkdir(dir, { recursive: true });

		const defaultInput = {
			type: "object",
			properties: {
				task: { type: "string", description: "The task for the worker." },
				input: { type: "object", description: "Optional structured input." },
				context: { type: "string", description: "Optional context from the caller." },
			},
			required: ["task"],
			additionalProperties: false,
		};
		const defaultOutput = {
			type: "object",
			properties: {
				summary: { type: "string" },
				result: { type: "object" },
			},
			required: ["summary"],
			additionalProperties: false,
		};

		const manifest: ToolManifest = {
			name,
			version: "0.1.0",
			contractVersion: "0.1.0",
			description,
			whenToUse:
				plan?.whenToUse && plan.whenToUse.length > 0
					? plan.whenToUse
					: ["Use when the task matches the original skill description."],
			notFor: plan?.notFor ?? [],
			kind: "agent",
			input: plan?.input ?? defaultInput,
			output: plan?.output ?? defaultOutput,
			agent: {
				instructions: "AGENT.md",
				workflow: "WORKFLOW.md",
				examples: plan?.agent.examples ? "EXAMPLES.md" : undefined,
				tools: plan?.agent.tools ?? ["read", "grep", "find", "ls"],
				maxTurns: plan?.agent.maxTurns ?? 30,
				sessionScope: "project",
				memoryScope: "project",
				resolution: "user-first",
				createProjectIfMissing: true,
				requireProjectTrust: true,
				contractRange: "^0.1.0",
			},
			permissions: {
				read: plan?.permissions?.read ?? true,
				write: plan?.permissions?.write ?? false,
				bash: plan?.permissions?.bash ?? false,
				network: plan?.permissions?.network ?? false,
			},
			limits: { maxInputBytes: 1_048_576, maxResultBytes: 20_000, jobTimeoutMs: 600_000 },
			execution: { defaultMode: "start", notifyOnIdle: true, asyncByDefault: true },
			exposure: "direct",
			namespace: "tool",
		};
		if (plan?.services && Object.keys(plan.services).length > 0) {
			manifest.services = plan.services;
		}
		manifest.dir = dir;
		manifest.scope = scope;

		const agentInstructions =
			plan?.agent.instructions ??
			[
				`You are the persistent worker for the tool "${name}".`,
				"",
				"Follow the skill instructions below. Work on one job at a time.",
				"Finish by calling submit_result.",
				"",
				"<skill_instructions>",
				parsed.body.trim(),
				"</skill_instructions>",
			].join("\n");
		const workflow =
			plan?.agent.workflow ??
			[
				"# Workflow",
				"",
				"1. Read the delegated task and supplied input.",
				"2. Follow the skill instructions in the system prompt.",
				"3. Use only the tools listed in the tool contract.",
				"4. If required information is missing, submit status needs_input.",
				"5. Call submit_result with a short summary and the structured result.",
			].join("\n");

		const validation = validateManifest(manifest, dir);
		if (!validation.manifest || validation.errors.length > 0) {
			return {
				status: "failed",
				summary: "Generated manifest failed validation.",
				warnings: [...warnings, ...validation.errors],
			};
		}
		const persisted = { ...validation.manifest };
		delete persisted.dir;
		await atomicWrite(path.join(dir, "TOOL.json"), `${JSON.stringify(persisted, null, 2)}\n`);
		await atomicWrite(path.join(dir, "AGENT.md"), `${agentInstructions}\n`);
		await atomicWrite(path.join(dir, "WORKFLOW.md"), `${workflow}\n`);
		if (plan?.agent.examples) {
			await atomicWrite(path.join(dir, "EXAMPLES.md"), `${plan.agent.examples}\n`);
		}
		this.register(validation.manifest, input.activate ?? true);
		return {
			status: "ok",
			summary: `Skill ${absolute} converted to tool ${name} using the ${plan ? "converter agent" : "deterministic fallback"}.`,
			result: {
				name,
				version: "0.1.0",
				dir,
				scope,
				source: absolute,
				conversionMode: plan ? "agent" : "deterministic",
				converterAgent: plan ? path.join(this.options.agentDir, "agents", "skill_converter.md") : undefined,
				notes: plan?.notes,
			},
			warnings,
		};
	}

	async close(): Promise<void> {
		for (const watcher of this.progressWatchers.values()) watcher.stopAll();
		this.progressWatchers.clear();
		await this.supervisor.close();
	}
}

