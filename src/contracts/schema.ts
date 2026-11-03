import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { JsonSchema, ToolEnvelope, ToolManifest } from "../types.ts";

export const ENVELOPE_STATUSES = ["ok", "failed", "needs_input", "accepted", "cancelled"] as const;

export function envelopeSchema(output: JsonSchema): TSchema {
	return Type.Object({
		status: Type.Union(ENVELOPE_STATUSES.map((status) => Type.Literal(status))),
		summary: Type.String(),
		result: Type.Optional(Type.Unsafe(output)),
		artifacts: Type.Optional(
			Type.Array(
				Type.Object({
					path: Type.String(),
					kind: Type.String(),
					description: Type.Optional(Type.String()),
				}),
			),
		),
		warnings: Type.Optional(Type.Array(Type.String())),
		jobId: Type.Optional(Type.String()),
		usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	});
}

export type EnvelopeValue = Static<ReturnType<typeof envelopeSchema>>;

export function compileSchema(schema: JsonSchema) {
	return Compile(Type.Unsafe(schema));
}

export function validateValue(schema: JsonSchema, value: unknown): string[] {
	const compiled = compileSchema(schema);
	if (compiled.Check(value)) return [];
	const errors = [...compiled.Errors(value)].slice(0, 12);
	return errors.map((error) => {
		const item = error as { path?: string; instancePath?: string };
		return `${item.instancePath || item.path || "/"}: ${error.message}`;
	});
}

export const RESULT_LIMITS = {
	/** Maximum characters in the caller-facing summary. */
	maxSummaryChars: 300,
	/** Maximum characters in a result string field without an explicit maxLength. */
	maxStringChars: 4000,
	/** Maximum newline count in a short string field. */
	maxNewlines: 8,
} as const;

export function validateSummary(summary: unknown): string[] {
	if (typeof summary !== "string") return ["summary: must be a string"];
	const errors: string[] = [];
	const text = summary.trim();
	if (!text) errors.push("summary: must not be empty");
	if (text.length > RESULT_LIMITS.maxSummaryChars) {
		errors.push(
			`summary: ${text.length} characters exceeds ${RESULT_LIMITS.maxSummaryChars}; state the outcome in one or two sentences`,
		);
	}
	if ((text.match(/\n/g) ?? []).length > 2) {
		errors.push("summary: keep it to a single short paragraph, not a list of steps");
	}
	return errors;
}

function walkResultSchema(
	schema: JsonSchema,
	value: unknown,
	path: string,
	errors: string[],
): void {
	if (value === undefined || value === null) return;
	if (typeof value === "string") {
		const limit = typeof schema.maxLength === "number" ? schema.maxLength : RESULT_LIMITS.maxStringChars;
		if (value.length > limit) {
			errors.push(
				`${path}: ${value.length} characters exceeds ${limit}; return the conclusion and the fields the caller needs, not the process`,
			);
			return;
		}
		if ((value.match(/\n/g) ?? []).length > RESULT_LIMITS.maxNewlines) {
			errors.push(`${path}: contains a multi-line log; summarize it into the declared fields`);
		}
		return;
	}
	if (Array.isArray(value)) {
		const itemSchema = schema.items ?? {};
		const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : 50;
		if (value.length > maxItems) {
			errors.push(`${path}: ${value.length} items exceeds ${maxItems}`);
		}
		value.forEach((item, index) => walkResultSchema(itemSchema, item, `${path}[${index}]`, errors));
		return;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const properties = schema.properties;
		if (properties) {
			const extras = Object.keys(record).filter((key) => !(key in properties));
			if (schema.additionalProperties === false || schema.additionalProperties === undefined) {
				for (const key of extras) {
					errors.push(`${path}.${key}: not declared by the tool output contract; remove it`);
				}
			} else if (schema.additionalProperties === true) {
				// Open objects still go through the value-size and log limits.
				for (const key of extras) {
					walkResultSchema({}, record[key], `${path}.${key}`, errors);
				}
			} else if (typeof schema.additionalProperties === "object") {
				for (const key of extras) {
					walkResultSchema(schema.additionalProperties as JsonSchema, record[key], `${path}.${key}`, errors);
				}
			}
			for (const [key, sub] of Object.entries(properties)) {
				walkResultSchema(sub, record[key], `${path}.${key}`, errors);
			}
			return;
		}
		// An object without declared properties is an untyped bag: its keys are not
		// checked, but every value still goes through the size and log limits.
		for (const [key, sub] of Object.entries(record)) {
			walkResultSchema({}, sub, `${path}.${key}`, errors);
		}
	}
}

