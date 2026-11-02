import * as path from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { ToolRuntime } from "../src/runtime/tool-runtime.ts";

let runtime: ToolRuntime | undefined;
let modelRuntime: ModelRuntime | undefined;

export default function toolRuntimeExtension(pi: ExtensionAPI) {
	pi.registerCommand("tool-progress", {
		description: "Show worker thinking and tool steps: /tool-progress [jobId|off]",
		handler: async (args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("tool-runtime is not initialized.", "warning");
				return;
			}
			const target = args.trim();
			if (target === "off") {
				ctx.ui.setWidget("tool-progress", undefined);
				ctx.ui.setStatus("tool-progress", undefined);
				return;
			}
			const snapshot = await runtime.progress(target || undefined, 12);
			if (!snapshot.jobId) {
				ctx.ui.notify("No tool job recorded in this project.", "warning");
				return;
			}
			ctx.ui.setWidget("tool-progress", snapshot.lines, { placement: "aboveEditor" });
			ctx.ui.notify(`${snapshot.tool ?? "tool"} ${snapshot.jobId} · ${snapshot.state ?? "unknown"}`, "info");
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
