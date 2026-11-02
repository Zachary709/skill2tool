---
name: echo
description: Echo a short message with a fixed prefix. Use when the user needs a deterministic echo of their request.
---

# Echo

Return the user's message with the prefix `echo: `.

Steps:
1. Read the delegated task.
2. Call submit_result with status `ok`, a short summary, and result `{ "message": "echo: <task>" }`.
