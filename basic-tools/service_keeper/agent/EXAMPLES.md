# Examples

## 只检查，不恢复

调用参数：

- `task`: 看一下资源看板服务是否正常，只检查不要重启。
- `service`: `adaptive-service`
- `allowRepair`: false

预期行为：读取登记表，运行 `systemctl --user is-active`，探测 `/healthz` 与
`/api/v1/snapshot`，两者都是 200 时提交 `ok`。结果里每个服务的 `healthy` 为
true，`before` 与 `after` 相同，不带 `action`，不写 `state.json`。

## 单元停止后启动一次

调用参数：

- `task`: 资源看板服务没响应了，检查一下，必要时执行登记表里的启动命令。
- `service`: `adaptive-service`
- `allowRepair`: true
- `context`: 规划时报 `cannot reach http://127.0.0.1:8765`

预期行为：单元为 `inactive`，两个检查失败，冷却与当日次数都允许，执行一次
`systemctl --user start adaptive-service.service`，按 `waitSeconds` 轮询就绪接口，
复查后提交 `ok`。结果里带 `action.kind`、`action.command`、`action.exitCode`、
`policy.remainingToday`，以及复查后的 `after`。

## 冷却期内被拒绝

调用参数：

- `task`: 再重启一次资源看板服务。
- `service`: `adaptive-service`
- `allowRepair`: true

预期行为：`state.json` 里上次动作距今小于 `cooldownSeconds`，不执行任何命令，
提交 `needs_input`。结果里给出 `policy.cooldownRemainingSeconds` 与当日已用次数。

## 服务健康但被要求重启

调用参数：

- `task`: 把资源看板服务重启一下。
- `service`: `adaptive-service`
- `allowRepair`: true

预期行为：单元 active、两个检查都通过。按登记的恢复规则，健康状态下不执行重启，
提交 `ok` 并在 summary 里说明“服务已健康，未执行动作”。
