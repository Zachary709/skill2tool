import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import pidtree from "pidtree";
import { JobManager } from "../src/jobs/manager.ts";
import { processAlive } from "../src/jobs/processes.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { ServiceSupervisor } from "../src/services/supervisor.ts";
import { writeToolArtifacts } from "../basic-tools/tool_add/artifacts.ts";
import { acquireWorkerLock } from "../src/jobs/lock.ts";
import { resolveAgent } from "../src/agents/resolver.ts";
import { workerKey } from "../src/agents/worker.ts";
import type { JobRecord, ToolManifest } from "../src/types.ts";

async function directory(): Promise<string> {
	const root = path.resolve("_intermediate");
	await fs.mkdir(root, { recursive: true });
	return fs.mkdtemp(path.join(root, "cancellation-tests-"));
}
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 20000;
	while (true) {
		const value = await read();
		if (matches(value)) return value;
		assert.ok(Date.now() < deadline, "等待真实任务状态超时");
		await sleep(50);
	}
}
async function commandTool(): Promise<ToolManifest> {
	const loaded = await readManifestFile("test/fixtures/process-control/TOOL.json");
	assert.deepEqual(loaded.errors, []);
	assert.ok(loaded.manifest);
	return loaded.manifest;
}

for (const force of [false, true]) test(`real command cancellation reaps descendants${force ? " after forced termination" : " and cancels queued work"}`, { timeout: 30000 }, async () => {
	const root = await directory();
	const manager = new JobManager({ root, agentDir: path.join(root, "agent"), notify: () => {}, log: console.error });
	const manifest = await commandTool();
	const controller = new AbortController();
	try {
		const first = await manager.create({ manifest, input: force
			? { command: "bash", args: ["-c", "trap '' TERM; exec sleep 120"] }
			: { command: "sleep", args: ["120"] },
			mode: "sync", cwd: process.cwd(), projectTrusted: true, signal: controller.signal,
			requester: { sessionId: "command-verification", runId: "command-run", toolCallId: "first" },
		});
		const pids = await until(async () => {
			const job = await manager.get(first.id);
			const pids = job?.pid ? await pidtree(job.pid) : [];
			const programs = await Promise.all(pids.map((pid) => fs.readlink(`/proc/${pid}/exe`).catch(() => "")));
			return programs.some((program) => path.basename(program) === "sleep") ? pids : [];
		}, (pids) => pids.length >= 3);
		const second = await manager.create({ manifest, input: { command: "node", args: ["--version"] },
			mode: "sync", cwd: process.cwd(), projectTrusted: true,
			requester: { sessionId: "command-verification", runId: "command-run", toolCallId: "second" },
		});
		assert.equal(second.state, "queued");
		manager.cancel(second.id);
		assert.equal(second.state, "cancelled");
		assert.equal(second.pid, undefined);
		const waiting = manager.wait(first.id, undefined, controller.signal);
		const stoppedAt = Date.now();
		controller.abort();
		assert.equal(first.state, "cancelling");
		assert.equal(first.finishedAt, undefined);
		await assert.rejects(waiting);
		assert.ok(Date.now() - stoppedAt < 1000, "外层等待应先于清理完成而结束");
		const finished = await until(() => manager.get(first.id), (job) => job?.state === "cancelled");
		assert.equal(finished?.result?.status, "cancelled");
		assert.equal(finished?.requester?.toolCallId, "first");
		for (const pid of [...pids, first.pid!]) assert.equal(processAlive(pid), false, `残留任务进程 ${pid}`);
		const events = await fs.readFile(path.join(root, first.id, "events.jsonl"), "utf8");
		assert.ok(events.includes("cancelling"));
		assert.ok(events.includes("cancelled"));
		if (force) assert.equal(finished?.forcedTermination, true);
	} finally { await manager.close(); }
});

