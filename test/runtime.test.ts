import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { after, before, test } from "node:test";
import pidtree from "pidtree";
import { validateEnvelope, validateManifest, validateResultShape, validateSummary } from "../src/contracts/schema.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { resolveServicePlacement, ServiceSupervisor } from "../src/services/supervisor.ts";
import { buildSystemPrompt, workerKey } from "../src/agents/worker.ts";
import {
	formatJobRow,
	formatProgressEntry,
	InlineProgress,
	ProgressWatcher,
	resolveJobReference,
	shortJobRef,
	snapshotProgress,
	snapshotFromRecord,
} from "../src/observability/progress.ts";
import { JobManager } from "../src/jobs/manager.ts";
import { writeJobRecord } from "../src/jobs/store.ts";
import type { ResolvedAgent, ToolManifest } from "../src/types.ts";

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
	const result = await readManifestFile("test/fixtures/word-count/TOOL.json");
	assert.ok(result.manifest);
	const supervisor = new ServiceSupervisor({ projectCwd: process.cwd(), agentDir: path.join(tempRoot, "agent") });
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
	const supervisor = new ServiceSupervisor({ projectCwd: process.cwd(), agentDir: path.join(tempRoot, "agent") });
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
	const supervisor = new ServiceSupervisor({ projectCwd: process.cwd(), agentDir: path.join(tempRoot, "agent") });
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
	const supervisor = new ServiceSupervisor({ projectCwd: process.cwd(), agentDir: path.join(tempRoot, "agent") });
	try {
		const call = await supervisor.call(tool, "echo", { method: "ping", params: { value: 9 } });
		assert.equal(call.ok, true);
		assert.deepEqual(call.result, { echo: { value: 9 }, method: "ping" });
	} finally {
		await supervisor.close();
		server.close();
	}
});

test("service placement uses the tool directory and agent state dir", () => {
	const tool: ToolManifest = {
		name: "placement_probe",
		version: "1.0.0",
		kind: "direct",
		description: "Placement probe.",
		input: { type: "object" },
		output: { type: "object" },
		dir: "/opt/tool",
	};
	const agentDir = "/home/u/.pi/agent";

	const user = resolveServicePlacement({
		tool,
		name: "svc",
		service: { type: "script", command: "x" },
		agentDir,
	});
	assert.equal(user.cwd, "/opt/tool");
	assert.equal(user.stateDir, "/home/u/.pi/agent/services/placement_probe/svc");
	assert.equal(user.key, "user:placement_probe:svc");

	const project = resolveServicePlacement({
		tool: { ...tool, scope: "project" },
		name: "svc",
		service: { type: "script", command: "x" },
		agentDir,
	});
	assert.equal(project.cwd, "/opt/tool");
	assert.equal(project.stateDir, "/home/u/.pi/agent/services/placement_probe/svc");
	assert.equal(project.key, "user:placement_probe:svc");
});

test("service script runs in the tool directory with the placement env", async () => {
	const projectCwd = path.join(tempRoot, "project-dir");
	const agentDir = path.join(tempRoot, "agent");
	const toolDir = path.join(tempRoot, "tool-dir");
	await fs.mkdir(projectCwd, { recursive: true });
	await fs.mkdir(toolDir, { recursive: true });
	const tool: ToolManifest = {
		name: "placement_probe",
		version: "1.0.0",
		kind: "direct",
		description: "Placement probe.",
		scope: "project",
		input: { type: "object" },
		output: { type: "object" },
		dir: toolDir,
		services: {
			probe: {
				type: "script",
				command: process.execPath,
				args: [
					"-e",
					"console.log(JSON.stringify({cwd: process.cwd(), state: process.env.PI_SERVICE_STATE_DIR, level: process.env.PI_SERVICE_LEVEL === undefined ? null : process.env.PI_SERVICE_LEVEL}))",
				],
			},
		},
	};
	const supervisor = new ServiceSupervisor({ projectCwd, agentDir });
	try {
		const call = await supervisor.call(tool, "probe", {});
		assert.equal(call.ok, true, call.error);
		assert.deepEqual(call.result, {
			cwd: toolDir,
			state: path.join(agentDir, "services", "placement_probe", "probe"),
			level: null,
		});
		assert.equal((await fs.stat(path.join(agentDir, "services", "placement_probe", "probe"))).isDirectory(), true);
	} finally {
		await supervisor.close();
	}
});

test("worker key carries the project path only for project scope", () => {
	const tool: ToolManifest = {
		name: "scope_probe",
		version: "1.0.0",
		kind: "agent",
		description: "Scope probe.",
		input: { type: "object" },
		output: { type: "object" },
	};
	const agent: ResolvedAgent = {
		name: "scope_probe",
		tool: "scope_probe",
		version: "1.0.0",
		contract: "^1.0.0",
		source: "embedded",
		instructions: "",
		workflow: "",
		tools: [],
		maxTurns: 10,
	};
	assert.notEqual(workerKey(tool, agent, "/a"), workerKey(tool, agent, "/b"));
	assert.equal(workerKey(tool, agent, "/a", true), workerKey(tool, agent, "/b", true));
});

test("manifest validation rejects unknown worker scopes", () => {
	const base = {
		name: "bad_scopes",
		version: "1.0.0",
		description: "Validation probe for worker scopes.",
		kind: "agent" as const,
		input: { type: "object" },
		output: { type: "object" },
		agent: {
			instructions: "AGENT.md",
			workflow: "WORKFLOW.md",
			tools: ["read"],
			sessionScope: "machine",
			memoryScope: "tenant",
		},
		services: {
			probe: { type: "script", command: "node" },
		},
	};
	const result = validateManifest(base);
	assert.ok(result.errors.some((error) => error.includes("agent.sessionScope")));
	assert.ok(result.errors.some((error) => error.includes("agent.memoryScope")));
});

