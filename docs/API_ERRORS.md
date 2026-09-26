# 错误契约

Server 的 REST、媒体 Worker 的 HTTP 和房间 WebSocket 共用 `protocol::ApiError`。定义与枚举见 `crates/protocol/src/errors.rs`；生成类型为 `packages/protocol/index.ts`，JSON Schema 为 `packages/protocol/error-response.schema.json`。新增公开错误码必须进入该枚举并重新导出。

```json
{
  "error": {
    "code": "STALE_MEDIA",
    "message": "房间状态已改变，请同步最新状态后重试",
    "retryable": false,
    "request_id": "11111111-1111-4111-8111-111111111111"
  }
}
```

WebSocket 消息另有 `type: "ERROR"`、可空 `command_id`；命令被 Actor 拒绝时附当前 `state`。格式错误且无法解析 UUID 时不回显原始 command_id。首次加入无权限、消息无效、限流和会话过期也会返回此契约；连接传输已失效时不能保证客户端收到最后一条错误。

HTTP 状态仍表达请求结果。响应中的 `request_id` 由服务端生成，与 `X-Request-Id` 响应头和失败日志对应，不信任客户端提供的同名头。日志包含错误码、状态和诊断编号，不把原始 URL/请求体加入这条日志。成功响应也有 `X-Request-Id`。

错误正文只使用允许列表中的公开错误码和固定说明。未知内部错误回退为状态对应的通用错误，不包含数据库异常、凭据、签名 URL、宿主机路径或框架解析详情。错误响应禁止缓存。Worker 的 `Content-Range` 等协议头保留，HEAD 不发送正文。中间层最多读取 16 KiB 错误正文并等待 1 秒，超限/超时丢弃原正文后返回通用错误，正常媒体流不经缓冲。

## 客户端处理

| 情况 | 处理 |
|---|---|
| `LOGIN_REQUIRED` / `SESSION_EXPIRED` / `NOT_A_MEMBER` / `ORIGIN_REJECTED` | 停止自动重连并提示登录或连接授权问题 |
| `CONTROLLER_REQUIRED` / 通用 `FORBIDDEN` | 只拒绝本次操作，保留观看和聊天连接；兼容旧 `forbidden` 字符串 |
| `REVISION_CONFLICT` / `STALE_MEDIA` | 使用当前状态或重新取快照，不盲目重放旧操作 |
| `COMMAND_PAYLOAD_CONFLICT` | 同一编号对应另一请求，新操作使用新编号 |
| `COMMAND_REPLAY_UNVERIFIABLE` | 旧数据没有可验证请求，取快照并重新操作 |
| `RANGE_NOT_SATISFIABLE` | 根据 Content-Range 重新确认资源长度 |
| 不兼容媒体/设备 | 展示具体原因；不能把认证或网络失败当作解码失败 |
| `retryable: true` | 允许调用者按有界策略重试，不代表 UI 已自动重试，也不替代请求幂等 |
| 内部错误/提交失败 | 保留诊断编号，先确认状态，不能假设操作没有生效 |

`retry_after_ms` 可选，仅在服务端有确切时间依据时设置；当前实现不虚构等待时间。WebSocket 队列、探测繁忙和部分上游暂时失败可重试，授权、冲突及结果不确定的提交失败不可盲重试。媒体探测与播放自动降级的完整策略仍按 W02/W06 推进。

心跳只有确认数据库中登录会话不存在或过期时才发出 `SESSION_EXPIRED`。数据库查询失败返回 `SERVICE_UNAVAILABLE` 并关闭连接，Web 保留重连资格并复查登录。播放请求的 `PLAYBACK_REQUEST_INTERRUPTED` 可复用同 key 重试；每 key 三次执行用尽后返回不可重试的 `PLAYBACK_REQUEST_RETRY_EXHAUSTED`。完整语义见 [播放请求幂等](PLAYBACK_REQUESTS.md)。

## 从 alpha.1 升级

这是开发预览的错误响应形状变更：旧 `{ "error": "lowercase_code" }` 改为结构化对象。HTTP 路由和控制命令的 `protocol_version: 1` 未变；尚不承诺 alpha 错误形状稳定。

先部署支持两种形状的新 Web，再部署 Server/Worker；旧 Web 必须刷新，新 Web 可读取旧后端字符串。第三方客户端需从 `error.code` 读取机器码，并使用 `error.message` 展示文本，不能比较可翻译的说明文字。代理网关自身生成的非 JSON 错误不属于此契约，新 Web 对这类响应显示通用失败提示。

验证入口：`cargo test -p protocol`、`npm test`、`node tests/integration.mjs`、`npm run test:e2e`。真实数据库集成覆盖应用/提取器/路由错误、范围头及权限；浏览器测试用受控 HTTP/WS 响应验证 UI 展示和停止重连，不替代真实弱网验收。
