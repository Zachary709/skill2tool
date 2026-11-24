# pi-tool-runtime

[English](README.md) | 简体中文

一个 Pi 扩展包，用来注册**由 agent 提供能力**和**确定性执行**的工具，并提供封闭的输入与结果契约、常驻 worker 和异步任务。

主 Pi agent 只能看到一个工具封装：名称、说明、输入 schema 和规范化后的输出信封。由 agent 提供能力的工具在常驻 worker 会话里执行；确定性工具直接调用脚本或 daemon。worker 的对话记录、记忆和服务日志都留在主 agent 上下文之外。

## 目录

- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [工具发现](#工具发现)
- [工具分类与按需加载](#工具分类与按需加载)
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
- [友情链接](#友情链接)

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

包内工具先注册，并且始终注册。用户级或项目级工具同名时会被跳过，并给出一条冲突诊断。项目级工具只在项目受信任时注册。注册与向模型展示分开处理：专门工具默认等待按需加载。

## 工具分类与按需加载

插件保留已有基础工具，并提供 `tool_find`、`tool_use` 两个常驻入口。`tool_find` 使用 MiniSearch 检索工具元数据，只返回候选名称、能力说明和当前加载状态，不改变活动工具列表。`tool_use` 负责查看确切工具的契约或实际调用。主提示词只增加领域的一句话说明，选中工具的输入契约和调用规则通过工具结果按需提供。发现流程不增加推理 worker。

插件使用独立的工具名称，与 CLI、Pi Web 的内置 `tool_search` 同时注册，不修改内置扩展配置。当前会话以 `tool_find` 为发现入口，初始化和重置时不激活内置搜索；`tool_find` 活动期间，内置搜索的声明不进入模型请求。SDK 只需加载本插件。

默认分类：

| 分类 | 能力 | 已有工具 |
| --- | --- | --- |
| `research` | 检索与研究 | `web_search`、`paper_reader` |
| `infrastructure` | 设备与计算 | `ssh_manager`、`tailscale_manager`、`adaptive_computation` |
| `runtime` | 运行维护 | `service_keeper`、`tool_add` |
| `other` | 其他工具 | 没有分类信息的其他工具 |

`TOOL.json` 支持以下可选元数据：

```json
{
  "category": "research/papers",
  "tags": ["论文", "作者"],
  "defaultActive": false,
  "exposure": "deferred"
}
```

- `category` 指定唯一的主要分类，使用小写字母、数字和下划线，支持 `领域/子分类`。可以声明其他领域。
- `tags` 提供跨分类检索的关键词，最多 16 个不重复的非空字符串。
- 缺少 `category` 时，插件为表中的已有工具补充分类；其他工具采用有效的非通用 `namespace`，其余归入 `other`。旧工具文件无需修改。
- 专门工具默认不激活。旧清单中的 `exposure: "direct"` 同样以 `deferred` 注册；工具仍按 `kind` 决定直接执行或通过 worker 执行。`defaultActive: true` 让工具默认常驻。显式 `model-only` 默认常驻，`codemode` 和 `hidden` 保留原有可达性语义。
- 没有自定义 `namespace` 或其值为旧默认值 `tool` 时，插件使用主要领域作为命名空间。

主 agent 使用 `tool_find` 按任务、工具名、分类或标签搜索。搜索后由主 agent 选择确切工具：

```json
{"tool":"paper_reader"}
```

通过 `tool_use` 省略 `input` 时，只读取目标工具的完整说明、输入 schema 和调用规则，不激活工具。提供 `input` 时执行一次真实调用：

```json
{"tool":"paper_reader","input":{"request":"阅读指定论文并回答当前问题。"}}
```

调用经由 SDK 的 `ctx.executeTool()`，保留原工具的参数校验、权限拦截、授权字段、进度和取消规则。只有目标 `execute` 实际运行后，该工具才自动加入当前对话列表，之后可以直接调用；参数 schema 校验失败或被权限拦截的调用不会加入。搜索中的其他候选保持未加载。调用期间显式收起、重置或停用工具后，任务完成不会再次将它加入列表。业务结果、错误和终止标志原样转交，嵌套用量由 SDK 汇总。

新建、转换、添加和重新启用的工具进入目录，是否默认激活由 `defaultActive` 决定。用户仍可显式加载一个工具或整个分类。

用户命令：

```text
/tool-catalog                       # 查看主要分类和加载数量
/tool-catalog research              # 查看一个领域及其子分类
/tool-catalog research/papers       # 查看子分类
/tool-catalog search 论文            # 跨分类按关键词查找，不自动加载
/tool-catalog load paper_reader     # 加载一个工具
/tool-catalog load research         # 加载整个分类
/tool-catalog unload research       # 收起整个分类
/tool-catalog reset                 # 恢复默认常驻列表
```

会话内保留已加载工具，不在每次调用后自动收起。Pi 的会话恢复、分支和重载可以恢复该分支记录的活动工具；升级后需要立即精简已有会话时，执行 `/tool-catalog reset`。新会话默认使用精简列表。命令仅调整本插件管理的工具，保留其他扩展及基础工具的现有选择。收起和重置不取消任务、不终止 worker 或 daemon；停用的工具不参与发现。项目可信检查、工具允许列表、输入校验、授权字段、进度和取消行为保持有效。

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

### 管理动作 handler

包内的 agent 工具可以声明 `"handler": "tool_add"` 或 `"handler": "service_keeper"`。推理 worker 在独立进程中运行，私有管理工具通过 IPC 请求父进程操作正在使用的注册表与共享服务。这两个 handler 保持同步返回的公开接口。

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

运行时启动 daemon 时会在状态目录下写入 `state.json`，记录进程号、工作目录和启动时间。同一个目录会收到 `PI_SERVICE_STATE_DIR`，子进程环境里带有 `PI_TOOL_NAME` 和 `PI_SERVICE_NAME`。

### 工具 daemon 维护

`service_keeper` 接收 `request` 和可选的 `allowRepair`，服务名称和操作写在请求中。`allowRepair` 默认 false，只检查状态或读取日志；只有显式传入 true 才允许启动或重启一次。

```json
{ "request": "检查 adaptive-service，必要时恢复一次。", "allowRepair": true }
```

工具注册时，它的 daemon 服务会立即启动。协议客户端由运行时持有，因此重启必须在运行时内部完成。独立的 `service_keeper` worker 额外获得 `service_keeper_manage`，由它通过 IPC 请求父进程执行管理动作：

| 动作 | 参数 | 结果 |
| --- | --- | --- |
| `list` | — | 列出已安装工具声明的每个 daemon，包括工具名、服务名、协议、进程号、进程状态和端点可达性。 |
| `status` | `tool`、`service` | 返回一个 daemon 的状态。 |
| `restart` | `tool`、`service` | 停止已记录的进程，并通过 supervisor 重新启动它。 |

`service_keeper` 仍然会读取 `services/registry.json` 来处理外部服务，例如 systemd 用户单元，并使用登记的命令操作这些服务。它不会用 bash 启动、终止或探测工具 daemon。

## Worker 模型

Worker 使用 agent tool 统一配置的模型和 thinking level，任务之间不再切换。默认模型是 `lqy-阿里云节省计划/deepseek-v4.1-flash-1017`，thinking level 默认跟随调用方。配置写在 `~/.pi/agent/tool-runtime.json`：

```json
{
  "model": "lqy-阿里云节省计划/deepseek-v4.1-flash-1017",
  "thinkingLevel": "high"
}
```

`/tool-model` 把当前会话的模型和 thinking level 写入配置；`/tool-model <模型 id>` 直接写模型 id，id 对应多个 provider 时会要求写成完整名称；`/tool-model <provider/model>` 指定完整名称；`/tool-model reset` 删除配置并回到默认值；`/tool-model show` 查询当前模型、thinking level、来源和配置文件路径。修改在下一个任务生效。环境变量 `PI_TOOL_MODEL` 的优先级高于配置文件中的模型。任务记录保存该模型；模型不在模型运行时中或缺少凭据时，任务直接失败，不会改选其他模型。

thinking level 由工具清单的 `agent.thinkingLevel` 优先决定，`web_search` 配置为 `low`；未配置时使用 `/tool-model` 固定下来的级别，也没有固定时跟随调用方。模型能力声明不支持工具指定的级别时，直接采用面向该模型的级别；级别超出模型能力时，Pi 下调到最近的受支持级别。接口明确拒绝 `low` 时，保留已经完成的操作，使用可用的 thinking level 继续同一任务一次。身份验证、网络和其他请求错误不会触发这项回退。用量记录保存 worker 实际采用的级别及回退原因。

Worker 使用的作用域名称是 `user` 和 `project`。

| 设置 | 默认值 | `project` | `user` |
| --- | --- | --- | --- |
| `agent.sessionScope` | `project` | Worker 历史按项目目录区分。 | 键中不包含项目路径：所有项目共用 worker 历史，工作目录是工具目录。 |
| `agent.memoryScope` | `project` | 记忆保存在 `tool-workers/<key>/memory.md`。 | 记忆共用，保存在 `~/.pi/agent/tool-memory/<tool>.md`。 |

旧值 `global` 仍然可用，会按 `user` 处理，并给出弃用提示。

`agent.concurrency` 默认为 `serial`，控制同一对话内的请求排队；配置 `"concurrency": "parallel"` 后，同一对话内的请求也可并行执行。不同对话调用同一个工具始终使用独立 worker 会话，可以并行执行，包括使用 `sessionScope: "user"` 共享历史的不同项目。每个请求从已完成任务的历史快照开始，正在执行的请求不会进入其他请求的快照。结果返回前，按完成顺序向共享历史追加任务要求、类型明确的结果、来源证据、可选的交接信息和完整会话的保存位置。锁只保护快照创建和历史发布，不覆盖模型请求及工具执行。每个请求使用独立的中间目录。管理当前运行时状态的工具在各自对话内保持串行执行。新对话初始化时，通过任务所有权锁识别其他运行时的活动任务，不修改其状态，也不等待其完成。

## 输入与结果契约

两个方向默认都是封闭的。

### 输入

- 除了 JSON Schema 校验之外，工具封装还会拒绝清单未声明的任何字段。调用方只能发送已声明的字段。
- `"additionalProperties": false` 让契约保持明确；缺少这个字段时加载器会给出警告。
- Agent 工具的自然语言 `request`、`task` 只写本轮目标、必要新增条件和定位引用。消解“继续”“测试一下”等指代，不照抄整段用户消息，不复述 worker 已知历史、文件内容或固定参数。已有任务只给足以唯一定位的最少任务标识或文件引用，不罗列相关文档和结果路径；其余由 worker 自行读取，未变更的输入、配置和资源约束自动继承，不附加“沿用”或“保持参数”的确认句。通常一句目标加必要新增条件即可，不添加用户未要求的检查、输出指标或格式；保留无法从历史或引用取得的关键事实和本轮授权限制。
- 生成器统一此类参数的简短说明；注册时通过带工具名称的 `promptGuidelines` 提醒调用方，同时包含 `whenToUse` 和 `notFor` 的选择边界。输入文本不被截断或改写，不增加改写模型调用，授权字段与既有校验保持不变。

例如搜索赛况可以直接传入：

```json
{"request":"查询英雄联盟 S16 当前赛况。"}
```

Worker 根据已有指令完成检索、来源核实和结果整理，无需调用方重复说明。延续任务时，worker 从同一项目、任务的已完成历史和引用文件获取已有配置与结果；调用方不复制上轮经过、源码说明或参数清单。

### 结果

`submit_result` 先用声明的输出 schema 校验提交内容，再应用结构限制：

- 有类型的对象中，未声明的键会被拒绝；
- 没有 `maxLength` 的字符串字段限制为 4000 个字符；
- 允许长度限制内的多行回答、列表、表格和原文引用；
- 数组默认限制为 50 项，除非 `maxItems` 另有说明；
- `summary` 最多 300 个字符、最多三行。

违反限制时，worker 会收到具体的错误信息，必须重新提交符合契约的结果。worker 指令要求结果只包含结论和支持事实；思考和完整工具记录保留在私有 worker 会话中，进度记录只包含状态、公开文本和工具活动。

没有声明类型的对象属性按容器处理：它的键不做检查，但字符串值仍然受长度限制约束。输出字段写成 `type: "object"` 却没有 `properties` 时，加载器会给出警告。

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

`job` 是内部概念，没有单独对外的任务工具。只有配置为后台执行的工具公开 `mode` 和 `jobId`。每次调用都生成内部任务记录，包括确定性工具及两个管理工具，并可通过用户命令控制。

每次调用关联父会话、本轮运行、toolCallId 和 jobId。任务管理对象统一维护取消信号、状态、进展、操作及进程清理，父进程是任务状态的唯一写入者。任务存储在 Pi 重启后保留；丢失所有权的未完成任务标记为 `lost`，不重新执行排队请求，也不凭历史 PID 终止进程。

启动的任务完成时，如果发起请求的 agent 处于空闲状态，运行时会发送一条简短完成消息。完整结果仍然保存在任务存储里。

任务文件位于 `<project>/.pi/jobs/<jobId>/`：

```text
job.json
result.json
events.jsonl
progress.jsonl
processes.jsonl
stdout.log
stderr.log
intermediate/    # 运行时临时文件和 Bash 输出
```

### 取消任务

```text
/tool-cancel <完整 id、短 id 或序号>
/tool-cancel all
```

命令直接执行，模型忙碌时也不等待模型回复。单项取消不影响其他并行任务；停止外层 agent 会取消它本轮调用的子任务，并及时结束外层等待。业务 request 不增加管理字段。每次模型请求和工具执行都先由父任务确认并写入操作记录；取消后不再批准新操作，不重试模型请求，本轮运行也不能重新启动用户已经取消的工具。

清理期间状态保持为 `cancelling`，界面显示“取消中”。独立监督进程先请求正常取消，在有界时间内等待退出，必要时强制终止任务拥有的进程。Linux 下使用 child subreaper 收养派生进程，并通过稳定的 pidfd 句柄操作进程，覆盖脱离进程组的命令、避免 PID 复用误伤并回收退出的子进程。确认清理完成后才提交 `cancelled`，后来到达的成功结果不能覆盖取消。共享 daemon 由父进程持有，不属于任务进程清理范围。

任务执行要求 Linux x64/arm64、glibc，以及支持 pidfd 和 child subreaper 的内核；不满足条件时在推理开始前报告错误。运行时关闭会取消它持有的任务。取消不会撤销已经发生的文件修改、服务重启或远程提交。`events.jsonl` 保存已请求、已完成和被中断的操作、worker 结果及最终状态；归档会话保存工具参数和结果。Bash 的标准输出和错误输出另外合并写入任务 `intermediate/bash-*.log`，路径登记在 `job.json` 的 `outputFiles`；被强制终止后仍保留已接收的输出。运行时临时文件使用该任务中间目录，不使用 `/tmp`。被中断的操作可能已经部分完成，需要检查实际状态。

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

Worker 使用 Pi 的自动压缩，并支持按工具配置预算：

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

省略配置时使用上述默认值。`budgetTokens` 是输入上下文的压缩阈值；`keepRecentTokens` 是随摘要保留的近期历史，必须小于预算。运行时按各模型的窗口计算 `reserveTokens`，使压缩在工具预算处触发，模型本身的物理窗口保持不变。单次较大的工具响应可能暂时超过阈值，Pi 会在下一次 assistant 响应前压缩。

随包工具统一使用 272000 tokens 的压缩阈值，`service_keeper` 保留 4000 tokens 的近期历史，`tool_add` 保留 8000。用户安装的工具使用相同阈值，并保持各自的近期历史保留量。模型窗口较小时，以模型自身的物理上限为准。各工具可以在自己的 `TOOL.json` 中配置预算。

已完成任务的交接信息可以直接用于压缩历史，无需额外请求模型。达到预算时会触发压缩，缓存复用预测不阻止压缩。用量记录包含预算、上下文估计、压缩用量、实际 thinking level 和共享历史发布信息。最终结果被接受后，任务立即完成并发布历史，不再追加摘要请求。

所有 agent 工具的共享历史只保存已完成结果及来源观察时间，完整中间记录保存在独立请求的会话文件中。摘要只能替换快照实际覆盖的共享历史前缀，后续完成的任务继续保留。旧快照的摘要不能替换更新的共享压缩结果。已有串行 worker 会话在首次创建快照时保留为共享历史。压缩保留固定系统提示词，每个任务向 `journal.jsonl` 追加一条简短记录。

Worker 文件位于：

```text
~/.pi/agent/tool-workers/<worker-key>/
├── memory.md
├── journal.jsonl
├── shared.jsonl     # agent 工具的已完成历史
└── runs/            # 独立请求的完整会话
```

## 进度显示

Pi Web 原工具卡片的即时结果显示、刷新恢复及服务启用步骤见 [Pi Web 集成说明](integrations/pi-web/README.md)。

Worker 通过 IPC 发送真实工具活动和阶段变化，任务管理对象保存 `progress.jsonl`，并按界面能力显示进度。交互界面使用独立任务窗口，无交互界面时通过 `onUpdate` 更新所属工具调用。每次模型请求只记录一次等待状态，流式 token、模型过程叙述和思考原文不产生进展消息。重复输出预览会去重，完整命令输出仍然归档。

活动任务使用事件订阅，只有缺少订阅时才轮询文件，内容未变时不推送。每次只发送当前活动或状态变化，不重复发送已有历史。仅耗时变化不会触发进展消息，`startedAt` 和 `finishedAt` 供客户端自行计时。

- TUI 和 RPC 界面为每个任务显示独立进度窗口与状态键。存在 `onUpdate` 回调时窗口仍然显示，进度不再重复发送到工具消息。
- Print、JSON 等无交互界面的调用通过 `onUpdate` 接收进度。同一内部调用的连续进展合并成一条历史记录，确认进入终止状态四秒后清除窗口，取消完成时只通知一次。
- `/tool-progress` 固定显示一个快照 30 秒，然后清除；`/tool-progress off` 立即清除。匹配不到任务的引用只会打印一条警告，不会创建组件。

引用任务时不需要完整任务 id：

| 输入 | 效果 |
| --- | --- |
| `/tool-progress` | 显示正在运行的任务或最近一个任务。 |
| `/tool-progress list` | 列出最近的任务和它们的短 id。 |
| `/tool-progress <index>` | 按序号选择一个任务。 |
| `/tool-progress <short id>` | 按短 id 选择一个任务。 |
| `/tool-progress <fragment>` | 在只匹配一个任务时，接受 id 的前缀、后缀或片段。 |

组件标题和状态行显示短 id。排队、模型请求、内部工具、服务等待、上下文压缩和取消分别记录活动，`/tool-progress` 同样包含两个管理工具。部分输出最后会被最终工具结果替换，因此只有结果进入对话。进度文件里的内容不会追加到主对话，也不会进入 worker 后续的回合。

## 内置工具

`basic-tools/` 存放这个包自己需要的工具。它们本身就是普通的工具目录，因此也会出现在 pi 的工具列表里：

- `basic-tools/tool_add/` —— agent 工具。它自己的 worker 提示词在 `basic-tools/tool_add/agent/`；`manager.ts`、`plan.ts` 和 `artifacts.ts` 实现 worker 调用的进程内管理动作。清单声明 `"handler": "tool_add"`，独立 worker 通过 IPC 请求父进程向正在使用的工具注册表注册工具。
- `basic-tools/service_keeper/` —— agent 工具，检查和恢复 agent 目录 `services/registry.json` 中登记的服务，以及已安装工具声明的 daemon。它声明 `"handler": "service_keeper"`，独立 worker 通过 IPC 请求运行时管理工具 daemon。

包内工具以 `package` 作用域运行。它的 daemon 在工具目录中启动，状态保存在 agent 目录下，不需要项目受信任。

## tool_add

`tool_add` 只接收一个自然语言 `request` 参数，工具名称、来源路径、需求和作用域都写在请求中。Worker 提取内部管理动作并执行，作用域默认 `project`，请求明确指定时使用 `user`。它同步返回结果，推理在受监督的独立子进程中运行。

Worker 使用 `basic-tools/tool_add/agent/` 中的提示词文件，以及只读工具和 `tool_add_manage`。`tool_add_manage` 是由 `manager.ts` 实现的进程内动作；只有 worker 会提供 `plan` 调用它。

### 内部动作

Worker 将 `request` 转换为 `list`、`inspect`、`validate`、`add`、`convert_skill`、`create_tool`、`disable` 或 `enable`，并通过 `tool_add_manage` 执行。

### 转换技能

```json
{
  "request": "把 /path/to/SKILL.md 转换成项目工具。"
}
```

Worker 读取技能和它的附属文件，根据技能的实际行为设计一个方案，并用这个方案调用 `tool_add_manage`。管理器校验方案，写入 `TOOL.json`、`AGENT.md`、`WORKFLOW.md` 和可选的 `EXAMPLES.md`，然后注册工具。Worker 最后用 `submit_result` 返回结果，内容只包含管理结果。

### 按需求创建工具

```json
{
  "request": "创建项目工具 log_tail_summary，汇总日志文件最近的错误行。输入是日志路径和行数，返回错误总数与各错误码次数。"
}
```

调用方在 `request` 中给出本轮目标、必要新增条件和需求文件引用；`tool_add` 不读取主对话。Worker 从请求、同目标的已完成历史和所引文件确认工具功能、输入、结果以及必须使用的脚本、服务或路径，不要求调用方复制已有需求说明。Worker 设计方案，并按与转换相同的方式应用。

创建和转换工具时，描述使用一句简短的能力说明，参数只保留调用方必须提供或独立控制的信息。通用 worker 优先使用一个自然语言 `request` 或 `task` 参数，传入本轮目标、必要新增条件和引用；只需要路径的工具可以直接使用 `path`。`request`、`task` 的说明统一为“本轮目标及新增条件；已有背景和配置只给引用。”，并用简短目标展示调用示例。其他参数说明保持简短，必要的校验和授权字段保留。操作步骤、脚本选项、环境配置、来源核实、输出与安全规则写入工具内部的 `AGENT.md`、`WORKFLOW.md`、`EXAMPLES.md`。`whenToUse` 只保留必要的选择场景，`notFor` 只说明实际的歧义或安全边界。

新生成的工具默认同步执行，不附加 `mode`、`timeoutMs` 和 `jobId`。技能行为或需求确实需要后台执行时，在方案中设置 `execution.asyncByDefault: true`，由运行时添加任务控制参数。

生成的工具必须包含：

- 简短的能力说明，且 `whenToUse` 至少有一项；
- 封闭的输入 schema，只保留必要字段，字段有类型和简短说明，`required` 非空；
- 封闭的结果 schema，字段有类型和说明，每个字符串都有 `maxLength`，每个数组都有 `maxItems`；
- worker 系统提示词，以及以 `submit_result` 结束的工作流；
- 只有在技能或需求给出对应的脚本或服务器时，才声明服务。Daemon 以 `lifecycle: "persistent"` 和 `start: "eager"` 声明，因此持续运行并随工具启动。

方案缺少任何一项时，管理器会拒绝它并返回具体问题，worker 可以修正方案后再次调用 `tool_add_manage`。调用 `convert_skill` 时没有提供方案，管理器会退回到确定性生成器，输入只保留 `task`，默认同步执行。`create_tool` 必须提供方案。

生成的工具使用方案建议的权限。方案默认只读；要允许 `bash`、`edit` 或 `write`，请修改 `TOOL.json`。

添加工具时，在 `request` 中提供 TOOL.json 或工具目录的路径。整个来源目录会被复制；agent 工具缺失的说明文档由管理器补齐。校验工具时，worker 读取指定 TOOL.json 并将清单对象交给管理器。

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

## 友情链接

[LINUX DO](https://linux.do/) — 新的理想型社区
