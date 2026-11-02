# Examples

For a text-processing skill, the input schema may contain a required `text` field and the result schema may contain a typed `count` or `items` field.

Input and output stay closed:

```json
{
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
      "matched_lines": { "type": "array", "items": { "type": "number" }, "description": "Line numbers, at most 20." }
    },
    "required": ["count"],
    "additionalProperties": false
  }
}
```

Avoid this shape, which accepts any process narrative:

```json
{ "type": "object", "properties": { "result": { "type": "object" } }, "required": ["result"] }
```

For an investigation skill, the input schema usually contains `task` and optional `context`. The workflow should tell the worker to inspect the workspace with read-only tools and submit a concise finding.

For a skill with `scripts/extract.py`, propose a script service named `extract` with `command: "python3"` and `args: ["scripts/extract.py"]`.
