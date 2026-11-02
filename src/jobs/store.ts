import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { JobRecord } from "../types.ts";

export function jobDir(root: string, id: string): string {
	return path.join(root, id);
}

export function jobFilePath(root: string, id: string): string {
	return path.join(jobDir(root, id), "job.json");
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	await fs.writeFile(temp, content, "utf8");
	await fs.rename(temp, filePath);
}

export async function writeJobRecord(root: string, record: JobRecord): Promise<void> {
	await atomicWrite(jobFilePath(root, record.id), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readJobRecord(root: string, id: string): Promise<JobRecord | undefined> {
	try {
		return JSON.parse(await fs.readFile(jobFilePath(root, id), "utf8")) as JobRecord;
	} catch {
		return undefined;
	}
}

export async function appendJobEvent(root: string, record: JobRecord, event: Record<string, unknown>): Promise<void> {
	try {
		await fs.mkdir(jobDir(root, record.id), { recursive: true });
		await fs.appendFile(
			path.join(jobDir(root, record.id), "events.jsonl"),
			`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`,
			"utf8",
		);
	} catch {
		// Events are diagnostic. A write failure must not change the job result.
	}
}

export async function writeJobResult(root: string, record: JobRecord): Promise<void> {
	if (!record.result) return;
	await atomicWrite(
		path.join(jobDir(root, record.id), "result.json"),
		`${JSON.stringify(record.result, null, 2)}\n`,
	);
}
