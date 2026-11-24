import { createHash } from "node:crypto";
import { promises as fs, openSync, closeSync, writeSync } from "node:fs";
import * as path from "node:path";
import {
	createAgentSession,
	createBashToolDefinition,
	createLocalBashOperations,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { validateEnvelope, validateResultShape, validateSummary } from "../contracts/schema.ts";
import {
	compactionUsage,
	DEFAULT_WORKER_CONTEXT_POLICY,
	HANDOFF_SCHEMA,
	handoffErrors,
	usageDelta,
	WorkerContext,
	type ContextDecision,
	type WorkerContextPolicy,
	type WorkerHandoff,
} from "./context.ts";
import type { ServiceSupervisor } from "../services/supervisor.ts";
import type { AgentConfig, ResolvedAgent, ToolEnvelope, ToolManifest } from "../types.ts";
import { WorkerHistory, type HistorySnapshot, type WorkerJob } from "./history.ts";
import { compactionForModel, resolveAgentContext } from "./policy.ts";
import { isUnsupportedThinkingError, resolveWorkerThinking } from "./model-settings.ts";

interface RunState {
	pending?: ToolEnvelope;
	handoff?: WorkerHandoff;
	handoffRequired: boolean;
	maxHandoffBytes: number;
	onSubmitted?: () => void;
}

export interface WorkerRunResult {
	envelope: ToolEnvelope;
	usage?: Record<string, unknown>;
	sessionFile?: string;
	sessionId?: string;
	warnings: string[];
}

export interface WorkerProgressEntry {
	time: string;
	kind: "thinking" | "text" | "tool" | "result" | "status" | "update";
	text: string;
	tool?: string;
	isError?: boolean;
	sessionFile?: string;
	sessionId?: string;
	event?: "model_request";
	callId?: string;
	internal?: boolean;
}

export type WorkerProgressSink = (entry: WorkerProgressEntry) => void;
export type WorkerAudit = (operation: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;

function progressText(value: unknown, limit: number): string {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function summarizeToolResult(result: unknown): string {
	const payload = result as { content?: Array<{ text?: string }> } | string | undefined;
	if (typeof payload === "string") return progressText(payload, 400);
	if (payload && Array.isArray(payload.content)) {
		const text = payload.content
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.filter(Boolean)
			.join(" ");
		if (text) return progressText(text, 400);
	}
	return progressText(payload, 400);
}

export function workerKey(tool: ToolManifest, agent: ResolvedAgent, cwd: string, userScope = false): string {
	const parts = [
		tool.name,
		tool.version,
		tool.contractVersion ?? tool.version,
		agent.name,
		agent.version,
		agent.contract,
		agent.source,
		agent.path ?? "embedded",
	];
	if (!userScope) parts.push(cwd);
	return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

async function readIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function modelFromRuntime(runtime: ModelRuntime, value: string | undefined) {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash < 0) return undefined;
	return runtime.getModel(value.slice(0, slash), value.slice(slash + 1));
}

export interface WorkerRuntimePaths {
	agentDir?: string;
	projectCwd?: string;
	jobDirectory?: string;
}

export function buildSystemPrompt(
	tool: ToolManifest,
	agent: ResolvedAgent,
	paths?: WorkerRuntimePaths,
): string {
	const contract = JSON.stringify(
		{
			name: tool.name,
			version: tool.version,
			contractVersion: tool.contractVersion ?? tool.version,
			description: tool.description,
			input: tool.input,
			output: tool.output,
		},
		null,
		2,
	);

	return [
		`You are the persistent worker for tool "${tool.name}".`,
		`Tool directory: ${tool.dir ?? "(unknown)"}`,
		"",
		"## Operating rules",
		"- Work on exactly one delegated job at a time.",
		"- Never read or write /tmp. Use the runtime's dedicated intermediate directories for temporary files.",
		"- Resolve relative paths against the tool directory unless the job says otherwise.",
		"- Do not ask the user questions. If required information is missing, submit status needs_input.",
		"- Do not call the facade tool itself. It is not in your tool list.",
		"- When the job is finished, call submit_result exactly once. Do not answer with prose only.",
		"- Keep the final result inside submit_result so the facade can validate it.",
		"",
		...(paths
			? [
					"## Runtime paths",
					...(paths.agentDir ? [`- Agent directory: ${paths.agentDir}`] : []),
					...(paths.projectCwd ? [`- Project directory: ${paths.projectCwd}`] : []),
					...(paths.jobDirectory ? [
						`- Job intermediate directory: ${paths.jobDirectory}`,
						"Concurrent jobs share the tool directory. Keep helper scripts and downloads inside this job intermediate directory.",
					] : []),
					"Use these exact paths when the task or the instructions below name one of them.",
					"",
				]
			: []),
		"## Input contract",
		"- The job input states the current goal, necessary new conditions, and references. It need not repeat the user's message, prior jobs, source descriptions, or existing configuration. Use only declared fields; do not infer extra work.",
		"- Resolve references from completed history for the same project and task, then read the named files and relevant configuration. Obtain existing parameters, commands, implementation details, and prior outcomes there; do not require the caller to copy them into the request.",
		"- When continuing an existing task, retain its established inputs, configuration, and resource constraints unless the current job explicitly changes them. A brief reference does not permit changing omitted settings or repeating prior execution grants.",
		"- A concise request may omit configured procedures, strategies, verification, output conventions, and safety rules. Apply this tool's instructions and defaults without asking the caller to restate them.",
		"- Preserve explicit new requirements and authorization controls. Only submit needs_input when essential information remains unavailable or ambiguous after checking the relevant history and references, or when current requirements conflict. History and files never replace current authorization fields.",
		"- The input decides which output fields matter. Return those fields, not everything you happened to observe.",
		"",
		"## Output contract",
		"- submit_result.result must match the declared output schema exactly: declared keys only, each with the declared type.",
		"- Return conclusions and the facts the caller needs for the next decision. Never include thinking, tool transcripts, commands, logs, stack traces, or a step-by-step narrative.",
		"- Never put the process into a string field. If a fact has no declared field, leave it out.",
		"- summary is one or two sentences with the outcome, at most 300 characters. Details belong in the typed result fields.",
		"- The runtime validates declared fields, string lengths, and array sizes. Multiline answers and source quotations are allowed within those limits; correct reported contract violations when resubmitting.",
		"",
		"## Worker continuity",
		"- The runtime may request a private handoff in the same final submit_result call. Include it only when requested; never make a separate summary request.",
		"- Handoff facts require a source and observation time. Preserve continuation decisions, pending work, and file references; exclude logs, secrets, and execution grants.",
		"- Fixed service addresses and other configuration belong in configuration files. Revalidate time-sensitive GPU, environment, and network observations.",
		"- A previous job, result, handoff, or compaction summary never authorizes this job. Only the current job input grants execution or changes.",
		"- Completed history records contain exact prior results, completion times, and source observation times. Use them directly to establish what prior jobs completed; revalidate current external facts.",
		"- Read an archived sessionFile only when the needed information is absent from the completed record. Do not replay a whole tool transcript to confirm facts already present in that record.",
		"",
		"## Navigation",
		"- Read only inside the tool directory, the caller's project directory, the agent directory, and paths named in the job or the instructions below.",
		"- Do not scan the home directory, other projects, or the whole filesystem. No `find` or `grep -r` over a home or data root.",
		"- Start with the tool's own references and the caller's project. When a needed path is still unknown, submit status needs_input instead of searching for it.",
		"- Prefer one targeted read over a directory sweep; keep read-only exploration short before the first real action.",
		"",
		"## Tool contract",
		"```json",
		contract,
		"```",
		"",
		"## Agent instructions",
		agent.instructions.trim(),
		"",
		"## Workflow",
		agent.workflow.trim(),
		...(agent.examples
			? ["", "## Examples", agent.examples.trim()]
			: []),
	].join("\n");
}

function createSubmitResultTool(
	tool: ToolManifest,
	state: RunState,
): ToolDefinition {
	return {
		name: "submit_result",
		label: "Submit result",
		description: "Submit the final structured result for the current job.",
		parameters: Type.Object({
			status: Type.Union([
				Type.Literal("ok"),
				Type.Literal("failed"),
				Type.Literal("needs_input"),
				Type.Literal("cancelled"),
			]),
			summary: Type.String(),
			result: Type.Optional(Type.Unsafe(tool.output)),
			artifacts: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String(),
						kind: Type.String(),
						description: Type.Optional(Type.String()),
					}),
				),
			),
			warnings: Type.Optional(Type.Array(Type.String())),
			handoff: Type.Optional(HANDOFF_SCHEMA),
		}),
		execute: async (_id, params) => {
			const input = params as {
				status: ToolEnvelope["status"];
				summary: string;
				result?: unknown;
				artifacts?: ToolEnvelope["artifacts"];
				warnings?: string[];
				handoff?: WorkerHandoff;
			};
			const candidate: ToolEnvelope = {
				status: input.status,
				summary: input.summary,
				result: input.result,
				artifacts: input.artifacts,
				warnings: input.warnings,
			};
			const errors = [
				...validateEnvelope(tool.output, candidate),
				...validateSummary(input.summary),
				...validateResultShape(tool.output, input.result),
				...(input.handoff ? handoffErrors(input.handoff, state.maxHandoffBytes) : []),
			];
			if (state.handoffRequired && input.status !== "cancelled" && !input.handoff) {
				errors.push(`handoff: requested by the runtime; include a concise private handoff in this same submit_result call, at most ${state.maxHandoffBytes} UTF-8 bytes`);
			}
			if (errors.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: [
								"submit_result failed validation:",
								...errors,
								"",
								"Return only the result the caller needs. Do not include the thinking, the tool calls, the commands, the logs, or a step-by-step narrative. Fill the declared fields; drop everything else.",
							].join("\n"),
						},
					],
					details: { errors },
				};
			}
			state.pending = candidate;
			state.handoff = state.handoffRequired && input.status !== "cancelled" ? input.handoff : undefined;
			state.onSubmitted?.();
			return {
				content: [{ type: "text", text: "Result recorded." }],
				details: undefined,
				terminate: true,
			};
		},
	};
}

