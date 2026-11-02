import { readFile } from "node:fs/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
	payload = JSON.parse(input || "{}");
} catch {
	console.error("invalid JSON input");
	process.exit(1);
}

const text = typeof payload.text === "string" ? payload.text : "";
const count = text.trim() ? text.trim().split(/\s+/u).length : 0;
process.stdout.write(`${JSON.stringify({ count })}\n`);
