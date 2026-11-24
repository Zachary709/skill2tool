import { createServer } from "node:http";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";

const watchers = new Set();
const server = createServer(async (req, res) => {
	if (req.method === "GET") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ watchers: watchers.size }));
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const input = JSON.parse(body);
	const file = input.params.path;
	const initial = await stat(file);
	const watcher = watch(file, async () => {
		const current = await stat(file);
		if (current.mtimeMs === initial.mtimeMs) return;
		watcher.close(); watchers.delete(watcher);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ status: "ok", result: { path: file, mtimeMs: current.mtimeMs } }));
	});
	watchers.add(watcher);
	res.once("close", () => { watcher.close(); watchers.delete(watcher); });
});
server.listen(0, "127.0.0.1", () => { process.send?.({ port: server.address().port }); });
process.on("SIGTERM", () => {
	for (const watcher of watchers) watcher.close();
	server.closeAllConnections();
	server.close();
	if (process.connected) process.disconnect();
});