function createServiceTool(tool: ToolManifest, supervisor: Pick<ServiceSupervisor, "call">): ToolDefinition {
	return {
		name: "service_call",
		label: "Call service",
		description: "Call a deterministic service declared by this tool.",
		parameters: Type.Object({
			service: Type.String(),
			method: Type.Optional(Type.String()),
			params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		execute: async (_id, params, signal) => {
			signal?.throwIfAborted();
			const input = params as { service: string; method?: string; params?: Record<string, unknown> };
			const service = tool.services?.[input.service];
			const payload =
				service?.type === "script"
					? (input.params ?? {})
					: { method: input.method, params: input.params ?? {} };
			const result = await supervisor.call(tool, input.service, payload, signal);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `service "${input.service}" failed: ${result.error}` }],
					details: result,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }],
				details: result,
			};
		},
	};
}

export class AgentWorker {
	private sessionPromise?: Promise<AgentSession>;
	private readonly state: RunState = {
		handoffRequired: false,
		maxHandoffBytes: DEFAULT_WORKER_CONTEXT_POLICY.maxHandoffBytes,
	};
	private context?: WorkerContext;
	private contextDecision?: ContextDecision;
	private readonly contextPolicy: Partial<WorkerContextPolicy>;
	private readonly key: string;
	private readonly sessionDir: string;
	private readonly memoryPath: string;
	private readonly journalPath: string;
	private readonly tool: ToolManifest;
	private readonly agent: ResolvedAgent;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly supervisor: Pick<ServiceSupervisor, "call">;
	private readonly log: (message: string) => void;
	private readonly onProgress?: WorkerProgressSink;
	private readonly defaultModel?: string;
	private readonly extraTools: ToolDefinition[];
	private readonly callerThinkingLevel?: AgentConfig["thinkingLevel"];
	private readonly history: WorkerHistory;
	private historySnapshot?: HistorySnapshot;
	private thinkingFallbackReason?: string;
	private running = false;
	private jobDirectory?: string;
	private readonly toolOutput = new Map<string, { previous: string; pending: string; preview: string }>();
	private readonly audit?: WorkerAudit;

