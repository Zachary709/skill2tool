import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { writeToolArtifacts } from "../basic-tools/tool_add/artifacts.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { processAlive } from "../src/jobs/processes.ts";
import { readJobRecord } from "../src/jobs/store.ts";
import { ToolRuntime } from "../src/runtime/tool-runtime.ts";
import type { AgentConfig, JobRecord, ToolEnvelope, ToolManifest } from "../src/types.ts";

setGlobalDispatcher(new EnvHttpProxyAgent()); install();
const parent = path.resolve("_intermediate/agent-runtime-checks");
await fs.mkdir(parent, { recursive: true });
const directory = await fs.mkdtemp(path.join(parent, "concurrency-runtime-"));
const project = path.join(directory, "project");
const otherProject = path.join(directory, "other-project");
await fs.mkdir(project, { recursive: true });
await fs.mkdir(otherProject, { recursive: true });
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
const manifest: ToolManifest = { ...loaded.manifest, name: "concurrency_bash_agent", dir: path.join(directory, "tool"), scope: "user",
	agent: { ...loaded.manifest.agent, sessionScope: "user", createProjectIfMissing: false } };
await writeToolArtifacts(manifest.dir!, manifest, {
	instructions: await fs.readFile("test/fixtures/process-control/BASH_AGENT.md", "utf8"),
	workflow: await fs.readFile("test/fixtures/process-control/BASH_WORKFLOW.md", "utf8"),
});
const sessions: AgentSession[] = [];
const runtimes: ToolRuntime[] = [];
const pending: Promise<unknown>[] = [];
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
const completed: string[] = [];
const evidence: Record<string, unknown> = { directory, model: `${provider}/${modelId}` };

async function conversation(cwd: string): Promise<AgentSession> {
	const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
			pi.on("session_start", async (_event, ctx) => {
				const runtime = new ToolRuntime({ pi, cwd, agentDir, projectTrusted: ctx.isProjectTrusted(), modelRuntime, log: console.error });
				runtimes.push(runtime);
				await runtime.initialize();
				runtime.register(manifest, true);
			});
		}] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader: loader,
		thinkingLevel: process.env.PI_REASONING_LEVEL as AgentConfig["thinkingLevel"], sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
	sessions.push(session);
	await session.bindExtensions({ mode: "print" });
	return session;
}

function invoke(session: AgentSession, command: string) {
	const tool = session.agent.state.tools.find((tool) => tool.name === manifest.name);
	assert.ok(tool);
	const toolCallId = randomUUID();
	const result = tool.execute(toolCallId, { command }, signal).then((result) => {
		completed.push(toolCallId);
		return result as typeof result & { structuredContent: ToolEnvelope; details: { jobId: string } };
	});
	pending.push(result);
	return { toolCallId, result };
}

async function record(cwd: string, id: string): Promise<JobRecord> {
	const job = await readJobRecord(path.join(cwd, ".pi", "jobs"), id);
	assert.ok(job);
	assert.equal(job.state, "succeeded", job.result?.summary);
	assert.equal(job.model, `${provider}/${modelId}`);
	assert.equal(job.concurrency, "serial");
	assert.equal(job.thinkingLevel, sessions[0].thinkingLevel);
	assert.equal(processAlive(job.pid), false);
	for (const pid of job.ownedPids ?? []) assert.equal(processAlive(pid), false);
	return job;
}

