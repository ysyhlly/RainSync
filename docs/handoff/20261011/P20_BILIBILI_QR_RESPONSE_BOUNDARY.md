# P20 Bilibili QR 前端响应边界

## 范围

- 基线：`d5528e4d7ff3e9a6e770a1afe4cec22ff7d1f48b`。
- 隔离分支：`p20-bilibili-qr-unknown`；工作树：`/workspace/shared/rainsync-p20-bilibili-qr-20261011`。
- 只修改 `platform-account.api.ts` 的 QR start/poll/cancel 返回类型和 `platform-login-flow.ts` 的接收/解析边界，另附 QR 专属测试、编译夹具与本文档。
- 不修改 `PlatformAccountPanel.vue`、renewal、OAuth、shared API、package/CI、公共 response-boundaries 类型夹具或 P08/P09。本轮不代表完整 P20 或发布验收完成。

## 响应处理

1. QR start/poll/cancel transport 均返回 `Promise<unknown>`，请求路由、方法、body、同意续期参数、signal 与 cancel 的 10 秒 timeout 不变。
2. flow start/poll 接收 unknown，继续在原 `apply` 的 current（closed / generation / identity / abort）和原 deadline 检查之后解析。无效或已退役的响应不绕过原错误分类及状态更新路径。
3. `validate` 只读取八个既有 DTO 字段各一次，返回新白名单对象。定时 poll 只捕获这个对象；源响应后续变化不能改写 id 或本地 QR。额外字段（包括 getters）不枚举、不读取、不回传。
4. 原 id 与 key/loginId 绑定、pending QR 的 start 不可省略 / poll 仅可用 null 保留本 flow 已验证 QR、同一 capability 不可替换、Bilibili URL/query 校验均保留。URL 校验仍只用于 pending capability。
5. cancel 回执依然完全忽略，没有 parser，也不能将其称为已验证 DTO。Close 先退役本 flow；多次 Close 不重发取消，取消失败不重新开启 flow。terminal 回执继续清空 key/loginId/QR/expiry，确认回调和终态不自动重试。
6. 轮询最小间隔、原 expiry 上限/不可延长、cooldown、超时后显式重试、idempotency key 复用、独立过期 timer 和刷新后 suspended-timer 路径保留。

## 接受集收窄（不是纯类型改名）

- 响应必须是非 null 的 object record，排除 primitive 和 array，包括人为附加合法字段的数组。
- `id` 明确要求 string；provider、status 和三个安全整数时间戳要求与既有契约一致，不增加正数/时间先后等约束。
- 过去 stage 未校验。本轮按原 `PlatformLogin` DTO 补充且仅补充 `null | "waiting" | "scanned"` 的形状约束；缺字段、undefined、其他文字或类型拒绝。pending 的 null 仍显示 waiting。
- 为构造完整 DTO，`qr_payload` 所有状态都要求 string 或 null。pending 原已有此约束；terminal 过去会忽略任意类型，现在缺字段/number/object 等不完整 DTO 拒绝。这是字段形状收窄，**不添加 terminal 必须 payload=null、stage=null 或 terminal 字符串须通过 QR URL 校验的业务约束**。terminal 的任意 string（不展示）和 waiting/scanned/null stage 仍按旧逻辑接受。
- 服务端依据：`apps/server/src/platform_accounts.rs` 的 `qr_response` 总是输出八个字段，stage 为 Option；pending 调用使用 waiting/scanned，terminal 输出 null。payload 为解密的字符串 Option；terminal 输出 null。此次只阅读服务端，不运行/修改 Rust 或 DB。

## 实际验证

依赖复用前 `cmp package-lock.json` 与 `/workspace/shared/rainsync-next-integration-20261010/package-lock.json` 相同，检查 `node_modules/@rainsync/web -> ../../apps/web` 后 hardlink 复制依赖。复制后 realpath 指向本工作树 `apps/web`。未安装依赖。每轮 source `/workspace/shared/refactor-tools/env.sh`，Vitest 缓存指向专用验证目录。

运行：

```sh
RAINSYNC_ARTIFACT_DIR=/workspace/shared/rainsync-local-validation-20261011/qr/artifacts \
  node_modules/.bin/vitest run \
  tests/platform-login-qr-flow.test.ts \
  tests/platform-login-response-boundary.test.ts \
  tests/platform-login-boundary-controls.test.ts \
  tests/platform-renewal-component.test.ts \
  tests/platform-account-check.test.ts --maxWorkers=1

RAINSYNC_ARTIFACT_DIR=/workspace/shared/rainsync-local-validation-20261011/qr/artifacts \
  node_modules/.bin/vitest run tests/native-platform-ui-flow.test.ts \
  -t 'QR polling|uncertain start retains|malicious QR origins' --maxWorkers=1

node tests/platform-login-boundary-types.test.mjs
node_modules/.bin/tsc --noEmit -p tests/tsconfig.platform-login-boundaries.json
node_modules/.bin/vue-tsc --noEmit -p apps/web/tsconfig.json
node_modules/.bin/eslint apps/web/src/features/account/platform-account.api.ts \
  apps/web/src/features/account/platform-login-flow.ts --max-warnings 0
git diff --check
```

- 5 文件、85 测试通过；另一个现有 UI-flow 文件仅 QR 名称过滤的 3 测试通过，15 测试跳过。最大并发 worker 为 1（Vitest 为隔离文件依次创建 worker，不代表并发 5）。
- 专属 tsc、生产 vue-tsc、定向源文件 ESLint 和 diff whitespace 检查通过。
- 类型负控分别在 TypeScript 编译器内存里把 start/poll/cancel 改回 `api<PlatformLogin>`：各自稳定触发 TS2344（unknown 等价性破坏）及 TS2578（未解析 DTO 赋值的 expect-error 失效）。真实源码诊断为 0；不修改 checkout。
- 行为负控在内存里分别提前 current/deadline 前解析，以及返回 raw DTO：oracle 捕获 poisoned getter 被触及、修改原对象影响延迟 poll id。生产版本同时证明不触碰/不受原对象修改影响。这些变体只执行本地 promise stub，无网络或外部状态。
- 新增正/负例覆盖 current primitive/array/缺字段/stage/数值错误、原 QR 保留、额外敏感字段 getter 不触及、start/poll 白名单读取一次及原对象后续篡改、身份退役/Close/新 generation/过期后的 poisoned receipt、取消回执不消费、重复/失败取消、显式超时重试和终态清理。原有 QR URL/query、payload 省略与 immutable capability 测试完整重跑。

## 限制

未执行默认全套 Vitest/playback、Cargo、DB、socket、native、真实浏览器或真实 Bilibili；未使用用户电脑、未推送。模拟时钟/本地 promise 测试不能证明真实服务/浏览器验收。

未发现可用 GitNexus MCP 或现有 CLI runner，按仓库 AGENTS.md fallback 直接检查源码、调用方及定向测试；没有当前图索引、impact 或 detect_changes 证据，也未安装工具/更改权限。

完整本地输出位于 `/workspace/shared/rainsync-local-validation-20261011/qr`；该目录不属于源码提交。
