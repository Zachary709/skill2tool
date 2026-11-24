import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { JobManager } from "../src/jobs/manager.ts";
import { processAlive } from "../src/jobs/processes.ts";
import { readJobRecord } from "../src/jobs/store.ts";

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 20000;
	while (true) {
		const value = await read();
		if (matches(value)) return value;
		assert.ok(Date.now() < deadline, "等待实际任务状态超时");
		await sleep(50);
	}
}

test("serial jobs queue within a conversation and other runtimes preserve live ownership", { timeout: 30000 }, async () => {
	const parent = path.resolve("_intermediate/concurrency-tests");
	await fs.mkdir(parent, { recursive: true });
	const cwd = await fs.mkdtemp(path.join(parent, "run-"));
	const root = path.join(cwd, "jobs");
	const agentDir = path.join(cwd, "agent");
	const manager = new JobManager({ root, agentDir, notify: () => {}, log: console.error });
	const other = new JobManager({ root, agentDir, notify: () => {}, log: console.error });
	const loaded = await readManifestFile("test/fixtures/process-control/TOOL.json");
	assert.deepEqual(loaded.errors, []);
	assert.ok(loaded.manifest);
	const manifest = loaded.manifest;
	const target = path.join(cwd, "README.md");
	const ready = path.join(cwd, "ready");
	try {
		const first = await manager.create({ manifest, input: { command: process.execPath,
			args: [path.resolve("test/fixtures/process-control/wait-file.mjs"), target, ready] },
			mode: "sync", cwd, projectTrusted: true, requester: { sessionId: "first-conversation" } });
		await until(() => fs.readdir(cwd), (files) => files.includes("ready"));
		const queued = await manager.create({ manifest, input: { command: process.execPath, args: ["--version"] },
			mode: "sync", cwd, projectTrusted: true, requester: { sessionId: "first-conversation" } });
		assert.equal(queued.state, "queued");
		await other.recover();
		assert.equal((await readJobRecord(root, first.id))?.state, "running");
		assert.equal((await readJobRecord(root, queued.id))?.state, "queued");
		assert.equal((await other.handle({ action: "cancel", jobId: first.id })).status, "failed");
		const second = await manager.create({ manifest, input: { command: process.execPath, args: ["--version"] },
			mode: "sync", cwd, projectTrusted: true, requester: { sessionId: "second-conversation" } });
		const completed = await until(() => manager.get(second.id), (job) => job?.state === "succeeded" || job?.state === "failed");
		assert.equal(completed?.state, "succeeded", completed?.result?.summary);
		assert.equal((completed?.result?.result as { stdout: string }).stdout.trim(), process.version);
		assert.equal(first.state, "running");
		assert.equal(queued.state, "queued");
		assert.equal(queued.pid, undefined);
		await other.close();
		assert.equal(first.state, "running");
		await fs.copyFile("README.md", path.join(cwd, "incoming"));
		await fs.rename(path.join(cwd, "incoming"), target);
		const finished = await until(() => manager.get(first.id), (job) => job?.state === "succeeded" || job?.state === "failed");
		assert.equal(finished?.state, "succeeded", finished?.result?.summary);
		const expected = createHash("sha256").update(await fs.readFile("README.md")).digest("hex");
		assert.equal((finished?.result?.result as { stdout: string }).stdout.trim(), expected);
		const last = await until(() => manager.get(queued.id), (job) => job?.state === "succeeded" || job?.state === "failed");
		assert.equal(last?.state, "succeeded", last?.result?.summary);
		for (const job of [first, second, queued]) {
			assert.equal(processAlive(job.pid), false);
			for (const pid of job.ownedPids ?? []) assert.equal(processAlive(pid), false);
		}
	} finally {
		await manager.close();
		await other.close();
	}
});