try {
	const firstSession = await conversation(project);
	const target = path.join(project, "README.md");
	const ready = path.join(project, "ready");
	const command = [process.execPath, path.resolve("test/fixtures/process-control/wait-file.mjs"), target, ready]
		.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
	const first = invoke(firstSession, command);
	const deadline = Date.now() + 300000;
	while (!(await fs.readdir(project)).includes("ready")) {
		signal.throwIfAborted();
		assert.ok(!completed.includes(first.toolCallId), "等待文件的命令不应提前结束");
		assert.ok(Date.now() < deadline, "等待真实 worker 启动命令超时");
		await sleep(50);
	}
	console.log("第一个对话的命令已开始等待真实文件，启动其他对话");
	const secondSession = await conversation(project);
	const second = invoke(secondSession, "uname -s");
	const secondResult = await second.result;
	assert.equal(secondResult.structuredContent.status, "ok", secondResult.structuredContent.summary);
	assert.equal((secondResult.structuredContent.result as { stdout: string }).stdout.trim(), os.type());
	assert.deepEqual(completed, [second.toolCallId]);
	const secondJob = await record(project, secondResult.details.jobId);
	const secondHistory = secondJob.usage!.history as { sharedSession: string; completedEntryId: string };
	const firstRoot = path.join(project, ".pi", "jobs");
	const active = (await Promise.all((await fs.readdir(firstRoot)).filter((id) => id.startsWith("job_"))
		.map((id) => readJobRecord(firstRoot, id)))).find((job) => job?.requester?.toolCallId === first.toolCallId);
	assert.equal(active?.state, "running", "新对话初始化不得改变另一个对话的活动任务");
	const before = SessionManager.open(secondHistory.sharedSession).getBranch();
	assert.deepEqual(before.map((entry) => entry.id), [secondHistory.completedEntryId]);

	const thirdSession = await conversation(otherProject);
	const third = invoke(thirdSession, "uname -m");
	const thirdResult = await third.result;
	assert.equal(thirdResult.structuredContent.status, "ok", thirdResult.structuredContent.summary);
	assert.equal((thirdResult.structuredContent.result as { stdout: string }).stdout.trim(), os.machine());
	const thirdJob = await record(otherProject, thirdResult.details.jobId);
	assert.deepEqual(completed, [second.toolCallId, third.toolCallId]);
	await fs.copyFile("README.md", path.join(project, "incoming"));
	await fs.rename(path.join(project, "incoming"), target);
	const firstResult = await first.result;
	assert.equal(firstResult.structuredContent.status, "ok", firstResult.structuredContent.summary);
	const expected = createHash("sha256").update(await fs.readFile("README.md")).digest("hex");
	assert.equal((firstResult.structuredContent.result as { stdout: string }).stdout.trim(), expected);
	const firstJob = await record(project, firstResult.details.jobId);
	assert.deepEqual(completed, [second.toolCallId, third.toolCallId, first.toolCallId]);
	assert.equal(new Set([firstJob, secondJob, thirdJob].map((job) => job.sessionId)).size, 3);
	const ordered = [secondJob, thirdJob, firstJob];
	for (const job of ordered) {
		assert.equal((job.usage!.history as { sharedSession: string }).sharedSession, secondHistory.sharedSession);
	}
	const shared = SessionManager.open(secondHistory.sharedSession);
	assert.deepEqual(shared.getBranch().map((entry) => entry.id),
		ordered.map((job) => (job.usage!.history as { completedEntryId: string }).completedEntryId));
	for (const [job, session, call] of [[firstJob, firstSession, first], [secondJob, secondSession, second], [thirdJob, thirdSession, third]] as const) {
		assert.equal(job.requester?.sessionId, session.sessionId);
		assert.equal(job.requester?.toolCallId, call.toolCallId);
	}
	evidence.jobs = ordered;
	evidence.sharedSession = secondHistory.sharedSession;
	evidence.completed = completed;
	evidence.status = "passed";
	console.log(JSON.stringify({ directory, verified: ["同项目不同对话并行", "不同项目共享工具并行", "活动任务不被误判丢失", "独立 worker 会话", "结果按返回顺序写入共享上下文", "结果归属各自对话", "无任务进程残留"] }, null, 2));
} catch (error) {
	evidence.error = String(error);
	throw error;
} finally {
	controller.abort();
	await Promise.all(runtimes.map((runtime) => runtime.close()));
	await Promise.allSettled(pending);
	for (const session of sessions) session.dispose();
	await fs.writeFile(path.join(directory, "verification.json"), JSON.stringify(evidence, null, 2));
}