	constructor(
		tool: ToolManifest,
		agent: ResolvedAgent,
		cwd: string,
		agentDir: string,
		modelRuntime: ModelRuntime,
		supervisor: Pick<ServiceSupervisor, "call">,
		log: (message: string) => void,
		onProgress?: WorkerProgressSink,
		defaultModel?: string,
		extraTools: ToolDefinition[] = [],
		contextPolicy: Partial<WorkerContextPolicy> = {},
		callerThinkingLevel?: AgentConfig["thinkingLevel"],
		audit?: WorkerAudit,
	) {
		this.tool = tool;
		this.agent = agent;
		this.agentDir = agentDir;
		this.modelRuntime = modelRuntime;
		this.supervisor = supervisor;
		this.log = log;
		this.onProgress = onProgress;
		this.defaultModel = defaultModel;
		this.extraTools = extraTools;
		this.callerThinkingLevel = callerThinkingLevel;
		this.audit = audit;
		const context = resolveAgentContext(tool.agent?.context);
		this.contextPolicy = {
			contextBudgetTokens: context.budgetTokens,
			keepRecentTokens: context.keepRecentTokens,
			minimumGrowthTokens: context.keepRecentTokens,
			...contextPolicy,
		};
		const sessionScope = tool.agent?.sessionScope ?? "project";
		const memoryScope = tool.agent?.memoryScope ?? "project";
		this.cwd = sessionScope === "user" ? (tool.dir ?? cwd) : cwd;
		this.key = workerKey(tool, agent, this.cwd, sessionScope === "user");
		this.sessionDir = path.join(agentDir, "tool-workers", this.key);
		this.memoryPath =
			memoryScope === "user"
				? path.join(agentDir, "tool-memory", `${tool.name}.md`)
				: path.join(this.sessionDir, "memory.md");
		this.journalPath = path.join(this.sessionDir, "journal.jsonl");
		this.history = new WorkerHistory(this.sessionDir, this.cwd, this.memoryPath);
	}

