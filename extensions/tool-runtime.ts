import * as path from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ToolRuntime } from "../src/runtime/tool-runtime.ts";
import type { JobToolInput, ToolAddInput } from "../src/types.ts";

let runtime: ToolRuntime | undefined;
let modelRuntime: ModelRuntime | undefined;

const TOOL_ADD_PARAMS = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("inspect"),
		Type.Literal("validate"),
		Type.Literal("add"),
		Type.Literal("convert_skill"),
		Type.Literal("disable"),
		Type.Literal("enable"),
	]),
	name: Type.Optional(Type.String()),
	scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("user")])),
	source: Type.Optional(
		Type.Object({
			type: Type.Union([Type.Literal("manifest"), Type.Literal("skill"), Type.Literal("script")]),
			path: Type.Optional(Type.String()),
		}),
	),
	manifest: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	instructions: Type.Optional(Type.String()),
	workflow: Type.Optional(Type.String()),
	examples: Type.Optional(Type.String()),
	replace: Type.Optional(Type.Boolean()),
	activate: Type.Optional(Type.Boolean()),
});

const JOB_PARAMS = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("status"),
		Type.Literal("wait"),
		Type.Literal("result"),
		Type.Literal("cancel"),
		Type.Literal("logs"),
	]),
	jobId: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
});

function resultFromEnvelope(envelope: {
	status: string;
	summary: string;
	jobId?: string;
	result?: unknown;
	warnings?: string[];
}) {
	return {
		content: [
			{
				type: "text" as const,
				text: [
					envelope.summary,
					envelope.warnings?.length ? `Warnings:\n- ${envelope.warnings.join("\n- ")}` : "",
					envelope.result !== undefined ? `Result:\n${JSON.stringify(envelope.result, null, 2)}` : "",
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		],
		structuredContent: envelope as never,
		details: envelope,
		isError: envelope.status === "failed",
	};
}

export default function toolRuntimeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tool_add",
		label: "Add tool",
		description:
			"Manage pi-tool-runtime tools. Add a tool from a manifest, convert a SKILL.md into an agent-backed tool, inspect, validate, or disable tools.",
		parameters: TOOL_ADD_PARAMS,
		executionMode: "sequential",
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			if (!runtime) {
				return {
					content: [{ type: "text", text: "tool-runtime is not initialized." }],
					details: undefined,
					isError: true,
				};
			}
			const envelope = await runtime.handleToolAdd(params as ToolAddInput, ctx);
			return resultFromEnvelope(envelope);
		},
	});

	pi.registerTool({
		name: "job",
		label: "Jobs",
		description: "Inspect, wait for, read, list, or cancel background tool jobs.",
		parameters: JOB_PARAMS,
		executionMode: "parallel",
		execute: async (_id, params, _signal, _onUpdate) => {
			if (!runtime) {
				return {
					content: [{ type: "text", text: "tool-runtime is not initialized." }],
					details: undefined,
					isError: true,
				};
			}
			const envelope = await runtime.handleJobTool(params as JobToolInput);
			return resultFromEnvelope(envelope);
		},
	});

	pi.registerCommand("tool-runtime", {
		description: "Show pi-tool-runtime status: /tool-runtime [list|diagnostics]",
		handler: async (args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("tool-runtime is not initialized.", "warning");
				return;
			}
			if (args.trim() === "diagnostics") {
				const diagnostics = runtime.diagnostics;
				ctx.ui.notify(
					diagnostics.length
						? diagnostics.map((item) => `${item.type}: ${item.path}: ${item.message}`).join("\n")
						: "No diagnostics.",
					diagnostics.some((item) => item.type === "error") ? "warning" : "info",
				);
				return;
			}
			const envelope = await runtime.handleJobTool({ action: "list" });
			ctx.ui.notify(envelope.summary, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await runtime?.close();
		const agentDir = getAgentDir();
		modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
		});
		runtime = new ToolRuntime({
			pi,
			cwd: ctx.cwd,
			agentDir,
			projectTrusted: ctx.isProjectTrusted(),
			modelRuntime,
			log: (message) => {
				if (ctx.mode === "tui" || ctx.mode === "rpc") {
					ctx.ui.notify(message, "warning");
				}
			},
		});
		await runtime.initialize();
		if (runtime.diagnostics.some((item) => item.type === "error")) {
			ctx.ui.notify(
				`pi-tool-runtime loaded with ${runtime.diagnostics.filter((item) => item.type === "error").length} error(s). Run /tool-runtime diagnostics.`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		await runtime?.close();
		runtime = undefined;
		modelRuntime = undefined;
	});
}
