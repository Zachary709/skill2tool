import * as path from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { ToolRuntime } from "../src/runtime/tool-runtime.ts";
import { formatJobRow } from "../src/observability/progress.ts";

const PROGRESS_WIDGET_KEY = "tool-progress";
const PROGRESS_STATUS_KEY = "tool-progress";
const PIN_DURATION_MS = 30_000;

interface ProgressUiContext {
	ui: {
		setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		setStatus(key: string, text: string | undefined): void;
	};
}

export default function toolRuntimeExtension(pi: ExtensionAPI) {
	let runtime: ToolRuntime | undefined;
	let modelRuntime: ModelRuntime | undefined;
	let pinTimer: NodeJS.Timeout | undefined;
	let startup: Promise<void> | undefined;

	function clearPinnedProgress(ctx: ProgressUiContext): void {
		if (pinTimer) clearTimeout(pinTimer);
		pinTimer = undefined;
		ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
		ctx.ui.setStatus(PROGRESS_STATUS_KEY, undefined);
	}

	function schedulePinnedClear(ctx: ProgressUiContext): void {
		if (pinTimer) clearTimeout(pinTimer);
		pinTimer = setTimeout(() => {
			pinTimer = undefined;
			ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
			ctx.ui.setStatus(PROGRESS_STATUS_KEY, undefined);
		}, PIN_DURATION_MS);
		pinTimer.unref?.();
	}

	async function waitForRuntime(): Promise<ToolRuntime | undefined> {
		if (!runtime && startup) await startup.catch(() => {});
		return runtime;
	}

	pi.registerCommand("tool-progress", {
		description: "Show worker thinking and tool steps: /tool-progress [list|<index>|<short id>|off]",
		handler: async (args, ctx) => {
			const active = await waitForRuntime();
			if (!active) {
				ctx.ui.notify("tool-runtime is not initialized.", "warning");
				return;
			}
			const target = args.trim();
			if (target === "off") {
				clearPinnedProgress(ctx);
				return;
			}
			if (target === "list") {
				const jobs = await active.progressJobs();
				if (jobs.length === 0) {
					ctx.ui.notify("No tool job recorded in this project.", "warning");
					return;
				}
				const rows = jobs.slice(0, 10).map((job, index) => formatJobRow(job, index + 1));
				ctx.ui.notify(
					`Recent jobs (/tool-progress <index|short id>):\n${rows.join("\n")}`,
					"info",
				);
				return;
			}
			const snapshot = await active.progress(target || undefined, 12);
			if (snapshot.error) {
				ctx.ui.notify(snapshot.error, "warning");
				return;
			}
			if (!snapshot.jobId) {
				ctx.ui.notify("No tool job recorded in this project.", "warning");
				return;
			}
			ctx.ui.setWidget(PROGRESS_WIDGET_KEY, snapshot.lines, { placement: "aboveEditor" });
			ctx.ui.notify(
				`${snapshot.tool ?? "tool"} ${snapshot.shortId ?? ""} · ${snapshot.state ?? "unknown"}`.trim(),
				"info",
			);
			schedulePinnedClear(ctx);
		},
	});

	pi.registerCommand("tool-runtime", {
		description: "Show pi-tool-runtime status: /tool-runtime [list|diagnostics]",
		handler: async (args, ctx) => {
			const active = await waitForRuntime();
			if (!active) {
				ctx.ui.notify("tool-runtime is not initialized.", "warning");
				return;
			}
			if (args.trim() === "diagnostics") {
				const diagnostics = active.diagnostics;
				ctx.ui.notify(
					diagnostics.length
						? diagnostics.map((item) => `${item.type}: ${item.path}: ${item.message}`).join("\n")
						: "No diagnostics.",
					diagnostics.some((item) => item.type === "error") ? "warning" : "info",
				);
				return;
			}
			const envelope = await active.handleJobTool({ action: "list" });
			ctx.ui.notify(envelope.summary, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		clearPinnedProgress(ctx);
		startup = (async () => {
			await runtime?.close();
			runtime = undefined;
			modelRuntime = undefined;
			const agentDir = getAgentDir();
			modelRuntime = await ModelRuntime.create({
				authPath: path.join(agentDir, "auth.json"),
				modelsPath: path.join(agentDir, "models.json"),
			});
			const instance = new ToolRuntime({
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
			await instance.initialize();
			runtime = instance;
			if (instance.diagnostics.some((item) => item.type === "error")) {
				ctx.ui.notify(
					`pi-tool-runtime loaded with ${instance.diagnostics.filter((item) => item.type === "error").length} error(s). Run /tool-runtime diagnostics.`,
					"warning",
				);
			}
		})();
		await startup.catch((error) => {
			ctx.ui.notify(
				`pi-tool-runtime failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	});

	pi.on("session_shutdown", async () => {
		if (pinTimer) clearTimeout(pinTimer);
		pinTimer = undefined;
		startup = undefined;
		await runtime?.close();
		runtime = undefined;
		modelRuntime = undefined;
	});
}