test("worker scope uses user and project, and reads global as a legacy alias", () => {
	const base = {
		name: "scope_alias",
		version: "1.0.0",
		description: "Scope alias probe.",
		kind: "agent" as const,
		input: { type: "object" },
		output: { type: "object" },
		agent: {
			instructions: "AGENT.md",
			workflow: "WORKFLOW.md",
			tools: ["read"],
		},
	};

	const user = validateManifest({
		...base,
		agent: { ...base.agent, sessionScope: "user", memoryScope: "user" },
	});
	assert.deepEqual(user.errors, []);
	assert.equal(user.manifest?.agent?.sessionScope, "user");
	assert.equal(user.manifest?.agent?.memoryScope, "user");

	const legacy = validateManifest({
		...base,
		agent: { ...base.agent, sessionScope: "global", memoryScope: "global" },
	});
	assert.deepEqual(legacy.errors, []);
	assert.equal(legacy.manifest?.agent?.sessionScope, "user");
	assert.equal(legacy.manifest?.agent?.memoryScope, "user");
	assert.ok(legacy.warnings.some((warning) => warning.includes("deprecated")));
});

test("progress snapshot prefers the running job and skips a partial line", async () => {
	const root = path.join(tempRoot, "jobs-progress");
	const finishedDir = path.join(root, "job_finished");
	const runningDir = path.join(root, "job_running");
	await fs.mkdir(finishedDir, { recursive: true });
	await fs.mkdir(runningDir, { recursive: true });
	await fs.writeFile(
		path.join(finishedDir, "job.json"),
		JSON.stringify({ id: "job_finished", tool: "demo", state: "succeeded", createdAt: "2026-01-01T00:00:00Z" }),
	);
	await fs.writeFile(
		path.join(runningDir, "job.json"),
		JSON.stringify({ id: "job_running", tool: "demo", state: "running", createdAt: "2026-01-02T00:00:00Z" }),
	);
	await fs.writeFile(
		path.join(runningDir, "progress.jsonl"),
		[
			JSON.stringify({ time: "2026-01-02T00:00:01Z", kind: "thinking", text: "read the manifest" }),
			JSON.stringify({ time: "2026-01-02T00:00:02Z", kind: "tool", tool: "bash", text: "{\"command\":\"ls\"}" }),
			'{"time":"2026-01-02T00:00:03Z","kind":"resu',
		].join("\n"),
	);

	const snapshot = await snapshotProgress({ jobsRoot: root });
	assert.equal(snapshot.jobId, "job_running");
	assert.equal(snapshot.state, "running");
	assert.equal(snapshot.entries.length, 2);
	assert.ok(snapshot.lines[0].includes("running"));
	assert.ok(snapshot.lines.some((line) => line.includes("[思考]")));
	assert.ok(snapshot.lines.some((line) => line.includes("[调用] bash")));
	assert.equal(
		formatProgressEntry({ time: "2026-01-02T00:00:04Z", kind: "result", tool: "read", isError: true, text: "boom" }),
		"00:00:04 [失败] read boom",
	);
});

test("worker system prompt confines navigation to known roots", () => {
	const tool: ToolManifest = {
		name: "nav_probe",
		version: "1.0.0",
		kind: "agent",
		description: "Navigation probe.",
		input: { type: "object" },
		output: { type: "object" },
		dir: "/opt/tool",
	};
	const agent: ResolvedAgent = {
		name: "nav_probe",
		tool: "nav_probe",
		version: "1.0.0",
		contract: "^1.0.0",
		source: "embedded",
		instructions: "Do the job.",
		workflow: "Do it.",
		tools: [],
		maxTurns: 10,
	};
	const prompt = buildSystemPrompt(tool, agent);
	assert.ok(prompt.includes("## Navigation"));
	assert.ok(prompt.includes("Do not scan the home directory"));
	assert.ok(prompt.includes("needs_input"));
});

test("progress job reference resolves an index, a short id, and reports ambiguity", async () => {
	const root = path.join(tempRoot, "jobs-reference");
	const names = ["job_echo_aaa_alpha1", "job_echo_bbb_alpha2", "job_word_ccc_beta3"];
	for (const [index, name] of names.entries()) {
		await fs.mkdir(path.join(root, name), { recursive: true });
		await fs.writeFile(
			path.join(root, name, "job.json"),
			JSON.stringify({
				id: name,
				tool: name.split("_")[1],
				state: "succeeded",
				createdAt: `2026-01-0${index + 1}T00:00:00Z`,
			}),
		);
	}
	assert.equal((await resolveJobReference(root, "1")).jobId, "job_word_ccc_beta3");
	assert.equal((await resolveJobReference(root, "beta3")).jobId, "job_word_ccc_beta3");
	assert.equal((await resolveJobReference(root, "job_echo_aaa_alpha1")).jobId, "job_echo_aaa_alpha1");
	const ambiguous = await resolveJobReference(root, "alpha");
	assert.equal(ambiguous.jobId, undefined);
	assert.ok(ambiguous.error?.includes("2 个任务"));
	assert.equal(shortJobRef("job_echo_aaa_alpha1"), "alpha1");
	assert.ok(formatJobRow({ jobId: "job_echo_aaa_alpha1", tool: "echo", state: "running" }, 2).startsWith("2. alpha1"));
});