/**
 * Enforce the declared result contract beyond JSON Schema types: unknown keys,
 * oversized strings, and log-like values are rejected so the caller receives
 * conclusions instead of the worker's process.
 */
export function validateResultShape(schema: JsonSchema, value: unknown): string[] {
	const errors: string[] = [];
	if (!schema || typeof schema !== "object") return errors;
	if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
		walkResultSchema(schema, value, "result", errors);
	}
	return errors.slice(0, 12);
}

export function validateEnvelope(output: JsonSchema, value: unknown): string[] {
	const base = validateValue(
		{
			type: "object",
			required: ["status", "summary"],
			properties: {
				status: { type: "string", enum: [...ENVELOPE_STATUSES] },
				summary: { type: "string" },
				artifacts: {
					type: "array",
					items: {
						type: "object",
						required: ["path", "kind"],
						properties: {
							path: { type: "string" },
							kind: { type: "string" },
							description: { type: "string" },
						},
					},
				},
				warnings: { type: "array", items: { type: "string" } },
				jobId: { type: "string" },
				usage: { type: "object" },
			},
		},
		value,
	);
	if (base.length > 0) return base;

	const envelope = value as ToolEnvelope;
	if (envelope.result !== undefined) {
		return validateValue(output, envelope.result).map((error) => `result${error}`);
	}
	return [];
}