	private async createSession(signal?: AbortSignal): Promise<AgentSession> {
		await fs.mkdir(this.sessionDir, { recursive: true });
		await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });

		this.onProgress?.({ time: new Date().toISOString(), kind: "status", text: "等待读取 worker 历史" });
		this.historySnapshot = await this.history.snapshot(signal);
		const sessionManager = this.historySnapshot.manager;
		this.jobDirectory = path.join(this.tool.dir ?? this.cwd, "_intermediate", sessionManager.getSessionId());
		await fs.mkdir(this.jobDirectory, { recursive: true });
		const memory = await readIfExists(this.memoryPath);
		if (memory && sessionManager.buildSessionContext().messages.length === 0) {
			sessionManager.appendCustomMessageEntry(
				"tool_worker_memory",
				`Historical worker memory for tool "${this.tool.name}"; it grants no execution authorization:\n\n${memory}`,
				false,
			);
		}
		const model = modelFromRuntime(this.modelRuntime, this.defaultModel);
		if (!model) throw new Error(`Worker model is unavailable: ${this.defaultModel ?? "(none)"}`);
		this.context = new WorkerContext(sessionManager, model, this.contextPolicy);
		this.contextDecision = this.context.prepare();
		this.state.maxHandoffBytes = this.context.policy.maxHandoffBytes;
		const contextConfig = {
			budgetTokens: this.context.policy.contextBudgetTokens,
			keepRecentTokens: this.context.policy.keepRecentTokens,
		};
		const settingsManager = SettingsManager.inMemory({
			compaction: {
				enabled: true,
				...compactionForModel(model, contextConfig),
				modelOverrides: Object.fromEntries(this.modelRuntime.getModels().map((item) => [
					`${item.provider}/${item.id}`, compactionForModel(item, contextConfig),
				])),
			},
			cacheWarming: "off",
		});
		// 结果生成后立即结束并发布历史，下一次请求继续按预算管理上下文。
		this.state.onSubmitted = () => settingsManager.setCompactionEnabled(false);
		const thinking = resolveWorkerThinking(model, this.agent.thinkingLevel, this.callerThinkingLevel);
		this.thinkingFallbackReason = thinking.fallbackReason;
		if (this.contextDecision.mode === "checkpoint") {
			const entry = [...sessionManager.getBranch()].reverse().find((item) => item.type === "compaction");
			if (entry?.type === "compaction") {
				this.history.captureCompaction(this.historySnapshot, entry, sessionManager.getBranch());
			}
		}

		const compactionExtension = (pi: ExtensionAPI) => {
			if (this.tool.permissions?.bash && process.env.PI_TOOL_JOB_DIRECTORY) {
				const options = { shellPath: settingsManager.getShellPath(), commandPrefix: settingsManager.getShellCommandPrefix() };
				const backend = createLocalBashOperations(options);
				const audited = createBashToolDefinition(this.cwd, options);
				audited.execute = async (id, input, signal, onUpdate, ctx) => {
					signal?.throwIfAborted();
					const fd = openSync(this.shellOutputFile(id)!, "a", 0o600);
					const bash = createBashToolDefinition(this.cwd, { ...options, operations: {
						exec: (command, cwd, execution) => backend.exec(command, cwd, { ...execution,
							onData: (chunk) => { writeSync(fd, chunk); execution.onData(chunk); } }),
					} });
					try { return await bash.execute(id, input, signal, onUpdate, ctx); }
					finally { closeSync(fd); }
				};
				pi.registerTool(audited);
			}
			pi.on("tool_call", async (event, ctx) => {
				ctx.signal?.throwIfAborted();
				const input = event.toolName === "submit_result" ? Object.fromEntries(Object.entries(event.input).filter(([key]) => key !== "handoff")) : event.input;
				await this.audit?.(event.toolName, { toolCallId: event.toolCallId, arguments: input,
					...(event.toolName === "bash" ? { outputPath: this.shellOutputFile(event.toolCallId) } : {}) }, ctx.signal);
				ctx.signal?.throwIfAborted();
			});
			pi.on("before_provider_request", async (_event, ctx) => {
				ctx.signal?.throwIfAborted();
				await this.audit?.("model_request", { provider: ctx.model?.provider, model: ctx.model?.id }, ctx.signal);
				ctx.signal?.throwIfAborted();
				this.onProgress?.({ time: new Date().toISOString(), kind: "status", text: "等待模型响应", event: "model_request" });
			});
			pi.on("context", (event, ctx) => {
				const tokens = Math.max(ctx.getContextUsage()?.tokens ?? 0, this.context!.estimateContextTokens());
				this.state.handoffRequired ||= this.context!.needsHandoff(tokens);
				if (!this.state.handoffRequired) return;
				return {
					messages: [...event.messages, {
						role: "custom" as const,
						customType: "tool_worker_handoff_request",
						content: `At task completion include handoff in the same submit_result call, limited to ${this.state.maxHandoffBytes} UTF-8 bytes of JSON. Update the prior handoff with sourced observations, decisions, pending work and file references. Use empty arrays where appropriate. Do not include logs, secrets, or execution authorizations. Do not make another model call or perform unrelated work for this handoff.`,
						display: false,
						timestamp: Date.now(),
					}],
				};
			});
			pi.on("session_before_compact", (event) => {
				const compaction = this.context?.reusableCompaction(event.preparation.firstKeptEntryId, event.preparation.tokensBefore);
				return compaction ? { compaction } : undefined;
			});
			pi.on("session_compact", async (event) => {
				this.context?.didCompact();
				this.state.handoffRequired = false;
				this.history.captureCompaction(this.historySnapshot!, event.compactionEntry, sessionManager.getBranch());
			});
		};

		const loader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [compactionExtension],
				systemPromptOverride: () =>
				buildSystemPrompt(this.tool, this.agent, {
					agentDir: this.agentDir,
					projectCwd: this.cwd,
					jobDirectory: this.jobDirectory,
				}),
			appendSystemPromptOverride: () => [],
		});
		await loader.reload();

		const readTools = this.tool.permissions?.read === false ? [] : ["read", "grep", "find", "ls"];
		const writeTools = this.tool.permissions?.write ? ["edit", "write"] : [];
		const bashTools = this.tool.permissions?.bash ? ["bash"] : [];
		const requested = this.agent.tools ?? [];
		const allowed = new Set([...readTools, ...writeTools, ...bashTools]);
		const selectedTools = Array.from(
			new Set([
				...readTools,
				...writeTools,
				...bashTools,
				...requested.filter((name) => allowed.has(name)),
				...(this.tool.services && Object.keys(this.tool.services).length > 0 ? ["service_call"] : []),
				...this.extraTools.map((tool) => tool.name),
				"submit_result",
			]),
		);

		const customTools: ToolDefinition[] = [createSubmitResultTool(this.tool, this.state)];
		if (this.tool.services && Object.keys(this.tool.services).length > 0) {
			customTools.push(createServiceTool(this.tool, this.supervisor));
		}
		customTools.push(...this.extraTools);
		const { session } = await createAgentSession({
			cwd: this.cwd,
			agentDir: this.agentDir,
			model,
			thinkingLevel: thinking.thinkingLevel,
			modelRuntime: this.modelRuntime,
			resourceLoader: loader,
			settingsManager,
			sessionManager,
			tools: selectedTools,
			customTools,
		});
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				this.context?.observeResponse(event.message as AssistantMessage);
			}
			this.emitProgress(event);
		});
		this.onProgress?.({ time: new Date().toISOString(), kind: "status", text: "worker 会话已建立", internal: true, sessionFile: session.sessionFile, sessionId: session.sessionId });
		return session;
	}

	private shellOutputFile(callId: string): string | undefined {
		const directory = process.env.PI_TOOL_JOB_DIRECTORY;
		return directory ? path.join(directory, `bash-${createHash("sha256").update(callId).digest("hex")}.log`) : undefined;
	}

	private emitProgress(event: { type: string; [key: string]: unknown }): void {
		if (!this.onProgress) return;
		const time = new Date().toISOString();
		try {
			if (event.type === "tool_execution_update") {
				const partial = event.partialResult as { content?: Array<{ text?: string }> } | undefined;
				const output = (partial?.content ?? []).map((part) => part.text ?? "").join("\n").replace(/\r\n?/g, "\n");
				const callId = String(event.toolCallId);
				const prior = this.toolOutput.get(callId);
				if (!output || output === prior?.previous) return;
				const appended = prior && output.startsWith(prior.previous);
				const current = (appended ? prior.pending : "") + (appended ? output.slice(prior.previous.length) : output);
				const preview = current.replace(/\s+/g, " ").trim().slice(-400);
				this.toolOutput.set(callId, { previous: output, pending: current.slice(current.lastIndexOf("\n") + 1), preview: preview || prior?.preview || "" });
				if (preview && preview !== prior?.preview) this.onProgress({ time, kind: "update", tool: String(event.toolName), callId, text: preview });
			}
			if (event.type === "tool_execution_start") {
				const args = event.args as Record<string, unknown> | undefined;
				this.onProgress({ time, kind: "tool", tool: String(event.toolName), callId: String(event.toolCallId),
					text: event.toolName === "submit_result" ? "提交任务结果" : progressText(args, 500), internal: event.toolName === "submit_result" });
			}
			if (event.type === "auto_compaction_start") this.onProgress({ time, kind: "status", text: "压缩上下文" });
			if (event.type === "tool_execution_end") {
				const streamed = this.toolOutput.has(String(event.toolCallId));
				const exitCode = (event.result as { structuredContent?: { exit_code?: number } })?.structuredContent?.exit_code;
				this.toolOutput.delete(String(event.toolCallId));
				this.onProgress({
					time,
					kind: "result",
					tool: String(event.toolName ?? ""),
					callId: String(event.toolCallId),
					isError: Boolean(event.isError),
					text: streamed && !event.isError ? `执行完成${exitCode !== undefined ? `，退出码 ${exitCode}` : ""}` : summarizeToolResult(event.result),
					internal: event.toolName === "submit_result",
				});
			}
		} catch (error) {
			this.log(`failed to record worker progress: ${String(error)}`);
		}
	}

	private async getSession(signal?: AbortSignal): Promise<AgentSession> {
		this.sessionPromise ??= this.createSession(signal);
		return this.sessionPromise;
	}

	async run(job: WorkerJob, signal?: AbortSignal): Promise<WorkerRunResult> {
		if (this.running) throw new Error("Create a separate AgentWorker instance for each concurrent job");
		this.running = true;
		try {
			await this.dispose();
			this.toolOutput.clear();
			this.state.pending = undefined;
			this.state.handoff = undefined;
			this.state.handoffRequired = false;
			this.state.onSubmitted = undefined;
			return await this.runJob(job, signal ?? new AbortController().signal);
		} finally {
			this.running = false;
		}
	}

	private async runJob(job: WorkerJob, signal: AbortSignal): Promise<WorkerRunResult> {
		const warnings: string[] = [];
		const session = await this.getSession(signal);
		signal.throwIfAborted();
		const before = session.getSessionStats();
		const previousEntries = new Set(this.context!.manager.getEntries().map((entry) => entry.id));

		const abortHandler = () => {
			void session.abort().catch((error) => this.log(`取消 worker 失败: ${String(error)}`));
		};
		signal?.addEventListener("abort", abortHandler, { once: true });

		const payload = [
			"## Job",
			`Task: ${job.task}`,
			job.context ? `Context:\n${job.context}` : "",
			job.input ? `Input:\n${JSON.stringify(job.input, null, 2)}` : "",
			"",
			"Use the workflow and internal tools. Finish by calling submit_result.",
		]
			.filter(Boolean)
			.join("\n");

		let promptError: unknown;
		try {
			signal.throwIfAborted();
			let initialError: unknown;
			try {
				await session.prompt(payload);
			} catch (error) {
				initialError = error;
			}
			signal.throwIfAborted();
			let failed = session.messages.at(-1);
			const failedMessage = initialError instanceof Error ? initialError.message : initialError !== undefined
				? String(initialError)
				: failed?.role === "assistant" && failed.stopReason === "error" ? failed.errorMessage ?? "" : "";
			if (!this.state.pending && this.agent.thinkingLevel === "low" && session.thinkingLevel === "low" &&
				isUnsupportedThinkingError(failedMessage) &&
				this.callerThinkingLevel !== undefined && this.callerThinkingLevel !== "low") {
				this.thinkingFallbackReason = failedMessage;
				const failedEntry = [...this.context!.manager.getBranch()].reverse().find((entry) =>
					!previousEntries.has(entry.id) && entry.type === "message" && entry.message.role === "assistant" &&
					entry.message.stopReason === "error" && isUnsupportedThinkingError(entry.message.errorMessage ?? ""),
				);
				if (failedEntry) this.context!.manager.appendContextEdit(failedEntry.id, null);
				session.setThinkingLevel(this.callerThinkingLevel);
				signal.throwIfAborted();
				await session.prompt(`Continue the same job with the caller's model settings. Preserve completed work and finish with submit_result.\n\n${payload}`);
				failed = session.messages.at(-1);
			} else if (initialError !== undefined) {
				throw initialError;
			}
			if (!this.state.pending && failed?.role === "assistant" && failed.stopReason === "error") {
				throw new Error(failed.errorMessage ?? "Worker model request failed");
			}
			signal.throwIfAborted();
			if (!this.state.pending) {
				warnings.push("worker finished without calling submit_result; retrying once");
				await session.prompt(
					"You did not call submit_result. Call submit_result now with the final structured result. Do not answer with prose.",
				);
			}
		} catch (error) {
			promptError = error;
		} finally {
			signal.removeEventListener("abort", abortHandler);
		}

		const envelope: ToolEnvelope = signal.aborted ? { status: "cancelled", summary: "任务已取消" } : promptError
			? {
				status: signal.aborted ? "cancelled" : "failed",
				summary: promptError instanceof Error ? promptError.message : String(promptError),
			}
			: this.state.pending ?? {
				status: "failed",
				summary: "Worker did not submit a result.",
				warnings,
			};
		const errors = validateEnvelope(this.tool.output, envelope);
		if (errors.length > 0) {
			envelope.status = "failed";
			envelope.summary = "Worker returned a result that does not match the output schema.";
			envelope.warnings = [...(envelope.warnings ?? []), ...errors];
		}

		const stats = session.getSessionStats();
		const delta = usageDelta(before, stats);
		let checkpointEntryId: string | undefined;
		if (this.state.handoff && !signal.aborted && envelope.status !== "cancelled" && errors.length === 0) {
			try {
				checkpointEntryId = this.context!.saveHandoff(envelope.summary, this.state.handoff);
			} catch (error) {
				warnings.push(`failed to persist worker handoff; original history retained: ${String(error)}`);
			}
		}
		const history = await this.history.complete(this.historySnapshot!, job, envelope, signal.aborted ? undefined : this.state.handoff);
		const usage = {
			...delta,
			contextUsage: stats.contextUsage,
			thinking: {
				preferred: this.agent.thinkingLevel,
				caller: this.callerThinkingLevel,
				effective: session.thinkingLevel,
				fallbackReason: this.thinkingFallbackReason,
			},
			history,
			compaction: compactionUsage(this.context!.manager.getEntries().filter((entry) => !previousEntries.has(entry.id))),
			contextManagement: {
				...this.contextDecision,
				budgetTokens: this.context!.policy.contextBudgetTokens,
				keepRecentTokens: this.context!.policy.keepRecentTokens,
				checkpointEntryId,
				handoffBytes: this.state.handoff ? Buffer.byteLength(JSON.stringify(this.state.handoff), "utf8") : 0,
			},
		};
		try {
			this.context!.recordRun(delta, this.contextDecision!, checkpointEntryId);
		} catch (error) {
			warnings.push(`failed to persist worker usage metadata: ${String(error)}`);
		}

		try {
			await fs.appendFile(
				this.journalPath,
				`${JSON.stringify({
					time: new Date().toISOString(),
					task: job.task,
					status: envelope.status,
					summary: envelope.summary,
					usage,
				})}\n`,
				"utf8",
			);
		} catch (error) {
			warnings.push(`failed to append worker journal: ${String(error)}`);
		}

		return {
			envelope,
			usage,
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			warnings,
		};
	}

	async dispose(): Promise<void> {
		const pending = this.sessionPromise;
		this.sessionPromise = undefined;
		const session = await pending;
		session?.dispose();
	}
}
