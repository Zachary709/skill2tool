import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { validateManifest } from "../src/contracts/schema.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { ServiceSupervisor } from "../src/services/supervisor.ts";
import { JobManager } from "../src/jobs/manager.ts";
import { writeJobRecord } from "../src/jobs/store.ts";
import type { ToolManifest } from "../src/types.ts";

const tempRoot = path.join(process.cwd(), ".test-tmp");

before(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
	await fs.mkdir(tempRoot, { recursive: true });
});

after(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

test("manifest validation rejects a direct tool without services", () => {
	const result = validateManifest({
		name: "x",
		version: "1.0.0",
		description: "A tool without services.",
		kind: "direct",
		input: { type: "object" },
		output: { type: "object" },
	});
	assert.ok(result.errors.some((error) => error.includes("at least one service")));
});

test("script service runs and returns JSON", async () => {
	const result = await readManifestFile("examples/tools/word-count/TOOL.json");
	assert.ok(result.manifest);
	const supervisor = new ServiceSupervisor();
	try {
		const call = await supervisor.call(result.manifest!, "count", { text: "alpha beta gamma" });
		assert.equal(call.ok, true);
		assert.deepEqual(call.result, { count: 3 });
	} finally {
		await supervisor.close();
	}
});

test("stdio daemon responds to JSON lines", async () => {
	const tool: ToolManifest = {
		name: "daemon_test",
		version: "1.0.0",
		kind: "direct",
		description: "Test daemon tool.",
		input: { type: "object" },
		output: { type: "object" },
		dir: process.cwd(),
		services: {
			echo: {
				type: "daemon",
				command: process.execPath,
				args: ["test/fixtures/echo-daemon.mjs"],
				protocol: "jsonl-stdio",
				start: "lazy",
			},
		},
	};
	const supervisor = new ServiceSupervisor();
	try {
		const call = await supervisor.call(tool, "echo", { method: "ping", params: { value: 7 } });
		assert.equal(call.ok, true);
		assert.deepEqual(call.result, { echo: { value: 7 }, method: "ping" });
	} finally {
		await supervisor.close();
	}
});

test("unix daemon responds to JSON lines", async () => {
	const socketPath = path.join(tempRoot, "echo.sock");
	const tool: ToolManifest = {
		name: "unix_test",
		version: "1.0.0",
		kind: "direct",
		description: "Test unix daemon tool.",
		input: { type: "object" },
		output: { type: "object" },
		dir: process.cwd(),
		services: {
			echo: {
				type: "daemon",
				command: process.execPath,
				args: ["test/fixtures/unix-daemon.mjs", socketPath],
				socket: socketPath,
				protocol: "unix-jsonl",
				start: "lazy",
			},
		},
	};
	const supervisor = new ServiceSupervisor();
	try {
		const call = await supervisor.call(tool, "echo", { method: "ping", params: { value: 8 } });
		assert.equal(call.ok, true);
		assert.deepEqual(call.result, { echo: { value: 8 }, method: "ping" });
	} finally {
		await supervisor.close();
	}
});

test("job recovery marks a dead running job as lost", async () => {
	const root = path.join(tempRoot, "jobs");
	const manager = new JobManager({
		root,
		agentDir: process.cwd(),
		notify: () => {},
		log: () => {},
	});
	await writeJobRecord(root, {
		id: "job_lost",
		tool: "demo_agent",
		toolVersion: "1.0.0",
		agentId: "",
		agentSource: "embedded",
		cwd: process.cwd(),
		input: {},
		mode: "start",
		state: "running",
		createdAt: new Date().toISOString(),
		pid: 99999999,
	});
	await manager.recover();
	const record = await manager.get("job_lost");
	assert.equal(record?.state, "lost");
});

test("http service responds to JSON requests", async () => {
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		const message = JSON.parse(body || "{}");
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ status: "ok", result: { echo: message.params ?? null, method: message.method ?? null } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const url = `http://127.0.0.1:${address.port}/rpc`;
	const tool: ToolManifest = {
		name: "http_test",
		version: "1.0.0",
		kind: "direct",
		description: "Test HTTP tool.",
		input: { type: "object" },
		output: { type: "object" },
		dir: process.cwd(),
		services: {
			echo: {
				type: "daemon",
				url,
				protocol: "http-json",
				start: "lazy",
			},
		},
	};
	const supervisor = new ServiceSupervisor();
	try {
		const call = await supervisor.call(tool, "echo", { method: "ping", params: { value: 9 } });
		assert.equal(call.ok, true);
		assert.deepEqual(call.result, { echo: { value: 9 }, method: "ping" });
	} finally {
		await supervisor.close();
		server.close();
	}
});
