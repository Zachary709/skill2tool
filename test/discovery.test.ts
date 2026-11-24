import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import {
	createAgentSession,
	createToolSearchExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("discovery plugin loads and reloads alongside builtin tool-search without diagnostics", async () => {
	const parent = path.resolve("_intermediate");
	await fs.mkdir(parent, { recursive: true });
	const root = await fs.mkdtemp(path.join(parent, "discovery-reload-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const rounds: unknown[] = [];
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
		const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [path.resolve("extensions/tool-runtime.ts"), "builtin:tool-search"],
			extensionFactories: [{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() }] });
		for (let round = 0; round < 2; round++) {
			await loader.reload();
			const extensions = loader.getExtensions();
			assert.deepEqual(extensions.errors, []);
			assert.deepEqual(extensions.warnings ?? [], []);
			assert.ok(extensions.extensions.some((entry) => entry.path === "builtin:tool-search"));
			const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
			await session.bindExtensions({ mode: "print" });
			try {
				const initial = session.getActiveToolNames();
				assert.deepEqual(initial, ["read", "bash", "edit", "write", "tool_find", "tool_use"]);
				assert.ok(session.getToolDefinition("tool_search"));
				assert.ok(session.getToolDefinition("tool_find"));
				const find = session.agent.state.tools.find((tool) => tool.name === "tool_find")!;
				const result = await find.execute(`search-${round}`, { query: "runtime" }, new AbortController().signal);
				const candidates = (result.details as { candidates: Array<{ name: string }> }).candidates.map((entry) => entry.name).sort();
				assert.deepEqual(candidates, ["service_keeper", "tool_add"]);
				assert.deepEqual(session.getActiveToolNames(), initial);
				const use = session.agent.state.tools.find((tool) => tool.name === "tool_use")!;
				const inspected = await use.execute(`inspect-${round}`, { tool: "tool_add" }, new AbortController().signal);
				assert.equal((inspected.details as { contract: { name: string } }).contract.name, "tool_add");
				assert.deepEqual(session.getActiveToolNames(), initial);
				session.setActiveToolsByName([...initial, "tool_search"]);
				assert.ok(session.systemPrompt.includes("tool_find"));
				assert.ok(!session.systemPrompt.includes("tool_search:"));
				await session.prompt("/tool-catalog reset");
				assert.deepEqual(session.getActiveToolNames(), initial);
				rounds.push({ round, errors: extensions.errors, warnings: extensions.warnings ?? [],
					extensions: extensions.extensions.map((entry) => entry.path), initial, candidates });
			} finally {
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		}
		await fs.writeFile(path.join(root, "verification.json"), JSON.stringify({ rounds }, null, 2));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
