import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	callerPromptGuidelines,
	compactTaskInputSchema,
	TASK_INPUT_DESCRIPTION,
} from "../src/contracts/caller.ts";
import { readManifestFile } from "../src/discovery/manifest.ts";
import { defaultAgentInstructions } from "../basic-tools/tool_add/artifacts.ts";

async function manifestAt(file: string) {
	const loaded = await readManifestFile(file);
	assert.deepEqual(loaded.errors, []);
	assert.ok(loaded.manifest);
	return loaded.manifest;
}

test("caller schema guidance preserves real contracts and authorization fields", async () => {
	for (const file of [
		"test/fixtures/web-search-worlds-2026/TOOL.json",
		"basic-tools/service_keeper/TOOL.json",
		"basic-tools/tool_add/TOOL.json",
	]) {
		const tool = await manifestAt(file);
		const original = structuredClone(tool.input);
		const expected = structuredClone(original);
		expected.properties!.request.description = TASK_INPUT_DESCRIPTION;
		const compact = compactTaskInputSchema(tool.input);
		assert.deepEqual(compact, expected);
		assert.deepEqual(tool.input, original);
		assert.deepEqual(compactTaskInputSchema(compact), compact);
		assert.deepEqual(compact.properties?.allowRepair, original.properties?.allowRepair);
	}
	const direct = await manifestAt("test/fixtures/word-count/TOOL.json");
	assert.equal(compactTaskInputSchema(direct.input), direct.input);
});

test("caller guidelines name each tool and delegate configured procedures to its worker", async () => {
	for (const file of [
		"test/fixtures/web-search-worlds-2026/TOOL.json",
		"basic-tools/service_keeper/TOOL.json",
		"basic-tools/tool_add/TOOL.json",
	]) {
		const tool = await manifestAt(file);
		const guidelines = callerPromptGuidelines(tool);
		assert.ok(guidelines.every((rule) => rule.startsWith(tool.name)));
		assert.ok(guidelines.some((rule) => rule.includes("任务原句") && rule.includes("授权限制")));
		assert.ok(guidelines.some((rule) => rule.includes("禁止扩写为操作指南")));
		assert.ok(defaultAgentInstructions(tool).includes("A concise request may omit configured procedures and defaults"));
	}
});
