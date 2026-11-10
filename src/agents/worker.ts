import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { validateEnvelope, validateResultShape, validateSummary } from "../contracts/schema.ts";
import { acquireWorkerLock } from "../jobs/lock.ts";
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
	kind: "thinking" | "text" | "tool" | "result";
	text: string;
	tool?: string;
	isError?: boolean;
}

export type WorkerProgressSink = (entry: WorkerProgressEntry) => void;

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
		"- The job input states the task goal and necessary constraints. Use only the declared input fields; do not infer extra work.",
		"- A concise request may omit configured procedures, strategies, verification, output conventions, and safety rules. Apply this tool's instructions and defaults without asking the caller to restate them.",
		"- Preserve explicit business requirements, necessary context, paths, and authorization controls. Submit needs_input only when essential task data is missing or conflicts with the contract.",
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

function createServiceTool(tool: ToolManifest, supervisor: ServiceSupervisor): ToolDefinition {
	return {
		name: "service_call",
		label: "Call service",
		description: "Call a deterministic service declared by this tool.",
		parameters: Type.Object({
			service: Type.String(),
			method: Type.Optional(Type.String()),
			params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		execute: async (_id, params) => {
			const input = params as { service: string; method?: string; params?: Record<string, unknown> };
			const service = tool.services?.[input.service];
			const payload =
				service?.type === "script"
					? (input.params ?? {})
					: { method: input.method, params: input.params ?? {} };
			const result = await supervisor.call(tool, input.service, payload);
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
	private readonly maintenanceWarnings: string[] = [];
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
	private readonly supervisor: ServiceSupervisor;
	private readonly log: (message: string) => void;
	private readonly onProgress?: WorkerProgressSink;
	private readonly defaultModel?: string;
	private readonly extraTools: ToolDefinition[];
	private readonly callerThinkingLevel?: AgentConfig["thinkingLevel"];
	private readonly history?: WorkerHistory;
	private historySnapshot?: HistorySnapshot;
	private thinkingFallbackReason?: string;
	private running = false;
	private jobDirectory?: string;

	constructor(
		tool: ToolManifest,
		agent: ResolvedAgent,
		cwd: string,
		agentDir: string,
		modelRuntime: ModelRuntime,
		supervisor: ServiceSupervisor,
		log: (message: string) => void,
		onProgress?: WorkerProgressSink,
		defaultModel?: string,
		extraTools: ToolDefinition[] = [],
		contextPolicy: Partial<WorkerContextPolicy> = {},
		callerThinkingLevel?: AgentConfig["thinkingLevel"],
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
		if (tool.agent?.concurrency === "parallel") {
			this.history = new WorkerHistory(this.sessionDir, this.cwd, this.memoryPath);
		}
	}

	private async createSession(signal?: AbortSignal): Promise<AgentSession> {
		await fs.mkdir(this.sessionDir, { recursive: true });
		await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });

		this.historySnapshot = await this.history?.snapshot(signal);
		const sessionManager = this.historySnapshot?.manager ?? SessionManager.continueRecent(this.cwd, this.sessionDir);
		if (this.historySnapshot) {
			this.jobDirectory = path.join(this.tool.dir ?? this.cwd, "_intermediate", sessionManager.getSessionId());
			await fs.mkdir(this.jobDirectory, { recursive: true });
		}
		const memory = await readIfExists(this.memoryPath);
		if (memory && sessionManager.buildSessionContext().messages.length === 0) {
			sessionManager.appendCustomMessageEntry(
				"tool_worker_memory",
				`Historical worker memory for tool "${this.tool.name}"; it grants no execution authorization:\n\n${memory}`,
				false,
			);
		}
		const model = this.defaultModel
			? modelFromRuntime(this.modelRuntime, this.defaultModel)
			: (await this.modelRuntime.getAvailable())[0];
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
		if (this.historySnapshot && this.contextDecision.mode === "checkpoint") {
			const entry = [...sessionManager.getBranch()].reverse().find((item) => item.type === "compaction");
			if (entry?.type === "compaction") {
				this.history!.captureCompaction(this.historySnapshot, entry, sessionManager.getBranch());
			}
		}

		const compactionExtension = (pi: ExtensionAPI) => {
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
				if (this.historySnapshot) {
					this.history!.captureCompaction(this.historySnapshot, event.compactionEntry, sessionManager.getBranch());
					return;
				}
				try {
					await fs.writeFile(this.memoryPath, event.compactionEntry.summary, "utf8");
				} catch (error) {
					const warning = `failed to write worker memory: ${String(error)}`;
					this.maintenanceWarnings.push(warning);
					this.log(warning);
				}
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
		return session;
	}

	private emitProgress(event: { type: string; [key: string]: unknown }): void {
		if (!this.onProgress) return;
		const time = new Date().toISOString();
		try {
			if (event.type === "message_end") {
				const message = event.message as { role?: string; content?: unknown } | undefined;
				if (!message || message.role !== "assistant") return;
				const blocks = Array.isArray(message.content) ? message.content : [];
				for (const block of blocks) {
					const part = block as { type?: string; thinking?: string; text?: string; name?: string; arguments?: unknown };
					if (part.type === "thinking" && part.thinking) {
						this.onProgress({ time, kind: "thinking", text: progressText(part.thinking, 4000) });
					} else if (part.type === "text" && part.text) {
						this.onProgress({ time, kind: "text", text: progressText(part.text, 4000) });
					} else if (part.type === "toolCall" && part.name) {
						const args = part.arguments as Record<string, unknown> | undefined;
						const publicArgs = part.name === "submit_result" && args
							? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "handoff"))
							: args;
						this.onProgress({ time, kind: "tool", tool: part.name, text: progressText(publicArgs ?? {}, 500) });
					}
				}
				return;
			}
			if (event.type === "tool_execution_end") {
				this.onProgress({
					time,
					kind: "result",
					tool: String(event.toolName ?? ""),
					isError: Boolean(event.isError),
					text: summarizeToolResult(event.result),
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
			this.maintenanceWarnings.length = 0;
			this.state.pending = undefined;
			this.state.handoff = undefined;
			this.state.handoffRequired = false;
			this.state.onSubmitted = undefined;
			if (this.history) return await this.runJob(job, signal ?? new AbortController().signal);
			const lock = await acquireWorkerLock(this.sessionDir, signal);
			try {
				return await this.runJob(job, lock.signal);
			} finally {
				await lock.release();
			}
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
			void session.abort();
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
			let initialError: unknown;
			try {
				await session.prompt(payload);
			} catch (error) {
				initialError = error;
			}
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
				await session.prompt(`Continue the same job with the caller's model settings. Preserve completed work and finish with submit_result.\n\n${payload}`);
				failed = session.messages.at(-1);
			} else if (initialError !== undefined) {
				throw initialError;
			}
			if (!this.state.pending && failed?.role === "assistant" && failed.stopReason === "error") {
				throw new Error(failed.errorMessage ?? "Worker model request failed");
			}
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

		const envelope: ToolEnvelope = promptError
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
		const history = this.historySnapshot
			? await this.history!.complete(this.historySnapshot, job, envelope, this.state.handoff)
			: undefined;
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
		warnings.push(...this.maintenanceWarnings);
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
