import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import extension from "../extensions/tool-runtime.ts";
import { readJobRecord } from "../src/jobs/store.ts";
import { processAlive } from "../src/jobs/processes.ts";
import type { AgentConfig, JobRecord, ToolEnvelope } from "../src/types.ts";

setGlobalDispatcher(new EnvHttpProxyAgent()); install();
const parent = path.resolve("_intermediate/agent-runtime-checks");
await fs.mkdir(parent, { recursive: true });
const cwd = await fs.mkdtemp(path.join(parent, "cancellation-runtime-"));
const root = path.join(cwd, ".pi", "jobs");
const agentDir = getAgentDir();
const provider = process.env.PI_PROVIDER;
const modelId = process.env.PI_MODEL;
assert.ok(provider && modelId, "需要 PI_PROVIDER 和 PI_MODEL 指定当前可用模型");
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const model = modelRuntime.getModel(provider, modelId);
assert.ok(model);
const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
	noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader: loader,
	thinkingLevel: process.env.PI_REASONING_LEVEL as AgentConfig["thinkingLevel"],
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")), settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
await session.bindExtensions({ mode: "print" });
const calls: Array<{ id: string; name: string; result?: any }> = [];
const updates: Array<{ id: string; jobId?: string; text: string }> = [];
session.subscribe((event) => {
	if (event.type === "tool_execution_start") calls.push({ id: event.toolCallId, name: event.toolName });
	if (event.type === "tool_execution_update") updates.push({ id: event.toolCallId,
		jobId: (event.partialResult.details as any)?.jobId, text: JSON.stringify(event.partialResult.content) });
	if (event.type === "tool_execution_end") {
		const call = calls.find((call) => call.id === event.toolCallId);
		if (call) call.result = event.result;
	}
});
async function records(): Promise<JobRecord[]> {
	const names = await fs.readdir(root);
	return (await Promise.all(names.filter((id) => id.startsWith("job_")).map((id) => readJobRecord(root, id)))).filter((record): record is JobRecord => Boolean(record));
}
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
	const end = Date.now() + 300000;
	while (true) {
		const value = await read();
		if (matches(value)) return value;
		assert.ok(Date.now() < end, "等待真实 SDK 任务超时");
		await sleep(100);
	}
}
const evidence: Record<string, unknown> = { cwd, parentSession: session.sessionFile, model: `${provider}/${modelId}` };
const pending: Promise<unknown>[] = [];
try {
	console.log("通过独立 tool_add worker 创建实际命令工具");
	session.setActiveToolsByName(["tool_add"]);
	await session.prompt("创建项目工具 command_agent：输入 request，用 bash 执行其中明确指定的命令，返回 exitCode 和 stdout。独立请求允许并行执行。没有明确命令时不执行。");
	const creation = calls.find((call) => call.name === "tool_add")?.result?.structuredContent as ToolEnvelope;
	assert.equal(creation?.status, "ok", creation?.summary);
	const built = JSON.parse(await fs.readFile(path.join(cwd, ".pi", "tools", "command_agent", "TOOL.json"), "utf8"));
	assert.equal(built.agent.concurrency, "parallel");
	const creationJob = (await records()).find((job) => job.tool === "tool_add")!;
	assert.ok(creationJob.pid && creationJob.pid !== process.pid && creationJob.ownedPids?.length);
	assert.equal(creationJob.model, `${provider}/${modelId}`);
	assert.equal(creationJob.thinkingLevel, session.thinkingLevel);
	assert.equal((creationJob.usage as any).contextManagement.budgetTokens, 272000);
	const createEvents = await fs.readFile(path.join(root, creationJob.id, "events.jsonl"), "utf8");
	assert.ok(createEvents.includes('"operation":"tool_add_manage","phase":"completed"'));
	evidence.creation = creationJob;

	const command = session.agent.state.tools.find((tool) => tool.name === "command_agent")!;
	const toolAdd = session.agent.state.tools.find((tool) => tool.name === "tool_add")!;
	assert.ok(command && toolAdd);
	const waitingId = randomUUID();
	const listId = randomUUID();
	const streamed = new Map<string, Set<string>>();
	const sink = (id: string) => (partial: any) => {
		if (!streamed.has(id)) streamed.set(id, new Set());
		if (partial.details?.jobId) streamed.get(id)!.add(partial.details.jobId);
	};
	console.log("取消一个模型等待任务，验证并行管理任务继续完成");
	const waiting = command.execute(waitingId, { request: "执行 sleep 120。" }, new AbortController().signal, sink(waitingId));
	const listing = toolAdd.execute(listId, { request: "列出已注册的工具。" }, new AbortController().signal, sink(listId));
	pending.push(waiting, listing);
	const waitingJob = (await until(records, (jobs) => jobs.some((job) => job.requester?.toolCallId === waitingId && (job.modelRequests ?? 0) >= 1)))
		.find((job) => job.requester?.toolCallId === waitingId)!;
	const requestCount = waitingJob.modelRequests;
	const cancellationAt = Date.now();
	await session.prompt(`/tool-cancel ${waitingJob.id}`);
	const stopped = await waiting;
	assert.ok(Date.now() - cancellationAt < 1000);
	const completedList = await listing;
	assert.equal((completedList.structuredContent as ToolEnvelope).status, "ok");
	const cancelled = (await until(records, (jobs) => jobs.some((job) => job.id === waitingJob.id && job.state === "cancelled"))).find((job) => job.id === waitingJob.id)!;
	assert.equal(cancelled.modelRequests, requestCount, "取消后不得重试模型请求");
	assert.equal(streamed.get(waitingId)?.size, 1);
	assert.equal(streamed.get(listId)?.size, 1);
	assert.notEqual([...streamed.get(waitingId)!][0], [...streamed.get(listId)!][0]);
	evidence.singleCancellation = { cancelled, returned: stopped, independentList: completedList, streamed: [...streamed].map(([id, jobs]) => ({ id, jobs: [...jobs] })) };

	console.log("在外层 agent 忙碌时直接执行 /tool-cancel all");
	session.setActiveToolsByName(["command_agent"]);
	const beforeAll = new Set((await records()).map((job) => job.id));
	const allRunning = session.prompt("并行调用 command_agent 执行两个独立命令：sleep 120 和 sleep 121。");
	pending.push(allRunning);
	const allStarted = (await until(records, (jobs) => jobs.filter((job) => !beforeAll.has(job.id) && (job.modelRequests ?? 0) >= 1).length >= 2))
		.filter((job) => !beforeAll.has(job.id));
	const allAt = Date.now();
	await session.prompt("/tool-cancel all");
	const allCommandMs = Date.now() - allAt;
	assert.ok(allCommandMs < 1000, `取消命令耗时 ${allCommandMs}ms`);
	await allRunning;
	const allStopped = (await until(records, (jobs) => allStarted.every((child) => jobs.some((job) => job.id === child.id && job.state === "cancelled"))))
		.filter((job) => allStarted.some((child) => child.id === job.id));
	assert.equal((await records()).filter((job) => !beforeAll.has(job.id)).length, 2);
	for (const job of allStopped) assert.equal(job.modelRequests, allStarted.find((child) => child.id === job.id)?.modelRequests);
	evidence.cancelAll = { allCommandMs, allStopped };

	console.log("实际停止外层 agent，验证全部并行 bash 子任务终止");
	const before = new Set((await records()).map((job) => job.id));
	const running = session.prompt("并行调用 command_agent 两次，两个独立命令分别是 `uname -s; sleep 120` 和 `uname -m; sleep 121`。");
	pending.push(running);
	const started = await until(records, (jobs) => jobs.filter((job) => !before.has(job.id) && job.tool === "command_agent" && job.phase?.includes("执行 bash") && (job.outputEvents ?? 0) > 0 && (job.ownedPids?.filter((pid) => processAlive(pid)).length ?? 0) >= 2).length >= 2);
	const children = started.filter((job) => !before.has(job.id) && job.tool === "command_agent");
	assert.equal(new Set(children.map((job) => job.requester?.runId)).size, 1);
	assert.equal(new Set(children.map((job) => job.requester?.toolCallId)).size, 2);
	const stopAt = Date.now();
	await session.abort();
	const outerStopMs = Date.now() - stopAt;
	assert.ok(outerStopMs < 1000, `外层停止耗时 ${outerStopMs}ms`);
	await running;
	const finished = (await until(records, (jobs) => children.every((child) => jobs.some((job) => job.id === child.id && job.state === "cancelled"))))
		.filter((job) => children.some((child) => child.id === job.id));
	for (const job of finished) {
		assert.equal(processAlive(job.pid), false);
		for (const pid of job.ownedPids ?? []) assert.equal(processAlive(pid), false);
		const outputs = await Promise.all((job.outputFiles ?? []).map((file) => fs.readFile(file, "utf8")));
		assert.ok(outputs.some((text) => text.includes(os.type()) || text.includes(os.machine())), "取消后应保留真实命令输出");
	}
	for (const child of children) assert.ok(updates.some((update) => update.jobId === child.id));
	evidence.parentCancellation = { outerStopMs, finished };

	console.log("验证 service_keeper 通过 IPC 读取主进程 daemon 注册信息");
	session.setActiveToolsByName(["service_keeper"]);
	await session.prompt("列出当前工具 daemon，不检查外部服务，也不进行修复。");
	const keeper = [...calls].reverse().find((call) => call.name === "service_keeper")?.result?.structuredContent as ToolEnvelope;
	assert.equal(keeper?.status, "ok", keeper?.summary);
	const keeperJob = (await records()).find((job) => job.tool === "service_keeper")!;
	const keeperEvents = await fs.readFile(path.join(root, keeperJob.id, "events.jsonl"), "utf8");
	assert.ok(keeperEvents.includes('"operation":"service_keeper_manage","phase":"completed"'));
	evidence.keeper = keeperJob;
	console.log(JSON.stringify({ cwd, outerStopMs, allCommandMs,
		verified: ["tool_add IPC", "单项取消", "忙碌时取消全部", "并行进展", "模型取消后不重试", "外层停止", "bash 子进程回收", "真实输出留档", "service_keeper IPC"] }, null, 2));
} finally {
	await session.abort();
	await session.extensionRunner.emit({ type: "session_shutdown" });
	await Promise.allSettled(pending);
	await fs.writeFile(path.join(parent, "cancellation-runtime-verification.json"), JSON.stringify({ ...evidence, calls, updates }, null, 2));
	session.dispose();
}
