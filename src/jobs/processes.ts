export const CLEANUP_GRACE_MS = 5000;

export function processAlive(pid?: number, group = false): boolean {
	if (!pid) return false;
	try { process.kill(group && process.platform !== "win32" ? -pid : pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export function signalProcess(pid: number, signal: NodeJS.Signals, group = false): void {
	try { process.kill(group && process.platform !== "win32" ? -pid : pid, signal); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
