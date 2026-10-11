# P20 局部落地：账号 status/check 与管理员设置响应边界

## 源码与边界

- 基线：`f5a6ce90daae97a548f60389ac6cb3a2a342a634`。
- 隔离分支：`dot/response-boundary-20261010`。
- 实际工作树：`/workspace/shared/rainsync-response-boundary-lane-20261010`。
- 对应方案 §4.6；这是 P20 的一个前端接缝，**不代表整个 P20 或发布门槛完成**。
- 父工作树及其五项 native 验证冻结源码没有修改；没有 DB、socket、真实浏览器、真实平台或推送操作。P08/P09 不在范围内。

### 完整覆盖的响应家族

1. Bilibili `GET /platform-accounts/bilibili`、`POST .../check`、`DELETE /platform-accounts/bilibili`。
2. Douyin/TikTok 各自 `GET /platform-accounts/{provider}`、`PUT .../credential`、`DELETE /platform-accounts/{provider}`。
3. YouTube 对应的 GET、credential PUT、DELETE，包括其原有 availability 字段。
4. 管理员设置 `GET /admin/settings` 与 `PATCH /admin/settings` 回执。

上述账号 API 返回 `Promise<unknown>`，不再通过 transport 泛型把 JSON 声称为 DTO。既有 request slot 接收 unknown，在原有 epoch / serial / abort 栅栏后交给原 parser，parser 返回 DTO 后才写入 store。账号公开 store 方法仍返回具体 DTO。cookie flow 同样在原 current 检查后消费 parser 返回的 DTO，不再读原始响应的 state。

管理员 GET/PATCH 调用显式请求 unknown，沿用原来的 `checkedSettings` 解析位置。PATCH 的解析仍在 receipt 专用 try/catch 内，schema 错误仍是“保存响应不完整、提交不确定”，而不是确认成功，也不会自动重试写入。

### 保持的业务行为

- 同源、`cache: no-store`、CSRF、JSON 失败和 `RequestFailure`、`StaleIdentity` 的 transport 行为不变。
- 先 fence 后 parse；畸形迟到账号成功回执仍优先产生 `StaleIdentity`，不触摸响应字段、不写旧缓存。
- 读取合并、写入互斥、刷新等待写入、身份退役、各 provider 超时和变更通知条件不变。
- revision 全程字符串，比较/递增保留 BigInt 精度。Bili/YouTube 的正整数规则、短视频原 `^\d+$`（含 0/前导零）的差异不做统一。
- provider、凭据方法、QR availability、verification、expiry、YouTube availability 及 Bili check 组合规则复用原 validator。
- 短视频 expired 原允许 unverified/none，YouTube 非 connected 必须 none 的差异保持。
- 平台 parser 原有白名单复制保持；cookie 输入校验、清空时机、单次显式提交和不回显凭据不变。
- 管理员 CAS、revision 上界、有效值一致性、权限失效、草稿保留、冲突、提交不确定及“已保存但刷新失败”区分不变。

### 明确的接受集变化（不是纯类型提取）

所有现有 parser 增加 JSON record 形状窄化，排除 primitive/array，避免让未知值借助 DTO 注解通过。数组即使被非 JSON 测试桩人为挂上合法字段，也不是 DTO record。

管理员原 `checkedSettings` 直接返回原对象，并漏校验 `updated_at`。本次为完成 unknown → **完整既有** `AdminSettingsSnapshot`：

- `updated_at` 必须为 null 或 JavaScript 安全整数，不要求正数。合法 null、0、负安全整数及毫秒时间戳保留；缺字段、字符串、非有限值、小数及不安全整数拒绝。
- 服务端证据：`apps/server/src/admin_settings.rs` 的 SELECT 取 `floor(extract(epoch FROM updated_at)*1000)::bigint AS updated_at_ms`；snapshot 始终输出 `row.try_get::<Option<i64>,_>("updated_at_ms")`；PATCH 用 `clock_timestamp()` 写入。`tests/admin-settings.mjs` 现有真实协议测试也检查初始 null 与保存后的毫秒数；本轮只阅读，没有运行该 DB 测试。
- 这是对不满足既有前端 number/null 时间戳契约的回执的收窄，未新增其他业务范围约束。数据库 bigint 的全部数值范围大于 JS 安全整数；本轮不声称所有可能的 i64 时间戳都能无损用于前端，超出安全范围的回执按不完整处理。
- parser 显式复制 DTO 各层已声明字段，丢弃额外字段，包括服务端额外的 `origins`（本页不读取该字段）、未知 secret 字段及嵌套额外字段，不保留原对象引用。
- 新负控分别覆盖：PATCH malformed updated_at → uncertain、保留原 revision/draft、重复 save 不发 PATCH；GET malformed updated_at → 原读取错误路径；已退役 PATCH 回执不被解析或误记为当前 uncertain。

