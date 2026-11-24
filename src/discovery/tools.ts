import MiniSearch from "minisearch";
import { Type } from "typebox";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

export const DISCOVERY_TOOL_NAMES = ["tool_find", "tool_use"] as const;
const SEARCH_GUIDELINE = "tool_find 只返回候选，不改变工具列表；首次调用选中的工具时使用 tool_use。";
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function tokenize(text: string): string[] {
	return Array.from(wordSegmenter.segment(text.replaceAll("_", " ")))
		.filter((part) => part.isWordLike).map((part) => part.segment);
}

export class ToolDiscovery {
	private registered = false;
	private closed = false;
	private epoch = 0;
	private readonly visibilityVersions = new Map<string, number>();

	constructor(private readonly pi: ExtensionAPI) {}

	register(): void {
		if (this.registered) return;
		this.pi.registerTool({
			name: "tool_find",
			label: "tool_find",
			description: "检索专门工具，只返回候选名称和能力说明，不加载或执行工具。",
			promptSnippet: "检索工具候选，不改变当前工具列表",
			promptGuidelines: [SEARCH_GUIDELINE],
			parameters: Type.Object({
				query: Type.String({ description: "所需能力或工具名称。" }),
				limit: Type.Optional(Type.Number({ description: "最多返回的候选数量，默认 8。" })),
			}, { additionalProperties: false }),
			exposure: "model-only",
			defaultActive: false,
			reachesTools: () => "all",
			prepareLoadout: (loadout) => loadout.declared.some((tool) => tool.name === "tool_search")
				? { hiddenDeclarations: ["tool_search"] } : undefined,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			execute: async (_id, { query, limit }, signal) => {
				this.assertOpen();
				signal?.throwIfAborted();
				if (!query.trim()) throw new Error("query 不能为空");
				const count = limit ?? 8;
				if (!Number.isInteger(count) || count <= 0) throw new Error("limit 必须是正整数");
				const active = new Set(this.pi.getActiveTools());
				const candidates = this.search(query, count).map((tool) => ({
					name: tool.name,
					description: tool.description,
					namespace: tool.namespace?.name,
					active: active.has(tool.name),
				}));
				return {
					content: [{ type: "text", text: candidates.length
						? `搜索未改变工具列表。使用 tool_use 指定尚未加载的确切工具；不传 input 可查看输入契约，传入 input 执行。\n${JSON.stringify(candidates, null, 2)}`
						: "没有匹配的工具。" }],
					details: { candidates },
				};
			},
		});
		this.pi.registerTool({
			name: "tool_use",
			label: "tool_use",
			description: "查看指定工具的输入契约，或传入 input 实际调用；只有实际执行的工具加入当前对话列表。",
			promptSnippet: "查看确切工具的契约，或执行选中的工具并将其加入列表",
			promptGuidelines: [
				"tool_use 的 tool 必须是确切工具名称。省略 input 仅查看契约；先读取契约和使用边界，再按原有字段提供 input 执行。",
				"tool_use 保留目标工具的参数校验、授权、进度和取消规则；已加入当前列表的工具可以直接调用。",
			],
			parameters: Type.Object({
				tool: Type.String({ minLength: 1, description: "确切的工具名称。" }),
				input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "目标工具原有的输入对象；省略时只查看契约。" })),
			}, { additionalProperties: false }),
			exposure: "model-only",
			defaultActive: false,
			reachesTools: (input) => typeof input.tool === "string" ? [input.tool] : [],
			execute: async (_id, { tool, input }, signal, onUpdate, ctx) => {
				this.assertOpen();
				signal?.throwIfAborted();
				if (DISCOVERY_TOOL_NAMES.some((name) => name === tool) || !ctx.tools.some((entry) => entry.name === tool)) {
					throw new Error(`工具不可调用：${tool}`);
				}
				const target = this.pi.getAllTools().find((entry) => entry.name === tool);
				if (!target || target.exposure === "hidden") throw new Error(`工具不可用：${tool}`);
				if (input === undefined) {
					const contract = { name: tool, description: target.description, input: target.parameters, guidelines: target.promptGuidelines ?? [] };
					return { content: [{ type: "text", text: JSON.stringify(contract, null, 2) }], details: { contract } };
				}
				const epoch = this.epoch;
				const version = this.visibilityVersions.get(tool) ?? 0;
				const outcome = await ctx.executeTool(tool, input, { signal, onUpdate });
				// durationMs 只在目标 execute 实际运行后存在；校验失败和权限拦截不加载工具。
				if (outcome.durationMs !== undefined && !this.closed && this.epoch === epoch &&
					(this.visibilityVersions.get(tool) ?? 0) === version &&
					this.pi.getAllTools().some((entry) => entry.name === tool && entry.exposure !== "hidden")) {
					this.pi.setActiveTools([...new Set([...this.pi.getActiveTools(), tool])]);
				}
				const result = { ...outcome.result, isError: outcome.isError };
				// 嵌套调用的用量由 SDK 汇总，转交结果时不再次计入。
				delete result.usage;
				return result;
			},
		});
		this.registered = true;
	}

	start(): void {
		this.register();
		const tools = this.pi.getAllTools();
		if (!tools.find((tool) => tool.name === "tool_find")?.promptGuidelines?.includes(SEARCH_GUIDELINE)) {
			throw new Error("tool_find 被其他扩展占用；需要使用本插件的工具发现入口。");
		}
		for (const name of DISCOVERY_TOOL_NAMES) {
			if (!tools.some((tool) => tool.name === name && tool.exposure !== "hidden")) throw new Error(`工具发现入口不可用：${name}`);
		}
		this.closed = false;
		this.epoch++;
		this.pi.setActiveTools([...new Set([...this.pi.getActiveTools().filter((name) => name !== "tool_search"), ...DISCOVERY_TOOL_NAMES])]);
		if (DISCOVERY_TOOL_NAMES.some((name) => !this.pi.getActiveTools().includes(name))) throw new Error("无法激活工具发现入口。");
	}

	suppressPromotion(names: Iterable<string>): void {
		for (const name of names) this.visibilityVersions.set(name, (this.visibilityVersions.get(name) ?? 0) + 1);
	}

	close(): void {
		this.closed = true;
		this.epoch++;
		this.visibilityVersions.clear();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("工具发现入口已关闭");
	}

	private search(query: string, limit: number): ToolInfo[] {
		const candidates = this.pi.getAllTools().filter((tool) => tool.exposure === "deferred" || tool.exposure === "codemode");
		const index = new MiniSearch({ idField: "name", fields: ["name", "description", "namespace"], tokenize });
		index.addAll(candidates.map((tool) => ({ name: tool.name, description: tool.description,
			namespace: [tool.namespace?.name, tool.namespace?.description, tool.namespace?.instructions].filter(Boolean).join(" ") })));
		const exact = candidates.find((tool) => tool.name.toLowerCase() === query.trim().toLowerCase());
		const ranked = index.search(query).map((match) => match.id as string);
		const names = [...new Set([...(exact ? [exact.name] : []), ...ranked])].slice(0, limit);
		const byName = new Map(candidates.map((tool) => [tool.name, tool]));
		return names.map((name) => byName.get(name)!);
	}
}
