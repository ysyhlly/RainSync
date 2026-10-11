# Bilibili renewal 前端响应边界

基线：`d5528e4`。范围仅含 renewal GET/PUT 的前端 transport、parser、面板接收顺序及纯测试。

## 边界与接受集

- `bilibiliRenewalApi.status/disable` 返回 `Promise<unknown>`。路径、方法、
  `expected_revision`、`enabled: false`、AbortSignal 与原错误对象保持不变。
- `validateBilibiliRenewal(unknown)` 先验证非数组对象，并复用已有
  `validatePlatformAccountStatus` 完整验证/复制嵌套账号，再逐字段构造 DTO。
  根对象和账号的额外字段（包括 cookie、refresh token）均不读取、不传播。
- 明确新增拒绝形状：装饰了 DTO 字段的数组；缺少账号字段；错误 provider、
  非 UUID id、非字符串/非正十进制 revision、id/revision 的 null 配对错误，
  以及不合法账号 state。此前 renewal 只检查嵌套 provider，不能证明完整账号 DTO。
- 不新增业务规则：保持五种 renewal state 与 enabled 的既有对应关系；
  next_refresh_at 仍独立允许 null 或正安全整数，不增加 state/timestamp 关联。
  revision 保留精确十进制字符串，不转换 Number、不新增整数上界。
  当前账号元组匹配与 enabled 必须连接的判断仍在面板原有逻辑中。

## 请求时序与失败行为

GET 和 PUT 都先等待 unknown 响应，再检查存活、identity/account key、serial
及 abort，最后才调用 parser。迟到响应不会读取字段，也不会改写面板状态。
PUT 继续使用观察到的 revision；进行中的操作仍排斥重复写入。冲突、
传输不确定和 malformed receipt 保持原错误/不确定显示，不会自动重复 PUT。
合法 uncertain 回执仍为 disabled；只有刷新取得新的 enabled 回执后才可再次停止续期。

## 验证

- 定向 Vitest：`tests/platform-renewal-response-boundary.test.ts`、
  `tests/platform-renewal-component.test.ts`、既有 `tests/platform-oauth-account.test.ts`，
  `--maxWorkers=1 --no-file-parallelism`，144/144 通过。
- 覆盖完整/缺失字段、数组/primitive、嵌套 revision、secret 白名单，以及
  GET/PUT 的 epoch、user、csrf、账号 id/revision/state、serial、abort、unmount
  迟到 poisoned getter；覆盖 pending 合并、重复停止、冲突和 uncertain 恢复。
- Vue app typecheck 与独立 parser 测试文件的 TypeScript 检查通过。
  内存负控把 GET/PUT 恢复成 typed transport 时，两项精确 unknown 断言均编译失败。
- 保留首轮测试失败：Vitest 身份比较断言的 formatter 读取了故意设置的 secret
  getter；改为布尔身份比较后通过。额外编译 SFC 测试 helper 时发现既有
  `Vue.mergeModels` 类型声明缺口；没有修改公共 helper，不声称该额外检查通过。
- GitNexus MCP/当前可用 CLI 不存在，按 AGENTS 使用当前 checkout 源码分析。
  未运行 native、网络、数据库、socket、Cargo、浏览器或用户电脑验证；未 push。
  全量集成检查由父任务执行，以上纯测试不等于端到端验收。