test("real task progress only publishes changes through subscriptions and file polling", { timeout: 30000 }, async () => {
	const root = path.join(tempRoot, "jobs-watch");
	const loaded = await readManifestFile("test/fixtures/process-control/TOOL.json");
	assert.ok(loaded.manifest);
	const manager = new JobManager({ root, agentDir: path.join(root, "agent"), notify: () => {}, log: console.error });
	const updates: Array<Array<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>> = [[], []];
	const waitFor = async (condition: () => Promise<boolean>) => {
		const deadline = Date.now() + 20000;
		while (!await condition()) {
			assert.ok(Date.now() < deadline, "等待真实进展超时");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const watchers = [
		new ProgressWatcher({ jobsRoot: root, ui: {}, onUpdate: (partial) => updates[0].push(partial),
			subscribe: (id, refresh) => manager.subscribe(id, refresh), snapshot: async (id) => {
				const record = await manager.get(id);
				return record ? snapshotFromRecord(record, manager.recent(id) ?? []) : { entries: [], lines: [] };
			} }),
		new ProgressWatcher({ jobsRoot: root, ui: {}, onUpdate: (partial) => updates[1].push(partial) }),
	];
	try {
		const job = await manager.create({ manifest: loaded.manifest, input: { command: "sleep", args: ["120"] },
			mode: "sync", cwd: process.cwd(), projectTrusted: true });
		await waitFor(async () => (await manager.get(job.id))?.phase === "调用服务 run" && Boolean(job.pid) && (await pidtree(job.pid!)).length >= 3);
		for (const watcher of watchers) watcher.start(job.id);
		await waitFor(async () => updates.every((messages) => messages.length > 0));
		const counts = updates.map((messages) => messages.length);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		assert.deepEqual(updates.map((messages) => messages.length), counts, "仅计时变化不能重发进展");
		manager.cancel(job.id);
		await waitFor(async () => updates.every((messages) => messages.at(-1)?.details.state === "cancelled"));
		for (const messages of updates) {
			assert.equal(messages.filter((message) => message.details.state === "cancelled").length, 1);
			assert.equal(messages.at(-1)?.details.jobId, job.id);
			assert.ok(messages.at(-1)?.details.finishedAt);
		}
	} finally { for (const watcher of watchers) watcher.stopAll(); await manager.close(); }
});

test("inline progress writes a widget and clears it without notifications", async () => {
	const widgets: Array<string[] | undefined> = [];
	const statuses: Array<string | undefined> = [];
	const progress = new InlineProgress({
		ui: {
			setWidget: (_key, content) => widgets.push(content),
			setStatus: (_key, text) => statuses.push(text),
		},
		title: "tool_add",
		limit: 2,
	});
	progress.push({ time: "2026-01-01T00:00:01Z", kind: "tool", tool: "read", text: "a" });
	progress.push({ time: "2026-01-01T00:00:02Z", kind: "tool", tool: "grep", text: "b" });
	progress.push({ time: "2026-01-01T00:00:03Z", kind: "tool", tool: "ls", text: "c" });
	await new Promise((resolve) => setTimeout(resolve, 500));
	progress.stop();
	const rendered = widgets.filter((content) => content !== undefined).at(-1);
	assert.deepEqual(rendered, ["tool_add", "00:00:02 [调用] grep b", "00:00:03 [调用] ls c"]);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(statuses.at(-1), undefined);
});

test("progress watcher clears a widget for a job that no longer exists", async () => {
	const root = path.join(tempRoot, "jobs-missing");
	await fs.mkdir(root, { recursive: true });
	const widgets: Array<string[] | undefined> = [];
	const watcher = new ProgressWatcher({
		jobsRoot: root,
		ui: {
			setWidget: (_key, content) => widgets.push(content),
		},
	});
	watcher.start("job_missing");
	await new Promise((resolve) => setTimeout(resolve, 200));
	watcher.stopAll();
	assert.ok(widgets.length >= 1);
	assert.equal(widgets[0], undefined);
});

test("job record carries the requester model for workers without a model", async () => {
	const root = path.join(tempRoot, "jobs-model");
	const manager = new JobManager({
		root,
		agentDir: process.cwd(),
		notify: () => {},
		log: () => {},
	});
	const manifest: ToolManifest = {
		name: "model_probe",
		version: "1.0.0",
		kind: "agent",
		description: "Model probe.",
		input: { type: "object" },
		output: { type: "object" },
	};
	const record = await manager.create({
		manifest,
		input: {},
		mode: "status",
		cwd: process.cwd(),
		projectTrusted: true,
		model: "deepseek/deepseek-flash",
	});
	assert.equal(record.model, "deepseek/deepseek-flash");
	const loaded = await manager.get(record.id);
	assert.equal(loaded?.model, "deepseek/deepseek-flash");
});

test("result shape rejects unknown keys and oversized strings", () => {
	const schema = {
		type: "object",
		properties: {
			count: { type: "number" },
			note: { type: "string", maxLength: 80 },
		},
		required: ["count"],
		additionalProperties: false,
	};
	assert.deepEqual(validateResultShape(schema, { count: 3 }), []);
	assert.ok(
		validateResultShape(schema, { count: 3, transcript: "step 1" }).some((error) =>
			error.includes("not declared"),
		),
	);
	assert.ok(
		validateResultShape(schema, { count: 3, note: "x".repeat(120) }).some((error) =>
			error.includes("exceeds 80"),
		),
	);

	const bag = { type: "object", properties: { result: { type: "object" } }, required: ["result"] };
	assert.deepEqual(validateResultShape(bag, { result: { any_key: "short" } }), []);
	assert.ok(
		validateResultShape(bag, { result: { any_key: "x".repeat(5000) } }).some((error) =>
			error.includes("exceeds 4000"),
		),
	);

	const open = {
		type: "object",
		properties: { count: { type: "number" } },
		required: ["count"],
		additionalProperties: true,
	};
	assert.deepEqual(validateResultShape(open, { count: 3, extra: "short" }), []);
	assert.ok(
		validateResultShape(open, { count: 3, extra: "x".repeat(5000) }).some((error) =>
			error.includes("exceeds 4000"),
		),
	);
});

test("result shape accepts multiline web search answers and source quotations", async () => {
	const fixtureDir = path.join("test", "fixtures", "web-search-worlds-2026");
	const { manifest, errors } = await readManifestFile(path.join(fixtureDir, "TOOL.json"));
	assert.deepEqual(errors, []);
	assert.ok(manifest);
	const submission = JSON.parse(await fs.readFile(path.join(fixtureDir, "submission.json"), "utf8"));
	assert.ok(submission.result.answer.split("\n").length > 9);
	assert.equal(submission.result.sources[0].excerpt.split("\n").length, 10);
	assert.deepEqual(validateEnvelope(manifest.output, submission), []);
	assert.deepEqual(validateSummary(submission.summary), []);
	assert.deepEqual(validateResultShape(manifest.output, submission.result), []);
});

test("summary stays short and single paragraph", () => {
	assert.deepEqual(validateSummary("cnn smoke passed on GPU1, exit 0."), []);
	assert.ok(validateSummary("x".repeat(320)).some((error) => error.includes("exceeds 300")));
	assert.ok(validateSummary("a\nb\nc\nd").some((error) => error.includes("single short paragraph")));
	assert.ok(validateSummary("   ").some((error) => error.includes("must not be empty")));
});

test("manifest validation warns about loose input and output contracts", () => {
	const result = validateManifest({
		name: "loose_contract",
		version: "1.0.0",
		description: "A tool with a catch-all output bag.",
		kind: "agent",
		input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
		output: {
			type: "object",
			properties: {
				result: { type: "object" },
				open: { type: "object", additionalProperties: true },
			},
		},
		agent: { instructions: "AGENT.md", workflow: "WORKFLOW.md", tools: ["read"] },
	});
	assert.deepEqual(result.errors, []);
	assert.ok(result.warnings.some((warning) => warning.includes("additionalProperties")));
	assert.ok(result.warnings.some((warning) => warning.includes("required")));
	assert.ok(result.warnings.some((warning) => warning.includes("untyped object bag")));
	assert.ok(!result.warnings.some((warning) => warning.includes("output.open")));
});

test("package tools load from basic-tools with the package scope", async () => {
	const { loadTools } = await import("../src/discovery/manifest.ts");
	const result = await loadTools([{ root: "basic-tools", scope: "package" }]);
	assert.deepEqual(result.diagnostics, []);
	const names = result.tools.map((entry) => entry.manifest.name).sort();
	assert.deepEqual(names, ["service_keeper", "tool_add"]);
	const toolAdd = result.tools.find((entry) => entry.manifest.name === "tool_add")?.manifest;
	assert.equal(toolAdd?.handler, "tool_add");
	assert.equal(toolAdd?.kind, "agent");
	assert.equal(toolAdd?.contractVersion, "2.0.0");
	assert.equal(toolAdd?.agent?.instructions, "agent/AGENT.md");
	assert.ok(toolAdd?.whenToUse?.length);
	const keeper = result.tools.find((entry) => entry.manifest.name === "service_keeper")?.manifest;
	assert.equal(keeper?.kind, "agent");
	assert.equal(keeper?.handler, "service_keeper");
	assert.equal(keeper?.contractVersion, "2.0.0");
	assert.deepEqual(keeper?.input.required, ["request"]);
	assert.equal(keeper?.agent?.instructions, "agent/AGENT.md");
	assert.ok((keeper?.output.required as string[]).includes("services"));
});

test("daemon manifests default to persistent and eager", () => {
	const result = validateManifest({
		name: "daemon_defaults",
		version: "1.0.0",
		description: "A daemon without lifecycle or start.",
		kind: "agent",
		input: { type: "object", properties: { task: { type: "string" } }, required: ["task"], additionalProperties: false },
		output: { type: "object", properties: { value: { type: "string", maxLength: 10 } }, required: ["value"], additionalProperties: false },
		agent: { instructions: "AGENT.md", workflow: "WORKFLOW.md", tools: ["read"] },
		whenToUse: ["需要常驻服务"],
		services: {
			panel: { type: "daemon", command: "node", args: ["services/panel.mjs"], protocol: "http-json" },
		},
	});
	assert.deepEqual(result.errors, []);
	assert.equal(result.manifest?.services?.panel.lifecycle, "persistent");
	assert.equal(result.manifest?.services?.panel.start, "eager");
});

test("converter plan validation requires a selection intro and a closed typed result", async () => {
	const { validateToolPlan } = await import("../basic-tools/tool_add/plan.ts");
	const plan = {
		name: "word_count",
		description: "统计文本中的英文单词数量。",
		whenToUse: ["需要统计一段文本的词数"],
		input: {
			type: "object",
			properties: { text: { type: "string", description: "文本" } },
			required: ["text"],
			additionalProperties: false,
		},
		output: {
			type: "object",
			properties: { count: { type: "number", description: "词数" } },
			required: ["count"],
			additionalProperties: false,
		},
		agent: {
			instructions: "You count words and return the count. ".repeat(4),
			workflow: "1. Read the declared text field.\n2. Count the words in it.\n3. Return only the count field.\n4. Call submit_result with the count.",
			tools: ["read"],
		},
	};
	assert.deepEqual(validateToolPlan(plan), []);

	const noIntro = { ...plan, whenToUse: [] };
	assert.ok(validateToolPlan(noIntro).some((error) => error.includes("whenToUse")));

	const bag = {
		...plan,
		output: {
			type: "object",
			properties: { result: { type: "object" } },
			required: ["result"],
		},
	};
	const bagErrors = validateToolPlan(bag);
	assert.ok(bagErrors.some((error) => error.includes("additionalProperties")));
	assert.ok(bagErrors.some((error) => error.includes("catch-all")));
	assert.ok(bagErrors.some((error) => error.includes("untyped object bag")));
});

test("deterministic fallback produces a closed contract and agent files", async () => {
	const { ToolAddManager } = await import("../basic-tools/tool_add/manager.ts");
	const host = {
		agentDir: path.join(tempRoot, "agent"),
		cwd: process.cwd(),
		modelRuntime: {},
		supervisor: {},
		log: () => {},
		listTools: () => [],
		getTool: () => undefined,
		register: () => {},
		setEnabled: async () => {},
		isReserved: () => false,
	};
	const manager = new ToolAddManager(host as never);
	const built = (manager as unknown as {
		manifestFromFallback(
			frontmatter: Record<string, unknown>,
			body: string,
			name: string,
			scope: "project" | "user",
			dir: string,
		): { manifest: ToolManifest; files: { instructions: string; workflow: string } };
	}).manifestFromFallback({}, "Do the thing.", "demo_skill", "user", "/skills/demo");
	assert.ok(built.manifest.whenToUse?.length);
	assert.equal(built.manifest.input.additionalProperties, false);
	assert.deepEqual(Object.keys(built.manifest.input.properties ?? {}), ["task"]);
	assert.deepEqual(built.manifest.execution, { defaultMode: "sync", notifyOnIdle: false, asyncByDefault: false });
	assert.equal(built.manifest.output.additionalProperties, false);
	assert.ok((built.manifest.output.required as string[]).includes("outcome"));
	assert.ok(built.files.instructions.includes("Do the thing."));
	assert.ok(built.files.workflow.includes("submit_result"));
	assert.deepEqual(validateManifest(built.manifest, "/skills/demo").errors, []);
});

test("adding an agent tool writes AGENT.md and WORKFLOW.md", async () => {
	const { ToolAddManager } = await import("../basic-tools/tool_add/manager.ts");
	const host = {
		agentDir: path.join(tempRoot, "agent"),
		cwd: tempRoot,
		modelRuntime: {},
		supervisor: {},
		log: () => {},
		listTools: () => [],
		getTool: () => undefined,
		register: () => {},
		setEnabled: async () => {},
		isReserved: () => false,
	};
	const manager = new ToolAddManager(host as never);
	const manifest = {
		name: "added_agent",
		version: "1.0.0",
		description: "An added agent tool used by the artifact test.",
		whenToUse: ["需要测试添加流程"],
		kind: "agent",
		input: { type: "object", properties: { task: { type: "string" } }, required: ["task"], additionalProperties: false },
		output: {
			type: "object",
			properties: { value: { type: "string", maxLength: 100 } },
			required: ["value"],
			additionalProperties: false,
		},
		agent: { instructions: "AGENT.md", workflow: "WORKFLOW.md", tools: ["read"] },
	};
	const envelope = await manager.handle(
		{ action: "add", manifest, scope: "user" },
		{ cwd: tempRoot, isProjectTrusted: () => true },
	);
	assert.equal(envelope.status, "ok", JSON.stringify(envelope));
	const dir = path.join(tempRoot, "agent", "tools", "added_agent");
	const instructions = await fs.readFile(path.join(dir, "AGENT.md"), "utf8");
	const workflow = await fs.readFile(path.join(dir, "WORKFLOW.md"), "utf8");
	assert.ok(instructions.includes("persistent worker"));
	assert.ok(workflow.includes("submit_result"));
	const loaded = await readManifestFile(path.join(dir, "TOOL.json"));
	assert.equal(loaded.manifest?.name, "added_agent");
});

test("runtime registers compact packaged tools in the real SDK and keeps management actions internal", async () => {
	const { ToolRuntime } = await import("../src/runtime/tool-runtime.ts");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = path.join(tempRoot, "integration");
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	let runtime: InstanceType<typeof ToolRuntime> | undefined;
	const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
			pi.on("session_start", async () => {
				runtime = new ToolRuntime({ pi, cwd, agentDir, projectTrusted: true, modelRuntime, log: console.error });
				await runtime.initialize();
			});
		}] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
	await session.bindExtensions({ mode: "print" });
	try {
		assert.ok(runtime);
		assert.deepEqual(runtime.diagnostics, []);
		const initial = session.getActiveToolNames();
		assert.ok(initial.includes("tool_find") && initial.includes("tool_use"));
		assert.ok(!initial.includes("tool_add") && !initial.includes("service_keeper"));
		assert.equal(session.systemPrompt.includes("tool_add 的 request"), false);
		assert.equal(session.getToolDefinition("tool_add")?.exposure, "deferred");
		assert.equal(session.getToolDefinition("tool_add")?.namespace?.name, "runtime");
		assert.deepEqual(runtime.catalogEntries().map((entry) => entry.category), ["runtime", "runtime"]);
		assert.ok(runtime.catalogCommand("").includes("运行维护"));
		assert.ok(runtime.catalogCommand("search 技能").includes("tool_add"));
		const search = session.agent.state.tools.find((tool) => tool.name === "tool_find");
		assert.ok(search);
		const discovered = await search.execute("call-discover", { query: "runtime" }, new AbortController().signal);
		assert.deepEqual((discovered.details as { candidates: Array<{ name: string }> }).candidates.map((tool) => tool.name).sort(), ["service_keeper", "tool_add"]);
		assert.deepEqual(session.getActiveToolNames(), initial);
		const use = session.agent.state.tools.find((tool) => tool.name === "tool_use");
		assert.ok(use);
		const inspected = await use.execute("call-inspect", { tool: "tool_add" }, new AbortController().signal);
		assert.deepEqual(Object.keys((inspected.details as any).contract.input.properties), ["request"]);
		assert.deepEqual(session.getActiveToolNames(), initial);
		assert.equal(session.systemPrompt.includes("tool_add 的 request"), false);
		const toolAdd = session.getToolDefinition("tool_add");
		const keeper = session.getToolDefinition("service_keeper");
		assert.ok(toolAdd && keeper);
		assert.deepEqual(Object.keys((toolAdd.parameters as any).properties), ["request"]);
		assert.deepEqual(Object.keys((keeper.parameters as any).properties), ["request", "allowRepair"]);
		assert.equal(session.getToolDefinition("tool_add_manage"), undefined);
		assert.equal(session.getToolDefinition("service_keeper_manage"), undefined);
		const manage = (runtime as unknown as { toolAddManageTool(cwd: string): { execute: Function } }).toolAddManageTool(cwd);
		const managed = await manage.execute("call-manage", { action: "list" });
		assert.equal(managed.details.status, "ok");
		assert.deepEqual(managed.details.result.tools.map((tool: { name: string }) => tool.name).sort(), ["service_keeper", "tool_add"]);
		runtime.catalogCommand("load tool_add");
		const facade = session.agent.state.tools.find((tool) => tool.name === "tool_add");
		assert.ok(facade);
		const rejected = await facade.execute("call-start", { request: "列出已注册的工具。", mode: "start" }, new AbortController().signal);
		assert.equal((rejected.structuredContent as any).status, "failed");
		assert.ok((rejected.structuredContent as any).summary.includes("does not match"));
		runtime.catalogCommand("load runtime");
		assert.ok(session.getActiveToolNames().includes("service_keeper"));
		runtime.catalogCommand("unload runtime");
		assert.equal(session.systemPrompt.includes("tool_add 的 request"), false);
		assert.deepEqual(session.getActiveToolNames(), initial);
		assert.throws(() => runtime!.catalogCommand("load missing_tool"), /没有可用/);
		runtime.catalogCommand("load tool_add");
		runtime.catalogCommand("reset");
		assert.deepEqual(session.getActiveToolNames(), initial);
	} finally { await runtime?.close(); session.dispose(); }
});

