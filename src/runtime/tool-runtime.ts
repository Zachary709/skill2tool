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
import { JobManager } from "../jobs/manager.ts";
import { ServiceSupervisor } from "../services/supervisor.ts";
import { executeDirectTool } from "./direct-executor.ts";
import { ToolAddManager } from "../../basic-tools/tool_add/manager.ts";
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

function packageToolsRoot(): string {
	return fileURLToPath(new URL("../../basic-tools", import.meta.url));
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
			cwd: options.cwd,
			modelRuntime: options.modelRuntime,
			supervisor: this.supervisor,
			log: options.log,
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
			promptGuidelines: manifest.whenToUse ?? [],
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
			if (manifest.handler === "tool_add") {
				const envelope = await this.toolAdd.handle(jobInput as unknown as ToolAddInput, {
					cwd: ctx.cwd ?? this.options.cwd,
					isProjectTrusted: () => this.options.projectTrusted,
				});
				return this.toolResult(envelope, manifest, undefined, envelope.status === "failed");
			}
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

	async close(): Promise<void> {
		for (const watcher of this.progressWatchers.values()) watcher.stopAll();
		this.progressWatchers.clear();
		await this.supervisor.close();
	}
}

