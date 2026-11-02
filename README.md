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
- `unix-jsonl`: newline-delimited JSON over a Unix socket. Set `socket`; it defaults to `<state dir>/service.sock`.
- `http-json`: JSON over HTTP. Set `url`, optional `method` and `headers`.

### Service levels

Every service declares `level`, which is `user` or `project`. When it is
omitted, it follows the tool's discovery scope: a user tool gets user services
and a project tool gets project services. A service can override that per
entry.

| | `user` | `project` |
| --- | --- | --- |
| default cwd | tool directory | project directory |
| state directory | `~/.pi/agent/services/<tool>/<service>` | `<project>/.pi/services/<tool>/<service>` |
| daemon key | `user:<tool>:<service>` | `project:<project>:<tool>:<service>` |
| reuse | a reachable Unix socket or HTTP endpoint is attached instead of spawned | always spawned for the current project |

Each spawn writes `state.json` with the level, process id, cwd, and start time
under the state directory. The same directory receives `PI_SERVICE_STATE_DIR`,
and the child environment carries `PI_TOOL_NAME`, `PI_SERVICE_NAME`, and
`PI_SERVICE_LEVEL`.

```json
{
  "type": "daemon",
  "command": "node",
  "args": ["services/server.mjs"],
  "protocol": "unix-jsonl",
  "level": "user"
}
```

A worker uses the default model from pi settings (`defaultProvider` and
`defaultModel`) and nothing else. Tool manifests and agent files no longer
select a model. The job record keeps the resolved model as `provider/id`, so
every job states which model its worker used. When settings set no default, the
runtime default applies.

Workers use the same two level names. `agent.sessionScope` is `project` by
default and fixes the worker key to the project directory, so every project gets
its own session. With `user`, the key drops the project path: one worker session
is shared by every project, and its working directory is the tool directory.
`agent.memoryScope` is `project` by default and keeps memory at
`tool-workers/<key>/memory.md`; with `user`, memory is shared at
`~/.pi/agent/tool-memory/<tool>.md`. The older value `global` is still accepted
and reads as `user`, with a deprecation warning.

Request and response shape:

```json
{"id":"1","method":"ping","params":{}}
{"id":"1","status":"ok","result":{"ok":true}}
```

For `http-json`, the request body is `{"method":"ping","params":{}}` and the response body is `{"status":"ok","result":{...}}`.

## Input and result contracts

Both sides are closed by default.

Input:

- The facade rejects any key that the manifest does not declare, in addition
  to JSON Schema validation. A caller can send only the declared fields.
- `"additionalProperties": false` keeps the contract explicit; the loader
  warns when it is missing.

Result:

- `submit_result` validates the payload against the declared output schema and
  then applies shape limits:
  - keys not declared in a typed object are rejected;
  - a string field without `maxLength` is limited to 4000 characters;
  - more than 8 newlines in a short string field is treated as a log dump;
  - arrays are limited to 50 items unless `maxItems` says otherwise;
  - `summary` is at most 300 characters and at most three lines.
- On violation the worker receives the exact errors and must resubmit a
  compressed result. Process narration, thinking, tool transcripts, commands,
  and logs therefore cannot reach the caller through a result field.
- An untyped object property is treated as a bag: its keys are not checked, but
  its string values still pass the size and log limits. The loader warns about
  any `type: "object"` output field without `properties`.

The converter requires typed fields, `required`, and
`"additionalProperties": false` on both sides, and rejects a catch-all
`result`, `details`, `notes`, or `output` object in the plan it produces.

## Worker progress

The worker writes one compact JSON line per step to
`<project>/.pi/jobs/<jobId>/progress.jsonl`: thinking, reply text, each tool
call, and each tool result. The facade reads that file and shows it in a TUI
widget while a job runs, so the steps stay out of the conversation context.

- Three display channels, all fed from the same file:
  - the running tool call streams the latest lines as partial output, so the
    tool block itself shows what the worker is doing;
  - an editor widget repeats the last lines above the editor and clears four
    seconds after the job reaches a terminal state;
  - `/tool-progress [jobId]` pins a snapshot; `/tool-progress off` clears it.
- Partial output is replaced by the final tool result, so only the result
  reaches the conversation. Nothing in the progress file is appended to the
  main conversation or to the worker's own later turns.

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

Read or wait for that job through the same tool:

```json
{ "mode": "wait", "jobId": "job_...", "timeoutMs": 600000 }
```

Modes:

- `sync`: run a new job and wait for it.
- `start`: create a new job and return its id.
- `wait`: wait for an existing job, or create and wait when `jobId` is omitted.
- `status`: read an existing job's state.
- `result`: read an existing job's result.
- `cancel`: cancel an existing job.

`job` is an internal concept. There is no separate public job tool. Every agent-backed tool exposes job operations through its own `mode` and `jobId` fields. The `/tool-runtime` command can list runtime jobs for diagnostics.

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

Ask the main agent to use `word_count`, or to start `demo_agent` with `mode=start` and then call `demo_agent` again with `mode=result` and the returned `jobId`.

## Security

- Project tools and project agents require project trust.
- Agent tools default to read-only permissions.
- Worker tools cannot exceed the permissions declared in `TOOL.json`.
- `tool_add` refuses to write project tools in an untrusted project.
- Built-in tool names and the management tools `tool_add` and `job` are reserved; generated tools cannot override them.
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
