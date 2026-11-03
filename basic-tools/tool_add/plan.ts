import type { JsonSchema, ServiceDefinition } from "../../src/types.ts";

export interface ToolPlan {
	name: string;
	description: string;
	whenToUse: string[];
	notFor?: string[];
	input: JsonSchema;
	output: JsonSchema;
	agent: {
		instructions: string;
		workflow: string;
		examples?: string;
		tools?: string[];
		maxTurns?: number;
	};
	services?: Record<string, ServiceDefinition>;
	permissions?: {
		read?: boolean;
		write?: boolean;
		bash?: boolean;
		network?: boolean;
	};
	notes?: string[];
}

export const TOOL_PLAN_SCHEMA: JsonSchema = {
	type: "object",
	required: ["name", "description", "whenToUse", "input", "output", "agent"],
	properties: {
		name: { type: "string", description: "Tool name in lowercase underscores." },
		description: { type: "string", description: "What the tool does and when to use it." },
		whenToUse: {
			type: "array",
			items: { type: "string" },
			description: "One line per situation in which the main agent should choose this tool.",
		},
		notFor: { type: "array", items: { type: "string" } },
		input: { type: "object", description: "JSON Schema for tool input." },
		output: { type: "object", description: "JSON Schema for the business result." },
		agent: {
			type: "object",
			required: ["instructions", "workflow"],
			properties: {
				instructions: { type: "string" },
				workflow: { type: "string" },
				examples: { type: "string" },
				tools: { type: "array", items: { type: "string" } },
				maxTurns: { type: "number" },
			},
		},
		services: { type: "object" },
		permissions: {
			type: "object",
			properties: {
				read: { type: "boolean" },
				write: { type: "boolean" },
				bash: { type: "boolean" },
				network: { type: "boolean" },
			},
		},
		notes: { type: "array", items: { type: "string" } },
	},
};

