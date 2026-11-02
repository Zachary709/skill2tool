# Conversion workflow

1. Read SKILL.md completely.
2. List and inspect the skill directory. Read supporting instructions, scripts, and references that affect execution.
3. Extract the stable role, constraints, and expected result from the skill.
4. Design the tool input schema:
   - Include task and context fields when the worker needs natural-language direction.
   - Add typed fields when the skill has a clear structured input.
   - Mark required fields and avoid unnecessary optional fields.
   - Set `"additionalProperties": false`. Every input field is a fact the worker will consume; do not accept fields the worker ignores.
5. Design the result schema:
   - Derive the fields from the input and the decision the caller makes next. If the input asks only for a count, the result carries the count.
   - List the always-present fields in `required` and set `"additionalProperties": false`.
   - Declare typed fields instead of an object bag. A field named `result`, `details`, `notes`, or `output` with `type: "object"` and no properties is rejected as a catch-all.
   - Allow no field to carry logs, transcripts, commands, or a step narrative. Add `maxLength` to every free-text field.
   - Keep summary short and factual, at most 300 characters.
   - Use artifacts for large outputs or generated files instead of long strings.
6. Write agent.instructions:
   - Role and scope.
   - What the worker must not do.
   - When to return needs_input.
   - Required submit_result behavior.
7. Write agent.workflow:
   - Ordered steps.
   - Tool and service usage.
   - Failure handling.
   - Final submission.
8. Decide services:
   - Use a script service only for an existing executable script in the skill directory that speaks the `json-stdin-stdout` protocol.
   - Use a daemon service only when the skill clearly starts a long-running server that speaks `jsonl-stdio`, `unix-jsonl`, or `http-json`. Daemons also declare `lifecycle`.
   - A command line tool with subcommands and plain text or JSON output does not speak a service protocol. Give the worker `bash` permission and let it invoke the script instead.
   - Every service entry declares `type` (`script` or `daemon`), `command`, and `args`. No other `type` value is valid.
   - Otherwise omit services.
9. Choose permissions:
   - read is normally true.
   - write, bash, and network default to false.
10. Validate the plan in your head. Then call submit_result with the complete plan.
