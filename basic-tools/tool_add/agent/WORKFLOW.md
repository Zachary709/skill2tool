# Workflow

1. Read the job input and identify the `action`.
2. For `list`, `inspect`, `validate`, `add`, `enable`, or `disable`:
   - call `tool_add_manage` with the action and the request fields;
   - go to step 6 with the returned result.
3. For `convert_skill`:
   - read `sourcePath` completely;
   - list the skill directory and read the supporting instructions, scripts, and references that affect execution;
   - record every script, service, and executable entry point. The skill directory is bundled as `skill/` inside the new tool directory, so every command and instruction uses `skill/...` paths;
   - declare a service for each existing script or server that speaks a runtime protocol, and grant `bash` for bundled command line tools that do not;
   - inspect the parent repository for services the skill depends on but does not contain. A referenced `service/` or `services/` deployment unit is bundled next to `skill/`, so use `service/...` paths; add its systemd user unit to `externalServices` with health and readiness URLs when known;
   - design one complete plan from the skill's actual behavior;
   - call `tool_add_manage` with `action: "convert_skill"`, the source path, the scope, and `plan`;
   - on a plan validation failure, correct the reported fields and call it again.
4. For `create_tool`:
   - read `name` and `requirements` from the job input;
   - read project files only when the requirements name a script, a service, or a path that must be grounded;
   - design one complete plan that matches the stated requirement;
   - call `tool_add_manage` with `action: "create_tool"`, the name and requirements, the scope, and `plan`;
   - on a plan validation failure, correct the reported fields and call it again.
5. Check the manage result:
   - `ok`: continue;
   - `needs_input`: report it with the missing information;
   - `failed`: report the failure instead of retrying the same request.
6. Call `submit_result` with the manage result object and a short summary.

Do not call `tool_add_manage` more than three times for one job. Do not call actions the job did not ask for.