### 明确不覆盖

- `shared/api/client.ts` 泛型兼容入口及 `as T` 仍供其他尚未迁移的调用者使用；只把实际 JSON 局部变量标为 unknown。本次没有宣称完成所有 HTTP 响应的全局迁移。
- QR `PlatformLogin` start/poll/cancel 和请求绑定校验仍在原 flow，不修改登录协议、能力 URL、时序或 binding。
- Bilibili renewal、独立 OAuth 响应、playback plan、生成 DTO、SQL 合同迁移和 Rust 路由/业务实现未改。
- 没有 UI 视觉变更，没有为这轮增加 browser/native 验证声明。

## 验证方式与结果

依赖从基线同一 `package-lock.json` 的 `node_modules` 创建本工作树 hardlink 副本；没有安装或修改依赖。已执行 `cmp` 确认 lockfile 相同，`realpath node_modules/@rainsync/web` 是本工作树的 `apps/web`，不是旧 checkout。Vitest 的 root 是本工作树，缓存定向 `/tmp/rainsync-response-boundary-artifacts`。

所有命令均从上述实际工作树执行：

```sh
node scripts/verification/response-boundary-types.mjs
./node_modules/.bin/tsc --noEmit -p tests/tsconfig.response-boundaries.json
./node_modules/.bin/vue-tsc --noEmit -p apps/web/tsconfig.json
npm run lint
RAINSYNC_ARTIFACT_DIR=/tmp/rainsync-response-boundary-artifacts \
  ./node_modules/.bin/vitest run --maxWorkers=2
```

类型夹具不依赖 Vitest 转译充当类型检查：独立 tsc 编译，验证九个账号 API 方法结果均为 unknown、九个公开 store 方法结果均为对应 DTO，并用 `@ts-expect-error` 禁止未解析赋值。验证脚本另外在编译器内存中把 Bili status 改回 `api<PlatformAccountStatus>`，要求 TS2344（unknown 类型断言失败）与 TS2578（负向赋值不再报错）同时出现。该负控不改工作树。

- 定向原有及新增测试首轮：10 文件、219 测试通过（随后新增 updated_at 组件负控，完整重跑覆盖最终集合）。
- 独立 tsc、生产 vue-tsc、全源码 lint：通过。
- 全量默认并发首轮：168 文件中 165 通过；2748 测试通过，3 例触发默认 5000ms timeout，分别是 action-feedback、source-draft-component、registration-policy-component 的既有用例。没有断言差异，但该轮不能算全绿。没有提高 timeout。
- 受限 worker 完整重跑：`--maxWorkers=2`，168 文件、2756 测试通过（164.49s），默认 5000ms timeout 未改。
- 最后补充 Bili check 迟到 getter 栅栏和 updated_at=-1 正控后，定向 10 文件、226 测试通过（11.07s）。这轮覆盖最后新增的两例 check 栅栏测试；不把前述 2756 误报成最终一次性 2758。完整重跑与补充测试使用相同的最终生产源码。
- 编译器内存负控：通过，真实源码诊断为 0，绕过 parser 的内存变体准确产生 TS2344 与 TS2578。

负控还覆盖 primitive/array/不完整回执、四 provider 的迟到 poisoned receipt 不触碰、当前错误不污染缓存/change、跨 provider/凭据方法与伪造验证状态、超 MAX_SAFE revision、完整深层白名单、cookie flow 使用 parser DTO、管理员未知 PATCH 不确定及重试阻止。

## 导航与证据限制

未发现可用 GitNexus MCP 工具或当前安装的 CLI，未安装工具、未更改 MCP 权限，按 AGENTS.md 的明确 fallback 做直接源码与全调用链检查。因此没有声称拥有当前图索引、图 impact 或 detect_changes 证据。调用者检索范围为整个 `apps/web/src` 与相关测试；源码/类型/行为检查共同验证此次有限接缝。
