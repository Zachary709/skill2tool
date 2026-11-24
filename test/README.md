# 任务控制验收

## 自动回归

```bash
npm run typecheck
npm test
```

`cancellation.test.ts` 使用真实命令、独立 worker、Linux 进程监督和 HTTP 文件监听服务，检查：

- 取消运行中的命令时，外层等待先结束，任务状态保持取消中，确认进程退出后才变为已取消。
- 排队任务不启动进程；等待真实历史快照锁时可取消，且没有发出模型请求。
- 忽略 SIGTERM 的命令会被强制终止，派生进程和退出后的子进程均被回收。
- worker 已产生成功结果但清理尚未结束时，取消仍然优先，成功结果保存在操作事件中。
- 取消 HTTP 文件变化等待会释放该请求，并保留共享服务；服务中的文件监听数量恢复为零。

`fixtures/process-control/command.mjs` 实际执行指定程序并返回退出状态。`file-watch-server.mjs` 实际监听文件，只有文件更新时间发生变化才返回结果；客户端断开时释放监听。

## 工具发现验收

`runtime.test.ts` 通过真实 SDK 检查多候选搜索和输入契约查看均不改变活动工具列表，同时检查手动加载、收起、重置及原工具输入校验。

`discovery.test.ts` 通过实际文件扩展与 `builtin:tool-search` 连续加载、重载，检查没有错误或警告，`tool_find`、`tool_use` 与内置搜索分别注册。它同时检查只读搜索、契约查看、内置搜索被激活时的提示词，以及重置后的活动工具列表。

```bash
node --experimental-transform-types test/verify-discovery.ts
```

该脚本使用当前真实模型和两个独立 SDK 对话，在隔离目录中加载实际词数统计工具及命令工具。它检查搜索返回多个候选后列表保持不变，查看契约不加载，执行 Node.js 版本查询后只加入命令工具；另一对话保持独立。缺少必填字段和真实权限策略拦截的调用均不会激活工具。脚本同时加载 `builtin:tool-search`，检查它与插件入口分别注册，并且加载时没有错误或警告。

模型凭据和代理要求同下节，会产生模型调用费用；不调用用户级工具业务或操作外部服务。会话、真实工具结果与各阶段工具列表保存在 `_intermediate/agent-runtime-checks/discovery-runtime-*/verification.json`。

## 真实模型与 SDK

在已有 Pi 模型凭据和受信任的工作目录下运行，使用当前模型对应的 `PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`，代理通过正常环境变量配置：

```bash
node --experimental-transform-types test/verify-cancellation.ts
```

该脚本会调用真实模型，并在被忽略的 `_intermediate/agent-runtime-checks/` 下创建隔离项目及命令工具。它验证：

- 独立 `tool_add` worker 通过 IPC 调用父进程管理动作，实际创建并注册工具。
- 单项取消模型等待，不影响另一个并行任务，进展分别关联各自的 toolCallId 和 jobId。
- 外层 agent 忙碌时，`/tool-cancel all` 可以直接执行，不等待模型结束，取消后不增加模型请求或重新启动任务。
- 两个独立 bash 命令实际启动并输出真实系统信息后，停止外层 agent 可及时结束外层等待，并取消同一运行下的全部子任务；进展事件和完整命令输出在取消后仍有记录。
- 清理完成后，已登记的任务 PID 和派生进程 PID 不再存在。
- 独立 `service_keeper` worker 通过 IPC 读取父进程中的工具 daemon 注册信息。
- 调用方模型、thinking level 与 272000 tokens 压缩阈值保持不变。

执行目录、会话、实际工具结果、进展事件、取消耗时和任务记录保存为 `_intermediate/agent-runtime-checks/cancellation-runtime-verification.json`。命令会产生模型调用费用。隔离目录保留以供检查，不向用户级工具目录安装验证工具，不提交远程计算任务，不修复或重启外部服务。

## 进展更新验收

`runtime.test.ts` 的真实任务进展用例同时检查事件订阅和文件轮询：没有实际变化时不重复发送消息，取消后只交付一次最终状态。

`progress-ui.test.ts` 使用真实 SDK RPC 服务和客户端，同时运行两个实际命令。它检查存在和缺少 `onUpdate` 回调时均有独立进度窗口、静默期间窗口不重发、取消一个任务不影响另一个，以及取消和正常完成后的窗口、状态与进程清理。该验收不调用模型，不创建模拟 UI；RPC 事件和任务结果保存在 `_intermediate/agent-runtime-checks/progress-ui-*/`。