test("create_tool validates the name and requirements before calling the builder", async () => {
	const { ToolAddManager } = await import("../basic-tools/tool_add/manager.ts");
	const host = {
		agentDir: path.join(tempRoot, "agent"),
		cwd: tempRoot,
		modelRuntime: {},
		supervisor: {},
		log: () => {},
		listTools: () => [],
		getTool: () => undefined,
		register: () => {},
		setEnabled: async () => {},
		isReserved: () => false,
	};
	const manager = new ToolAddManager(host as never);
	const missingName = await manager.handle(
		{ action: "create_tool", name: "", requirements: "生成一个汇总日志文件的工具，读取最近的行并统计错误码。" },
		{ cwd: tempRoot, isProjectTrusted: () => true },
	);
	assert.equal(missingName.status, "failed");
	const shortRequirements = await manager.handle(
		{ action: "create_tool", name: "log_tool", requirements: "太短" },
		{ cwd: tempRoot, isProjectTrusted: () => true },
	);
	assert.equal(shortRequirements.status, "failed");
	assert.ok(shortRequirements.summary.includes("requirements"));
	const noPlan = await manager.handle(
		{
			action: "create_tool",
			name: "log_tool",
			requirements: "汇总一个日志文件里最近的错误行，输入是路径和行数，结果是错误总数与每个错误码的次数。",
		},
		{ cwd: tempRoot, isProjectTrusted: () => true },
	);
	assert.equal(noPlan.status, "failed");
	assert.ok(noPlan.summary.includes("plan"));
});

