import { createHash } from "node:crypto";
import { readFile, watch, writeFile } from "node:fs/promises";
import * as path from "node:path";

const [target, ready] = process.argv.slice(2);
if (!target || !ready) throw new Error("需要目标文件和就绪文件路径");
const changes = watch(path.dirname(target));
let next = changes.next();
try {
	await writeFile(ready, String(process.pid));
	while (true) {
		const event = await next;
		if (event.done) throw new Error("文件监听提前结束");
		if (event.value.filename === path.basename(target)) {
			const content = await readFile(target);
			process.stdout.write(`${createHash("sha256").update(content).digest("hex")}\n`);
			break;
		}
		next = changes.next();
	}
} finally {
	await changes.return();
}
