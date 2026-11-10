# Workflow

1. Read `request` and extract one requested `action` and its necessary fields. Default the scope to `project`. Missing or ambiguous required information: submit `needs_input`.
2. For `list`, `inspect`, `validate`, `add`, `enable`, or `disable`:
   - for `validate`, read the named TOOL.json and extract its manifest object;
   - call `tool_add_manage` with the action and the extracted fields;
   - go to step 6 with the returned result.
3. For `convert_skill`:
   - extract the SKILL.md path from `request` as `sourcePath` and read it completely;
   - list the skill directory and read the supporting instructions, scripts, and references that affect execution;
   - record every script, service, and executable entry point. The skill directory is bundled as `skill/` inside the new tool directory, so every command and instruction uses `skill/...` paths;
   - declare a service for each existing script or server that speaks a runtime protocol, and grant `bash` for bundled command line tools that do not;
   - inspect the parent repository for services the skill depends on but does not contain. A referenced `service/` or `services/` deployment unit is bundled next to `skill/`, so use `service/...` paths; add its systemd user unit to `externalServices` with health and readiness URLs when known;
   - design one complete plan from the skill's actual behavior, following the compact caller interface rules in the system prompt;
   - shorten the capability description and parameter descriptions; describe request/task as the goal and necessary conditions, keep configured procedures in worker instructions, and preserve explicit business and authorization requirements; remove redundant selection text and input fields; keep execution synchronous unless the skill needs background execution;
   - call `tool_add_manage` with `action: "convert_skill"`, the source path, the scope, and `plan`;
   - on a plan validation failure, correct the reported fields and call it again.
4. For `create_tool`:
   - extract `name` and the complete `requirements` from `request`;
   - read project files only when the requirements name a script, a service, or a path that must be grounded;
   - design one complete plan that matches the stated requirement, following the compact caller interface rules in the system prompt;
   - prefer one `request` or `task` field containing the goal and necessary conditions; retain explicit business requirements, background, paths, and authorization controls; put configured procedures in worker instructions and keep descriptions short; keep execution synchronous unless background execution is needed;
   - call `tool_add_manage` with `action: "create_tool"`, the name and requirements, the scope, and `plan`;
   - on a plan validation failure, correct the reported fields and call it again.
5. Check the manage result:
   - `ok`: continue;
   - `needs_input`: report it with the missing information;
   - `failed`: report the failure instead of retrying the same request.
6. Call `submit_result` with the manage result object and a short summary.

Do not call `tool_add_manage` more than three times for one job. Do not call actions the job did not ask for.