test("tool_add keeps its public request separate from the management schema", async () => {
	const { loadTools } = await import("../src/discovery/manifest.ts");
	const { TOOL_ADD_MANAGE_SCHEMA } = await import("../basic-tools/tool_add/manager.ts");
	const { tools } = await loadTools([{ root: "basic-tools", scope: "package" }]);
	const toolAdd = tools.find((entry) => entry.manifest.name === "tool_add")!.manifest;
	assert.deepEqual(toolAdd.input.required, ["request"]);
	assert.equal(toolAdd.input.properties?.action, undefined);
	assert.ok(TOOL_ADD_MANAGE_SCHEMA.properties?.action.enum?.includes("create_tool"));
	assert.ok(TOOL_ADD_MANAGE_SCHEMA.properties?.requirements);
	assert.ok(TOOL_ADD_MANAGE_SCHEMA.properties?.plan);
	assert.deepEqual(TOOL_ADD_MANAGE_SCHEMA.required, ["action"]);
});

test("tool_add resolves its packaged agent without a user install", async () => {
	const { loadTools } = await import("../src/discovery/manifest.ts");
	const { resolveAgent } = await import("../src/agents/resolver.ts");
	const { tools } = await loadTools([{ root: "basic-tools", scope: "package" }]);
	const tool = tools.find((entry) => entry.manifest.name === "tool_add")!.manifest;
	const resolved = await resolveAgent({
		tool,
		cwd: path.join(tempRoot, "empty-project"),
		agentDir: path.join(tempRoot, "empty-agent"),
		projectTrusted: false,
		allowCreateProject: false,
	});
	assert.equal(resolved.agent?.source, "embedded");
	assert.equal(resolved.agent?.name, "tool_add");
	assert.equal(resolved.agent?.contract, "^2.0.0");
	assert.ok(resolved.agent?.instructions.includes("tool_add_manage"));
	assert.ok(resolved.agent?.workflow.includes("submit_result"));
});

