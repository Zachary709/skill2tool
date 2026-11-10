import { promises as fs } from "node:fs";
import { setTimeout } from "node:timers/promises";
import lockfile from "proper-lockfile";

export interface WorkerLock {
	signal: AbortSignal;
	release(): Promise<void>;
}

export async function acquireWorkerLock(directory: string, signal?: AbortSignal): Promise<WorkerLock> {
	await fs.mkdir(directory, { recursive: true });
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	while (true) {
		combined.throwIfAborted();
		try {
			const release = await lockfile.lock(directory, {
				realpath: false,
				onCompromised: (error) => controller.abort(error),
			});
			if (combined.aborted) {
				await release();
				combined.throwIfAborted();
			}
			return {
				signal: combined,
				release: async () => {
					if (controller.signal.aborted) throw controller.signal.reason;
					await release();
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			await setTimeout(500, undefined, { signal: combined });
		}
	}
}
