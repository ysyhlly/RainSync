# 播放请求幂等

播放请求的 `idempotency_key` 是 UUID。同一用户的一次播放操作在网络重试时沿用
相同 key 和相同请求载荷；不同请求复用 key 会冲突，新的用户操作使用新 key。
未提供 key 的兼容路径会分配新编号，不能获得跨次 HTTP 重试去重。
这与 [房间创建](ROOM_CREATION.md) 和注册邀请码的一次性消费是独立机制。

Server 在 PostgreSQL 保存请求摘要、执行租约、响应密文和终态；
重放仍检查确切登录、房间成员权限/代次、媒体代次、播放会话和片源权限。
已过期、停止或失权的结果不会重新授予播放；返回时刷新当前剩余期限与观测信息。
常规结果保留窗口为 48 小时，进行中的请求不能并行创建另一个执行者。

`PLAYBACK_REQUEST_INTERRUPTED` 可沿用 key 做有界恢复；每 key 最多三次执行，
用尽后返回不可重试的 `PLAYBACK_REQUEST_RETRY_EXHAUSTED`。
`DELETE /api/v1/playback-requests/{key}` 撤销对应请求；
取消/停止后不得为了重试重新恢复它。Static HLS、HTTP 文件续接等专用路径还检查
其来源绑定、期限和输出代次，不能仅凭相同 key 绕过这些授权条件。

公开错误形状与 `retryable` 见 [错误契约](API_ERRORS.md)。
`tests/playback-request.test.ts` 覆盖客户端请求行为；后端/集成验证要覆盖
提交结果不确定、同载荷重放、载荷冲突、超时中断、撤销登录及媒体换代。
客户端单元结果不代表真实上游播放或长时运行已通过。
