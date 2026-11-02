import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	process.stdout.write(
		`${JSON.stringify({ id: message.id, status: "ok", result: { echo: message.params ?? null, method: message.method ?? null } })}\n`,
	);
});
