# Examples

## Compact caller interface

For a general management worker, follow the existing `ssh_manager` shape:

- Description: `按自然语言查询和维护 SSH 配置中的设备。`
- Input:

```json
{
  "type": "object",
  "properties": {
    "request": { "type": "string", "maxLength": 4000, "description": "用自然语言说明要查什么或改什么。" }
  },
  "required": ["request"],
  "additionalProperties": false
}
```

The request includes the target and necessary background. The worker reads its
configuration and follows the full procedure in its internal instructions.
Execution defaults to synchronous; no job control fields are exposed. Enable
`execution.asyncByDefault` only for a tool that needs background execution.
A focused tool can use a single typed value such as `path` instead.

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
