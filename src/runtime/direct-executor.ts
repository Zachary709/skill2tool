import { validateEnvelope } from "../contracts/schema.ts";
import type { ServiceSupervisor } from "../services/supervisor.ts";
import type { ToolEnvelope, ToolManifest } from "../types.ts";

export async function executeDirectTool(
	manifest: ToolManifest,
	input: Record<string, unknown>,
	supervisor: ServiceSupervisor,
): Promise<ToolEnvelope> {
	const serviceNames = Object.keys(manifest.services ?? {});
	if (serviceNames.length === 0) {
		return { status: "failed", summary: "Direct tool has no services configured." };
	}

	const requested = typeof input.service === "string" ? input.service : undefined;
	const serviceName = requested ?? manifest.directService ?? serviceNames[0];
	const params = { ...input };
	delete params.service;

	const serviceResult = await supervisor.call(manifest, serviceName, params);
	if (!serviceResult.ok) {
		return {
			status: "failed",
			summary: `Service "${serviceName}" failed: ${serviceResult.error ?? "unknown error"}`,
		};
	}

	const raw = serviceResult.result;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const candidate = raw as Record<string, unknown>;
		if (typeof candidate.status === "string" && typeof candidate.summary === "string") {
			const envelope = candidate as unknown as ToolEnvelope;
			const errors = validateEnvelope(manifest.output, envelope);
			if (errors.length > 0) {
				return {
					status: "failed",
					summary: `Service "${serviceName}" returned an invalid envelope.`,
					warnings: errors,
				};
			}
			return envelope;
		}
		if (typeof candidate.summary === "string" && candidate.result !== undefined) {
			const envelope: ToolEnvelope = {
				status: "ok",
				summary: candidate.summary,
				result: candidate.result,
			};
			const errors = validateEnvelope(manifest.output, envelope);
			if (errors.length > 0) {
				return {
					status: "failed",
					summary: `Service "${serviceName}" returned an invalid result.`,
					warnings: errors,
				};
			}
			return envelope;
		}
	}

	const envelope: ToolEnvelope = {
		status: "ok",
		summary: `Service "${serviceName}" completed.`,
		result: raw,
	};
	const errors = validateEnvelope(manifest.output, envelope);
	if (errors.length > 0) {
		return {
			status: "failed",
			summary: `Service "${serviceName}" returned a result that does not match the output schema.`,
			warnings: errors,
		};
	}
	return envelope;
}
