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

`service_keeper` accepts `request` and optional `allowRepair`; name the service and operation in the request. `allowRepair` defaults to false for state and log inspection. Only an explicit true permits one start or restart.

```json
{ "request": "检查 adaptive-service，必要时恢复一次。", "allowRepair": true }
```

A tool's daemon services start eagerly when the tool is registered. The runtime owns the protocol client, so a restart must run inside the runtime. The `service_keeper` worker therefore runs in process and receives an extra `service_keeper_manage` tool:

| Action | Arguments | Result |
| --- | --- | --- |
| `list` | — | Every daemon declared by an installed tool with its tool name, service name, protocol, pid, process state, and endpoint reachability. |
| `status` | `tool`, `service` | One daemon. |
| `restart` | `tool`, `service` | Stops the recorded process and starts it again through the supervisor. |

`service_keeper` still reads `services/registry.json` for external services such as systemd user units and uses the registered commands for those. It never starts, kills, or probes a tool daemon with bash.

## Worker model

A worker uses the caller's current model and thinking level. When the caller has no session model, the runtime reads `defaultProvider` and `defaultModel` from Pi settings. Tool manifests and agent files do not select another model. Job records store the caller's model and thinking level; usage records include the worker's effective thinking level and any fallback reason.

`agent.thinkingLevel` sets a tool's preferred level. `web_search` prefers `low`. If model capabilities exclude that level, it uses the caller's settings immediately. If the API explicitly rejects `low`, the worker continues the same job once with the caller's thinking setting, preserving completed operations. Authentication, network, and unrelated request errors do not trigger this fallback.

Workers use the scope names `user` and `project`.

| Setting | Default | `project` | `user` |
| --- | --- | --- | --- |
| `agent.sessionScope` | `project` | Worker history is keyed by project directory. | The key drops the project path: all projects share worker history, with the tool directory as working directory. |
| `agent.memoryScope` | `project` | Memory stays at `tool-workers/<key>/memory.md`. | Memory is shared at `~/.pi/agent/tool-memory/<tool>.md`. |

The older value `global` is still accepted and reads as `user`, with a deprecation warning.

`agent.concurrency` defaults to `serial`. A tool with `"concurrency": "parallel"` starts each request in an independent session from a snapshot containing completed tasks. An active request does not enter another request's snapshot. Completion immediately appends the task, typed result, source evidence, optional handoff, and archive reference to shared history. Locks cover snapshot creation and publication only; model requests run concurrently. Each request gets its own intermediate directory. Tools that manage live runtime state require serial execution.

## Input and result contracts

Both sides are closed by default.

### Input

- The facade rejects any key that the manifest does not declare, in addition to JSON Schema validation. A caller can send only the declared fields.
- `"additionalProperties": false` keeps the contract explicit; the loader warns when it is missing.
- For natural language `request` and `task` fields, pass a complete user task directly. Add only necessary context the worker cannot obtain, preserving explicit user requirements, paths, and authorization limits. Do not expand the task into an operating guide or invent extra scope, verification, output, or safety requirements. Keep complex user requirements complete.
- The builder normalizes these parameter descriptions. Registration adds caller `promptGuidelines` that name the tool. Request text is neither truncated nor rewritten, no rewriting model is called, and authorization fields and existing validation remain unchanged.

A search request can simply be:

```json
{"request":"查询英雄联盟 S16 当前赛况。"}
```

The worker applies its existing search, verification, and result instructions.

### Result

`submit_result` validates the payload against the declared output schema and then applies shape limits:

- keys not declared in a typed object are rejected;
- a string field without `maxLength` is limited to 4000 characters;
- multiline answers, lists, tables, and quotations are allowed within the string length limits;
- arrays are limited to 50 items unless `maxItems` says otherwise;
- `summary` is at most 300 characters and at most three lines.

On violation the worker receives the exact errors and must resubmit a result that conforms to the contract. Worker instructions require conclusions and supporting facts; process narration, thinking, tool transcripts, commands, and logs stay in the worker session and progress records.

An untyped object property is treated as a bag: its keys are not checked, but its string values still pass the size limits. The loader warns about any `type: "object"` output field without `properties`.

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

Workers use Pi's automatic compaction with a per-tool budget:

```json
{
  "agent": {
    "context": {
      "budgetTokens": 272000,
      "keepRecentTokens": 6000
    }
  }
}
```

These are the defaults for omitted settings. `budgetTokens` is the input-context threshold; `keepRecentTokens` controls the recent history retained with the summary and must be smaller than the budget. The runtime derives `reserveTokens` for each model so compaction starts at the tool budget, while leaving the model's physical context window unchanged. A single large tool response can temporarily cross the threshold; Pi compacts before the next assistant turn.

