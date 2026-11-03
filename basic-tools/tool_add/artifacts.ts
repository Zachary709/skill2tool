import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ToolManifest } from "../../src/types.ts";

export function atomicWrite(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	return fs
		.mkdir(dir, { recursive: true })
		.then(() => fs.writeFile(temp, content, "utf8"))
		.then(() => fs.rename(temp, filePath));
}

export function safeToolName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
}

export function defaultAgentInstructions(manifest: ToolManifest): string {
	const permissions = manifest.permissions ?? {};
	const allowed = [
		permissions.read === false ? undefined : "read files",
		permissions.write ? "write files" : undefined,
		permissions.bash ? "run shell commands" : undefined,
	]
		.filter(Boolean)
		.join(", ");
	return [
		`You are the persistent worker for the tool "${manifest.name}".`,
		"",
		manifest.description.trim(),
		"",
		"## Scope",
		`- You may ${allowed || "read files"}.`,
		"- Work on exactly one job at a time and stay inside the tool directory and the caller's project.",
		"- Do not ask the user questions. If required information is missing, submit status needs_input with the exact missing field.",
		"",
		"## Result",
		"- Finish every job with exactly one submit_result call.",
		"- Return only the declared output fields. Do not include thinking, tool transcripts, commands, logs, or a step-by-step narrative.",
		"- Keep summary to one or two sentences; put the facts in the typed result fields.",
	].join("\n");
}

export function defaultWorkflow(manifest: ToolManifest): string {
	const steps = [
		"# Workflow",
		"",
		`1. Read the delegated task and the declared input fields for ${manifest.name}.`,
		"2. Check the input against the contract. When a required field is missing, submit status needs_input.",
		"3. Follow the agent instructions in the system prompt.",
		manifest.services && Object.keys(manifest.services).length > 0
			? "4. Call the declared services through service_call when the task needs them."
			: "4. Work with the tools declared by the tool contract.",
		"5. Collect the facts the declared output fields need. Drop everything the output schema does not declare.",
		"6. Call submit_result with a short summary and the typed result.",
	];
	return steps.join("\n");
}

export function defaultExamples(manifest: ToolManifest): string {
	const inputFields = Object.keys(manifest.input.properties ?? {});
	const outputFields = Object.keys(manifest.output.properties ?? {});
	return [
		"# Examples",
		"",
		`Input fields: ${inputFields.length ? inputFields.join(", ") : "(none)"}.`,
		`Result fields: ${outputFields.length ? outputFields.join(", ") : "(none)"}.`,
		"",
		"Send only the declared input fields, and return only the declared result fields.",
	].join("\n");
}

export async function writeToolArtifacts(
	dir: string,
	manifest: ToolManifest,
	files: { instructions?: string; workflow?: string; examples?: string },
): Promise<void> {
	const persisted = { ...manifest };
	delete persisted.dir;
	await atomicWrite(path.join(dir, "TOOL.json"), `${JSON.stringify(persisted, null, 2)}\n`);
	if (manifest.kind !== "agent") return;
	if (files.instructions !== undefined) {
		await atomicWrite(path.join(dir, manifest.agent?.instructions ?? "AGENT.md"), `${files.instructions.trim()}\n`);
	}
	if (files.workflow !== undefined) {
		await atomicWrite(path.join(dir, manifest.agent?.workflow ?? "WORKFLOW.md"), `${files.workflow.trim()}\n`);
	}
	if (files.examples !== undefined) {
		await atomicWrite(path.join(dir, manifest.agent?.examples ?? "EXAMPLES.md"), `${files.examples.trim()}\n`);
	}
}

/**
 * Fill the agent files a tool needs. Missing instructions, workflow, and
 * examples are generated from the manifest so every agent tool ships the
 * system prompt and the execution steps its worker needs.
 */
export async function ensureAgentFiles(dir: string, manifest: ToolManifest): Promise<void> {
	if (manifest.kind !== "agent") return;
	const agentPath = path.join(dir, manifest.agent?.instructions ?? "AGENT.md");
	const workflowPath = path.join(dir, manifest.agent?.workflow ?? "WORKFLOW.md");
	const examplesPath = path.join(dir, manifest.agent?.examples ?? "EXAMPLES.md");
	const exists = (filePath: string) => fs.access(filePath).then(() => true).catch(() => false);
	if (!(await exists(agentPath))) {
		await atomicWrite(agentPath, `${defaultAgentInstructions(manifest)}\n`);
	}
	if (!(await exists(workflowPath))) {
		await atomicWrite(workflowPath, `${defaultWorkflow(manifest)}\n`);
	}
	if (manifest.agent?.examples && !(await exists(examplesPath))) {
		await atomicWrite(examplesPath, `${defaultExamples(manifest)}\n`);
	}
}
