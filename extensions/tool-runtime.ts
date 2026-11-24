import * as path from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { ToolRuntime } from "../src/runtime/tool-runtime.ts";
import { parseToolModel, readToolModel, writeToolModel } from "../src/agents/tool-model.ts";
import { ToolDiscovery } from "../src/discovery/tools.ts";
import { formatJobRow } from "../src/observability/progress.ts";

const PROGRESS_WIDGET_KEY = "tool-progress";
const PROGRESS_STATUS_KEY = "tool-progress";
const PIN_DURATION_MS = 30_000;

function resolveRequestedModel(modelRuntime: ModelRuntime, target: string) {
	if (target.includes("/")) {
		const parsed = parseToolModel(target);
		const model = modelRuntime.getModel(parsed.provider, parsed.id);
		if (!model) throw new Error(`模型运行时中没有 ${parsed.model}`);
		return model;
	}
	const all = modelRuntime.getModels().filter((model) => model.id === target);
	const availableIds = new Set(modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`));
	const available = all.filter((model) => availableIds.has(`${model.provider}\0${model.id}`));
	const matches = available.length > 0 ? available : all;
	if (matches.length === 0) throw new Error(`模型运行时中没有 id 为 ${target} 的模型`);
	if (matches.length > 1) {
		const choices = matches.map((model) => `${model.provider}/${model.id}`).join("、");
		throw new Error(`模型 id ${target} 对应多个模型：${choices}。请写成完整名称。`);
	}
	return matches[0];
}

interface ProgressUiContext {
	ui: {
		setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		setStatus(key: string, text: string | undefined): void;
	};
}

export default function toolRuntimeExtension(pi: ExtensionAPI) {
	const discovery = new ToolDiscovery(pi);
	discovery.register();
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
		description: "Show tool progress: /tool-progress [list|<index>|<short id>|off]",
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

	pi.registerCommand("tool-cancel", {
		description: "取消一个工具任务或本会话全部活动任务：/tool-cancel <任务编号|all>",
		handler: async (args, ctx) => {
			const active = await waitForRuntime();
			if (!active) { ctx.ui.notify("工具运行时尚未就绪", "warning"); return; }
			const reference = args.trim();
			if (!reference) { ctx.ui.notify("用法：/tool-cancel <任务编号|all>，任务编号见 /tool-progress list", "info"); return; }
			try {
				const jobs = await active.cancelTasks(reference, ctx.sessionManager.getSessionId());
				ctx.ui.notify(jobs.length ? `已请求取消 ${jobs.length} 个任务；清理状态见进展。` : "没有活动任务", "info");
			} catch (error) { ctx.ui.notify(String(error), "warning"); }
		},
	});

	pi.on("agent_start", (_event, ctx) => runtime?.beginRun(ctx.sessionManager.getSessionId()));
	pi.on("agent_settled", (event, ctx) => runtime?.endRun(ctx.sessionManager.getSessionId(), event.aborted));

	pi.registerCommand("tool-catalog", {
		description: "分类浏览与加载工具：/tool-catalog [分类|search 关键词|load 目标|unload 目标|reset]",
		handler: async (args, ctx) => {
			const active = await waitForRuntime();
			if (!active) { ctx.ui.notify("工具运行时尚未就绪", "warning"); return; }
			try {
				const output = truncateHead(active.catalogCommand(args));
				ctx.ui.notify(output.content + (output.truncated ? "\n目录显示已截断，请按分类或关键词缩小范围。" : ""), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
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

	pi.registerCommand("tool-model", {
		description: "切换 agent tool 的模型和 thinking level：/tool-model [provider/model|模型 id|reset|show]",
		handler: async (args, ctx) => {
			const agentDir = getAgentDir();
			const target = args.trim();
			try {
				if (target === "show") {
					const selection = await readToolModel(agentDir);
					const source = selection.source === "env"
						? "环境变量 PI_TOOL_MODEL"
						: selection.source === "config" ? selection.path : `默认值（${selection.path}）`;
					const rows = [
						`Agent tool 模型：${selection.model}`,
						`thinking level：${selection.thinkingLevel ?? "跟随调用方"}`,
						`来源：${source}`,
						"用法：/tool-model 切换到当前会话的模型和 thinking level；/tool-model <provider/model|模型 id> 指定模型；/tool-model reset 恢复默认；/tool-model show 查询。",
					];
					const parsed = parseToolModel(selection.model);
					if (modelRuntime && !modelRuntime.getModel(parsed.provider, parsed.id)) {
						rows.push("警告：模型运行时中没有这个模型，任务会失败。");
					}
					ctx.ui.notify(rows.join("\n"), "info");
					return;
				}
				if (target === "reset") {
					const restored = await writeToolModel(agentDir, undefined);
					ctx.ui.notify(`Agent tool 设置已恢复默认：模型 ${restored.model}，thinking level 跟随调用方。新任务生效。`, "info");
					return;
				}
				if (!modelRuntime) throw new Error("模型运行时尚未就绪");
				if (!target && !ctx.model) throw new Error("当前会话没有模型，无法切换");
				const selected = target
					? resolveRequestedModel(modelRuntime, target)
					: ctx.model!;
				if (!(await modelRuntime.checkAuth(selected.provider))) throw new Error(`${selected.provider} 没有可用的凭据`);
				const thinkingLevel = target ? undefined : ctx.thinkingLevel ?? pi.getThinkingLevel?.();
				const choice = await writeToolModel(agentDir, { model: `${selected.provider}/${selected.id}`, thinkingLevel });
				const env = process.env.PI_TOOL_MODEL?.trim();
				ctx.ui.notify(
					[
						`Agent tool 已切换：模型 ${choice.model}，thinking level ${choice.thinkingLevel ?? "跟随调用方"}。新任务生效。`,
						env ? `注意：环境变量 PI_TOOL_MODEL=${env} 优先于此设置。` : "",
					].filter(Boolean).join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
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
				discovery,
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
