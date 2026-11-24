import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { ToolRuntime } from "../src/runtime/tool-runtime.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { readJobRecord } from "../src/jobs/store.ts";
import { readProgressEntries, snapshotProgress } from "../src/observability/progress.ts";
import { processAlive } from "../src/jobs/processes.ts";
import type { AgentConfig, JobRecord, ToolEnvelope } from "../src/types.ts";

setGlobalDispatcher(new EnvHttpProxyAgent()); install();
const parent = path.resolve("_intermediate/agent-runtime-checks");
await fs.mkdir(parent, { recursive: true });
const cwd = await fs.mkdtemp(path.join(parent, "progress-runtime-"));
const agentDir = getAgentDir();
const provider = process.env.PI_PROVIDER;
const modelId = process.env.PI_MODEL;
assert.ok(provider && modelId);
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const model = modelRuntime.getModel(provider, modelId);
assert.ok(model);
const loaded = await readManifestFile("test/fixtures/process-control/BASH_TOOL.json");
assert.deepEqual(loaded.errors, []);
assert.ok(loaded.manifest);
let runtime: ToolRuntime | undefined;
const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
	noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
		pi.on("session_start", async (_event, ctx) => {
			runtime = new ToolRuntime({ pi, cwd, agentDir, projectTrusted: ctx.isProjectTrusted(), modelRuntime, log: console.error });
			await runtime.initialize();
			runtime.register(loaded.manifest!);
		});
	}] });
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader: loader,
	thinkingLevel: process.env.PI_REASONING_LEVEL as AgentConfig["thinkingLevel"], sessionManager: SessionManager.inMemory(cwd),
	settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
await session.bindExtensions({ mode: "print" });
const updates: Array<{ at: number; text: string; details: Record<string, unknown> }> = [];
const evidence: Record<string, unknown> = { cwd, model: `${provider}/${modelId}` };
const signal = new AbortController();
let running: Promise<unknown> | undefined;
try {
	const tool = session.agent.state.tools.find((tool) => tool.name === loaded.manifest!.name);
	assert.ok(tool);
	const command = "uname -s; sleep 2; uname -s; sleep 2; uname -m; sleep 2";
	console.log("验证真实模型和 Bash 流式进展去重");
	running = tool.execute(randomUUID(), { command }, signal.signal, (partial) => updates.push({ at: Date.now(),
		text: partial.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n"),
		details: partial.details as Record<string, unknown> }));
	const deadline = Date.now() + 300000;
	while (!updates.some((update) => update.text.includes(`[进展] bash ${os.type()}`))) {
		assert.ok(Date.now() < deadline, "等待真实流式输出超时");
		await sleep(20);
	}
	const silentStart = updates.length;
	await sleep(2500);
	assert.equal(updates.length, silentStart, "静默及重复输出期间不应重发状态或计时消息");
	const result = await running as { structuredContent: ToolEnvelope };
	assert.equal(result.structuredContent.status, "ok", result.structuredContent.summary);
	const jobId = updates.find((update) => typeof update.details.jobId === "string")!.details.jobId as string;
	const root = path.join(cwd, ".pi", "jobs");
	const job = await readJobRecord(root, jobId) as JobRecord;
	assert.equal(job.state, "succeeded");
	assert.equal(job.model, `${provider}/${modelId}`);
	assert.equal(job.thinkingLevel, session.thinkingLevel);
	assert.equal((job.usage as any).contextManagement.budgetTokens, 272000);
	const entries = await readProgressEntries(path.join(root, jobId, "progress.jsonl"), 60);
	const output = entries.filter((entry) => entry.kind === "update");
	assert.deepEqual(output.map((entry) => entry.text), [os.type(), os.machine()]);
	assert.equal(entries.filter((entry) => entry.text === "模型正在处理").length, 0);
	assert.equal(entries.filter((entry) => entry.kind === "tool" && entry.tool === "submit_result").length, 1);
	for (const update of updates) assert.equal(update.text.split("\n").filter((line) => /\[调用\]|\[进展\]|\[结果\]/.test(line)).length <= 1, true);
	assert.equal(updates.filter((update) => update.text.includes(`[进展] bash ${os.type()}`)).length, 1);
	assert.equal(updates.filter((update) => update.text.includes(`[进展] bash ${os.machine()}`)).length, 1);
	assert.equal(updates.some((update) => update.text.includes("worker 会话已建立") || update.text.includes("submit_result") || update.text.includes("Linux Linux")), false);
	const raw = await Promise.all((job.outputFiles ?? []).map((file) => fs.readFile(file, "utf8")));
	assert.ok(raw.includes(`${os.type()}\n${os.type()}\n${os.machine()}\n`), "完整记录应保留实际重复输出");
	assert.equal(processAlive(job.pid), false);
	for (const pid of job.ownedPids ?? []) assert.equal(processAlive(pid), false);
	const snapshot = await snapshotProgress({ jobsRoot: root, jobId });
	assert.equal(snapshot.entries.filter((entry) => entry.tool === "bash").length, 1, "同一内部调用的进展应合并为一条记录");
	evidence.job = job; evidence.entries = entries; evidence.snapshot = snapshot;
	console.log(JSON.stringify({ cwd, updates: updates.length, output: output.map((entry) => entry.text),
		verified: ["静默期间无重复更新", "重复输出去重", "不重发历史快照", "submit_result 单次记录", "完整输出保留", "任务进程退出"] }, null, 2));
} finally {
	signal.abort();
	await runtime?.close();
	await Promise.allSettled(running ? [running] : []);
	session.dispose();
	await fs.writeFile(path.join(parent, "progress-runtime-verification.json"), JSON.stringify({ ...evidence, updates }, null, 2));
}
