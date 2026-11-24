import type { ToolExposure, ToolNamespace } from "@earendil-works/pi-coding-agent";
import type { JsonSchema, ToolManifest } from "../types.ts";

export const TOOL_CATEGORY_SCHEMA: JsonSchema = {
	type: "string",
	maxLength: 128,
	pattern: "^[a-z][a-z0-9_]*(/[a-z][a-z0-9_]*)?$",
	description: "主要能力分类，可使用领域或领域/子分类。",
};

export const TOOL_TAGS_SCHEMA: JsonSchema = {
	type: "array",
	maxItems: 16,
	uniqueItems: true,
	items: { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" },
	description: "用于跨分类检索的关键词。",
};

export const TOOL_CATALOG_METADATA_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		category: TOOL_CATEGORY_SCHEMA,
		tags: TOOL_TAGS_SCHEMA,
		defaultActive: { type: "boolean" },
		exposure: { type: "string", enum: ["direct", "model-only", "codemode", "deferred", "hidden"] },
		namespace: { type: "string", minLength: 1 },
	},
};

const CATEGORIES = new Map<string, { label: string; description: string }>([
	["research", { label: "检索与研究", description: "检索网络资料，阅读论文并调研作者。" }],
	["infrastructure", { label: "设备与计算", description: "管理远程连接和网络，安排实验室计算任务。" }],
	["runtime", { label: "运行维护", description: "管理工具及已登记的本地服务。" }],
	["other", { label: "其他工具", description: "其他已安装工具的专门能力。" }],
]);

const DEFAULT_CATEGORIES = new Map([
	["web_search", "research"],
	["paper_reader", "research"],
	["ssh_manager", "infrastructure"],
	["tailscale_manager", "infrastructure"],
	["adaptive_computation", "infrastructure"],
	["service_keeper", "runtime"],
	["tool_add", "runtime"],
]);

export interface ToolCatalogEntry {
	name: string;
	description: string;
	category: string;
	tags: string[];
	whenToUse: string[];
	active: boolean;
	exposure: ToolExposure;
}

export function toolCategory(manifest: ToolManifest): string {
	if (manifest.category) return manifest.category;
	const known = DEFAULT_CATEGORIES.get(manifest.name);
	if (known) return known;
	if (manifest.namespace && manifest.namespace !== "tool" && /^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)?$/.test(manifest.namespace)) {
		return manifest.namespace;
	}
	return "other";
}

export function categoryLabel(category: string): string {
	const [root, child] = category.split("/");
	const label = CATEGORIES.get(root)?.label ?? root;
	return child ? `${label} / ${child}` : label;
}

export function toolNamespace(manifest: ToolManifest): ToolNamespace {
	const category = toolCategory(manifest);
	const root = category.split("/")[0];
	const domain = CATEGORIES.get(root);
	return {
		name: manifest.namespace && manifest.namespace !== "tool" ? manifest.namespace : root,
		description: domain ? `${categoryLabel(root)}：${domain.description}` : categoryLabel(root),
	};
}

export function catalogExposure(manifest: ToolManifest): ToolExposure {
	// 旧清单的 direct 同样参与按需发现；执行方式仍由 kind 决定。
	return !manifest.exposure || manifest.exposure === "direct" ? "deferred" : manifest.exposure;
}

export function catalogDefaultActive(manifest: ToolManifest): boolean {
	return manifest.exposure !== "hidden" && (manifest.defaultActive ?? manifest.exposure === "model-only");
}

export function catalogOverview(entries: ToolCatalogEntry[]): string {
	const roots = [...new Set(entries.map((entry) => entry.category.split("/")[0]))].sort();
	if (roots.length === 0) return "";
	return [
		"需要专门能力时，使用 tool_find 查找候选；搜索不会改变当前工具列表。",
		"使用 tool_use 指定确切工具，省略 input 查看输入契约，传入 input 实际调用；实际执行的工具才加入当前列表，之后可直接调用。",
		"tool_find 支持跨分类检索；查看契约不加载工具，所有调用保留目标工具的参数校验和授权要求。",
		...roots.map((root) => `- ${root}（${categoryLabel(root)}）：${CATEGORIES.get(root)?.description ?? "按该领域检索相关工具。"}`),
	].join("\n");
}

export function catalogMatches(entry: ToolCatalogEntry, query: string): boolean {
	const text = [entry.name, entry.description, entry.category, categoryLabel(entry.category), ...entry.tags, ...entry.whenToUse]
		.join(" ").toLocaleLowerCase();
	return query.trim().toLocaleLowerCase().split(/\s+/).every((term) => text.includes(term));
}

export function catalogTargets(entries: ToolCatalogEntry[], target: string): ToolCatalogEntry[] {
	const tool = entries.find((entry) => entry.name === target);
	const matches = tool ? [tool] : entries.filter((entry) => entry.category === target || entry.category.startsWith(`${target}/`));
	if (matches.length === 0) throw new Error(`没有可用的工具或分类：${target}`);
	return matches;
}

export function formatCatalog(entries: ToolCatalogEntry[], category?: string, query?: string): string {
	const selected = entries.filter((entry) => (!category || entry.category === category || entry.category.startsWith(`${category}/`)) &&
		(!query || catalogMatches(entry, query)));
	if (category && selected.length === 0) throw new Error(`没有可用的分类：${category}`);
	const lines: string[] = [];
	if (!category && !query) {
		lines.push(`工具目录：${entries.length} 个工具，${entries.filter((entry) => entry.active).length} 个已加载。`);
		for (const root of [...new Set(entries.map((entry) => entry.category.split("/")[0]))].sort()) {
			const tools = entries.filter((entry) => entry.category === root || entry.category.startsWith(`${root}/`));
			lines.push(`- ${root}（${categoryLabel(root)}）：${tools.length} 个工具，${tools.filter((entry) => entry.active).length} 个已加载`);
		}
		lines.push("使用 /tool-catalog <分类> 查看工具，/tool-catalog search <关键词> 跨分类查找。");
	} else {
		lines.push(query ? `找到 ${selected.length} 个匹配工具。` : `${categoryLabel(category!)}：${selected.length} 个工具。`);
		let previousCategory: string | undefined;
		for (const entry of selected.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))) {
			if (entry.category !== previousCategory) {
				lines.push(`${entry.category}（${categoryLabel(entry.category)}）`);
				previousCategory = entry.category;
			}
			lines.push(`  ${entry.active ? "[已加载]" : "[未加载]"} ${entry.name}：${entry.description.trim().split(/\r?\n/)[0]}`);
		}
	}
	lines.push("/tool-catalog load <工具或分类> 加载；unload <工具或分类> 收起；reset 恢复初始列表。");
	return lines.join("\n");
}
