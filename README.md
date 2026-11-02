# pi-tool-runtime

Pi extension package for agent-backed and deterministic tools.

The main Pi agent sees only a tool facade: name, description, input schema, and a normalized output envelope. Agent-backed tools execute in a persistent worker session. Deterministic tools call scripts or daemons. Worker transcripts, memory, and service logs stay outside the main agent context.

## Install

```bash
pi install ./pi-tool-runtime
```

For one invocation:

```bash
pi --no-skills -e ./pi-tool-runtime
```

`--no-skills` keeps Pi's native skill list out of the main system prompt. This package scans tool manifests itself.

## Tool package layout

```text
tools/repair-shop/
├── TOOL.json
├── AGENT.md
├── WORKFLOW.md
├── EXAMPLES.md
├── scripts/
├── services/
└── references/
```

Tools are discovered from:

- `~/.pi/agent/tools/`
- `<project>/.pi/tools/`

Project tools load only when the project is trusted.

## TOOL.json

```json
{
  "name": "repair_shop",
  "version": "1.0.0",
  "contractVersion": "1.0.0",
  "description": "Diagnose and repair vehicle issues. Use when the user needs inspection or repair planning.",
  "whenToUse": ["需要检查车辆故障", "需要制定维修步骤"],
  "notFor": ["只是查询保养周期"],
  "kind": "agent",
  "input": {
    "type": "object",
    "properties": {
      "task": { "type": "string" },
      "input": { "type": "object" },
      "context": { "type": "string" }
    },
    "required": ["task"]
  },
  "output": {
    "type": "object",
    "properties": {
      "summary": { "type": "string" },
      "result": { "type": "object" }
    },
    "required": ["summary"]
  },
  "agent": {
    "instructions": "AGENT.md",
    "workflow": "WORKFLOW.md",
    "tools": ["read", "grep", "find", "ls"],
    "maxTurns": 30,
    "sessionScope": "project",
    "memoryScope": "project",
    "resolution": "user-first",
    "createProjectIfMissing": true,
    "requireProjectTrust": true,
    "contractRange": "^1.0.0"
  },
  "permissions": {
    "read": true,
    "write": false,
    "bash": false,
    "network": false
  },
  "limits": {
    "maxInputBytes": 1048576,
    "maxResultBytes": 20000,
    "jobTimeoutMs": 600000
  },
  "execution": {
    "defaultMode": "start",
    "notifyOnIdle": true
  }
}
```

`kind` is either `direct` or `agent`.

- `direct` runs a declared service synchronously.
- `agent` creates a persistent worker and can call declared services through `service_call`.

## Services

Script service:

```json
{
  "type": "script",
  "command": "node",
  "args": ["scripts/count.mjs"],
  "protocol": "json-stdin-stdout",
  "timeoutMs": 10000
}
```

Daemon service:

```json
{
  "type": "daemon",
  "command": "node",
  "args": ["services/server.mjs"],
  "protocol": "jsonl-stdio",
  "lifecycle": "persistent",
  "start": "eager",
  "healthCheck": { "method": "ping", "intervalMs": 5000 }
}
```

Daemon protocols:

- `jsonl-stdio`: newline-delimited JSON over stdin/stdout.
- `unix-jsonl`: newline-delimited JSON over a Unix socket. Set `socket`.
- `http-json`: JSON over HTTP. Set `url`, optional `method` and `headers`.

Request and response shape:

```json
{"id":"1","method":"ping","params":{}}
{"id":"1","status":"ok","result":{"ok":true}}
```

For `http-json`, the request body is `{"method":"ping","params":{}}` and the response body is `{"status":"ok","result":{...}}`.

## Jobs

Agent tools support asynchronous jobs.

```json
{ "task": "...", "mode": "start" }
```

returns:

```json
{
  "status": "accepted",
  "summary": "Job job_... accepted.",
  "jobId": "job_..."
}
```

Use the `job` tool later:

