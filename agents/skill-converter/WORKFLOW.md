# Conversion workflow

1. Read SKILL.md completely.
2. List and inspect the skill directory. Read supporting instructions, scripts, and references that affect execution.
3. Extract the stable role, constraints, and expected result from the skill.
4. Design the tool input schema:
   - Include task and context fields when the worker needs natural-language direction.
   - Add typed fields when the skill has a clear structured input.
   - Mark required fields and avoid unnecessary optional fields.
5. Design the result schema:
   - Put the business result in result.
   - Keep summary short and factual.
   - Use artifacts for large outputs or generated files.
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
   - Use a script service only for an existing executable script in the skill directory.
   - Use a daemon service only when the skill clearly starts a long-running server.
   - Otherwise omit services.
9. Choose permissions:
   - read is normally true.
   - write, bash, and network default to false.
10. Validate the plan in your head. Then call submit_result with the complete plan.
