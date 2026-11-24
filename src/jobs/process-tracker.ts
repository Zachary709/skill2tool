import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { ChildProcess, spawn as Spawn } from "node:child_process";

// 仅在独立 worker 中安装；共享服务由父进程管理，不经过此处。
export const workerController = new AbortController();
process.on("message", (message: any) => { if (message?.type === "cancel") workerController.abort(new Error("任务已取消")); });
process.on("SIGTERM", () => workerController.abort(new Error("任务已取消")));
process.on("SIGINT", () => workerController.abort(new Error("任务已取消")));
process.on("disconnect", () => workerController.abort(new Error("父进程已断开")));
const journal = process.env.PI_TOOL_PROCESS_JOURNAL;
if (journal) {
	const childProcess = createRequire(import.meta.url)("node:child_process") as { spawn: typeof Spawn };
	const original = childProcess.spawn;

	childProcess.spawn = ((...args: any[]): ChildProcess => {
		workerController.signal.throwIfAborted();
		const child = (original as Function)(...args) as ChildProcess;
		if (child.pid) {
			appendFileSync(journal, `${JSON.stringify({ pid: child.pid })}\n`);
			process.send?.({ type: "owned", pid: child.pid });
		}
		return child;
	}) as typeof Spawn;
	syncBuiltinESMExports();
}