test("a newly added tool resolves to an agent named after the tool", async () => {
	const { ToolAddManager } = await import("../basic-tools/tool_add/manager.ts");
	const { resolveAgent } = await import("../src/agents/resolver.ts");
	const agentDir = path.join(tempRoot, "named-agent");
	const host = {
		agentDir,
		cwd: tempRoot,
		modelRuntime: {},
		supervisor: {},
		log: () => {},
		listTools: () => [],
		getTool: () => undefined,
		register: () => {},
		setEnabled: async () => {},
		isReserved: () => false,
	};
	const manager = new ToolAddManager(host as never);
	const manifest = {
		name: "named_agent_tool",
		version: "1.0.0",
		description: "A tool whose worker agent must share its name.",
		whenToUse: ["需要验证 agent 名称"],
		kind: "agent",
		input: { type: "object", properties: { task: { type: "string" } }, required: ["task"], additionalProperties: false },
		output: {
			type: "object",
			properties: { value: { type: "string", maxLength: 100 } },
			required: ["value"],
			additionalProperties: false,
		},
		agent: { instructions: "AGENT.md", workflow: "WORKFLOW.md", tools: ["read"] },
	};
	const envelope = await manager.handle(
		{ action: "add", manifest, scope: "user" },
		{ cwd: tempRoot, isProjectTrusted: () => true },
	);
	assert.equal(envelope.status, "ok", JSON.stringify(envelope));
	const loaded = await readManifestFile(path.join(agentDir, "tools", "named_agent_tool", "TOOL.json"));
	assert.ok(loaded.manifest);
	const resolved = await resolveAgent({
		tool: loaded.manifest!,
		cwd: path.join(tempRoot, "named-project"),
		agentDir,
		projectTrusted: true,
		allowCreateProject: true,
	});
	assert.equal(resolved.agent?.name, "named_agent_tool");
	assert.equal(resolved.agent?.tool, "named_agent_tool");
});

