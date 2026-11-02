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
	return errors.map((error) => `${(error as { path?: string }).path || "/"}: ${error.message}`);
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
			if (service.type === "daemon" && service.lifecycle === undefined) {
				warnings.push(`services.${name} is a daemon without lifecycle; defaulting to session`);
			}
		}
	}

	if (manifest.kind === "direct" && !manifest.services) {
		errors.push('direct tools must declare at least one service or be implemented by an extension');
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
