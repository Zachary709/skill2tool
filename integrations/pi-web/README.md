# Pi Web 工具结果即时显示

适用于 `@agegr/pi-web` 0.16.0、Pi SDK 1.5.2。

修复后的源码保存在 `/home/data/data_zhangdw/work/tools/pi-web`，本目录的 `parallel-tool-results.patch` 保存相对于上游 `v0.16.0` 的修改。

## 行为

- 每个普通工具完成时，Web 服务立即转发其最终显示内容、错误状态和运行时间。
- `read`、`bash`、插件工具及其他普通工具的结果直接显示在各自原有工具卡片内。
- 同批其他工具继续执行时，已完成结果保持可见。
- 刷新网页时，服务重放尚未进入正式会话消息的已完成结果。
- 正式结果消息到达时，界面将临时结果交给会话消息；每个调用只显示一份结果。
- SDK 的执行、消息顺序、模型上下文及会话文件格式保持不变。

修改涉及 `lib/agent-event-wire.ts`、`lib/rpc-manager.ts` 和 `hooks/useAgentSession.ts`。浏览器检查位于 `e2e/parallel-tool-results.mjs`。

## 启用

当前 `pi-web` 启动入口已指向修复后的源码目录。正在运行的服务仍保留当前进程及任务；需要在所有对话任务结束后重启：

```bash
systemctl --user restart agegr-pi-web.service
```

随后强制刷新网页（`Ctrl+Shift+R`）。插件的 `/reload` 只重载会话扩展，不能替换 Web 服务和网页代码。重启服务会中断仍在执行的对话任务。

## 验证

生产构建和类型检查已通过。真实 Chromium、真实模型及原生 `bash`、`read` 调用检查了：

1. `bash` 等待实际文件期间，`read` 已在原工具卡片正文中显示实际文件内容。
2. 刷新网页后，已完成结果仍显示在原卡片中，等待中的命令继续执行。
3. 提供实际文件后，两项调用正常完成；正式会话中每个调用只保存一次结果。

在工具运行时项目目录执行：

```bash
node --experimental-transform-types test/verify-result-display.ts
```

使用当前环境中的 `PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL`，可通过 `PI_WEB_SOURCE_DIR` 指定源码目录。该检查启动独立的本机 Pi Web 服务，不停止当前服务，会产生模型调用费用；仅检查实际 DOM 和事件，不拍摄截图。检查结束时删除隔离目录中的凭据副本。

验收证据：`_intermediate/agent-runtime-checks/web-tool-results-7cTd3P/verification.json`。

后续更新全局 npm 安装可能替换 `pi-web` 启动入口；更新时需要确认新版本包含这些修改。
