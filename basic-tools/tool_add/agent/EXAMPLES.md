# Examples

## Compact caller interface

For a general management worker, follow the existing `ssh_manager` shape:

- Description: `查询 SSH 连接配置，对明确指定的远程 SSH 主机检查连接、执行命令或传输文件。`
- Selection: SSH connection configuration queries or operations on an explicitly identified remote SSH host. Ordinary local device queries and local commands use the caller's local tools; state this boundary in `notFor`.
- Input:

```json
{
  "type": "object",
  "properties": {
    "request": { "type": "string", "maxLength": 4000, "description": "本轮目标及新增条件；已有背景和配置只给引用。" }
  },
  "required": ["request"],
  "additionalProperties": false
}
```

State the current goal, necessary new conditions, and locating references.
Resolve pronouns without copying the user's whole message, prior outcomes,
implementation descriptions, or fixed parameters. Use task identifiers and file
paths only as needed to uniquely identify existing information; do not enumerate
supporting documents and result paths or add unrequested output metrics. The
worker reads matching completed history, configuration, source documents, and results. Include essential facts unavailable
from those sources and preserve current authorization limits. A search request
can simply say `查询英雄联盟 S16 当前赛况。`.
Execution defaults to synchronous; no job control fields are exposed. Enable
`execution.asyncByDefault` only for a tool that needs background execution.
A focused tool can use a single typed value such as `path` instead.

## Continue an existing task

When this worker has already identified the modified manifest, pass the new
operation without repeating the manifest contents or the previous validation:

```json
{"request":"重新校验上次修改的 TOOL.json。"}
```

The worker resolves the same target from completed history and reads the current
file. If history does not identify one target, the caller supplies its path.

## Convert a skill

Job input:

```json
{
  "request": "把 /work/skills/report/SKILL.md 转换成项目工具 report_summary。"
}
```

Steps: read `/work/skills/report/SKILL.md` and the files it references, design a
plan that keeps its behavior, then call:

```json
{
  "action": "convert_skill",
  "sourcePath": "/work/skills/report/SKILL.md",
  "scope": "project",
  "plan": {
    "name": "report_summary",
    "description": "提取报告中的主要结论和关键数字。",
    "whenToUse": ["需要把一个报告文件整理成结论与关键数字"],
    "notFor": ["需要生成新的报告正文"],
    "input": {
      "type": "object",
      "properties": { "path": { "type": "string", "description": "报告路径。" } },
      "required": ["path"],
      "additionalProperties": false
    },
    "output": {
      "type": "object",
      "properties": {
        "findings": {
          "type": "array",
          "maxItems": 20,
          "items": { "type": "string", "maxLength": 400 },
          "description": "Key findings, at most 20."
        },
        "figures": {
          "type": "array",
          "maxItems": 20,
          "items": { "type": "string", "maxLength": 100 },
          "description": "Important figures, at most 20."
        }
      },
      "required": ["findings"],
      "additionalProperties": false
    },
    "agent": {
      "instructions": "You read one report file and return its key findings and figures. Work only from the declared path. Finish with submit_result.",
      "workflow": "1. Read the report file.\n2. Extract the key findings and figures.\n3. Return only the declared result fields.\n4. Call submit_result.",
      "tools": ["read", "grep"]
    }
  }
}
```

Then call `submit_result` with the object returned by `tool_add_manage`.

## Create a tool from a requirement

Job input:

```json
{
  "request": "创建项目工具 log_tail_summary，汇总日志文件最近的错误行。输入是日志路径和行数，返回错误总数与各错误码次数。"
}
```

The requirements name no existing script or server, so the plan declares no
services. The new worker reads the file with read-only tools and returns
`total` and `by_code`.

## List tools

Job input:

```json
{ "request": "列出已注册的工具。" }
```

Call `tool_add_manage` with `{ "action": "list" }` and submit the returned
result. Do not design a plan.
