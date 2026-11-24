import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { RpcClient, type RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { readJobRecord } from "../src/jobs/store.ts";
import { processAlive } from "../src/jobs/processes.ts";
import type { JobRecord } from "../src/types.ts";


test("real RPC tools keep independent progress windows with an onUpdate callback", { timeout: 45000 }, async () => {
	const parent = path.resolve("_intermediate/agent-runtime-checks");
	await fs.mkdir(parent, { recursive: true });
	const cwd = await fs.mkdtemp(path.join(parent, "progress-ui-"));
	const temporary = path.join(cwd, "intermediate");
	await fs.mkdir(temporary);
	const client = new RpcClient({
		cliPath: path.resolve("test/fixtures/process-control/progress-rpc.ts"), cwd,
		env: { TMPDIR: temporary, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-transform-types`.trim() },
	});
	const events: Array<{ at: number; packet: Record<string, unknown> }> = [];
	client.onEvent((event) => events.push({ at: Date.now(), packet: event as unknown as Record<string, unknown> }));
	const widgets = () => events.filter((event) => event.packet.type === "extension_ui_request" && event.packet.method === "setWidget")
		.map((event) => event.packet as unknown as Extract<RpcExtensionUIRequest, { method: "setWidget" }>);
	const waitFor = async (condition: () => boolean | Promise<boolean>) => {
		const deadline = Date.now() + 20000;
		while (!await condition()) {
			assert.ok(Date.now() < deadline, `等待真实进度窗口超时：${client.getStderr()}`);
			await sleep(25);
		}
	};
	try {
		await client.start();
		assert.ok((await client.getCommands()).some((command) => command.name === "progress-window"));
		assert.equal(await client.prompt("/progress-window start"), "handled");
		const calls = JSON.parse(await fs.readFile(path.join(cwd, "rpc-progress-calls.json"), "utf8")) as string[];
		const root = path.join(cwd, ".pi", "jobs");
		let jobs: JobRecord[] = [];
		await waitFor(async () => {
			const names = (await fs.readdir(root)).filter((name) => name.startsWith("job_"));
			const records = await Promise.all(names.map((name) => readJobRecord(root, name)));
			jobs = records.filter((record): record is JobRecord => Boolean(record));
			return jobs.length === 2 && jobs.every((job) => job.phase === "调用服务 run") &&
				new Set(widgets().filter((event) => event.widgetLines?.some((line) => line.includes("调用服务 run"))).map((event) => event.widgetKey)).size === 2;
		});
		const first = jobs.find((job) => job.requester?.toolCallId === calls[0]);
		const second = jobs.find((job) => job.requester?.toolCallId === calls[1]);
		assert.ok(first && second);
		const firstKey = `tool-progress:${first.id}`;
		const secondKey = `tool-progress:${second.id}`;
		assert.ok(widgets().some((event) => event.widgetKey === firstKey && event.widgetPlacement === "aboveEditor"));
		assert.ok(widgets().some((event) => event.widgetKey === secondKey && event.widgetPlacement === "aboveEditor"));
		const count = widgets().length;
		await sleep(1200);
		assert.equal(widgets().length, count, "静默期间不应反复重发窗口");
		assert.equal(await client.prompt("/progress-window cancel-first"), "handled");
		await waitFor(() => widgets().some((event) => event.widgetKey === firstKey && event.widgetLines?.[0]?.includes("已取消")));
		await waitFor(() => widgets().some((event) => event.widgetKey === firstKey && event.widgetLines === undefined));
		assert.equal(widgets().some((event) => event.widgetKey === secondKey && event.widgetLines === undefined), false, "清理一个窗口不能影响另一个运行任务");
		const actual = await fs.readFile("README.md");
		await fs.writeFile(path.join(cwd, "released-readme.md"), actual);
		await waitFor(() => widgets().some((event) => event.widgetKey === secondKey && event.widgetLines?.[0]?.includes("succeeded")));
		await waitFor(() => widgets().some((event) => event.widgetKey === secondKey && event.widgetLines === undefined));
		await client.prompt("/progress-window report");
		const report = JSON.parse(await fs.readFile(path.join(cwd, "rpc-progress-results.json"), "utf8"));
		assert.deepEqual(report.partials, [], "独立窗口显示进度时不应重复发送工具消息");
		assert.ok(["accepted", "cancelled"].includes(report.outcomes[0].structuredContent.status));
		assert.equal(report.outcomes[0].structuredContent.jobId, first.id);
		assert.equal(report.outcomes[1].structuredContent.status, "ok");
		assert.equal(Number(report.outcomes[1].structuredContent.result.stdout.trim()), actual.length);
		for (const job of jobs) {
			const record = await readJobRecord(root, job.id);
			assert.ok(record);
			assert.equal(record.state, job.id === first.id ? "cancelled" : "succeeded");
			assert.equal(processAlive(record.pid), false);
			for (const pid of record.ownedPids ?? []) assert.equal(processAlive(pid), false);
		}
		for (const key of [firstKey, secondKey]) {
			assert.equal(widgets().filter((event) => event.widgetKey === key && event.widgetLines === undefined).length, 1);
			assert.ok(events.some(({ packet }) => packet.method === "setStatus" && packet.statusKey === key && packet.statusText === undefined));
		}
	} finally {
		await client.stop();
		await fs.writeFile(path.join(cwd, "rpc-progress-events.json"), JSON.stringify(events, null, 2));
	}
});
