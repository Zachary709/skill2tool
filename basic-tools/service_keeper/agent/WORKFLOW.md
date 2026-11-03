# Workflow

1. Read `task`, `service`, and `allowRepair`. Read the service registry at
   `<Agent directory>/services/registry.json`, using the Agent directory from
   the system prompt's Runtime paths block.
2. Resolve the target services. With no `service`, take every registered
   service. Unknown name: submit `needs_input` with the registered names.
3. For each target, collect read-only state:
   - the registered `status` command and its exit code;
   - the two registered HTTP checks with
     `curl -s -o /dev/null -w '%{http_code}' -m <timeout> <url>`;
   - the registered `detail` command when the unit is not active or a check
     failed.
4. Classify: healthy, unit not active, or active but unhealthy.
5. Healthy: submit `ok` with the evidence and no action.
6. When `allowRepair` is false or omitted: submit `ok` with the state and the action the
   registry would allow. Do not run a start or restart and do not write state.
7. Otherwise verify the registered start or restart command against the
   allowlist form `systemctl --user <start|restart> <unit>`. Mismatch: submit
   `needs_input`.
8. Read `<Agent directory>/services/state.json` and apply `cooldownSeconds` and
   `maxActionsPerDay`. A blocked action is `needs_input`, with the remaining
   budget in the result.
9. Run the single action. Record its exit code and a one-line output tail.
10. Poll readiness in one bounded loop, then re-run `status`, both checks, and
    `detail`.
11. Collect the registered `logs` output, compressed to one line, when the
    service is still unhealthy.
12. Write `<Agent directory>/services/state.json` when an action was taken.
13. Submit `ok` or `failed` with the `services` array: `service`, `healthy`,
    `state`, `action`, and `message` when there is evidence to report.