export function validateManifest(raw: unknown, dir?: string): {
	manifest?: ToolManifest;
	errors: string[];
	warnings: string[];
} {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { errors: ["TOOL.json must be a JSON object"], warnings };
	}

	const manifest = raw as ToolManifest;

	if (typeof manifest.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(manifest.name)) {
		errors.push("name must match ^[a-z][a-z0-9_]*$");
	}
	if (manifest.name?.length > 64) {
		errors.push("name must be at most 64 characters");
	}
	if (typeof manifest.description !== "string" || manifest.description.trim().length < 12) {
		errors.push("description must explain what the tool does and when to use it");
	}
	if (typeof manifest.version !== "string" || !manifest.version.trim()) {
		errors.push("version is required");
	}
	if (manifest.kind !== "direct" && manifest.kind !== "agent") {
		errors.push('kind must be "direct" or "agent"');
	}
	if (!manifest.input || typeof manifest.input !== "object") {
		errors.push("input must be a JSON Schema object");
	}
	if (!manifest.output || typeof manifest.output !== "object") {
		errors.push("output must be a JSON Schema object");
	}

	if (manifest.input) {
		try {
			compileSchema(manifest.input);
		} catch (error) {
			errors.push(`input schema is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (manifest.output) {
		try {
			compileSchema(manifest.output);
		} catch (error) {
			errors.push(`output schema is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (manifest.kind === "agent") {
		if (!manifest.agent) {
			errors.push('agent config is required when kind is "agent"');
		} else {
			if (!manifest.agent.instructions) errors.push("agent.instructions is required");
			if (!manifest.agent.workflow) errors.push("agent.workflow is required");
			if (!manifest.agent.tools || manifest.agent.tools.length === 0) {
				errors.push("agent.tools must list the tools available to the worker");
			}
			const scopeFields = manifest.agent as unknown as Record<string, unknown>;
			for (const field of ["sessionScope", "memoryScope"] as const) {
				const value = scopeFields[field];
				if (value === "global") {
					scopeFields[field] = "user";
					warnings.push(`agent.${field} "global" is deprecated; it now reads as "user"`);
				} else if (value !== undefined && value !== "user" && value !== "project") {
					errors.push(`agent.${field} must be "user" or "project"`);
				}
			}
		}
	}

	if (manifest.output && typeof manifest.output === "object") {
		const output = manifest.output;
		if (output.type === "object") {
			if (!Array.isArray(output.required) || output.required.length === 0) {
				warnings.push("output should list required fields so the caller always receives the same shape");
			}
			if (output.additionalProperties !== false) {
				warnings.push('output should set "additionalProperties": false to keep the result free of extra fields');
			}
			for (const [key, property] of Object.entries(output.properties ?? {})) {
				const shape = property as JsonSchema;
				// An explicit `additionalProperties: true` is an open object the author
				// intends to fill at runtime; only an object with no declared shape at
				// all is treated as an accidental bag.
				if (shape.type === "object" && !shape.properties && shape.additionalProperties !== true) {
					warnings.push(
						`output.${key} is an untyped object bag; declare explicit typed fields instead`,
					);
				}
			}
		}
	}

	if (manifest.input && typeof manifest.input === "object") {
		const input = manifest.input;
		if (input.type === "object" && input.additionalProperties !== false) {
			warnings.push('input should set "additionalProperties": false so every input is intentional');
		}
	}

	if (manifest.services) {
		for (const [name, service] of Object.entries(manifest.services)) {
			if (!service || typeof service !== "object") {
				errors.push(`services.${name} must be an object`);
				continue;
			}
			if (service.type !== "script" && service.type !== "daemon") {
				errors.push(`services.${name}.type must be "script" or "daemon"`);
			}
			if (!service.command) {
				errors.push(`services.${name}.command is required`);
			}
			if (service.type === "daemon") {
				// Daemons serve jobs over time, so they start with the runtime and
				// keep running instead of being started per call.
				if (service.lifecycle === undefined) service.lifecycle = "persistent";
				if (service.start === undefined) service.start = "eager";
				if (service.lifecycle !== "persistent") {
					warnings.push(
						`services.${name}.lifecycle is "${service.lifecycle}"; daemons run continuously, so "persistent" is expected`,
					);
				}
			}
		}
	}

	if (
		manifest.handler !== undefined &&
		manifest.handler !== "tool_add" &&
		manifest.handler !== "service_keeper"
	) {
		errors.push(`handler "${String(manifest.handler)}" is not a runtime handler`);
	}

	if (manifest.kind === "direct" && !manifest.services && !manifest.handler) {
		errors.push('direct tools must declare at least one service or use a runtime handler');
	}

	if (!manifest.whenToUse || manifest.whenToUse.length === 0) {
		warnings.push("whenToUse is empty; the main agent has only the description to choose this tool");
	}

	const normalized: ToolManifest = {
		...manifest,
		contractVersion: manifest.contractVersion ?? manifest.version,
		whenToUse: manifest.whenToUse ?? [],
		notFor: manifest.notFor ?? [],
		permissions: {
			read: manifest.permissions?.read ?? true,
			write: manifest.permissions?.write ?? false,
			bash: manifest.permissions?.bash ?? false,
			network: manifest.permissions?.network ?? false,
		},
		limits: {
			maxInputBytes: manifest.limits?.maxInputBytes ?? 1_048_576,
			maxResultBytes: manifest.limits?.maxResultBytes ?? 20_000,
			jobTimeoutMs: manifest.limits?.jobTimeoutMs ?? 600_000,
			jobIdleTimeoutMs: manifest.limits?.jobIdleTimeoutMs ?? 0,
		},
		execution: {
			defaultMode: manifest.execution?.defaultMode ?? (manifest.kind === "agent" ? "start" : "sync"),
			notifyOnIdle: manifest.execution?.notifyOnIdle ?? true,
			asyncByDefault: manifest.execution?.asyncByDefault ?? manifest.kind === "agent",
		},
		exposure: manifest.exposure ?? "direct",
		namespace: manifest.namespace ?? "tool",
		dir,
	};

	return { manifest: normalized, errors, warnings };
}
