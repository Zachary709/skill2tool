import { workerController } from "./process-tracker.ts";
import * as path from "node:path";
import { getAgentDir, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { AgentWorker, type WorkerRunResult } from "../agents/worker.ts";
import { resolveAgent } from "../agents/resolver.ts";
import { readJobRecord } from "./store.ts";
import { WorkerRpc, type WorkerMessage, type ParentMessage } from "./ipc.ts";
import { abortable } from "./abort.ts";
import { executeDirectTool } from "../runtime/direct-executor.ts";
import { ServiceSupervisor } from "../services/supervisor.ts";

function send(message: WorkerMessage): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.connected) { reject(new Error("父进程已断开")); return; }
		process.send!(message, (error) => error ? reject(error) : resolve());
	});
}

async function main(): Promise<void> {
	const jobPath = process.argv[2];
	if (!jobPath || !process.send) throw new Error("worker 必须由任务管理器通过 IPC 启动");
	setGlobalDispatcher(new EnvHttpProxyAgent()); install();
	const root = path.dirname(path.dirname(path.resolve(jobPath)));
	const jobId = path.basename(path.dirname(jobPath));
	const record = await readJobRecord(root, jobId);
	if (!record?.toolDir) throw new Error("任务缺少工具目录");
	const signal = workerController.signal;
	const configured = new Promise<Extract<ParentMessage, { type: "configure" }>>((resolve) => {
		const receive = (raw: unknown) => {
			const message = raw as ParentMessage;
			if (message.type === "configure") { process.removeListener("message", receive); resolve(message); }
		};
		process.on("message", receive);
	});
	await send({ type: "ready" });
	const configuration = await abortable(configured, signal);
	const manifest = configuration.manifest;
	const rpc = new WorkerRpc(signal);
	const localServices = new ServiceSupervisor({ projectCwd: record.cwd, agentDir: process.env.PI_TOOL_RUNTIME_AGENT_DIR || getAgentDir() });
	const supervisor = { call: (_tool: unknown, name: string, input: Record<string, unknown>, callSignal?: AbortSignal) =>
		manifest.services?.[name]?.type === "script" ? localServices.call(manifest, name, input, callSignal ?? signal) : rpc.call("service", name, input) };
	const extraTools: ToolDefinition[] = configuration.tools.map((tool) => ({
		...tool, parameters: Type.Unsafe(tool.parameters),
		execute: async (_id, input, signal) => { signal?.throwIfAborted(); return rpc.call("management", tool.name, input as Record<string, unknown>); },
	}));
	signal.throwIfAborted();
	if (manifest.kind === "direct") {
		await rpc.call("audit", "direct_service", { input: record.input });
		signal.throwIfAborted();
		const service = typeof record.input.service === "string" ? record.input.service : manifest.directService ?? Object.keys(manifest.services ?? {})[0];
		await send({ type: "progress", entry: { time: new Date().toISOString(), kind: "status", text: `调用服务 ${service}` } });
		signal.throwIfAborted();
		const envelope = await executeDirectTool(manifest, record.input, supervisor, signal);
		await send({ type: "result", result: { envelope, warnings: [] } }); return;
	}
	const agentDir = process.env.PI_TOOL_RUNTIME_AGENT_DIR || getAgentDir();
	const resolution = await resolveAgent({ tool: manifest, cwd: record.cwd, agentDir,
		projectTrusted: record.projectTrusted ?? false, allowCreateProject: manifest.agent?.createProjectIfMissing ?? !manifest.handler });
	signal.throwIfAborted();
	if (!resolution.agent) throw new Error(resolution.error ?? "未找到可用的 worker 配置");
	await send({ type: "resolved", agentId: `${resolution.agent.source}:${resolution.agent.name}@${resolution.agent.version}`, agentSource: resolution.agent.source });
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	signal.throwIfAborted();
	const worker = new AgentWorker(manifest, resolution.agent, record.cwd, agentDir, modelRuntime, supervisor,
		(message) => process.stderr.write(`${message}\n`),
		(entry) => { void send({ type: "progress", entry }).catch((error) => { if (!signal.aborted) process.stderr.write(`${String(error)}\n`); }); },
		record.model, extraTools, {}, record.thinkingLevel,
		async (operation, input, callSignal) => { callSignal?.throwIfAborted(); await rpc.call("audit", operation, input); });
	try {
		const result = await worker.run({ task: `Handle this ${manifest.name} request and finish with submit_result.`,
			input: record.input, context: `Project directory: ${record.cwd}` }, signal);
		await send({ type: "result", result });
	} finally { await worker.dispose(); }
}

try { await main(); }
catch (error) {
	const result: WorkerRunResult = { envelope: { status: workerController.signal.aborted ? "cancelled" : "failed",
		summary: error instanceof Error ? error.message : String(error) }, warnings: [] };
	if (process.connected) await send({ type: "result", result });
	else process.stderr.write(`${result.envelope.summary}\n`);
} finally {
	if (process.connected) process.disconnect();
}
