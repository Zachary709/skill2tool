import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { WorkerHistory } from "../src/agents/history.ts";
import { resolveWorkerThinking } from "../src/agents/model-settings.ts";
import { compactionForModel, resolveAgentContext } from "../src/agents/policy.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import type { ToolEnvelope } from "../src/types.ts";

const fixture = path.join("test", "fixtures", "web-search-worlds-2026", "submission.json");

function completedSessions(manager: Awaited<ReturnType<WorkerHistory["snapshot"]>>["manager"]): string {
	return JSON.stringify(manager.buildSessionContext().messages);
}

test("parallel history publishes completed real tasks without exposing active snapshots", async () => {
	const parent = path.join(process.cwd(), "_intermediate", "agent-context-tests");
	await fs.mkdir(parent, { recursive: true });
	const directory = await fs.mkdtemp(path.join(parent, "run-"));
	try {
		const history = new WorkerHistory(directory, process.cwd(), path.join(directory, "memory.md"));
		const submission: ToolEnvelope = JSON.parse(await fs.readFile(fixture, "utf8"));
		const job = { task: "查询英雄联盟s16总决赛目前赛况" };
		const first = await history.snapshot();
		const second = await history.snapshot();
		assert.notEqual(first.manager.getSessionId(), second.manager.getSessionId());
		assert.equal(first.leafId, null);
		assert.equal(second.leafId, null);

		// 重放真实查询结果，检查共享历史只在任务完成时发生变化。
		first.manager.appendMessage({ role: "user", content: job.task, timestamp: Date.now() });
		second.manager.appendMessage({ role: "user", content: job.task, timestamp: Date.now() });
		await history.complete(first, job, submission);
		const third = await history.snapshot();
		assert.ok(completedSessions(third.manager).includes(first.manager.getSessionId()));
		assert.ok(!completedSessions(third.manager).includes(second.manager.getSessionId()));
		assert.equal(second.manager.getBranch().length, 1);

		await history.complete(second, job, submission);
		const fourth = await history.snapshot();
		assert.ok(completedSessions(fourth.manager).includes(first.manager.getSessionId()));
		assert.ok(completedSessions(fourth.manager).includes(second.manager.getSessionId()));
		assert.ok(!completedSessions(third.manager).includes(second.manager.getSessionId()));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("tool budgets and thinking preferences use real manifests and model capabilities", async () => {
	const model = getModel("openai", "gpt-5.1");
	const nonReasoning = getModel("openai", "gpt-4o");
	assert.ok(model);
	assert.ok(nonReasoning);
	const keeper = await readManifestFile("basic-tools/service_keeper/TOOL.json");
	const builder = await readManifestFile("basic-tools/tool_add/TOOL.json");
	assert.deepEqual(keeper.errors, []);
	assert.deepEqual(builder.errors, []);
	const keeperContext = resolveAgentContext(keeper.manifest!.agent!.context);
	const builderContext = resolveAgentContext(builder.manifest!.agent!.context);
	assert.equal(resolveAgentContext().budgetTokens, 272000);
	assert.equal(keeperContext.budgetTokens, 272000);
	assert.equal(builderContext.budgetTokens, 272000);
	assert.ok(keeperContext.keepRecentTokens < builderContext.keepRecentTokens);
	for (const context of [keeperContext, builderContext]) {
		for (const candidate of [model, nonReasoning]) {
			const settings = compactionForModel(candidate, context);
			assert.equal(candidate.contextWindow - settings.reserveTokens, Math.min(candidate.contextWindow, context.budgetTokens));
			assert.equal(settings.keepRecentTokens, context.keepRecentTokens);
		}
	}
	assert.equal(resolveWorkerThinking(model, "low", "high").thinkingLevel, "low");
	const fallback = resolveWorkerThinking(nonReasoning, "low", "off");
	assert.equal(fallback.thinkingLevel, "off");
	assert.ok(fallback.fallbackReason?.includes("using caller settings"));
});
