import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadTools, type ToolLoadDiagnostic, type ToolSource } from "../discovery/manifest.ts";
import { DISCOVERY_TOOL_NAMES, ToolDiscovery } from "../discovery/tools.ts";
import {
	catalogDefaultActive,
	catalogExposure,
	catalogOverview,
	catalogTargets,
	formatCatalog,
	toolCategory,
	toolNamespace,
	type ToolCatalogEntry,
} from "../discovery/catalog.ts";
import { validateValue, envelopeSchema } from "../contracts/schema.ts";
import { callerPromptGuidelines, compactTaskInputSchema } from "../contracts/caller.ts";
import { JobManager } from "../jobs/manager.ts";
import { parseToolModel, readToolModel } from "../agents/tool-model.ts";
import { ServiceSupervisor } from "../services/supervisor.ts";
import { randomUUID } from "node:crypto";
import { TOOL_ADD_MANAGE_SCHEMA, ToolAddManager } from "../../basic-tools/tool_add/manager.ts";
import {
	ProgressWatcher,
	listJobs,
	snapshotProgress,
	snapshotFromRecord,
	resolveJobReference,
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
	discovery?: ToolDiscovery;
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
	"tool_search",
	"tool_find",
	"tool_use",
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
	lines.push(`Category: ${toolCategory(manifest)}`);
	if (manifest.tags?.length) lines.push(`Keywords: ${manifest.tags.join("; ")}`);
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
	private readonly discovery: ToolDiscovery;
	private readonly progressWatchers = new Map<string, ProgressWatcher>();
	private settingsManager?: SettingsManager;
	private lastIsIdle?: () => boolean;
	private readonly runs = new Map<string, string>();
	private readonly signalRuns = new WeakMap<AbortSignal, string>();
	private readonly cancelledTools = new Map<string, Set<string>>();
	private closed = false;
	private stopCatalogPrompt?: () => void;

	private readonly options: ToolRuntimeOptions;

	constructor(options: ToolRuntimeOptions) {
		this.options = options;
		this.discovery = options.discovery ?? new ToolDiscovery(options.pi);
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
			service: (manifest, name, input, signal) => this.supervisor.call(manifest, name, input, signal),
		});
		this.toolAdd = new ToolAddManager({
			agentDir: options.agentDir,
			listTools: () => [...this.tools.values()].map(({ manifest }) => manifest),
			getTool: (name) => this.tools.get(name)?.manifest,
			register: (manifest, activate) => {
				this.register(manifest, activate);
			},
			setEnabled: (name, enabled, activate, signal) => this.setToolEnabled(name, enabled, activate, signal),
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

	private async setToolEnabled(name: string, enabled: boolean, activate: boolean, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const registered = this.tools.get(name);
		if (!registered) throw new Error(`Unknown tool: ${name}`);
		const dir = registered.manifest.dir;
		if (!dir) throw new Error(`Tool ${name} has no directory.`);
		const marker = path.join(dir, ".disabled");
		if (!enabled) {
			this.discovery.suppressPromotion([name]);
			await fs.writeFile(marker, new Date().toISOString(), "utf8");
			signal?.throwIfAborted();
			this.options.pi.registerTool({ ...registered.definition, exposure: "hidden" });
			const active = this.options.pi.getActiveTools().filter((entry) => entry !== name);
			this.options.pi.setActiveTools(active);
			return;
		}
		await fs.rm(marker, { force: true });
		signal?.throwIfAborted();
		this.register(registered.manifest, activate);
	}

	async initialize(): Promise<void> {
		this.discovery.start();
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
				this.register(tool.manifest);
			} catch (error) {
				this.options.log(`failed to register tool ${tool.manifest.name}: ${String(error)}`);
			}
		}
		this.stopCatalogPrompt = this.options.pi.on("before_agent_start", (event) => {
			const overview = catalogOverview(this.catalogEntries());
			if (overview) event.systemPromptOptions.sections.tool_catalog = overview;
			else delete event.systemPromptOptions.sections.tool_catalog;
		});
	}

	register(manifest: ToolManifest, activate = catalogDefaultActive(manifest)): RegisteredTool {
		if (this.closed) throw new Error("工具运行时已关闭");
		if (RESERVED_TOOL_NAMES.has(manifest.name) && manifest.scope !== "package") {
			throw new Error(`tool name "${manifest.name}" is reserved by the runtime`);
		}
		if (manifest.scope === "project" && !this.options.projectTrusted) throw new Error("项目未受信任，不能注册项目工具。");
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
			defaultActive: false,
			exposure: catalogExposure(manifest),
			namespace: toolNamespace(manifest),
			annotations: manifest.annotations,
			executionMode: manifest.handler ? "sequential" : "parallel",
			execute: async (id, params, signal, onUpdate, ctx) => {
				this.lastIsIdle = () => ctx.isIdle();
				const input = params as Record<string, unknown>;
				return this.execute(manifest, input, signal, ctx, onUpdate ? (partial) => {
					onUpdate(partial as never);
				} : undefined, id);
			},
		};
	}

	catalogEntries(): ToolCatalogEntry[] {
		const active = new Set(this.options.pi.getActiveTools());
		return this.options.pi.getAllTools().flatMap((tool) => {
			const manifest = this.tools.get(tool.name)?.manifest;
			if (!manifest || tool.exposure === "hidden") return [];
			return [{
				name: manifest.name,
				description: manifest.description,
				category: toolCategory(manifest),
				tags: manifest.tags ?? [],
				whenToUse: manifest.whenToUse ?? [],
				active: active.has(manifest.name),
				exposure: tool.exposure,
			}];
		});
	}

	catalogCommand(args: string): string {
		if (this.closed) throw new Error("工具运行时已关闭");
		const [action, ...parts] = args.trim().split(/\s+/);
		const entries = this.catalogEntries();
		if (!action || action === "list") {
			if (parts.length > 1) throw new Error("用法：/tool-catalog [list] [分类]");
			return formatCatalog(entries, parts[0]);
		}
		if (action === "search") {
			if (parts.length === 0) throw new Error("用法：/tool-catalog search <关键词>");
			return formatCatalog(entries, undefined, parts.join(" "));
		}
		if (action === "load" || action === "unload") {
			if (parts.length !== 1) throw new Error(`用法：/tool-catalog ${action} <工具或分类>`);
			const targets = catalogTargets(entries, parts[0]).map((entry) => entry.name);
			const active = this.options.pi.getActiveTools();
			if (action === "unload") this.discovery.suppressPromotion(targets);
			const next = action === "load" ? [...new Set([...active, ...targets, ...DISCOVERY_TOOL_NAMES])]
				: active.filter((name) => !targets.includes(name));
			this.options.pi.setActiveTools(next);
			return `${action === "load" ? "已加载" : "已收起"}：${targets.join("、")}。${action === "unload" ? "正在运行的任务和服务不受影响。" : ""}`;
		}
		if (action === "reset") {
			if (parts.length) throw new Error("用法：/tool-catalog reset");
			const defaults = entries.filter((entry) => catalogDefaultActive(this.tools.get(entry.name)!.manifest)).map((entry) => entry.name);
			const active = this.options.pi.getActiveTools().filter((name) => !this.tools.has(name) && name !== "tool_search");
			this.discovery.suppressPromotion(this.tools.keys());
			this.options.pi.setActiveTools([...new Set([...active, ...defaults, ...DISCOVERY_TOOL_NAMES])]);
			return "已恢复初始工具列表；基础工具、发现入口和配置为常驻的工具保留，正在运行的任务和服务不受影响。";
		}
		if (parts.length) throw new Error("用法：/tool-catalog <分类>，或 search、load、unload、reset");
		return formatCatalog(entries, action);
	}

	private toolAddManageTool(cwd: string): ToolDefinition {
		const parameters = Type.Unsafe(TOOL_ADD_MANAGE_SCHEMA);
		return {
			name: "tool_add_manage",
			label: "Manage tools",
			description:
				"Run one tool_add management action. For convert_skill and create_tool, pass the complete plan built from the skill or the requirements.",
			parameters,
			execute: async (_id, params, signal) => {
				signal?.throwIfAborted();
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
					signal,
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
			execute: async (_id, params, signal) => {
				signal?.throwIfAborted();
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
						const status = await this.supervisor.restartDaemon(manifest, input.service, signal);
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
						signal?.throwIfAborted();
						try {
							statuses.push(await this.supervisor.daemonStatus(target.manifest, target.name, signal));
						} catch (error) {
							if (signal?.aborted) throw error;
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

	private async toolSettings(ctx: {
		thinkingLevel?: AgentConfig["thinkingLevel"];
	}): Promise<{ model: string; thinkingLevel?: AgentConfig["thinkingLevel"] }> {
		const selection = await readToolModel(this.options.agentDir);
		let thinkingLevel: AgentConfig["thinkingLevel"] = selection.thinkingLevel ?? ctx.thinkingLevel ?? this.options.pi.getThinkingLevel?.();
		if (thinkingLevel === undefined) {
			this.settingsManager ??= SettingsManager.create(this.options.cwd, this.options.agentDir);
			const { provider, id } = parseToolModel(selection.model);
			thinkingLevel = this.settingsManager.getModelThinkingLevel(provider, id);
			thinkingLevel ??= this.settingsManager.getDefaultThinkingLevel();
		}
		return { model: selection.model, thinkingLevel };
	}

	private progressRoot(): string {
		return path.join(this.options.cwd, ".pi", "jobs");
	}

	private watchProgress(jobId: string, ui?: ProgressUi, onUpdate?: ProgressUpdateSink): void {
		if (this.progressWatchers.has(jobId)) return;
		const watcher = new ProgressWatcher({
			jobsRoot: this.progressRoot(),
			ui: ui ?? {},
			log: this.options.log,
			onUpdate,
			subscribe: (id, refresh) => this.jobs.subscribe(id, refresh),
			snapshot: async (id) => {
				const record = await this.jobs.get(id);
				if (!record) return { entries: [], lines: [] };
				const entries = this.jobs.recent(id);
				return entries ? snapshotFromRecord(record, entries) : snapshotProgress({ jobsRoot: this.progressRoot(), jobId: id });
			},
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
		ctx: ExtensionToolContext,
		onUpdate?: ProgressUpdateSink,
		toolCallId?: string,
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
		if (["status", "result", "cancel"].includes(mode) && !existingJobId) {
			return this.toolResult({ status: "failed", summary: "该操作需要 jobId。" }, manifest, undefined, true);
		}
		const jobInput = { ...input };
		delete jobInput.mode;
		delete jobInput.timeoutMs;
		delete jobInput.jobId;

		if (existingJobId && (mode === "status" || mode === "result" || mode === "cancel" || mode === "wait")) {
			const target = await this.jobs.get(existingJobId);
			if (!target || target.tool !== manifest.name) return this.toolResult({ status: "failed", summary: "任务不存在或不属于该工具。" }, manifest, undefined, true);
			const owned = Boolean(target.requester?.sessionId && target.requester.sessionId === ctx.sessionManager?.getSessionId?.());
			if (mode === "cancel" && !owned) return this.toolResult({ status: "failed", summary: "任务不属于当前会话。" }, manifest, target, true);
			if (mode === "cancel") {
				const envelope = await this.jobs.handle({ action: "cancel", jobId: existingJobId });
				return this.toolResult(envelope, manifest, await this.jobs.get(existingJobId), envelope.status === "failed");
			}
			if (mode === "wait") this.watchProgress(existingJobId, ctx.hasUI ? ctx.ui : undefined, onUpdate);
			const abort = () => { if (owned) this.jobs.cancel(existingJobId); };
			let record: JobRecord | undefined;
			try {
				if (mode === "wait") {
					signal?.addEventListener("abort", abort, { once: true });
					if (signal?.aborted) abort();
					record = await this.jobs.wait(existingJobId, timeoutMs, signal);
				} else record = target;
			} catch (error) {
				const current = await this.jobs.get(existingJobId);
				if (!signal?.aborted && current?.state !== "cancelling" && current?.state !== "cancelled") throw error;
				return this.toolResult({ status: current?.state === "cancelled" ? "cancelled" : "accepted", summary: "已停止等待，取消及清理状态见任务进展。", jobId: existingJobId }, manifest, current);
			} finally { signal?.removeEventListener("abort", abort); }
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

		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "api";
		let runId = this.runs.get(sessionId) ?? (signal ? this.signalRuns.get(signal) : undefined);
		if (!runId) { runId = randomUUID(); if (signal) this.signalRuns.set(signal, runId); }
		const cancelled = this.cancelledTools.get(`${sessionId}:${runId}`);
		if (cancelled?.has("*") || cancelled?.has(manifest.name)) {
			return { ...this.toolResult({ status: "cancelled", summary: "本轮该工具已被用户取消，不会重新启动。" }, manifest), terminate: true };
		}
		const management = manifest.handler === "tool_add" ? [this.toolAddManageTool(ctx.cwd)]
			: manifest.handler === "service_keeper" ? [this.serviceKeeperManageTool()] : [];
		const job = await this.jobs.create({
			manifest,
			input: jobInput,
			mode,
			cwd: ctx.cwd ?? this.options.cwd,
			projectTrusted: this.options.projectTrusted,
			requester: { sessionId, runId, toolCallId, idle: ctx.isIdle() },
			signal,
			managementTools: management.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
				execute: async (id, parameters, operationSignal) => tool.execute(id, parameters, operationSignal, undefined, ctx) })),
			...await this.toolSettings(ctx),
		});
		this.watchProgress(job.id, ctx.hasUI ? ctx.ui : undefined, onUpdate);

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

		let finished: JobRecord | undefined;
		try { finished = await this.jobs.wait(job.id, mode === "wait" ? timeoutMs : undefined, signal); }
		catch (error) {
			const current = await this.jobs.get(job.id);
			if (!signal?.aborted && current?.state !== "cancelling" && current?.state !== "cancelled") throw error;
			return this.toolResult({ status: current?.state === "cancelled" ? "cancelled" : "accepted",
				summary: "已停止等待；任务管理器正在取消任务并确认进程退出。已完成的操作不会撤销。", jobId: job.id }, manifest, current);
		}
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
		if (job?.auditError) envelope = { ...envelope, warnings: [...(envelope.warnings ?? []), `操作记录未能完整保存：${job.auditError}`] };
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
				phase: job?.phase,
				outputFiles: job?.outputFiles,
				requester: job?.requester,
				sessionFile: (job as JobRecord & { sessionFile?: string })?.sessionFile,
			},
			isError,
			terminate: envelope.status === "cancelled" || job?.state === "cancelling",
		};
	}

	private notify(job: JobRecord): void {
		if (this.closed || job.mode !== "start" || job.state === "cancelled" || job.state === "cancelling") return;
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

	beginRun(sessionId: string): void { if (!this.runs.has(sessionId)) this.runs.set(sessionId, randomUUID()); }
	endRun(sessionId: string, aborted: boolean): void {
		const runId = this.runs.get(sessionId);
		if (aborted && runId) this.jobs.cancelRun(sessionId, runId);
		if (runId) this.cancelledTools.delete(`${sessionId}:${runId}`);
		this.runs.delete(sessionId);
	}
	async cancelTasks(reference: string, sessionId: string): Promise<JobRecord[]> {
		reference = reference.trim().toLowerCase();
		if (!reference) throw new Error("需要任务编号或 all");
		const running = this.jobs.active(sessionId);
		const mark = (job: JobRecord) => {
			const key = `${sessionId}:${job.requester?.runId}`;
			const tools = this.cancelledTools.get(key) ?? new Set<string>();
			tools.add(reference === "all" ? "*" : job.tool); this.cancelledTools.set(key, tools);
		};
		if (reference === "all") return running.map((job) => { mark(job); return this.jobs.cancel(job.id)!; }).filter(Boolean);
		let matches: JobRecord[];
		if (/^\d+$/.test(reference)) {
			const resolved = await resolveJobReference(this.progressRoot(), reference);
			if (!resolved.jobId) throw new Error(resolved.error ?? "没有匹配的任务");
			matches = running.filter((job) => job.id === resolved.jobId);
		} else matches = running.filter((job) => job.id.toLowerCase().includes(reference));
		if (matches.length > 1) throw new Error("任务编号不唯一");
		const job = matches[0];
		if (!job) throw new Error("该任务已结束或不属于当前会话");
		mark(job);
		return [this.jobs.cancel(job.id)!];
	}

	async handleJobTool(input: JobToolInput): Promise<ToolEnvelope> {
		return this.jobs.handle(input);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.discovery.close();
		this.stopCatalogPrompt?.();
		this.stopCatalogPrompt = undefined;
		for (const watcher of this.progressWatchers.values()) watcher.stopAll();
		this.progressWatchers.clear();
		await this.jobs.close();
		await this.supervisor.close();
	}
}

