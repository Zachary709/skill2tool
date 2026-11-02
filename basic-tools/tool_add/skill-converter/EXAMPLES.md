# Examples

A text-counting skill produces this selection text and result contract:

```json
{
  "description": "Count literal occurrences of a pattern in one file.",
  "whenToUse": ["需要统计一个文件里某个固定文本出现的次数"],
  "notFor": ["需要语义检索或摘要"],
  "input": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "File to inspect." },
      "pattern": { "type": "string", "description": "Literal text to count." }
    },
    "required": ["path", "pattern"],
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "properties": {
      "count": { "type": "number", "description": "Occurrences of pattern." },
      "matched_lines": {
        "type": "array",
        "items": { "type": "number" },
        "maxItems": 20,
        "description": "Line numbers, at most 20."
      }
    },
    "required": ["count"],
    "additionalProperties": false
  }
}
```

The input and output stay closed. Every string has `maxLength`, every array has `maxItems`, and no field carries the process.

Avoid this shape, which accepts any process narrative:

```json
{ "type": "object", "properties": { "result": { "type": "object" } }, "required": ["result"] }
```

For an investigation skill, the input schema usually contains `task` and optional `context`. The workflow should tell the worker to inspect the workspace with read-only tools and submit a concise finding.

For a skill with `scripts/extract.py` speaking JSON over stdin and stdout, propose:

```json
{
  "extract": {
    "type": "script",
    "command": "python3",
    "args": ["scripts/extract.py"],
    "protocol": "json-stdin-stdout",
    "timeoutMs": 30000
  }
}
```

For a skill that runs a long-lived HTTP server, propose a daemon that starts with the runtime and keeps running:

```json
{
  "panel": {
    "type": "daemon",
    "command": "node",
    "args": ["services/panel.mjs"],
    "protocol": "http-json",
    "url": "http://127.0.0.1:8765",
    "lifecycle": "persistent",
    "start": "eager",
    "healthCheck": { "method": "healthz" }
  }
}
```
