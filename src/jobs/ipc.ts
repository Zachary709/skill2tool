import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerProgressEntry, WorkerRunResult } from "../agents/worker.ts";
import type { ToolManifest } from "../types.ts";

export interface RemoteTool {
	name: string;
	label: string;
	description: string;
	parameters: ToolDefinition["parameters"];
}

export interface ManagementTool extends RemoteTool {
	execute(id: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export type WorkerMessage =
	| { type: "progress"; entry: WorkerProgressEntry }
	| { type: "resolved"; agentId: string; agentSource: string }
	| { type: "result"; result: WorkerRunResult }
	| { type: "request"; id: string; method: "service" | "management" | "audit"; name: string; input: Record<string, unknown> }
	| { type: "owned"; pid: number }
	| { type: "ready" }
	| { type: "cleaned" | "forcing" }
	| { type: "cleanup_error" | "worker_error"; error: string };

export type ParentMessage =
	| { type: "cancel" }
	| { type: "reply"; id: string; value?: unknown; error?: string }
	| { type: "configure"; tools: RemoteTool[]; manifest: ToolManifest };

export class WorkerRpc {
	private nextId = 0;
	private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
	constructor(private readonly signal: AbortSignal) {
		process.on("message", (raw) => {
			const message = raw as ParentMessage;
			if (message.type !== "reply") return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error));
			else pending.resolve(message.value);
		});
		signal.addEventListener("abort", () => {
			for (const pending of this.pending.values()) pending.reject(new Error("任务已取消"));
			this.pending.clear();
		}, { once: true });
	}
	call(method: "service" | "management" | "audit", name: string, input: Record<string, unknown>): Promise<any> {
		this.signal.throwIfAborted();
		const id = String(++this.nextId);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			process.send!({ type: "request", id, method, name, input } satisfies WorkerMessage, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}
}
