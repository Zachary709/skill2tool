import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentWorker } from "../agents/worker.ts";
import { resolveAgent } from "../agents/resolver.ts";
import { readManifestFile } from "../discovery/manifest.ts";
import { ServiceSupervisor } from "../services/supervisor.ts";
import type { JobRecord, ToolEnvelope } from "../types.ts";
import { appendJobEvent, atomicWrite, jobDir, readJobRecord, writeJobRecord, writeJobResult } from "./store.ts";

function jobRootFromPath(jobPath: string): string {
	return path.dirname(path.dirname(jobPath));
}

async function update(
	root: string,
	record: JobRecord,
	patch: Partial<JobRecord>,
	event?: Record<string, unknown>,
): Promise<JobRecord> {
	Object.assign(record, patch, { heartbeatAt: new Date().toISOString() });
	await writeJobRecord(root, record);
	if (event) await appendJobEvent(root, record, event);
	return record;
}

async function main(): Promise<void> {
	const jobPath = process.argv[2];
	if (!jobPath) throw new Error("usage: worker-entry.ts <job.json>");
	const absoluteJobPath = path.resolve(jobPath);
	const root = jobRootFromPath(absoluteJobPath);
	const jobId = path.basename(path.dirname(absoluteJobPath));
	const initial = await readJobRecord(root, jobId);
	if (!initial) throw new Error(`job not found: ${absoluteJobPath}`);
	if (!initial.toolDir) throw new Error("job has no toolDir");

	const manifestResult = await readManifestFile(path.join(initial.toolDir, "TOOL.json"));
	if (!manifestResult.manifest) {
		throw new Error(`manifest is invalid: ${manifestResult.errors.join("; ")}`);
	}
	const manifest = manifestResult.manifest;
	manifest.dir = initial.toolDir;

	const agentDir = process.env.PI_TOOL_RUNTIME_AGENT_DIR || getAgentDir();
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
	});
	const supervisor = new ServiceSupervisor((message) => {
		void fs.appendFile(path.join(jobDir(root, jobId), "stderr.log"), `${message}\n`).catch(() => {});
	});

	let record = await update(
		root,
		initial,
		{
			state: "running",
			pid: process.pid,
			startedAt: new Date().toISOString(),
		},
		{ state: "running", pid: process.pid },
	);

	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGTERM", abort);
	process.once("SIGINT", abort);

	let envelope: ToolEnvelope;
	let usage: Record<string, unknown> | undefined;
	try {
		const resolution = await resolveAgent({
			tool: manifest,
			cwd: record.cwd,
			agentDir,
			projectTrusted: record.projectTrusted ?? false,
			allowCreateProject: manifest.agent?.createProjectIfMissing ?? true,
		});
		if (!resolution.agent) {
			envelope = {
				status: "failed",
				summary: resolution.error ?? "No usable agent for this tool.",
				warnings: resolution.warnings,
			};
		} else {
			record = await update(
				root,
				record,
				{
					agentId: `${resolution.agent.source}:${resolution.agent.name}@${resolution.agent.version}`,
					agentSource: resolution.agent.source,
				},
				{ state: "agent-resolved", source: resolution.agent.source, path: resolution.agent.path },
			);
			const worker = new AgentWorker(
				manifest,
				resolution.agent,
				record.cwd,
				agentDir,
				modelRuntime,
				supervisor,
				(message) => {
					void fs.appendFile(path.join(jobDir(root, jobId), "stderr.log"), `${message}\n`).catch(() => {});
				},
			);
			try {
				const params = record.input as {
					task?: string;
					input?: Record<string, unknown>;
					context?: string;
				};
				const result = await worker.run(
					{
						task: typeof params.task === "string" ? params.task : JSON.stringify(params),
						input: params.input,
						context: params.context,
					},
					controller.signal,
				);
				envelope = result.envelope;
				usage = result.usage;
				if (result.warnings.length > 0) {
					envelope.warnings = [...(envelope.warnings ?? []), ...result.warnings];
				}
			} finally {
				await worker.dispose();
			}
		}
	} catch (error) {
		envelope = {
			status: controller.signal.aborted ? "cancelled" : "failed",
			summary: error instanceof Error ? error.message : String(error),
		};
	} finally {
		process.removeListener("SIGTERM", abort);
		process.removeListener("SIGINT", abort);
		await supervisor.close();
	}

	const state =
		envelope.status === "cancelled"
			? "cancelled"
			: envelope.status === "failed"
				? "failed"
				: "succeeded";
	record = await update(
		root,
		record,
		{
			state,
			result: { ...envelope, jobId },
			usage,
			artifacts: envelope.artifacts,
			message: envelope.summary,
			error: state === "failed" ? envelope.summary : undefined,
			finishedAt: new Date().toISOString(),
		},
		{ state, message: envelope.summary },
	);
	await writeJobResult(root, record);
}

main().catch(async (error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
	const jobPath = process.argv[2];
	if (!jobPath) return;
	try {
		const absoluteJobPath = path.resolve(jobPath);
		const root = jobRootFromPath(absoluteJobPath);
		const jobId = path.basename(path.dirname(absoluteJobPath));
		const record = await readJobRecord(root, jobId);
		if (record) {
			record.state = "failed";
			record.error = message;
			record.result = { status: "failed", summary: message, jobId };
			record.finishedAt = new Date().toISOString();
			record.heartbeatAt = record.finishedAt;
			await atomicWrite(path.join(jobDir(root, jobId), "job.json"), `${JSON.stringify(record, null, 2)}\n`);
			await writeJobResult(root, record);
		}
	} catch {
		// ignore
	}
});
