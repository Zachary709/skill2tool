import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

interface LockOwner {
	pid: number;
	createdAt: string;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function acquireWorkerLock(cwd: string, tool: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	const key = createHash("sha256").update(`${tool}|${cwd}`).digest("hex").slice(0, 12);
	const lockDir = path.join(cwd, ".pi", "jobs", ".locks", `${tool}-${key}.lock`);
	await fs.mkdir(path.dirname(lockDir), { recursive: true });

	while (true) {
		if (signal?.aborted) throw new Error("job aborted while waiting for worker lock");
		try {
			await fs.mkdir(lockDir);
			const owner: LockOwner = { pid: process.pid, createdAt: new Date().toISOString() };
			await fs.writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
			return async () => {
				await fs.rm(lockDir, { recursive: true, force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = await fs
				.readFile(path.join(lockDir, "owner.json"), "utf8")
				.then((text) => JSON.parse(text) as LockOwner)
				.catch(() => undefined);
			const stale = !owner || !isAlive(owner.pid);
			if (stale) {
				await fs.rm(lockDir, { recursive: true, force: true });
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
}
