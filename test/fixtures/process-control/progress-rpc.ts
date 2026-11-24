import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	runRpcMode,
	SessionManager,
	SettingsManager,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { ToolRuntime } from "../../../src/runtime/tool-runtime.ts";
import { readManifestFile } from "../../../src/discovery/manifest.ts";
import { readJobRecord } from "../../../src/jobs/store.ts";

const cwd = process.cwd();
const agentDir = path.join(cwd, "agent");
const jobsRoot = path.join(cwd, ".pi", "jobs");
const releasedFile = path.join(cwd, "released-readme.md");
await fs.mkdir(agentDir, { recursive: true });
const loaded = await readManifestFile(fileURLToPath(new URL("./TOOL.json", import.meta.url)));
assert.ok(loaded.manifest);
let host: AgentSessionRuntime;
let runtime: ToolRuntime | undefined;
const calls: string[] = [];
const results: Array<Promise<unknown>> = [];
const partials: unknown[] = [];

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd, agentDir,
		settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
		resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				pi.on("session_start", async (_event, ctx) => {
					runtime = new ToolRuntime({ pi, cwd, agentDir, projectTrusted: ctx.isProjectTrusted(),
						modelRuntime: services.modelRuntime, log: console.error });
					await runtime.initialize();
					runtime.register(loaded.manifest!);
					runtime.register({ ...loaded.manifest!, name: "process_command_second" });
				});
				pi.on("session_shutdown", async () => { await runtime?.close(); });
				pi.registerCommand("progress-window", {
					description: "运行真实进度窗口验收命令。",
					handler: async (args, ctx) => {
						assert.ok(runtime);
						if (args.trim() === "start") {
							assert.equal(calls.length, 0);
							const inputs = [
								{ command: "sleep", args: ["120"] },
								{ command: "bash", args: ["-c", 'while [ ! -f "$1" ]; do sleep 0.1; done; wc -c < "$1"', "progress-window", releasedFile] },
							];
							for (const [index, input] of inputs.entries()) {
								const name = index === 0 ? loaded.manifest!.name : "process_command_second";
								const tool = host.session.agent.state.tools.find((entry) => entry.name === name);
								assert.ok(tool);
								const id = randomUUID();
								calls.push(id);
								results.push(tool.execute(id, input, new AbortController().signal,
									index === 0 ? (partial) => partials.push(partial) : undefined));
							}
							await fs.writeFile(path.join(cwd, "rpc-progress-calls.json"), JSON.stringify(calls));
							ctx.ui.notify("两个真实工具任务已启动", "info");
						} else if (args.trim() === "cancel-first") {
							const jobs = await runtime.progressJobs();
							const records = await Promise.all(jobs.map((job) => readJobRecord(jobsRoot, job.jobId)));
							const first = records.find((job) => job?.requester?.toolCallId === calls[0]);
							assert.ok(first);
							await runtime.cancelTasks(first.id, ctx.sessionManager.getSessionId());
						} else if (args.trim() === "report") {
							const outcomes = await Promise.all(results);
							await fs.writeFile(path.join(cwd, "rpc-progress-results.json"), JSON.stringify({ calls, partials, outcomes }, null, 2));
						} else {
							throw new Error(`未知验收动作：${args}`);
						}
					},
				});
			}],
		},
	});
	return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent }),
		services, diagnostics: services.diagnostics };
};

host = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
await runRpcMode(host);
