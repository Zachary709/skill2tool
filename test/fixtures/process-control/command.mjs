import { spawn } from "node:child_process";

let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
const child = spawn(input.command, input.args ?? [], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("error", (error) => { process.stderr.write(error.message); process.exitCode = 1; });
child.on("close", (exitCode, signal) => {
	process.stdout.write(JSON.stringify({ exitCode, signal, stdout, stderr }));
});
