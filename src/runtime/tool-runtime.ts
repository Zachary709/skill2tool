import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	SettingsManager,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadTools, type ToolLoadDiagnostic, type ToolSource } from "../discovery/manifest.ts";
import { validateValue, envelopeSchema } from "../contracts/schema.ts";
import { callerPromptGuidelines, compactTaskInputSchema } from "../contracts/caller.ts";
import { JobManager } from "../jobs/manager.ts";
import { ServiceSupervisor } from "../services/supervisor.ts";
import { AgentWorker } from "../agents/worker.ts";
import { resolveAgent } from "../agents/resolver.ts";
import { executeDirectTool } from "./direct-executor.ts";
import { TOOL_ADD_MANAGE_SCHEMA, ToolAddManager } from "../../basic-tools/tool_add/manager.ts";
import {
	InlineProgress,
	ProgressWatcher,
	listJobs,
	snapshotProgress,
	type JobSummary,
	type ProgressSnapshot,
	type ProgressUi,
	type ProgressUpdateSink,
} from "../observability/progress.ts";
import type {
	AgentConfig,
	JobRecord,
	JobToolInput,
	ToolAddManageInput,
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

function packageToolsRoot(): string {
	return fileURLToPath(new URL("../../basic-tools", import.meta.url));
}

function facadeInputSchema(manifest: ToolManifest) {
	const input = manifest.kind === "agent" ? compactTaskInputSchema(manifest.input) : manifest.input;
	const properties: Record<string, unknown> = {
		...(input.properties ?? {}),
	};
	const supportsJobs = manifest.kind === "agent" && !manifest.handler && manifest.execution?.asyncByDefault !== false;
	if (supportsJobs) {
		properties.mode = {
			type: "string",
			enum: ["sync", "start", "wait", "status", "result", "cancel"],
			description:
				"sync waits for a new job, start returns a job handle, wait waits for a job, status/result/cancel operate on an existing job. Job-control modes need only mode and jobId.",
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
	const schema: Record<string, unknown> = {
		...input,
		type: "object",
		properties,
	};
	if (supportsJobs) {
		// A job-control call does not repeat the task fields. The runtime enforces
		// the task contract only when a job is created.
		delete schema.required;
	}
	return schema;
}

function truncate(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	return `${Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - 80)).toString("utf8")}\n...[truncated]`;
}

function formatToolDescription(manifest: ToolManifest): string {
	const lines = [manifest.description.trim()];
	if (manifest.whenToUse?.length) lines.push(`Use when: ${manifest.whenToUse.join("; ")}`);
	if (manifest.notFor?.length) lines.push(`Do not use for: ${manifest.notFor.join("; ")}`);
	if (manifest.kind === "agent" && !manifest.handler) {
		lines.push(
			manifest.execution?.asyncByDefault === false
				? "This tool delegates to a persistent worker and runs one job to completion."
				: "This tool delegates to a persistent worker. It accepts mode=start to return a job handle.",
		);
	}
	return lines.join("\n");
}

export class ToolRuntime {
	private readonly tools = new Map<string, RegisteredTool>();
	private readonly supervisor: ServiceSupervisor;
	private readonly jobs: JobManager;
	private readonly toolAdd: ToolAddManager;
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
		this.toolAdd = new ToolAddManager({
			agentDir: options.agentDir,
			listTools: () => [...this.tools.values()].map(({ manifest }) => manifest),
			getTool: (name) => this.tools.get(name)?.manifest,
			register: (manifest, activate) => {
				this.register(manifest, activate);
			},
			setEnabled: (name, enabled, activate) => this.setToolEnabled(name, enabled, activate),
			isReserved: (name) => RESERVED_TOOL_NAMES.has(name),
		});
	}

	get diagnostics(): ToolLoadDiagnostic[] {
		return this.loadDiagnostics;
	}

	private loadDiagnostics: ToolLoadDiagnostic[] = [];

	private sources(): ToolSource[] {
		const sources: ToolSource[] = [
			// Package tools ship with the runtime and load before user and project tools.
			{ root: packageToolsRoot(), scope: "package" },
			{ root: path.join(this.options.agentDir, "tools"), scope: "user" },
			{ root: path.join(this.options.cwd, ".pi", "tools"), scope: "project" },
		];
		return sources;
	}

	private async setToolEnabled(name: string, enabled: boolean, activate: boolean): Promise<void> {
		const registered = this.tools.get(name);
		if (!registered) throw new Error(`Unknown tool: ${name}`);
		const dir = registered.manifest.dir;
		if (!dir) throw new Error(`Tool ${name} has no directory.`);
		const marker = path.join(dir, ".disabled");
		if (!enabled) {
			await fs.writeFile(marker, new Date().toISOString(), "utf8");
			this.options.pi.registerTool({ ...registered.definition, exposure: "hidden" });
			const active = this.options.pi.getActiveTools().filter((entry) => entry !== name);
			this.options.pi.setActiveTools(active);
			return;
		}
		await fs.rm(marker, { force: true });
		this.register(registered.manifest, activate);
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
		if (RESERVED_TOOL_NAMES.has(manifest.name) && manifest.scope !== "package") {
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
			promptGuidelines: callerPromptGuidelines(manifest),
			parameters: Type.Unsafe(facadeInputSchema(manifest)),
			outputSchema: envelopeSchema(manifest.output),
			exposure: manifest.exposure ?? "direct",
			namespace: manifest.namespace
				? { name: manifest.namespace, description: "Tools registered by pi-tool-runtime" }
				: undefined,
			annotations: manifest.annotations,
			executionMode: manifest.handler ? "sequential" : "parallel",
			execute: async (_id, params, signal, onUpdate, ctx) => {
				this.lastIsIdle = () => ctx.isIdle();
				const input = params as Record<string, unknown>;
				return this.execute(manifest, input, signal, ctx, (partial) => {
					onUpdate?.(partial as never);
				});
			},
		};
	}

	private async runHandlerAgent(
		manifest: ToolManifest,
		input: Record<string, unknown>,
		mode: ToolMode,
		signal: AbortSignal | undefined,
		ctx: {
			cwd?: string;
			isProjectTrusted?(): boolean;
			ui?: ProgressUi;
			model?: { provider: string; id: string };
			thinkingLevel?: AgentConfig["thinkingLevel"];
		},
		extraTools: ToolDefinition[],
	): Promise<ToolEnvelope> {
		if (mode !== "sync") {
			return {
				status: "failed",
				summary: `${manifest.name} manages live runtime state, so it runs in process and supports only sync mode.`,
			};
		}
		const cwd = ctx.cwd ?? this.options.cwd;
		const resolution = await resolveAgent({
			tool: manifest,
			cwd,
			agentDir: this.options.agentDir,
			projectTrusted: this.options.projectTrusted,
			allowCreateProject: manifest.agent?.createProjectIfMissing ?? false,
		});
		if (!resolution.agent) {
			return {
				status: "failed",
				summary: resolution.error ?? `No usable agent for ${manifest.name}.`,
				warnings: resolution.warnings,
			};
		}
		const inline = ctx.ui ? new InlineProgress({ ui: ctx.ui, title: manifest.name }) : undefined;
		const worker = new AgentWorker(
			manifest,
			resolution.agent,
			cwd,
			this.options.agentDir,
			this.options.modelRuntime,
			this.supervisor,
			this.options.log,
			(entry) => {
				if (inline) {
					inline.push(entry);
					return;
				}
				this.options.log(`[${manifest.name}] ${entry.kind}: ${entry.text.slice(0, 300)}`);
			},
			this.callerSettings(ctx).model,
			extraTools,
			{},
			this.callerSettings(ctx).thinkingLevel,
		);
		try {
			const result = await worker.run(
				{
					task: `Handle this ${manifest.name} request and finish with submit_result.`,
					input,
					context: `Project directory: ${cwd}`,
				},
				signal,
			);
			return {
				...result.envelope,
				usage: result.usage,
				...(result.warnings.length ? { warnings: [...(result.envelope.warnings ?? []), ...result.warnings] } : {}),
			};
		} catch (error) {
			return {
				status: "failed",
				summary: `${manifest.name} worker failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			await worker.dispose();
			inline?.stop();
		}
	}

	private toolAddManageTool(cwd: string): ToolDefinition {
		const parameters = Type.Unsafe(TOOL_ADD_MANAGE_SCHEMA);
		return {
			name: "tool_add_manage",
			label: "Manage tools",
			description:
				"Run one tool_add management action. For convert_skill and create_tool, pass the complete plan built from the skill or the requirements.",
			parameters,
			execute: async (_id, params) => {
				const request = { ...(params as Record<string, unknown>) };
				if (typeof request.plan === "string") {
					try {
						request.plan = JSON.parse(request.plan);
					} catch (error) {
						return {
							content: [
								{
									type: "text" as const,
									text: `plan must be a JSON object, not a serialized string: ${String(error)}`,
								},
							],
							details: undefined,
							isError: true,
						};
					}
				}
				if (
					request.plan !== undefined &&
					(typeof request.plan !== "object" || request.plan === null || Array.isArray(request.plan))
				) {
					return {
						content: [{ type: "text" as const, text: "plan must be a JSON object." }],
						details: undefined,
						isError: true,
					};
				}
				const envelope = await this.toolAdd.handle(request as unknown as ToolAddManageInput, {
					cwd,
					isProjectTrusted: () => this.options.projectTrusted,
				});
				const text = [
					envelope.summary,
					envelope.warnings?.length ? `Warnings:
- ${envelope.warnings.join("\n- ")}` : "",
					envelope.result !== undefined ? JSON.stringify(envelope.result, null, 2) : "",
				]
					.filter(Boolean)
					.join("\n\n");
				return {
					content: [{ type: "text" as const, text }],
					details: envelope,
					isError: envelope.status === "failed",
				};
			},
		};
	}

	private daemonTargets(toolName?: string, serviceName?: string): Array<{ manifest: ToolManifest; name: string }> {
		const targets: Array<{ manifest: ToolManifest; name: string }> = [];
		for (const { manifest } of this.tools.values()) {
			for (const [name, service] of Object.entries(manifest.services ?? {})) {
				if (service.type !== "daemon") continue;
				if (toolName && manifest.name !== toolName) continue;
				if (serviceName && name !== serviceName) continue;
				targets.push({ manifest, name });
			}
		}
		return targets;
	}

	private serviceKeeperManageTool(): ToolDefinition {
		return {
			name: "service_keeper_manage",
			label: "Maintain tool daemons",
			description:
				"List, inspect, or restart daemons declared by installed tools. The runtime owns these processes, so a restart must run through this tool and not through bash.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("restart")]),
				tool: Type.Optional(Type.String()),
				service: Type.Optional(Type.String()),
			}),
			execute: async (_id, params) => {
				const input = params as { action: string; tool?: string; service?: string };
				try {
					if (input.action === "restart") {
						if (!input.tool || !input.service) {
							return {
								content: [{ type: "text" as const, text: "restart requires tool and service." }],
								details: undefined,
								isError: true,
							};
						}
						const manifest = this.tools.get(input.tool)?.manifest;
						if (!manifest) throw new Error(`unknown tool "${input.tool}"`);
						const status = await this.supervisor.restartDaemon(manifest, input.service);
						return {
							content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
							details: status,
						};
					}
					const targets = this.daemonTargets(input.tool, input.service);
					if (input.action === "status" && (!input.tool || !input.service)) {
						return {
							content: [{ type: "text" as const, text: "status requires tool and service." }],
							details: undefined,
							isError: true,
						};
					}
					const statuses = [];
					for (const target of targets) {
						try {
							statuses.push(await this.supervisor.daemonStatus(target.manifest, target.name));
						} catch (error) {
							statuses.push({
								tool: target.manifest.name,
								service: target.name,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
					return {
						content: [{ type: "text" as const, text: JSON.stringify(statuses, null, 2) }],
						details: { statuses },
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `service_keeper_manage failed: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
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

	private callerSettings(ctx: {
		model?: { provider: string; id: string };
		thinkingLevel?: AgentConfig["thinkingLevel"];
	}) {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : this.defaultModel();
		let thinkingLevel: AgentConfig["thinkingLevel"] = ctx.thinkingLevel ?? this.options.pi.getThinkingLevel?.();
		if (thinkingLevel === undefined) {
			this.settingsManager ??= SettingsManager.create(this.options.cwd, this.options.agentDir);
			const slash = model?.indexOf("/") ?? -1;
			thinkingLevel = model && slash >= 0
				? this.settingsManager.getModelThinkingLevel(model.slice(0, slash), model.slice(slash + 1))
				: undefined;
			thinkingLevel ??= this.settingsManager.getDefaultThinkingLevel();
		}
		return { model, thinkingLevel };
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

	async progress(reference?: string, limit = 8): Promise<ProgressSnapshot> {
		return snapshotProgress({ jobsRoot: this.progressRoot(), reference, limit });
	}

	async progressJobs(): Promise<JobSummary[]> {
		return listJobs(this.progressRoot());
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
			model?: { provider: string; id: string };
			thinkingLevel?: AgentConfig["thinkingLevel"];
		},
		onUpdate?: ProgressUpdateSink,
	) {
		const schema = facadeInputSchema(manifest);
		const errors = validateValue(schema as never, input);
		const mode = (input.mode as ToolMode | undefined) ?? manifest.execution?.defaultMode ?? "sync";
		const jobControl = ["status", "wait", "result", "cancel"].includes(mode);
		if (!jobControl) {
			for (const field of manifest.input.required ?? []) {
				if (!(field in input)) errors.push(`${field}: required by the task contract`);
			}
		}
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

		const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
		const existingJobId = typeof input.jobId === "string" ? input.jobId : undefined;
		const jobInput = { ...input };
		delete jobInput.mode;
		delete jobInput.timeoutMs;
		delete jobInput.jobId;

		if (manifest.handler) {
			const extraTools =
				manifest.handler === "tool_add"
					? [this.toolAddManageTool(ctx.cwd ?? this.options.cwd)]
					: [this.serviceKeeperManageTool()];
			const envelope = await this.runHandlerAgent(manifest, jobInput, mode, signal, ctx, extraTools);
			return this.toolResult(envelope, manifest, undefined, envelope.status === "failed");
		}

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
			...this.callerSettings(ctx),
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

	async close(): Promise<void> {
		for (const watcher of this.progressWatchers.values()) watcher.stopAll();
		this.progressWatchers.clear();
		await this.supervisor.close();
	}
}

