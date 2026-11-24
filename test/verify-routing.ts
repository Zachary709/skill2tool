import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { ToolRuntime } from "../src/runtime/tool-runtime.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { callerPromptGuidelines } from "../src/contracts/caller.ts";
import type { AgentConfig } from "../src/types.ts";

setGlobalDispatcher(new EnvHttpProxyAgent()); install();
const parent = path.resolve("_intermediate/agent-runtime-checks");
await fs.mkdir(parent, { recursive: true });
const cwd = await fs.mkdtemp(path.join(parent, "routing-runtime-"));
const agentDir = getAgentDir();
const provider = process.env.PI_PROVIDER;
const modelId = process.env.PI_MODEL;
assert.ok(provider && modelId, "需要 PI_PROVIDER 和 PI_MODEL 指定当前模型");
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const model = modelRuntime.getModel(provider, modelId);
assert.ok(model);
const loaded = await readManifestFile(path.join(agentDir, "tools", "ssh_manager", "TOOL.json"));
assert.deepEqual(loaded.errors, []);
assert.ok(loaded.manifest);
const ssh = loaded.manifest;
assert.ok(ssh.notFor?.some((rule) => rule.includes("本机")));
for (const rule of ssh.notFor!) assert.ok(callerPromptGuidelines(ssh).includes(`ssh_manager 不用于：${rule}`));
const cases = [
	{ name: "local_gpu", request: "查看本机 GPU 占用。", expected: "bash" },
	{ name: "local_device", request: "查看这台设备的系统版本。", expected: "bash" },
	{ name: "local_hostname", request: `查看本机 ${os.hostname()} 的 GPU 占用。`, expected: "bash" },
	{ name: "local_file", request: `读取 ${path.resolve("README.md")}。`, expected: "read" },
	{ name: "ssh_configuration", request: "列出 SSH 配置中的主机别名。", expected: "ssh_manager" },
	{ name: "explicit_remote", request: "通过 SSH 查看远程主机 zdw-macbook 的系统版本。", expected: "ssh_manager" },
];
const results: Array<Record<string, unknown>> = [];
try {
	for (const example of cases) {
		let runtime: ToolRuntime | undefined;
		const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
		const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
				pi.on("session_start", async (_event, ctx) => {
					runtime = new ToolRuntime({ pi, cwd, agentDir, projectTrusted: ctx.isProjectTrusted(), modelRuntime, log: console.error });
					await runtime.initialize();
				});
				pi.on("tool_call", (event) => {
					calls.push({ tool: event.toolName, input: structuredClone(event.input) });
					return { block: true, terminate: true, reason: "仅捕获真实模型的工具选择，不执行命令、SSH 连接或其他工具业务。" };
				});
			}] });
		await loader.reload();
		const manager = SessionManager.inMemory(cwd);
		manager.appendCustomMessageEntry("actual_runtime_environment", `当前执行环境的本机主机名：${os.hostname()}；系统：${os.platform()}。`, false);
		const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader: loader,
			thinkingLevel: process.env.PI_REASONING_LEVEL as AgentConfig["thinkingLevel"], sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
		await session.bindExtensions({ mode: "print" });
		try {
			const definition = session.getToolDefinition("ssh_manager");
			assert.ok(definition);
			assert.deepEqual(definition.promptGuidelines, callerPromptGuidelines(ssh));
			for (const rule of ssh.notFor!) assert.ok(session.systemPrompt.includes(`ssh_manager 不用于：${rule}`));
			await session.prompt(example.request);
			results.push({ ...example, calls, activeTools: session.getActiveToolNames(),
				response: session.agent.state.messages.filter((message) => message.role === "assistant") });
			assert.ok(calls.length > 0, `未生成工具调用：${example.name}`);
			for (const call of calls) {
				assert.equal(call.tool, example.expected, `${example.name}: ${JSON.stringify(call)}`);
				if (example.expected === "bash") assert.equal(String(call.input.command).includes("ssh "), false);
			}
			console.log(`${example.name}: ${calls.map((call) => call.tool).join(", ")}`);
		} finally { await runtime?.close(); session.dispose(); }
	}
} finally {
	await fs.writeFile(path.join(parent, "routing-runtime-verification.json"), JSON.stringify({
		cwd, hostname: os.hostname(), model: `${provider}/${modelId}`, results, workloadExecuted: false,
	}, null, 2));
}
