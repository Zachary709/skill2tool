import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import koffi from "koffi";
import pidtree from "pidtree";
import { CLEANUP_GRACE_MS } from "./processes.ts";

function enableReaper() {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("可靠的任务回收要求 Linux x64/arm64");
	const libc = koffi.load("libc.so.6");
	const prctl = libc.func("int prctl(int, unsigned long, unsigned long, unsigned long, unsigned long)");
	const syscall = libc.func("long syscall(long, ...)");
	const waitpid = libc.func("int waitpid(int, int *, int)");
	const close = libc.func("int close(int)");
	if (prctl(36, 1, 0, 0, 0) !== 0) throw new Error("无法启用任务子进程回收");
	const probe = syscall(434, "int", process.pid, "uint", 0);
	if (probe < 0) throw new Error("无法使用 pidfd，要求支持 pidfd 的 Linux 内核");
	close(probe);
	return { syscall, waitpid, close };
}
async function send(message: unknown): Promise<void> {
	return new Promise((resolve) => {
		if (!process.connected) { resolve(); return; }
		process.send!(message as any, () => resolve());
	});
}
let native: ReturnType<typeof enableReaper>;
try { native = enableReaper(); }
catch (error) {
	await send({ type: "worker_error", error: String(error) });
	await send({ type: "cleaned" });
	process.exit(1);
}

// 监督进程不执行模型或用户代码；共享服务由父进程持有。
const worker = spawn(process.execPath, [fileURLToPath(new URL("./worker-entry.ts", import.meta.url)), process.argv[2]], {
	env: process.env, detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced",
});
const handles = new Set<number>();
const known = new Set<number>();
let exited = false;
let finished = false;
let stopping = false;
let stopAt = 0;
let cleaning: Promise<void> | undefined;
let escalation: NodeJS.Timeout | undefined;

function open(pid: number): number | undefined {
	const fd = native.syscall(434, "int", pid, "uint", 0) as number;
	if (fd < 0) {
		if (koffi.errno() === constants.errno.ESRCH) return undefined;
		throw new Error(`pidfd_open(${pid}): errno ${koffi.errno()}`);
	}
	handles.add(fd); return fd;
}
function close(fd: number): void {
	if (!handles.delete(fd)) return;
	native.close(fd);
}
function signal(fd: number, name: "SIGTERM" | "SIGSTOP" | "SIGKILL"): void {
	const result = native.syscall(424, "int", fd, "int", constants.signals[name], "void *", null, "uint", 0);
	if (result < 0 && koffi.errno() !== constants.errno.ESRCH) throw new Error(`pidfd_send_signal: errno ${koffi.errno()}`);
}
function remember(pid: number): void {
	if (!known.has(pid)) { known.add(pid); void send({ type: "owned", pid }); }
}
const workerFd = worker.pid ? open(worker.pid) : undefined;
async function capture(): Promise<Map<number, number>> {
	const result = new Map<number, number>();
	for (const pid of await pidtree(process.pid)) {
		const fd = open(pid);
		if (fd !== undefined) result.set(pid, fd);
	}
	// 持有稳定句柄后再次核对父子关系，防止 PID 在枚举期间被复用。
	const verified = new Set(await pidtree(process.pid));
	for (const [pid, fd] of result) {
		if (!verified.has(pid)) { close(fd); result.delete(pid); }
		else remember(pid);
	}
	return result;
}
function reap(children: Map<number, number>): void {
	if (!exited) return;
	for (const pid of children.keys()) {
		if (pid !== worker.pid) native.waitpid(pid, [0], 1);
	}
}
async function cleanup(): Promise<void> {
	if (cleaning) return cleaning;
	cleaning = (async () => {
		if (escalation) clearTimeout(escalation);
		let current = await capture();
		const deadline = (stopAt || Date.now()) + CLEANUP_GRACE_MS;
		for (const fd of current.values()) signal(fd, "SIGTERM");
		while (current.size && Date.now() < deadline) {
			reap(current);
			for (const fd of current.values()) close(fd);
			await sleep(100);
			current = await capture();
		}
		if (current.size) await send({ type: "forcing" });
		const frozen = new Map<number, number>();
		while (true) {
			for (const [pid, fd] of current) {
				if (frozen.has(pid)) close(fd);
				else { signal(fd, "SIGSTOP"); frozen.set(pid, fd); }
			}
			const next = await capture();
			if ([...next.keys()].every((pid) => frozen.has(pid))) { for (const fd of next.values()) close(fd); break; }
			current = next;
		}
		for (const fd of [...frozen.values()].reverse()) signal(fd, "SIGKILL");
		while (true) {
			current = await capture();
			reap(current);
			for (const fd of current.values()) close(fd);
			if (exited && !current.size) break;
			await sleep(50);
		}
		for (const fd of handles) close(fd);
		finished = true;
		await send({ type: "cleaned" });
		if (process.connected) process.disconnect();
	})();
	return cleaning;
}
function fatal(error: unknown): void {
	void send({ type: "cleanup_error", error: String(error) });
	process.stderr.write(`${String(error)}\n`);
	for (const fd of handles) { if (fd !== workerFd) close(fd); }
	cleaning = undefined;
	setTimeout(() => { void cleanup().catch(fatal); }, 1000);
}
function stop(): void {
	if (stopping || finished) return;
	stopping = true; stopAt = Date.now();
	if (worker.connected) worker.send({ type: "cancel" });
	if (!exited && workerFd !== undefined) signal(workerFd, "SIGTERM");
	escalation = setTimeout(() => { void cleanup().catch(fatal); }, CLEANUP_GRACE_MS);
}
process.on("message", (message: any) => {
	if (message?.type === "cancel") stop();
	else if (worker.connected && !stopping) worker.send(message);
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGUSR2", () => { void cleanup().catch(fatal); });
process.on("disconnect", stop);
if (worker.pid) remember(worker.pid);
worker.on("message", (message) => { void send(message); });
worker.once("error", (error) => { exited = true; void send({ type: "worker_error", error: error.message }); void cleanup().catch(fatal); });
worker.once("exit", () => { exited = true; void cleanup().catch(fatal); });
