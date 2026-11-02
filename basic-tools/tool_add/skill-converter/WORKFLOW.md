# Conversion workflow

1. Read SKILL.md completely.
2. List and inspect the skill directory. Read supporting instructions, scripts, and references that affect execution.
3. Extract the stable role, constraints, and expected result from the skill.
4. Write the selection text:
   - `description`: what the tool does and when the main agent should choose it, at least 20 characters.
   - `whenToUse`: at least one specific situation. This is what the main agent compares against the request.
   - `notFor`: the nearby requests this tool must refuse.
5. Design the tool input schema:
   - Declare only fields the worker consumes. Include `task` and `context` when the worker needs natural-language direction.
   - Give every field a type and a description, mark the always-present fields in `required`, and set `"additionalProperties": false`.
   - Do not accept fields the worker ignores.
6. Design the result schema:
   - Derive the fields from the input and the decision the caller makes next. If the input asks only for a count, the result carries the count.
   - List the always-present fields in `required`, set `"additionalProperties": false`, and describe every field.
   - Declare typed fields instead of an object bag. A field named `result`, `details`, `notes`, or `output` with `type: "object"` is rejected as a catch-all.
   - Add `maxLength` to every string field and `maxItems` to every array.
   - Allow no field to carry logs, transcripts, commands, or a step narrative.
   - Keep summary short and factual, at most 300 characters, and keep it in the envelope rather than the result.
   - Use artifacts for large outputs or generated files instead of long strings.
7. Write agent.instructions:
   - Role and scope.
   - What the worker must not do.
   - When to return needs_input.
   - Required submit_result behavior and the rule that only declared result fields are returned.
   - At least 80 characters, complete without the skill file.
8. Write agent.workflow:
   - Ordered steps, from reading the input to the final submission.
   - Tool and service usage.
   - Failure handling.
   - A final submit_result call, at least 80 characters.
9. Decide services:
   - Use a script service only for an existing executable script in the skill directory that speaks the `json-stdin-stdout` protocol. Declare `type`, `command`, `args`, and optional `timeoutMs`.
   - Use a daemon service only when the skill clearly starts a long-running server. A daemon must use `jsonl-stdio`, `unix-jsonl`, or `http-json`, and must set `lifecycle: "persistent"` and `start: "eager"` so it runs continuously. Add a `healthCheck`.
   - A command line tool with subcommands and plain text or JSON output does not speak a service protocol. Give the worker `bash` permission and let it invoke the script instead.
   - Otherwise omit services.
10. Choose permissions:
    - read is normally true.
    - write, bash, and network default to false.
11. Validate the plan in your head. Then call submit_result with the complete plan.