```json
{ "action": "wait", "jobId": "job_...", "timeoutMs": 600000 }
```

Actions: `list`, `status`, `wait`, `result`, `cancel`, `logs`.

Jobs run in detached worker processes. The job store survives a Pi restart. On restart, queued jobs are re-enqueued; running jobs with a dead worker are marked `lost`.

When a started job finishes and the requesting agent is idle, the runtime sends a short completion message. The full result stays in the job store.

Job files live in `<project>/.pi/jobs/<jobId>/`:

```text
job.json
result.json
events.jsonl
```

## Worker agents

Resolution order:

1. User agent: `~/.pi/agent/agents/<tool>.md`
2. Project agent: `<project>/.pi/agents/<tool>.md`
3. Create a project agent from the tool's `AGENT.md` and `WORKFLOW.md`, if the project is trusted

Project agents are skipped when the project is not trusted. Project agents may declare `override: true` to take precedence over user agents.

Agent file:

```markdown
---
name: repair-shop
tool: repair_shop
version: 1.0.0
contract: "^1.0.0"
tools: ["read", "grep", "find", "ls"]
workflow: repair-shop.workflow.md
override: false
---

You are the repair worker...
```

The worker system prompt includes the tool contract, `AGENT.md`, and `WORKFLOW.md`. The facade tool is removed from the worker tool list to prevent recursion.

## Worker context

Workers use Pi's automatic compaction. Compaction is threshold-based, not per job.

```text
reserveTokens: 20000
keepRecentTokens: 30000
```

On compaction, the summary is written to the worker memory file. Each job also appends a short record to `journal.jsonl`. The fixed system prompt is never rewritten by compaction.

Worker files live under:

```text
~/.pi/agent/tool-workers/<worker-key>/
├── memory.md
└── journal.jsonl
```

## tool_add

`tool_add` is both a Pi tool and a management entry point.

Actions:

- `list`
- `inspect`
- `validate`
- `add`
- `convert_skill`
- `disable`
- `enable`

Convert a skill:

```json
{
  "action": "convert_skill",
  "source": { "type": "skill", "path": "/path/to/SKILL.md" },
  "scope": "project",
  "activate": true
}
```

Conversion uses a user-level converter agent:

```text
~/.pi/agent/agents/skill_converter.md
~/.pi/agent/agents/skill_converter.workflow.md
```

The runtime installs these from `agents/skill-converter/` on the first conversion. The converter agent reads the skill and its supporting files, then returns a complete plan through `submit_result`. The runtime validates the plan, writes `TOOL.json`, `AGENT.md`, `WORKFLOW.md`, and optional `EXAMPLES.md`, then registers the tool.

If the converter agent is unavailable or returns an invalid plan, conversion falls back to the deterministic generator.

The converted tool uses the permissions proposed by the converter. The converter defaults to read-only; edit `TOOL.json` to allow `bash`, `edit`, or `write`.

`add` accepts `instructions`, `workflow`, and `examples` strings. If an agent tool's files are missing, `tool_add` writes safe defaults. A source path may point to a directory containing `TOOL.json`; the whole directory is copied.

## Examples

```bash
mkdir -p .pi/tools
cp -R examples/tools/word-count .pi/tools/
cp -R examples/tools/demo-agent .pi/tools/
pi --no-skills -e .
```

Ask the main agent to use `word_count`, or to start a `demo_agent` job and then use the `job` tool.

## Security

- Project tools and project agents require project trust.
- Agent tools default to read-only permissions.
- Worker tools cannot exceed the permissions declared in `TOOL.json`.
- `tool_add` refuses to write project tools in an untrusted project.
- Daemons are started by the package and receive only declared environment variables plus the inherited environment.
- Results are validated before they reach the main agent.
- Large results are truncated; full results belong in artifacts or job files.

## Development

```bash
npm install
npm run typecheck
npm test
```

The extension entry point is `extensions/tool-runtime.ts`.
