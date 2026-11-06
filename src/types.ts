import type { ToolAnnotations, ToolExposure } from "@earendil-works/pi-coding-agent";

export type ToolKind = "direct" | "agent";
export type AgentSource = "user" | "project" | "created-project" | "embedded";
export type JobState =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "lost";

export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	description?: string;
	[k: string]: unknown;
}

export interface ServiceDefinition {
	type: "script" | "daemon";
	command?: string;
	args?: string[];
	cwd?: string;
	protocol?: "json-stdin-stdout" | "jsonl-stdio" | "unix-jsonl" | "http-json";
	/** Unix socket path for unix-jsonl services. */
	socket?: string;
	/** Base URL for http-json services. */
	url?: string;
	/** HTTP method for http-json services. Defaults to POST. */
	method?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	lifecycle?: "session" | "persistent";
	start?: "lazy" | "eager";
	healthCheck?: {
		method: string;
		intervalMs?: number;
	};
	env?: Record<string, string>;
}

export interface AgentConfig {
	instructions?: string;
	workflow?: string;
	examples?: string;
	tools?: string[];
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	maxTurns?: number;
	sessionScope?: "user" | "project";
	memoryScope?: "user" | "project";
	resolution?: "user-first";
	createProjectIfMissing?: boolean;
	requireProjectTrust?: boolean;
	contractRange?: string;
	defaultTemplate?: string;
}

export interface ExecutionConfig {
	defaultMode?: ToolMode;
	notifyOnIdle?: boolean;
	/** When true, the facade returns a job handle for agent tools by default. */
	asyncByDefault?: boolean;
}

export type ToolMode = "sync" | "start" | "status" | "wait" | "result" | "cancel";

export interface ToolManifest {
	name: string;
	version: string;
	contractVersion?: string;
	description: string;
	whenToUse?: string[];
	notFor?: string[];
	kind: ToolKind;
	/** Service used by a direct tool when it declares multiple services. */
	directService?: string;
	input: JsonSchema;
	output: JsonSchema;
	agent?: AgentConfig;
	services?: Record<string, ServiceDefinition>;
	permissions?: {
		read?: boolean;
		write?: boolean;
		bash?: boolean;
		network?: boolean;
	};
	limits?: {
		maxInputBytes?: number;
		maxResultBytes?: number;
		jobTimeoutMs?: number;
		jobIdleTimeoutMs?: number;
	};
	execution?: ExecutionConfig;
	exposure?: ToolExposure;
	/** In-process handler for a package tool that must run inside the runtime. */
	handler?: "tool_add" | "service_keeper";
	annotations?: ToolAnnotations;
	namespace?: string;
	/** Discovery level of the tool. Set by the loader. */
	scope?: "user" | "project" | "package";
	/** Absolute directory containing the manifest. Set by the loader. */
	dir?: string;
}

export interface ResolvedAgent {
	name: string;
	tool: string;
	version: string;
	contract: string;
	source: AgentSource;
	path?: string;
	instructions: string;
	workflow: string;
	examples?: string;
	tools: string[];
	thinkingLevel?: AgentConfig["thinkingLevel"];
	maxTurns: number;
	overrides: boolean;
}

export interface ToolEnvelope {
	status: "ok" | "failed" | "needs_input" | "accepted" | "cancelled";
	summary: string;
	result?: unknown;
	artifacts?: Array<{ path: string; kind: string; description?: string }>;
	warnings?: string[];
	jobId?: string;
	usage?: Record<string, unknown>;
}

export interface JobRecord {
	id: string;
	tool: string;
	toolVersion: string;
	agentId: string;
	agentSource: AgentSource;
	cwd: string;
	input: Record<string, unknown>;
	mode: ToolMode;
	state: JobState;
	createdAt: string;
	/** Resolved worker model as "provider/id", taken from the pi settings default. */
	model?: string;
	toolDir?: string;
	projectTrusted?: boolean;
	pid?: number;
	startedAt?: string;
	finishedAt?: string;
	heartbeatAt?: string;
	progress?: number;
	message?: string;
	result?: ToolEnvelope;
	error?: string;
	artifacts?: Array<{ path: string; kind: string; description?: string }>;
	requester?: {
		sessionId?: string;
		idle?: boolean;
	};
	usage?: Record<string, unknown>;
}

export interface ToolAddInput {
	request: string;
}

export interface ToolAddManageInput {
	action: "list" | "inspect" | "validate" | "add" | "convert_skill" | "create_tool" | "disable" | "enable";
	name?: string;
	requirements?: string;
	scope?: "project" | "user";
	sourcePath?: string;
	manifest?: unknown;
	/** Full tool plan produced by the tool_add worker. */
	plan?: unknown;
}

export interface JobToolInput {
	action: "list" | "status" | "wait" | "result" | "cancel" | "logs";
	jobId?: string;
	timeoutMs?: number;
}