test("a task waiting on the history snapshot lock cancels without making a model request", { timeout: 30000 }, async () => {
	const root = await directory();
	const loaded = await readManifestFile("basic-tools/tool_add/TOOL.json");
	assert.ok(loaded.manifest);
	const manifest = { ...loaded.manifest, scope: "package" as const };
	const agentDir = path.join(root, "agent");
	const resolved = await resolveAgent({ tool: manifest, cwd: root, agentDir, projectTrusted: true, allowCreateProject: false });
	assert.ok(resolved.agent);
	const lock = await acquireWorkerLock(path.join(agentDir, "tool-workers", workerKey(manifest, resolved.agent, root)));
	const manager = new JobManager({ root: path.join(root, "jobs"), agentDir, notify: () => {}, log: console.error });
	try {
		const job = await manager.create({ manifest, input: { request: "列出已注册工具。" }, mode: "sync", cwd: root, projectTrusted: true });
		await until(() => manager.get(job.id), (current) => current?.phase === "等待读取 worker 历史");
		manager.cancel(job.id);
		const stopped = await until(() => manager.get(job.id), (current) => current?.state === "cancelled");
		assert.equal(stopped?.modelRequests ?? 0, 0);
		assert.equal(processAlive(stopped?.pid), false);
	} finally { await manager.close(); await lock.release(); }
});

test("cancellation during cleanup wins over an already produced successful result", { timeout: 30000 }, async () => {
	const root = await directory();
	const manager = new JobManager({ root, agentDir: path.join(root, "agent"), notify: () => {}, log: console.error });
	try {
		const job = await manager.create({ manifest: await commandTool(), mode: "sync", cwd: process.cwd(), projectTrusted: true,
			input: { command: "bash", args: ["-c", "trap '' TERM; sleep 120 >/dev/null 2>&1 & exit 0"] } });
		await until(() => manager.get(job.id), (current) => current?.phase === "保存结果并清理子进程");
		manager.cancel(job.id);
		const stopped = await until(() => manager.get(job.id), (current) => current?.state === "cancelled");
		assert.equal(stopped?.result?.status, "cancelled");
		const events = await fs.readFile(path.join(root, job.id, "events.jsonl"), "utf8");
		assert.ok(events.includes('"phase":"worker_result","envelope":{"status":"ok"'));
		for (const pid of stopped?.ownedPids ?? []) assert.equal(processAlive(pid), false);
	} finally { await manager.close(); }
});

test("cancelling an HTTP wait releases the request and leaves the shared file service alive", { timeout: 30000 }, async () => {
	const root = await directory();
	const server = fork(path.resolve("test/fixtures/process-control/file-watch-server.mjs"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.once("message", (message: any) => resolve(message.port));
	});
	const url = `http://127.0.0.1:${port}/`;
	const manifest: ToolManifest = {
		name: "file_change", version: "1.0.0", description: "等待指定文件实际发生修改并返回其更新时间。", kind: "direct",
		dir: path.join(root, "file-change"), input: { type: "object", properties: {
			method: { type: "string" }, params: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
		}, required: ["method", "params"], additionalProperties: false },
		output: { type: "object", properties: { path: { type: "string", maxLength: 1000 }, mtimeMs: { type: "number" } }, required: ["path", "mtimeMs"], additionalProperties: false },
		services: { wait: { type: "daemon", protocol: "http-json", url, lifecycle: "persistent" } },
	};
	await writeToolArtifacts(manifest.dir!, manifest, {});
	const supervisor = new ServiceSupervisor({ agentDir: path.join(root, "agent"), projectCwd: process.cwd() });
	const manager = new JobManager({ root: path.join(root, "jobs"), agentDir: path.join(root, "agent"), notify: () => {}, log: console.error,
		service: (tool, name, input, signal) => supervisor.call(tool, name, input, signal) });
	const count = async () => (await (await fetch(url)).json() as { watchers: number }).watchers;
	try {
		const job = await manager.create({ manifest, input: { method: "wait", params: { path: path.resolve("README.md") } },
			mode: "sync", cwd: process.cwd(), projectTrusted: true });
		await until(count, (watchers) => watchers === 1);
		manager.cancel(job.id);
		await until(() => manager.get(job.id), (current) => current?.state === "cancelled");
		assert.equal(processAlive(server.pid), true);
		await until(count, (watchers) => watchers === 0);
	} finally {
		await manager.close(); await supervisor.close();
		const exit = new Promise<void>((resolve) => server.once("exit", () => resolve()));
		server.kill("SIGTERM"); await exit;
	}
});
