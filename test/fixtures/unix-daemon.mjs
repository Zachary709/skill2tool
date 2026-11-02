import * as net from "node:net";
import * as fs from "node:fs";

const socketPath = process.argv[2];
try {
	fs.unlinkSync(socketPath);
} catch {}
const server = net.createServer((socket) => {
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim()) {
				const message = JSON.parse(line);
				socket.write(
					`${JSON.stringify({ id: message.id, status: "ok", result: { echo: message.params ?? null, method: message.method ?? null } })}\n`,
				);
			}
			index = buffer.indexOf("\n");
		}
	});
});
server.listen(socketPath);