```bash
node --experimental-transform-types test/verify-progress.ts
```

该脚本通过真实 SDK 和模型执行 `uname` 与等待命令，检查静默时无重复更新、重复系统信息只显示一次、每次更新不重发历史、同一内部调用合并展示，以及完整输出仍保留实际重复行。结果保存到 `_intermediate/agent-runtime-checks/progress-runtime-verification.json`。模型凭据和环境变量要求与前述 SDK 验收相同，会产生模型调用费用。

## Web 工具卡片验收

```bash
node --experimental-transform-types test/verify-result-display.ts
```

该脚本使用修复后的 Pi Web 源码、独立本机服务、真实 Chromium 和真实模型，直接检查原生 `read` 的原工具卡片。它确认同批 `bash` 仍在等待实际文件时，`read` 已显示实际文件内容；刷新后仍保留结果，正式会话中每个调用只保存一次结果。检查实际 DOM 与 SSE 事件，不拍摄截图，不模拟模型或网络。

源码默认位于 `/home/data/data_zhangdw/work/tools/pi-web`，可用 `PI_WEB_SOURCE_DIR` 指定。模型与代理要求同前，会产生模型调用费用。证据保存在 `_intermediate/agent-runtime-checks/web-tool-results-*/verification.json`。构建、启用与当前服务的重启要求见 [Pi Web 集成说明](../integrations/pi-web/README.md)。

## 跨对话并行验收

`concurrency.test.ts` 使用实际文件监听命令和 Node.js 版本查询，检查同一对话的串行排队、不同对话的独立调度，以及另一个运行时初始化和关闭时保持活动任务的所有权与状态。`agent-context.test.ts` 使用独立历史管理器和真实查询结果，检查后发先完成的任务先进入共享上下文，活动快照保持隔离。

```bash
node --experimental-transform-types test/verify-concurrency.ts
```

该脚本使用真实模型、三个独立 SDK 对话和实际 Bash 命令，检查同一项目及不同项目调用同一个用户级历史工具时可以并行执行；新对话不会把活动任务标记为丢失。第一个命令等待真实文件，其他对话完成系统信息查询后才提供该文件，随后检查 worker 会话隔离、结果与调用方关联、按返回顺序追加共享上下文及任务进程清理。模型、thinking level 和工具的串行配置保持不变。证据保存在 `_intermediate/agent-runtime-checks/concurrency-runtime-*/verification.json`，模型凭据和代理要求同前，会产生模型调用费用。

## 工具选择验收

```bash
node --experimental-transform-types test/verify-routing.ts
```

需要已安装用户级 `ssh_manager`，模型与代理环境要求同前。该脚本使用实际工具声明和真实模型，检查本机 GPU、泛称本机设备、当前主机名及本地文件分别选择 `bash` 或 `read`，SSH 配置查询与明确远程 SSH 目标选择 `ssh_manager`。调用在执行前拦截，不执行设备命令、建立 SSH 连接或运行其他工具业务。结果保存到 `_intermediate/agent-runtime-checks/routing-runtime-verification.json`。

## 平台与界面

已验收环境为 Linux x64、glibc、Node.js 22，内核支持 pidfd 和 child subreaper。Linux arm64 分支未在本机验收；原因是当前主机为 x64。该平台上的最小验证方式是运行上述自动回归和真实模型脚本，预期全部通过且结束后没有任务进程残留。不支持的系统会在推理开始前报告错误，不使用降低进程隔离能力的替代方式。

SDK 验收检查真实进展事件、任务关联与 RPC 窗口请求，没有进行交互前端的视觉验收。界面的最小检查步骤：重载后启动两个并行调用，观察各自独立进度窗口；用 `/tool-progress list` 取得短编号，执行 `/tool-cancel <短编号>`，再检查另一任务仍继续运行。预期每个任务只显示一份进度，静默期间窗口不重发，终止窗口四秒后清除。同一内部调用的输出合并展示，取消中与已取消的状态明确，取消一个任务不影响另一个。耗时可由客户端依据时间字段自行显示。RPC 客户端需要支持 `setWidget` 和 `setStatus` 请求；无交互界面的 Print、JSON 调用使用 `onUpdate`。

取消不会自动撤销已经发生的文件修改、服务重启或远程提交。事件中的中断操作可能有部分效果，应检查实际状态；不能将取消状态理解为操作已经撤销。新任务控制逻辑在重载后启动的调用中生效，不自动接管旧运行时的进程。
