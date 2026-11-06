# Workflow

1. Read `request` and `allowRepair`. Extract the target and decide its kind:
   - a tool daemon declared by an installed tool;
   - an external service in `<Agent directory>/services/registry.json`.
   Use `service_keeper_manage` `action: "list"` and the registry to match the
   named target. An unknown or ambiguous name requires `needs_input`.
2. For an external service, read the registry and select the target named in
   `request`. With no named target, check all registered services and tool
   daemons. Only an explicit `allowRepair: true` permits recovery actions.
3. For an external service, collect read-only state:
   - the registered `status` command and its exit code;
   - the two registered HTTP checks with
     `curl -s -o /dev/null -w '%{http_code}' -m <timeout> <url>`;
   - the registered `detail` command when the unit is not active or a check
     failed.
4. For a tool daemon, call `service_keeper_manage` `action: "status"` with the
   tool and service. A daemon is healthy when its process is alive and, for a
   protocol with an endpoint, the endpoint is reachable.
5. Classify: healthy, not running, or running but unhealthy.
6. Healthy: submit `ok` with the evidence and no action.
7. When `allowRepair` is false or omitted: submit `ok` with the state and the
   action that would be allowed. Do not start or restart anything and do not
   write state.
8. For an external service, verify the registered start or restart command
   against the allowlist form `systemctl --user <start|restart> <unit>`.
   Mismatch: submit `needs_input`.
9. For an external service, read `<Agent directory>/services/state.json` and
   apply `cooldownSeconds` and `maxActionsPerDay`. A blocked action is
   `needs_input`, with the remaining budget in the result.
10. Run the single external action. Record its exit code and a one-line output
    tail.
11. For a tool daemon that is not healthy and `allowRepair` is true, call
    `service_keeper_manage` `action: "restart"` with the tool and service. It
    restarts the process through the runtime. Re-run `action: "status"`
    afterwards.
12. Poll readiness in one bounded loop, then re-run the external `status`, both
    checks, and `detail`.
13. Collect the registered `logs` output, compressed to one line, when the
    service is still unhealthy.
14. Write `<Agent directory>/services/state.json` when an external action was
    taken.
15. Submit `ok` or `failed` with the `services` array: `service`, `healthy`,
    `state`, `action`, and `message` when there is evidence to report. For a tool
    daemon, use `<tool>/<service>` as the `service` value and `none` or
    `restart` as the action.