test("an agent file whose name differs from the tool name is rejected", async () => {
	const { resolveAgent } = await import("../src/agents/resolver.ts");
	const agentDir = path.join(tempRoot, "mismatch-agent");
	const toolDir = path.join(tempRoot, "mismatch-tool");
	await fs.mkdir(path.join(agentDir, "agents"), { recursive: true });
	await fs.mkdir(toolDir, { recursive: true });
	await fs.writeFile(path.join(toolDir, "AGENT.md"), "embedded instructions\n");
	await fs.writeFile(path.join(toolDir, "WORKFLOW.md"), "1. Work.\n2. Call submit_result.\n");
	await fs.writeFile(
		path.join(agentDir, "agents", "mismatch_tool.md"),
		[
			"---",
			"name: other_name",
			"tool: mismatch_tool",
			'tools: ["read"]',
			"workflow: mismatch_tool.workflow.md",
			"---",
			"",
			"user instructions",
		].join("\n"),
	);
	await fs.writeFile(path.join(agentDir, "agents", "mismatch_tool.workflow.md"), "1. Work.\n2. Call submit_result.\n");
	const tool: ToolManifest = {
		name: "mismatch_tool",
		version: "1.0.0",
		description: "A tool used to check the agent name rule.",
		whenToUse: ["需要验证名称规则"],
		kind: "agent",
		input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
		output: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		agent: { instructions: "AGENT.md", workflow: "WORKFLOW.md", tools: ["read"] },
		dir: toolDir,
	};
	const resolved = await resolveAgent({
		tool,
		cwd: path.join(tempRoot, "mismatch-project"),
		agentDir,
		projectTrusted: false,
		allowCreateProject: false,
	});
	assert.equal(resolved.agent?.source, "embedded");
	assert.equal(resolved.agent?.name, "mismatch_tool");
	assert.ok(resolved.warnings.some((warning) => warning.includes("must match the tool name")));
});

