import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const project = fileURLToPath(new URL("..", import.meta.url));
const script = process.env.PI_WEB_SOURCE_DIR
	? path.join(process.env.PI_WEB_SOURCE_DIR, "e2e", "parallel-tool-results.mjs")
	: fileURLToPath(new URL("../../../pi-web/e2e/parallel-tool-results.mjs", import.meta.url));
const child = spawn(process.execPath, [script], {
	cwd: project,
	env: { ...process.env, PI_TOOL_RUNTIME_PROJECT: project },
	stdio: "inherit",
});
child.once("error", (error) => { throw error; });
const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
assert.equal(code, 0, "Pi Web 原工具卡片验收失败");
