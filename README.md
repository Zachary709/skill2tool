# pi-tool-runtime

English | [简体中文](README.zh-CN.md)

A Pi extension package that registers **agent-backed** and **deterministic** tools with closed input/result contracts, persistent workers, and asynchronous jobs.

The main Pi agent only sees a tool facade: name, description, input schema, and a normalized output envelope. Agent-backed tools run in a persistent worker session; deterministic tools call scripts or daemons. Worker transcripts, memory, and service logs stay outside the main agent context.

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Tool discovery](#tool-discovery)
- [Tool package layout](#tool-package-layout)
- [TOOL.json reference](#tooljson-reference)
- [Services](#services)
- [Worker model](#worker-model)
- [Input and result contracts](#input-and-result-contracts)
- [Jobs](#jobs)
- [Worker agents](#worker-agents)
- [Worker context](#worker-context)
- [Progress display](#progress-display)
- [Bundled tools](#bundled-tools)
- [tool_add](#tool_add)
- [Security](#security)
- [Development](#development)
- [Friendly links](#friendly-links)

## Quick start

Install the package:

```bash
pi install .
```

Run it for one invocation:

```bash
pi --no-skills -e .
```

`--no-skills` keeps Pi's native skill list out of the main system prompt. This package scans tool manifests itself.

## How it works

| Layer | Responsibility |
| --- | --- |
| Facade | Exposes name, description, input schema, and normalized result to the main agent. Rejects undeclared input keys. |
| Agent worker | Runs a persistent Pi session that reads `AGENT.md` and `WORKFLOW.md` and returns a result through `submit_result`. |
| Direct tool | Runs a declared script service synchronously. |
| Runtime | Discovers manifests, starts workers and daemons, stores jobs, and validates results before they reach the main agent. |

## Tool discovery

Tools are discovered from:

- `basic-tools/` in this package, loaded under the `package` scope
- `~/.pi/agent/tools/`
- `<project>/.pi/tools/`

Package tools load first and always load. A user or project tool with the same name is skipped with a collision diagnostic. Project tools load only when the project is trusted.

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

`agent.instructions`, `agent.workflow`, and `agent.examples` are relative to the tool directory, so an agent tool may keep its prompt files under `agent/`.

## TOOL.json reference

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

### Kind

| `kind` | Behavior |
| --- | --- |
| `direct` | Runs a declared service synchronously. |
| `agent` | Creates a persistent worker that can call declared services through `service_call`. |

### In-process handlers

A packaged agent tool may declare `"handler": "tool_add"` or `"handler": "service_keeper"`. The runtime then runs its worker in process instead of a detached job, because the action changes live runtime state. Both handlers support only `mode: "sync"`.

## Services

A tool declares its services in `TOOL.json`.

### Script service

```json
{
  "type": "script",
  "command": "node",
  "args": ["scripts/count.mjs"],
  "protocol": "json-stdin-stdout",
  "timeoutMs": 10000
}
```

### Daemon service

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

### Daemon protocols

| Protocol | Transport | Required fields |
| --- | --- | --- |
| `jsonl-stdio` | Newline-delimited JSON over stdin/stdout | — |
| `unix-jsonl` | Newline-delimited JSON over a Unix socket | `socket`, defaults to `<state dir>/service.sock` |
| `http-json` | JSON over HTTP | `url`, optional `method` and `headers` |

Daemons run continuously. When `lifecycle` and `start` are omitted they default to `persistent` and `eager`, so the daemon starts with the tool and keeps serving jobs. A persistent daemon that uses a Unix socket or HTTP is left running when the session closes and is attached again on the next start.

### Request and response shape

```json
{"id":"1","method":"ping","params":{}}
{"id":"1","status":"ok","result":{"ok":true}}
```

For `http-json`, the request body is `{"method":"ping","params":{}}` and the response body is `{"status":"ok","result":{...}}`.

### Service placement

Every service starts in the tool directory and keeps its state under `~/.pi/agent/services/<tool>/<service>`. Its daemon key is `user:<tool>:<service>`, so every project shares one handle. When a Unix socket or HTTP endpoint is already reachable, the runtime attaches to it instead of spawning another process.

Each spawn writes `state.json` with the process id, cwd, and start time under the state directory. The same directory receives `PI_SERVICE_STATE_DIR`, and the child environment carries `PI_TOOL_NAME` and `PI_SERVICE_NAME`.

### Tool daemon maintenance

A tool's daemon services start eagerly when the tool is registered. The runtime owns the protocol client, so a restart must run inside the runtime. The `service_keeper` worker therefore runs in process and receives an extra `service_keeper_manage` tool:

| Action | Arguments | Result |
| --- | --- | --- |
| `list` | — | Every daemon declared by an installed tool with its tool name, service name, protocol, pid, process state, and endpoint reachability. |
| `status` | `tool`, `service` | One daemon. |
| `restart` | `tool`, `service` | Stops the recorded process and starts it again through the supervisor. |

`service_keeper` still reads `services/registry.json` for external services such as systemd user units and uses the registered commands for those. It never starts, kills, or probes a tool daemon with bash.

## Worker model

A worker uses the default model from pi settings (`defaultProvider` and `defaultModel`) and nothing else. Tool manifests and agent files no longer select a model. The job record keeps the resolved model as `provider/id`, so every job states which model its worker used. When settings set no default, the runtime default applies.

Workers use the scope names `user` and `project`.

| Setting | Default | `project` | `user` |
| --- | --- | --- | --- |
| `agent.sessionScope` | `project` | Worker key is fixed to the project directory, so every project gets its own session. | The key drops the project path: one worker session is shared by every project, with the tool directory as working directory. |
| `agent.memoryScope` | `project` | Memory stays at `tool-workers/<key>/memory.md`. | Memory is shared at `~/.pi/agent/tool-memory/<tool>.md`. |

The older value `global` is still accepted and reads as `user`, with a deprecation warning.

## Input and result contracts

Both sides are closed by default.

### Input

- The facade rejects any key that the manifest does not declare, in addition to JSON Schema validation. A caller can send only the declared fields.
- `"additionalProperties": false` keeps the contract explicit; the loader warns when it is missing.

### Result

`submit_result` validates the payload against the declared output schema and then applies shape limits:

- keys not declared in a typed object are rejected;
- a string field without `maxLength` is limited to 4000 characters;
- more than 8 newlines in a short string field is treated as a log dump;
- arrays are limited to 50 items unless `maxItems` says otherwise;
- `summary` is at most 300 characters and at most three lines.

On violation the worker receives the exact errors and must resubmit a compressed result. Process narration, thinking, tool transcripts, commands, and logs therefore cannot reach the caller through a result field.

An untyped object property is treated as a bag: its keys are not checked, but its string values still pass the size and log limits. The loader warns about any `type: "object"` output field without `properties`.

### Builder requirements

The builder requires typed fields, `required`, and `"additionalProperties": false` on both sides. It also rejects a catch-all `result`, `details`, `notes`, or `output` object in the plan it produces, and requires:

- a selection description with at least one `whenToUse` entry;
- a described system prompt;
- a workflow that ends with `submit_result`;
- `maxLength` on output strings;
- `maxItems` on output arrays;
- continuous daemon services.

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

### Modes

| Mode | Behavior |
| --- | --- |
| `sync` | Run a new job and wait for it. |
| `start` | Create a new job and return its id. |
| `wait` | Wait for an existing job, or create and wait when `jobId` is omitted. |
| `status` | Read an existing job's state. |
| `result` | Read an existing job's result. |
| `cancel` | Cancel an existing job. |

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

An agent file must carry the tool name in both `name` and `tool`. A file whose `name` differs from the tool name is rejected with a warning and the next candidate is used. Generated project agents and embedded agents are written with the tool name, so every tool, including a newly created one, resolves a worker agent whose name matches the tool.

```markdown
---
name: repair_shop
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

## Progress display

The worker writes one compact JSON line per step to `<project>/.pi/jobs/<jobId>/progress.jsonl`: thinking, reply text, each tool call, and each tool result. The facade reads that file and shows it in a TUI widget while a job runs, so the steps stay out of the conversation context.

Three display channels are all fed from the same file:

- the running tool call streams the latest lines as partial output, so the tool block itself shows what the worker is doing;
- an editor widget repeats the last lines above the editor and clears four seconds after the job reaches a terminal state;
- `/tool-progress` pins a snapshot for 30 seconds, then clears it; `/tool-progress off` clears it immediately. A reference that matches no job only prints a warning and does not create a widget.

A job reference never needs the full job id:

| Input | Effect |
| --- | --- |
| `/tool-progress` | Shows the running job or the latest one. |
| `/tool-progress list` | Prints recent jobs with a short id. |
| `/tool-progress <index>` | Selects a job by index. |
| `/tool-progress <short id>` | Selects a job by short id. |
| `/tool-progress <fragment>` | Accepts an id prefix, suffix, or fragment when it matches exactly one job. |

The widget header and status line show the short id instead of the full job id. Partial output is replaced by the final tool result, so only the result reaches the conversation. Nothing in the progress file is appended to the main conversation or to the worker's own later turns.

## Bundled tools

`basic-tools/` holds the tools this package needs itself. They are ordinary tool directories, so they also appear in the pi tool list:

- `basic-tools/tool_add/` — agent tool. Its own worker prompt lives in `basic-tools/tool_add/agent/`; `manager.ts`, `plan.ts`, and `artifacts.ts` implement the in-process management action the worker calls. The manifest declares `"handler": "tool_add"`, so the worker runs in process and can register tools in the live registry.
- `basic-tools/service_keeper/` — agent tool that checks and recovers services registered in the agent directory's `services/registry.json`, and daemons declared by installed tools. It declares `"handler": "service_keeper"`, so its worker runs in process and restarts tool daemons through the runtime.

A packaged tool runs with the `package` scope. Its daemons start in the tool directory, its state stays under the agent directory, and it needs no project trust.

## tool_add

`tool_add` is an agent tool. One job handles one management request: the worker reads the skill or the stated requirement, builds a complete tool plan, and applies it through an in-process management action. Because it changes the live tool registry, it runs in process and supports only `mode: "sync"`.

The worker uses the prompt files in `basic-tools/tool_add/agent/`, and the read-only tools plus `tool_add_manage`. `tool_add_manage` is the in-process action backed by `manager.ts`; the worker is the only caller that supplies a `plan`.

### Actions

`list`, `inspect`, `validate`, `add`, `convert_skill`, `create_tool`, `disable`, `enable`.

### Convert a skill

```json
{
  "action": "convert_skill",
  "source": { "type": "skill", "path": "/path/to/SKILL.md" },
  "scope": "project",
  "activate": true
}
```

The worker reads the skill and its supporting files, designs one plan from the skill's actual behavior, and calls `tool_add_manage` with the plan. The manager validates the plan, writes `TOOL.json`, `AGENT.md`, `WORKFLOW.md`, and optional `EXAMPLES.md`, then registers the tool. The worker finishes with `submit_result`, carrying only the management result.

### Create a tool from a requirement

```json
{
  "action": "create_tool",
  "name": "log_tail_summary",
  "requirements": "汇总一个日志文件里最近的错误行。输入是日志路径和行数，结果是错误总数与每个错误码的次数。",
  "scope": "project",
  "activate": true
}
```

The calling agent states the requirement; `tool_add` does not read the chat history. The requirement is the complete brief: what the tool does, the input, the result, and any script, service, or path the tool must use. The worker designs the plan and applies it the same way as a conversion.

A generated tool must carry:

- a selection description and at least one `whenToUse` entry;
- a closed input schema with typed, described fields and a non-empty `required` list;
- a closed result schema with typed, described fields, `maxLength` on every string, and `maxItems` on every array;
- a worker system prompt and a workflow that ends with `submit_result`;
- services only when the skill or the requirement names a matching script or server. Daemons are declared with `lifecycle: "persistent"` and `start: "eager"`, so they run continuously and are started with the tool.

The manager rejects a plan that misses any of these and returns the exact problems, so the worker can correct the plan and call `tool_add_manage` again. When `convert_skill` is called without a plan, the manager falls back to the deterministic generator. `create_tool` requires a plan.

The generated tool uses the permissions proposed by the plan. The plan defaults to read-only; edit `TOOL.json` to allow `bash`, `edit`, or `write`.

`add` accepts `instructions`, `workflow`, and `examples` strings. If an agent tool's files are missing, `tool_add` writes safe defaults. A source path may point to a directory containing `TOOL.json`; the whole directory is copied.

## Security

- Project tools and project agents require project trust.
- Package tools under `basic-tools/` load without project trust and cannot be disabled through `tool_add`.
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

## Friendly links

- [LINUX DO](https://linux.do/) — a new ideal community