Packaged tools use a threshold of 272000 tokens, retaining 4000 recent tokens for `service_keeper` and 8000 for `tool_add`. Tools installed at user scope use the same threshold and keep their existing recent history retention settings. Models with smaller context windows use their own physical limit. Each tool can configure its budget in `TOOL.json`.

A completed handoff can compact history without another model request. Reaching the budget triggers compaction regardless of predicted cache reuse. Usage records report the budget, token estimates, compaction usage, effective thinking, and shared-history publication. Once the final result is accepted, the task finishes and publishes history without a trailing summarization request.

Parallel shared history contains completed results and source observation times. Full intermediate transcripts stay in independent run archives. A summary can replace only the shared prefix covered by its snapshot; newer completions remain present. A stale summary cannot replace a newer shared compaction. Serial tools continue their existing worker session. Compaction preserves the fixed system prompt, and each job appends a short record to `journal.jsonl`.

Worker files live under:

```text
~/.pi/agent/tool-workers/<worker-key>/
├── memory.md
├── journal.jsonl
├── shared.jsonl     # completed history for parallel tools
└── runs/            # independent request archives
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

`tool_add` accepts one natural language `request` containing the tool name, source path, requirements, and scope. The worker extracts and executes the internal management action. Scope defaults to `project`; use `user` only when explicitly requested. It runs synchronously in the current process.

The worker uses the prompt files in `basic-tools/tool_add/agent/`, and the read-only tools plus `tool_add_manage`. `tool_add_manage` is the in-process action backed by `manager.ts`; the worker is the only caller that supplies a `plan`.

### Internal actions

The worker maps `request` to `list`, `inspect`, `validate`, `add`, `convert_skill`, `create_tool`, `disable`, or `enable`, then calls `tool_add_manage`.

### Convert a skill

```json
{
  "request": "把 /path/to/SKILL.md 转换成项目工具。"
}
```

The worker reads the skill and its supporting files, designs one plan from the skill's actual behavior, and calls `tool_add_manage` with the plan. The manager validates the plan, writes `TOOL.json`, `AGENT.md`, `WORKFLOW.md`, and optional `EXAMPLES.md`, then registers the tool. The worker finishes with `submit_result`, carrying only the management result.

### Create a tool from a requirement

```json
{
  "request": "创建项目工具 log_tail_summary，汇总日志文件最近的错误行。输入是日志路径和行数，返回错误总数与各错误码次数。"
}
```

The caller states the complete requirement in `request`; `tool_add` does not read the chat history. The requirement is the complete brief: what the tool does, the input, the result, and any script, service, or path the tool must use. The worker designs the plan and applies it the same way as a conversion.

Creation and conversion keep the public interface small: one short capability sentence and only the inputs the caller must supply or control independently. General workers prefer one natural language `request` or `task` field containing the task and necessary background; a tool that only needs a path can expose `path` directly. Descriptions for `request` and `task` use `直接写用户任务及必要条件，不扩写工具规则。`, and examples state concise goals. Other parameter descriptions stay brief, and necessary validation and authorization fields remain explicit. Procedures, script options, environment configuration, source verification, output conventions, and safety rules belong in the tool's internal `AGENT.md`, `WORKFLOW.md`, and `EXAMPLES.md`. Keep `whenToUse` to necessary selection situations and use `notFor` only for a real ambiguity or safety boundary.

Newly generated tools run synchronously by default, without `mode`, `timeoutMs`, or `jobId`. When the skill's behavior or the requirement needs background execution, set `execution.asyncByDefault: true` in the plan and let the runtime add the job control parameters.

A generated tool must carry:

- a short capability description and at least one `whenToUse` entry;
- a closed input schema with only necessary, typed, briefly described fields and a non-empty `required` list;
- a closed result schema with typed, described fields, `maxLength` on every string, and `maxItems` on every array;
- a worker system prompt and a workflow that ends with `submit_result`;
- services only when the skill or the requirement names a matching script or server. Daemons are declared with `lifecycle: "persistent"` and `start: "eager"`, so they run continuously and are started with the tool.

The manager rejects a plan that misses any of these and returns the exact problems, so the worker can correct the plan and call `tool_add_manage` again. When `convert_skill` is called without a plan, the manager falls back to the deterministic generator with only a `task` input and synchronous execution. `create_tool` requires a plan.

The generated tool uses the permissions proposed by the plan. The plan defaults to read-only; edit `TOOL.json` to allow `bash`, `edit`, or `write`.

To add a tool, give its TOOL.json or tool directory path in `request`. The source directory is copied, and the manager supplies missing agent documentation. To validate a tool, the worker reads the named TOOL.json and passes the manifest object to the manager.

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
