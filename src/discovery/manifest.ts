import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateManifest } from "../contracts/schema.ts";
import type { ToolManifest } from "../types.ts";

export interface ToolSource {
	root: string;
	scope: "user" | "project" | "package";
}

export interface LoadedTool {
	manifest: ToolManifest;
	dir: string;
	scope: ToolSource["scope"];
}

export interface ToolLoadDiagnostic {
	type: "error" | "warning";
	path: string;
	message: string;
}

export async function loadTools(sources: ToolSource[]): Promise<{
	tools: LoadedTool[];
	diagnostics: ToolLoadDiagnostic[];
}> {
	const tools: LoadedTool[] = [];
	const diagnostics: ToolLoadDiagnostic[] = [];
	const seen = new Map<string, string>();

	for (const source of sources) {
		let entries: string[];
		try {
			entries = await fs.readdir(source.root, { withFileTypes: true }).then((items) =>
				items.filter((item) => item.isDirectory()).map((item) => item.name),
			);
		} catch {
			continue;
		}

		for (const entry of entries.sort()) {
			const dir = path.join(source.root, entry);
			const manifestPath = path.join(dir, "TOOL.json");
			let raw: unknown;
			try {
				raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				diagnostics.push({
					type: "error",
					path: manifestPath,
					message: `failed to read TOOL.json: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}

			const result = validateManifest(raw, dir);
			for (const warning of result.warnings) {
				diagnostics.push({ type: "warning", path: manifestPath, message: warning });
			}
			if (!result.manifest) {
				for (const error of result.errors) {
					diagnostics.push({ type: "error", path: manifestPath, message: error });
				}
				continue;
			}
			if (result.errors.length > 0) {
				for (const error of result.errors) {
					diagnostics.push({ type: "error", path: manifestPath, message: error });
				}
				continue;
			}

			const manifest = result.manifest;
			const previous = seen.get(manifest.name);
			if (previous) {
				diagnostics.push({
					type: "error",
					path: manifestPath,
					message: `tool name "${manifest.name}" collides with ${previous}`,
				});
				continue;
			}
			seen.set(manifest.name, manifestPath);
			tools.push({ manifest, dir, scope: source.scope });
		}
	}

	return { tools, diagnostics };
}

export async function readManifestFile(filePath: string): Promise<{
	manifest?: ToolManifest;
	dir: string;
	errors: string[];
	warnings: string[];
}> {
	const dir = path.dirname(path.resolve(filePath));
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch (error) {
		return {
			dir,
			errors: [`failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`],
			warnings: [],
		};
	}
	return { ...validateManifest(raw, dir), dir };
}
