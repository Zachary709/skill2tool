# pi-tool-runtime

[English](README.md) | 简体中文

一个 Pi 扩展包，用来注册**由 agent 提供能力**和**确定性执行**的工具，并提供封闭的输入与结果契约、常驻 worker 和异步任务。

主 Pi agent 只能看到一个工具封装：名称、说明、输入 schema 和规范化后的输出信封。由 agent 提供能力的工具在常驻 worker 会话里执行；确定性工具直接调用脚本或 daemon。worker 的对话记录、记忆和服务日志都留在主 agent 上下文之外。

## 目录

- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [工具发现](#工具发现)
- [工具包目录结构](#工具包目录结构)
- [TOOL.json 参考](#tooljson-参考)
- [服务](#服务)
- [Worker 模型](#worker-模型)
- [输入与结果契约](#输入与结果契约)
- [任务](#任务)
- [Worker agent](#worker-agent)
- [Worker 上下文](#worker-上下文)
- [进度显示](#进度显示)
- [内置工具](#内置工具)
- [tool_add](#tool_add)
- [安全](#安全)
- [开发](#开发)

## 快速开始

安装这个包：

```bash
pi install .
```

只运行一次：

```bash
pi --no-skills -e .
```

`--no-skills` 让 Pi 自带的技能列表不进入主系统提示词。这个包会自己扫描工具清单。

## 工作原理

| 层次 | 负责的事情 |
| --- | --- |
| 工具封装 | 向主 agent 暴露名称、说明、输入 schema 和规范化后的结果，并拒绝清单未声明的输入字段。 |
| Agent worker | 运行一个常驻 Pi 会话，读取 `AGENT.md` 和 `WORKFLOW.md`，通过 `submit_result` 返回结果。 |
| 确定性工具 | 同步执行清单里声明的脚本服务。 |
| 运行时 | 发现清单，启动 worker 和 daemon，保存任务，并在结果到达主 agent 之前完成校验。 |

## 工具发现

工具从以下位置发现：

- 本包内的 `basic-tools/`，以 `package` 作用域加载
- `~/.pi/agent/tools/`
- `<project>/.pi/tools/`

包内工具先加载，并且始终加载。用户级或项目级工具同名时会被跳过，并给出一条冲突诊断。项目级工具只在项目受信任时加载。

## 工具包目录结构

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

`agent.instructions`、`agent.workflow` 和 `agent.examples` 都相对于工具目录，因此 agent 工具可以把提示词文件放在 `agent/` 下。

## TOOL.json 参考

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

### kind

| `kind` | 行为 |
| --- | --- |
| `direct` | 同步执行一个已声明的服务。 |
| `agent` | 创建一个常驻 worker，worker 可以通过 `service_call` 调用已声明的服务。 |

### 进程内 handler

包内的 agent 工具可以声明 `"handler": "tool_add"` 或 `"handler": "service_keeper"`。因为这类动作会改动正在运行的运行时状态，运行时会把它的 worker 放在当前进程里执行，不创建独立任务。这两个 handler 都只支持 `mode: "sync"`。

## 服务

工具在 `TOOL.json` 里声明自己使用的服务。

### 脚本服务

```json
{
  "type": "script",
  "command": "node",
  "args": ["scripts/count.mjs"],
  "protocol": "json-stdin-stdout",
  "timeoutMs": 10000
}
```

### Daemon 服务

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

### Daemon 协议

| 协议 | 传输方式 | 必填字段 |
| --- | --- | --- |
| `jsonl-stdio` | 通过标准输入输出传递按行分隔的 JSON | — |
| `unix-jsonl` | 通过 Unix socket 传递按行分隔的 JSON | `socket`，默认是 `<state dir>/service.sock` |
| `http-json` | 通过 HTTP 传递 JSON | `url`，可选的 `method` 和 `headers` |

Daemon 持续运行。省略 `lifecycle` 和 `start` 时，默认值分别是 `persistent` 和 `eager`，因此 daemon 会随工具启动，并持续处理任务。使用 Unix socket 或 HTTP 的常驻 daemon 在会话结束时继续运行，下次启动时重新接入。

### 请求与响应结构

```json
{"id":"1","method":"ping","params":{}}
{"id":"1","status":"ok","result":{"ok":true}}
```

对于 `http-json`，请求体是 `{"method":"ping","params":{}}`，响应体是 `{"status":"ok","result":{...}}`。

### 服务位置

每个服务都在工具目录中启动，状态保存在 `~/.pi/agent/services/<tool>/<service>` 下。它的 daemon 键是 `user:<tool>:<service>`，因此每个项目共用同一个句柄。如果 Unix socket 或 HTTP 端点已经可以访问，运行时会接入这个端点，不再启动新的进程。

每次启动进程都会在状态目录下写入 `state.json`，记录进程号、工作目录和启动时间。同一个目录会收到 `PI_SERVICE_STATE_DIR`，子进程环境里带有 `PI_TOOL_NAME` 和 `PI_SERVICE_NAME`。

### 工具 daemon 维护

工具注册时，它的 daemon 服务会立即启动。协议客户端由运行时持有，因此重启必须在运行时内部完成。`service_keeper` 的 worker 因此在当前进程里运行，并额外获得一个 `service_keeper_manage` 工具：

| 动作 | 参数 | 结果 |
| --- | --- | --- |
| `list` | — | 列出已安装工具声明的每个 daemon，包括工具名、服务名、协议、进程号、进程状态和端点可达性。 |
| `status` | `tool`、`service` | 返回一个 daemon 的状态。 |
| `restart` | `tool`、`service` | 停止已记录的进程，并通过 supervisor 重新启动它。 |

`service_keeper` 仍然会读取 `services/registry.json` 来处理外部服务，例如 systemd 用户单元，并使用登记的命令操作这些服务。它不会用 bash 启动、终止或探测工具 daemon。

## Worker 模型

Worker 只使用 pi 设置里的默认模型（`defaultProvider` 和 `defaultModel`），不使用其他模型。工具清单和 agent 文件不再选择模型。任务记录以 `provider/id` 的形式保存实际使用的模型，因此每个任务都能说明它的 worker 用了哪个模型。设置里没有默认值时，使用运行时默认值。

Worker 使用的作用域名称是 `user` 和 `project`。

| 设置 | 默认值 | `project` | `user` |
| --- | --- | --- | --- |
| `agent.sessionScope` | `project` | Worker 键固定为项目目录，因此每个项目有自己的会话。 | 键中不再包含项目路径：所有项目共用一个 worker 会话，工作目录是工具目录。 |
| `agent.memoryScope` | `project` | 记忆保存在 `tool-workers/<key>/memory.md`。 | 记忆共用，保存在 `~/.pi/agent/tool-memory/<tool>.md`。 |

旧值 `global` 仍然可用，会按 `user` 处理，并给出弃用提示。

## 输入与结果契约

两个方向默认都是封闭的。

### 输入

- 除了 JSON Schema 校验之外，工具封装还会拒绝清单未声明的任何字段。调用方只能发送已声明的字段。
- `"additionalProperties": false` 让契约保持明确；缺少这个字段时加载器会给出警告。

### 结果

`submit_result` 先用声明的输出 schema 校验提交内容，再应用结构限制：

- 有类型的对象中，未声明的键会被拒绝；
- 没有 `maxLength` 的字符串字段限制为 4000 个字符；
- 短字符串字段中出现超过 8 个换行时，按日志转储处理；
- 数组默认限制为 50 项，除非 `maxItems` 另有说明；
- `summary` 最多 300 个字符、最多三行。

违反限制时，worker 会收到具体的错误信息，必须重新提交经过压缩的结果。因此过程叙述、思考、工具记录、命令和日志都无法通过结果字段到达调用方。

没有声明类型的对象属性按容器处理：它的键不做检查，但字符串值仍然受长度和日志限制约束。输出字段写成 `type: "object"` 却没有 `properties` 时，加载器会给出警告。

### 构建器要求

构建器要求两个方向都有带类型的字段、`required` 和 `"additionalProperties": false`。在它生成的方案里，会拒绝笼统的 `result`、`details`、`notes` 或 `output` 对象，并要求：

- 有用于选择工具的说明，且 `whenToUse` 至少有一项；
- 有带说明的系统提示词；
- 工作流以 `submit_result` 结束；
- 输出字符串带 `maxLength`；
- 输出数组带 `maxItems`；
- daemon 服务声明为持续运行。

## 任务

Agent 工具支持异步任务。

```json
{ "task": "...", "mode": "start" }
```

返回：

```json
{
  "status": "accepted",
  "summary": "Job job_... accepted.",
  "jobId": "job_..."
}
```

之后通过同一个工具读取或等待这个任务：

```json
{ "mode": "wait", "jobId": "job_...", "timeoutMs": 600000 }
```

### 模式

| 模式 | 行为 |
| --- | --- |
| `sync` | 运行一个新任务并等待结果。 |
| `start` | 创建一个新任务并返回任务 id。 |
| `wait` | 等待已有任务；省略 `jobId` 时创建并等待。 |
| `status` | 读取已有任务的状态。 |
| `result` | 读取已有任务的结果。 |
| `cancel` | 取消已有任务。 |

`job` 是内部概念，没有单独对外的任务工具。每个 agent 工具都通过自己的 `mode` 和 `jobId` 字段提供任务操作。`/tool-runtime` 命令可以列出运行时任务，用于诊断。

任务在独立的 worker 进程中运行。任务存储可以在 Pi 重启后继续使用。重启时，排队中的任务会重新入队；正在运行但 worker 已退出的任务会被标记为 `lost`。

启动的任务完成时，如果发起请求的 agent 处于空闲状态，运行时会发送一条简短完成消息。完整结果仍然保存在任务存储里。

任务文件位于 `<project>/.pi/jobs/<jobId>/`：

```text
job.json
result.json
events.jsonl
```

## Worker agent

解析顺序：

1. 用户级 agent：`~/.pi/agent/agents/<tool>.md`
2. 项目级 agent：`<project>/.pi/agents/<tool>.md`
3. 在项目受信任时，根据工具的 `AGENT.md` 和 `WORKFLOW.md` 创建一个项目级 agent

项目不受信任时跳过项目级 agent。项目级 agent 可以声明 `override: true` 来取得高于用户级 agent 的优先级。

Agent 文件必须在 `name` 和 `tool` 两处都写上工具名。`name` 与工具名不一致的文件会被拒绝并给出警告，然后使用下一个候选文件。生成的项目级 agent 和内置 agent 都会写入工具名，因此每个工具（包括新建的工具）都能解析到名称与工具一致的 worker agent。

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

Worker 的系统提示词包含工具契约、`AGENT.md` 和 `WORKFLOW.md`。为了避免递归，工具封装本身会从 worker 的工具列表中移除。

## Worker 上下文

Worker 使用 Pi 的自动压缩。压缩按阈值触发，不按任务触发。

```text
reserveTokens: 20000
keepRecentTokens: 30000
```

压缩时，摘要会写入 worker 的记忆文件。每个任务还会向 `journal.jsonl` 追加一条简短记录。固定的系统提示词不会被压缩改写。

Worker 文件位于：

```text
~/.pi/agent/tool-workers/<worker-key>/
├── memory.md
└── journal.jsonl
```

## 进度显示

Worker 每完成一步，都会向 `<project>/.pi/jobs/<jobId>/progress.jsonl` 写入一行紧凑的 JSON：思考、回复文本、每次工具调用和每次工具结果。工具封装读取这个文件，并在任务运行时显示在 TUI 组件里，因此这些步骤不会进入对话上下文。

三个显示通道都来自同一个文件：

- 运行中的工具调用把最新的若干行作为部分输出流式显示，因此工具块本身就能看出 worker 正在做什么；
- 编辑器上方的组件重复显示最后若干行，任务进入终止状态四秒后清除；
- `/tool-progress` 固定显示一个快照 30 秒，然后清除；`/tool-progress off` 立即清除。匹配不到任务的引用只会打印一条警告，不会创建组件。

引用任务时不需要完整任务 id：

| 输入 | 效果 |
| --- | --- |
| `/tool-progress` | 显示正在运行的任务或最近一个任务。 |
| `/tool-progress list` | 列出最近的任务和它们的短 id。 |
| `/tool-progress <index>` | 按序号选择一个任务。 |
| `/tool-progress <short id>` | 按短 id 选择一个任务。 |
| `/tool-progress <fragment>` | 在只匹配一个任务时，接受 id 的前缀、后缀或片段。 |

组件标题和状态行显示短 id，不显示完整任务 id。部分输出最后会被最终工具结果替换，因此只有结果进入对话。进度文件里的内容不会追加到主对话，也不会进入 worker 后续的回合。

## 内置工具

`basic-tools/` 存放这个包自己需要的工具。它们本身就是普通的工具目录，因此也会出现在 pi 的工具列表里：

- `basic-tools/tool_add/` —— agent 工具。它自己的 worker 提示词在 `basic-tools/tool_add/agent/`；`manager.ts`、`plan.ts` 和 `artifacts.ts` 实现 worker 调用的进程内管理动作。清单声明 `"handler": "tool_add"`，因此 worker 在当前进程里运行，可以直接向正在使用的工具注册表注册工具。
- `basic-tools/service_keeper/` —— agent 工具，检查和恢复 agent 目录 `services/registry.json` 中登记的服务，以及已安装工具声明的 daemon。它声明 `"handler": "service_keeper"`，因此 worker 在当前进程里运行，并通过运行时重启工具 daemon。

包内工具以 `package` 作用域运行。它的 daemon 在工具目录中启动，状态保存在 agent 目录下，不需要项目受信任。

## tool_add

`tool_add` 是一个 agent 工具。一个任务处理一个管理请求：worker 读取技能或给定的需求，生成完整工具方案，并通过进程内管理动作应用这个方案。由于它会改动正在使用的工具注册表，它在当前进程里运行，只支持 `mode: "sync"`。

Worker 使用 `basic-tools/tool_add/agent/` 中的提示词文件，以及只读工具和 `tool_add_manage`。`tool_add_manage` 是由 `manager.ts` 实现的进程内动作；只有 worker 会提供 `plan` 调用它。

### 动作

`list`、`inspect`、`validate`、`add`、`convert_skill`、`create_tool`、`disable`、`enable`。

### 转换技能

```json
{
  "action": "convert_skill",
  "source": { "type": "skill", "path": "/path/to/SKILL.md" },
  "scope": "project",
  "activate": true
}
```

Worker 读取技能和它的附属文件，根据技能的实际行为设计一个方案，并用这个方案调用 `tool_add_manage`。管理器校验方案，写入 `TOOL.json`、`AGENT.md`、`WORKFLOW.md` 和可选的 `EXAMPLES.md`，然后注册工具。Worker 最后用 `submit_result` 返回结果，内容只包含管理结果。

### 按需求创建工具

```json
{
  "action": "create_tool",
  "name": "log_tail_summary",
  "requirements": "汇总一个日志文件里最近的错误行。输入是日志路径和行数，结果是错误总数与每个错误码的次数。",
  "scope": "project",
  "activate": true
}
```

需求由调用方 agent 给出；`tool_add` 不读取聊天记录。需求就是完整说明：工具做什么、输入是什么、结果是什么，以及工具必须使用的脚本、服务或路径。Worker 设计方案，并按与转换相同的方式应用。

生成的工具必须包含：

- 用于选择工具的说明，且 `whenToUse` 至少有一项；
- 封闭的输入 schema，字段有类型和说明，`required` 非空；
- 封闭的结果 schema，字段有类型和说明，每个字符串都有 `maxLength`，每个数组都有 `maxItems`；
- worker 系统提示词，以及以 `submit_result` 结束的工作流；
- 只有在技能或需求给出对应的脚本或服务器时，才声明服务。Daemon 以 `lifecycle: "persistent"` 和 `start: "eager"` 声明，因此持续运行并随工具启动。

方案缺少任何一项时，管理器会拒绝它并返回具体问题，worker 可以修正方案后再次调用 `tool_add_manage`。调用 `convert_skill` 时没有提供方案，管理器会退回到确定性生成器。`create_tool` 必须提供方案。

生成的工具使用方案建议的权限。方案默认只读；要允许 `bash`、`edit` 或 `write`，请修改 `TOOL.json`。

`add` 接受 `instructions`、`workflow` 和 `examples` 字符串。如果 agent 工具的文件缺失，`tool_add` 会写入安全的默认内容。来源路径可以指向包含 `TOOL.json` 的目录，整个目录会被复制。

## 安全

- 项目级工具和项目级 agent 需要项目受信任。
- `basic-tools/` 下的包内工具不需要项目受信任即可加载，并且不能通过 `tool_add` 停用。
- Agent 工具默认使用只读权限。
- Worker 使用的工具不能超出 `TOOL.json` 声明的权限。
- 项目不受信任时，`tool_add` 拒绝写入项目级工具。
- 内置工具名以及管理工具 `tool_add` 和 `job` 是保留名称；生成的工具不能覆盖它们。
- Daemon 由这个包启动，只接收声明的环境变量和继承的环境变量。
- 结果在到达主 agent 之前会经过校验。
- 过大的结果会被截断；完整结果应放在产物文件或任务文件中。

## 开发

```bash
npm install
npm run typecheck
npm test
```

扩展入口是 `extensions/tool-runtime.ts`。
