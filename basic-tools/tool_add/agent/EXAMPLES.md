# Examples

## Convert a skill

Job input:

```json
{
  "action": "convert_skill",
  "sourcePath": "/work/skills/report/SKILL.md",
  "scope": "project"
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
    "description": "Summarize one report file into its key findings and figures.",
    "whenToUse": ["需要把一个报告文件整理成结论与关键数字"],
    "notFor": ["需要生成新的报告正文"],
    "input": {
      "type": "object",
      "properties": { "path": { "type": "string", "description": "Report file to read." } },
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
  "action": "create_tool",
  "name": "log_tail_summary",
  "requirements": "汇总一个日志文件里最近的错误行。输入是日志路径和行数，结果是错误总数与每个错误码的次数。",
  "scope": "project"
}
```

The requirements name no existing script or server, so the plan declares no
services. The new worker reads the file with read-only tools and returns
`total` and `by_code`.

## List tools

```json
{ "action": "list" }
```

Call `tool_add_manage` with `{ "action": "list" }` and submit the returned
result. Do not design a plan.