const CATCH_ALL_NAMES = new Set(["result", "details", "notes", "output", "data", "payload", "content"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkObjectSchema(schema: JsonSchema, side: "input" | "output", errors: string[]): void {
	if (!isRecord(schema) || schema.type !== "object") {
		errors.push(`${side}: must be a JSON Schema object`);
		return;
	}
	const properties = schema.properties;
	if (!isRecord(properties) || Object.keys(properties).length === 0) {
		errors.push(`${side}: must declare typed properties`);
		return;
	}
	if (schema.additionalProperties !== false) {
		errors.push(`${side}: must set "additionalProperties": false so the contract is closed`);
	}
	const required = schema.required;
	if (!Array.isArray(required) || required.length === 0) {
		errors.push(`${side}: must list the always-present fields in "required"`);
	} else {
		for (const field of required) {
			if (typeof field !== "string" || !(field in properties)) {
				errors.push(`${side}.required: "${String(field)}" is not a declared property`);
			}
		}
	}
	for (const [key, property] of Object.entries(properties)) {
		if (!isRecord(property)) {
			errors.push(`${side}.${key}: must be a typed schema`);
			continue;
		}
		const shape = property as JsonSchema;
		if (!shape.type) {
			errors.push(`${side}.${key}: must declare a type`);
		}
		if (!shape.description || String(shape.description).trim().length < 4) {
			errors.push(`${side}.${key}: needs a description so the field is unambiguous`);
		}
		if (side === "output") {
			if (shape.type === "object" && !isRecord(shape.properties)) {
				errors.push(`${side}.${key}: untyped object bags are rejected; declare typed fields`);
			}
			if (CATCH_ALL_NAMES.has(key) && shape.type === "object") {
				errors.push(`${side}.${key}: catch-all result objects are rejected; declare the fields the caller needs`);
			}
			if (shape.type === "string" && typeof shape.maxLength !== "number") {
				errors.push(`${side}.${key}: add "maxLength" so long text cannot flood the caller`);
			}
			if (shape.type === "array" && typeof shape.maxItems !== "number") {
				errors.push(`${side}.${key}: add "maxItems" so long lists cannot flood the caller`);
			}
			if (shape.type === "array" && isRecord(shape.items)) {
				const items = shape.items as JsonSchema;
				if (!items.type) errors.push(`${side}.${key}.items: must declare a type`);
			}
		}
	}
}

function checkServices(services: Record<string, ServiceDefinition>, errors: string[], warnings: string[]): void {
	for (const [name, service] of Object.entries(services)) {
		if (!/^[a-z][a-z0-9_]*$/.test(name)) errors.push(`services.${name}: name must match ^[a-z][a-z0-9_]*$`);
		if (!isRecord(service)) {
			errors.push(`services.${name}: must be an object`);
			continue;
		}
		if (service.type !== "script" && service.type !== "daemon") {
			errors.push(`services.${name}.type: must be "script" or "daemon"`);
			continue;
		}
		if (!service.command || !String(service.command).trim()) {
			errors.push(`services.${name}.command: required`);
		}
		if (service.args !== undefined && !Array.isArray(service.args)) {
			errors.push(`services.${name}.args: must be an array of strings`);
		}
		if (service.type === "script") {
			if (service.protocol && service.protocol !== "json-stdin-stdout") {
				errors.push(`services.${name}.protocol: scripts must use "json-stdin-stdout"`);
			}
		} else {
			const protocols = ["jsonl-stdio", "unix-jsonl", "http-json"];
			if (!service.protocol || !protocols.includes(service.protocol)) {
				errors.push(`services.${name}.protocol: daemons must use ${protocols.join(", ")}`);
			}
			if (service.lifecycle !== "persistent") {
				errors.push(`services.${name}.lifecycle: daemons run continuously, so it must be "persistent"`);
			}
			if (service.start !== "eager") {
				errors.push(`services.${name}.start: daemons run continuously, so it must be "eager"`);
			}
			if (!service.healthCheck) {
				warnings.push(`services.${name}: add a healthCheck so the daemon is verified after start`);
			}
		}
	}
}

/**
 * Enforce the minimum shape of a generated tool: a selection description, a
 * closed input contract, a closed and typed result contract, a worker system
 * prompt, an execution workflow, and continuous services.
 */
export function validateToolPlan(plan: ToolPlan): string[] {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!/^[a-z][a-z0-9_]*$/.test(plan.name ?? "")) {
		errors.push("name: must match ^[a-z][a-z0-9_]*$ and be at most 64 characters");
	}
	if (!plan.name || plan.name.length > 64) errors.push("name: must be at most 64 characters");
	if (!plan.description || plan.description.trim().length < 20) {
		errors.push("description: must explain what the tool does and when the main agent should choose it");
	}
	if (!Array.isArray(plan.whenToUse) || plan.whenToUse.length === 0) {
		errors.push("whenToUse: must list at least one situation for the main agent to choose this tool");
	} else {
		for (const [index, item] of plan.whenToUse.entries()) {
			if (typeof item !== "string" || item.trim().length < 4) {
				errors.push(`whenToUse[${index}]: must be a short, specific situation`);
			}
		}
	}
	checkObjectSchema(plan.input, "input", errors);
	checkObjectSchema(plan.output, "output", errors);

	if (!plan.agent || !isRecord(plan.agent)) {
		errors.push("agent: required with instructions and workflow");
	} else {
		if (typeof plan.agent.instructions !== "string" || plan.agent.instructions.trim().length < 80) {
			errors.push("agent.instructions: must be a complete worker system prompt, at least 80 characters");
		}
		if (typeof plan.agent.workflow !== "string" || plan.agent.workflow.trim().length < 80) {
			errors.push("agent.workflow: must give the worker concrete ordered steps");
		} else if (!plan.agent.workflow.includes("submit_result")) {
			errors.push("agent.workflow: must end with a submit_result call");
		}
		if (!Array.isArray(plan.agent.tools) || plan.agent.tools.length === 0) {
			errors.push("agent.tools: must list the worker tools");
		} else {
			const allowed = new Set(["read", "grep", "find", "ls", "edit", "write", "bash"]);
			for (const name of plan.agent.tools) {
				if (!allowed.has(name)) errors.push(`agent.tools: "${name}" is not a runtime worker tool`);
			}
		}
	}

	if (plan.services && Object.keys(plan.services).length > 0) {
		checkServices(plan.services, errors, warnings);
	}

	if (plan.permissions?.network && !plan.services) {
		warnings.push("permissions.network is set but the tool declares no service");
	}

	return [...errors, ...warnings.map((warning) => `warning: ${warning}`)];
}

export function planErrors(plan: ToolPlan): string[] {
	return validateToolPlan(plan).filter((entry) => !entry.startsWith("warning: "));
}
