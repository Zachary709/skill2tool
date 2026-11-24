import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	createAgentSession,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import extension from "../extensions/tool-runtime.ts";
import type { AgentConfig, ToolEnvelope } from "../src/types.ts";

setGlobalDispatcher(new EnvHttpProxyAgent());
install();
const originalAgentDir = getAgentDir();
const parent = path.resolve("_intermediate/agent-runtime-checks");
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "discovery-runtime-"));
const agentDir = path.join(root, "agent");
await fs.mkdir(path.join(agentDir, "tools"), { recursive: true });
await fs.cp(path.resolve("test/fixtures/word-count"), path.join(agentDir, "tools", "word_count"), { recursive: true });
await fs.cp(path.resolve("test/fixtures/process-control"), path.join(agentDir, "tools", "process_command"), { recursive: true });
const provider = process.env.PI_PROVIDER;
const modelId = process.env.PI_MODEL;
assert.ok(provider && modelId, "需要 PI_PROVIDER 和 PI_MODEL 指定当前模型");
const modelRuntime = await ModelRuntime.create({ authPath: path.join(originalAgentDir, "auth.json"), modelsPath: path.join(originalAgentDir, "models.json") });
const model = modelRuntime.getModel(provider, modelId);
assert.ok(model);
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessions: AgentSession[] = [];
const snapshots: Array<{ tool: string; result: unknown; active: string[]; parent?: string }> = [];

async function createSession(name: string): Promise<AgentSession> {
	const cwd = path.join(root, name);
	await fs.mkdir(cwd, { recursive: true });
	const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: ["builtin:tool-search"],
		extensionFactories: [
			{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
			extension,
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "process_command" && Array.isArray(event.input.args) && event.input.args.includes("--help")) {
						return { block: true, reason: "验收策略禁止该命令参数。" };
					}
				});
			},
		] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.deepEqual(loader.getExtensions().warnings ?? [], []);
	assert.ok(loader.getExtensions().extensions.some((entry) => entry.path === "builtin:tool-search"));
	const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader: loader,
		thinkingLevel: process.env.PI_REASONING_LEVEL as AgentConfig["thinkingLevel"],
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
		settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
	await session.bindExtensions({ mode: "print" });
	sessions.push(session);
	session.subscribe((event) => {
		if (event.type === "tool_execution_end") snapshots.push({ tool: event.toolName, result: event.result,
			active: session.getActiveToolNames(), parent: event.parentToolCallId });
	});
	return session;
}

try {
	const session = await createSession("primary");
	const independent = await createSession("independent");
	const initial = session.getActiveToolNames();
	assert.deepEqual(initial, ["read", "bash", "edit", "write", "tool_find", "tool_use"]);
	assert.deepEqual(independent.getActiveToolNames(), initial);
	assert.ok(session.getToolDefinition("tool_search"));
	assert.ok(session.getToolDefinition("tool_find")?.promptGuidelines?.some((rule) => rule.includes("只返回候选")));
	await session.prompt(`执行一次工具发现验收。先用 tool_find 搜索 other，保留全部候选但不加载。然后用 tool_use 仅指定 process_command 查看契约，接着通过 tool_use 调用 process_command，input 为 ${JSON.stringify({ command: process.execPath, args: ["--version"] })}。不要调用 word_count，不要手动加载工具。最后只返回实际命令输出。`);
	const search = snapshots.find((entry) => entry.tool === "tool_find");
	assert.ok(search);
	const candidates = (search.result as { details: { candidates: Array<{ name: string }> } }).details.candidates.map((entry) => entry.name).sort();
	assert.deepEqual(candidates, ["process_command", "word_count"]);
	assert.deepEqual(search.active, initial);
	const inspection = snapshots.find((entry) => entry.tool === "tool_use" && (entry.result as { details?: { contract?: unknown } }).details?.contract);
	assert.ok(inspection);
	assert.deepEqual(inspection.active, initial);
	const actual = snapshots.find((entry) => entry.tool === "process_command" && entry.parent);
	assert.ok(actual);
	const outcome = (actual.result as { structuredContent: ToolEnvelope }).structuredContent;
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	assert.deepEqual(outcome.result, { exitCode: 0, signal: null, stdout: `${process.version}\n`, stderr: "" });
	assert.ok(session.getActiveToolNames().includes("process_command"));
	assert.ok(!session.getActiveToolNames().includes("word_count"));
	assert.deepEqual(independent.getActiveToolNames(), initial);
	const used = session.getActiveToolNames();

	await session.prompt("/tool-catalog reset");
	assert.deepEqual(session.getActiveToolNames(), initial);
	let offset = snapshots.length;
	await session.prompt('执行参数校验验收：只调用一次 tool_use，tool 为 process_command，input 为 {}。记录实际错误即可，不补齐 command、不重试、不调用其他工具。');
	const invalid = snapshots.slice(offset).find((entry) => entry.tool === "tool_use");
	assert.ok(invalid && (invalid.result as { isError?: boolean }).isError);
	assert.deepEqual(session.getActiveToolNames(), initial);

	offset = snapshots.length;
	await session.prompt(`执行权限拦截验收：只调用一次 tool_use，tool 为 process_command，input 为 ${JSON.stringify({ command: process.execPath, args: ["--help"] })}。记录实际错误即可，不重试、不调用其他工具。`);
	const blocked = snapshots.slice(offset).find((entry) => entry.tool === "tool_use");
	assert.ok(blocked && (blocked.result as { isError?: boolean }).isError);
	assert.ok(JSON.stringify(blocked.result).includes("验收策略禁止"));
	assert.deepEqual(session.getActiveToolNames(), initial);
	assert.deepEqual(independent.getActiveToolNames(), initial);
	await fs.writeFile(path.join(root, "verification.json"), JSON.stringify({ model: `${provider}/${modelId}`, initial, candidates, used,
		snapshots, sessions: sessions.map((entry) => entry.sessionFile) }, null, 2));
	console.log(JSON.stringify({ verified: true, root, initial, candidates, used }));
} finally {
	for (const session of sessions.reverse()) {
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}