test("tool_add applies a plan supplied by its worker", async () => {
	const { ToolAddManager } = await import("../basic-tools/tool_add/manager.ts");
	const agentDir = path.join(tempRoot, "apply-agent");
	const skillDir = path.join(tempRoot, "apply-skill");
	await fs.mkdir(skillDir, { recursive: true });
	const skillFile = path.join(skillDir, "SKILL.md");
	await fs.writeFile(
		skillFile,
		"---\nname: apply_demo\ndescription: A skill used by the apply test.\n---\n\nDo the work through service/scripts/svc.sh.\n",
	);
	const serviceDir = path.join(tempRoot, "service", "scripts");
	await fs.mkdir(serviceDir, { recursive: true });
	await fs.writeFile(path.join(serviceDir, "svc.sh"), "#!/bin/sh\necho ok\n");
	const registered: string[] = [];
	const host = {
		agentDir,
		listTools: () => [],
		getTool: () => undefined,
		register: (manifest: ToolManifest) => registered.push(manifest.name),
		setEnabled: async () => {},
		isReserved: () => false,
	};
	const manager = new ToolAddManager(host as never);
	const plan = {
		name: "apply_demo",
		description: "Apply one planned tool and write its files.",
		whenToUse: ["需要验证计划写入流程"],
		input: {
			type: "object",
			properties: { task: { type: "string", maxLength: 2000, description: "Task to run." } },
			required: ["task"],
			additionalProperties: false,
		},
		output: {
			type: "object",
			properties: { outcome: { type: "string", maxLength: 500, description: "Outcome." } },
			required: ["outcome"],
			additionalProperties: false,
		},
		agent: {
			instructions: "You run the planned task and return the outcome. Work on one job at a time and finish with submit_result.",
			workflow: "1. Read the task.\n2. Do the work.\n3. Return only the outcome field.\n4. Call submit_result.",
			tools: ["read"],
		},
		externalServices: [
			{
				name: "apply-service",
				description: "The service this skill depends on.",
				unit: "apply-service.service",
				checks: { health: { url: "http://127.0.0.1:8765/healthz", expectStatus: 200 } },
			},
		],
	};
	const envelope = await manager.handle(
		{
			action: "convert_skill",
			sourcePath: skillFile,
			scope: "user",
			plan,
		},
		{ cwd: tempRoot, isProjectTrusted: () => true },
	);
	assert.equal(envelope.status, "ok", JSON.stringify(envelope));
	assert.deepEqual(registered, ["apply_demo"]);
	const dir = path.join(agentDir, "tools", "apply_demo");
	const loaded = await readManifestFile(path.join(dir, "TOOL.json"));
	assert.equal(loaded.manifest?.whenToUse?.[0], "需要验证计划写入流程");
	assert.deepEqual(loaded.manifest?.execution, { defaultMode: "sync", notifyOnIdle: false, asyncByDefault: false });
	assert.ok((await fs.readFile(path.join(dir, "AGENT.md"), "utf8")).includes("submit_result"));
	assert.ok((await fs.readFile(path.join(dir, "WORKFLOW.md"), "utf8")).includes("submit_result"));
	const bundled = await fs.readdir(path.join(dir, "skill"));
	assert.ok(bundled.includes("SKILL.md"));
	const bundledService = await fs.readdir(path.join(dir, "service"));
	assert.ok(bundledService.includes("scripts"));
	const registry = JSON.parse(await fs.readFile(path.join(agentDir, "services", "registry.json"), "utf8")) as {
		services: Array<{ name: string; unit: string; generatedBy?: string; commands?: Record<string, string> }>;
	};
	const entry = registry.services.find((item) => item.name === "apply-service");
	assert.equal(entry?.unit, "apply-service.service");
	assert.equal(entry?.generatedBy, "tool_add");
	assert.equal(entry?.commands?.start, "systemctl --user start apply-service.service");
});

test("supervisor reports and restarts a tool daemon", async () => {
	const socketPath = path.join(tempRoot, "restart.sock");
	const tool: ToolManifest = {
		name: "restart_test",
		version: "1.0.0",
		kind: "direct",
		description: "Test daemon restart tool.",
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
	const supervisor = new ServiceSupervisor({ projectCwd: process.cwd(), agentDir: path.join(tempRoot, "restart-agent") });
	try {
		const first = await supervisor.call(tool, "echo", { method: "ping", params: { value: 1 } });
		assert.equal(first.ok, true);
		const before = await supervisor.daemonStatus(tool, "echo");
		assert.equal(before.alive, true);
		assert.equal(before.reachable, true);
		const restarted = await supervisor.restartDaemon(tool, "echo");
		assert.equal(restarted.alive, true);
		assert.equal(restarted.reachable, true);
		assert.notEqual(restarted.pid, before.pid);
		const second = await supervisor.call(tool, "echo", { method: "ping", params: { value: 2 } });
		assert.equal(second.ok, true);
		assert.deepEqual(second.result, { echo: { value: 2 }, method: "ping" });
	} finally {
		await supervisor.close();
	}
});

test("job-control calls do not require the task fields in the real SDK", async () => {
	const { ToolRuntime } = await import("../src/runtime/tool-runtime.ts");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = path.join(tempRoot, "facade-job");
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	let runtime: InstanceType<typeof ToolRuntime> | undefined;
	const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
			pi.on("session_start", async () => {
				runtime = new ToolRuntime({ pi, cwd, agentDir, projectTrusted: true, modelRuntime, log: console.error });
				await runtime.initialize();
			});
		}] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
	await session.bindExtensions({ mode: "print" });
	try {
		assert.ok(runtime);
		const loaded = await readManifestFile("test/fixtures/process-control/AGENT_TOOL.json");
		assert.deepEqual(loaded.errors, []);
		assert.ok(loaded.manifest);
		runtime.register(loaded.manifest);
		assert.ok(!session.getActiveToolNames().includes(loaded.manifest.name));
		const search = session.agent.state.tools.find((tool) => tool.name === "tool_find");
		assert.ok(search);
		await search.execute("call-discover", { query: loaded.manifest.name, limit: 1 }, new AbortController().signal);
		assert.ok(!session.getActiveToolNames().includes(loaded.manifest.name));
		runtime.catalogCommand(`load ${loaded.manifest.name}`);
		const facade = session.agent.state.tools.find((tool) => tool.name === loaded.manifest!.name);
		assert.ok(facade);
		const wait = await facade.execute("call-wait", { mode: "wait", jobId: "job_missing" }, new AbortController().signal);
		assert.equal((wait.structuredContent as any).status, "failed");
		assert.ok((wait.structuredContent as any).summary.includes("任务不存在"));
		const start = await facade.execute("call-start", { mode: "start" }, new AbortController().signal);
		assert.ok((start.structuredContent as any).summary.includes("Input does not match"));
		assert.ok((start.structuredContent as any).warnings.some((warning: string) => warning.includes("command")));
		const cancel = await facade.execute("call-cancel", { mode: "cancel" }, new AbortController().signal);
		assert.equal((cancel.structuredContent as any).status, "failed");
		assert.ok((cancel.structuredContent as any).summary.includes("jobId"));
	} finally { await runtime?.close(); session.dispose(); }
});
