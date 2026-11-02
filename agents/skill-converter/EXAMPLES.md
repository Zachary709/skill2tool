# Examples

For a text-processing skill, the input schema may contain a required `text` field and the result schema may contain a typed `count` or `items` field.

For an investigation skill, the input schema usually contains `task` and optional `context`. The workflow should tell the worker to inspect the workspace with read-only tools and submit a concise finding.

For a skill with `scripts/extract.py`, propose a script service named `extract` with `command: "python3"` and `args: ["scripts/extract.py"]`.
