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
import { Type } from "typebox";
import { validateEnvelope } from "../contracts/schema.ts";
import type { ServiceSupervisor } from "../services/supervisor.ts";
import type { ResolvedAgent, ToolEnvelope, ToolManifest } from "../types.ts";

interface RunState {
	pending?: ToolEnvelope;
}

export interface WorkerRunResult {
	envelope: ToolEnvelope;
	usage?: Record<string, unknown>;
	sessionFile?: string;
	sessionId?: string;
	warnings: string[];
}

function workerKey(tool: ToolManifest, agent: ResolvedAgent, cwd: string): string {
	return createHash("sha256")
		.update(
			[
				tool.name,
				tool.version,
				tool.contractVersion ?? tool.version,
				agent.name,
				agent.version,
				agent.contract,
				agent.source,
				agent.path ?? "embedded",
				cwd,
			].join("|"),
		)
		.digest("hex")
		.slice(0, 16);
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

function buildSystemPrompt(tool: ToolManifest, agent: ResolvedAgent): string {
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
		}),
		execute: async (_id, params) => {
			const input = params as {
				status: ToolEnvelope["status"];
				summary: string;
				result?: unknown;
				artifacts?: ToolEnvelope["artifacts"];
				warnings?: string[];
			};
			const candidate: ToolEnvelope = {
				status: input.status,
				summary: input.summary,
				result: input.result,
				artifacts: input.artifacts,
				warnings: input.warnings,
			};
			const errors = validateEnvelope(tool.output, candidate);
			if (errors.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `submit_result failed validation:\n${errors.join("\n")}\nFix the result and call submit_result again.`,
						},
					],
					details: { errors },
				};
			}
			state.pending = candidate;
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
	private readonly state: RunState = {};
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

	constructor(
		tool: ToolManifest,
		agent: ResolvedAgent,
		cwd: string,
		agentDir: string,
		modelRuntime: ModelRuntime,
		supervisor: ServiceSupervisor,
		log: (message: string) => void,
	) {
		this.tool = tool;
		this.agent = agent;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.modelRuntime = modelRuntime;
		this.supervisor = supervisor;
		this.log = log;
		this.key = workerKey(tool, agent, cwd);
		this.sessionDir = path.join(agentDir, "tool-workers", this.key);
		this.memoryPath = path.join(this.sessionDir, "memory.md");
		this.journalPath = path.join(this.sessionDir, "journal.jsonl");
	}

	private async createSession(): Promise<AgentSession> {
		await fs.mkdir(this.sessionDir, { recursive: true });

		const settingsManager = SettingsManager.inMemory({
			compaction: {
				enabled: true,
				reserveTokens: 20_000,
				keepRecentTokens: 30_000,
			},
		});

		const compactionExtension = (pi: ExtensionAPI) => {
			pi.on("session_compact", async (event) => {
				try {
					await fs.writeFile(this.memoryPath, event.compactionEntry.summary, "utf8");
				} catch (error) {
					this.log(`failed to write worker memory: ${String(error)}`);
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
			systemPromptOverride: () => buildSystemPrompt(this.tool, this.agent),
			appendSystemPromptOverride: () => [],
		});
		await loader.reload();

		const sessionManager = SessionManager.continueRecent(this.cwd, this.sessionDir);
		const memory = await readIfExists(this.memoryPath);
		if (memory && sessionManager.buildSessionContext().messages.length === 0) {
			sessionManager.appendCustomMessageEntry(
				"tool_worker_memory",
				`Previous worker memory for tool "${this.tool.name}":\n\n${memory}`,
				false,
			);
		}

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
				"submit_result",
			]),
		);

		const customTools: ToolDefinition[] = [createSubmitResultTool(this.tool, this.state)];
		if (this.tool.services && Object.keys(this.tool.services).length > 0) {
			customTools.push(createServiceTool(this.tool, this.supervisor));
		}

		const model = modelFromRuntime(this.modelRuntime, this.agent.model ?? this.tool.agent?.model);
		const { session } = await createAgentSession({
			cwd: this.cwd,
			agentDir: this.agentDir,
			model,
			modelRuntime: this.modelRuntime,
			resourceLoader: loader,
			settingsManager,
			sessionManager,
			tools: selectedTools,
			customTools,
		});
		return session;
	}

	private async getSession(): Promise<AgentSession> {
		this.sessionPromise ??= this.createSession();
		return this.sessionPromise;
	}

	async run(
		job: { task: string; input?: Record<string, unknown>; context?: string },
		signal?: AbortSignal,
	): Promise<WorkerRunResult> {
		const warnings: string[] = [];
		const session = await this.getSession();
		this.state.pending = undefined;

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

		try {
			await session.prompt(payload);
			if (!this.state.pending) {
				warnings.push("worker finished without calling submit_result; retrying once");
				await session.prompt(
					"You did not call submit_result. Call submit_result now with the final structured result. Do not answer with prose.",
				);
			}
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}

		const envelope: ToolEnvelope =
			this.state.pending ?? {
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
		const usage = stats
			? {
					tokens: stats.tokens,
					cost: stats.cost,
					contextUsage: stats.contextUsage,
			  }
			: undefined;

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
		try {
			const session = await this.sessionPromise;
			session?.dispose();
		} catch {
			// ignore
		}
	}
}
