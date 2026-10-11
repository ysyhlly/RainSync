# P20 OAuth unknown 响应边界（2026-10-11）

## 范围与基线

- 基线：`d5528e4d7ff3e9a6e770a1afe4cec22ff7d1f48b`。
- 工作树：`/workspace/shared/rainsync-oauth-response-lane-20261011`。
- 分支：`dot/oauth-response-boundary-20261011`。
- 仅修改独立 OAuth API、flow、OfficialPlatformAccountPanel 及 OAuth 专属测试/本说明。Bilibili/QR 文件、shared/api、公共 typecheck、package/CI、P08/P09、播放与服务端协议均未修改。
- 这是 P20 的局部前端响应接缝，不代表 P20、native owner gates 或发布门槛完成。

## 完整 OAuth API 家族

Douyin / TikTok 的 `status`、`start`、`read`、`poll`、`cancel`、`disableRenewal`、`unlink` 七个方法全部返回 `Promise<unknown>`。请求路径、HTTP 方法、body、signal、cancel 的 10 秒 timeout、revision、明确的保存/续期同意没有改变。没有添加请求、自动重试或真实 OAuth 操作。

消费路径：

- 面板 refresh：先 await unknown，再检查原 snapshot 与 refresh serial，最后 parse/更新。
- disable/unlink：先 await unknown，再检查原 snapshot，最后 parse/更新；错误仍使用原“结果未确认”消息，不把 malformed success 当成功，不清空原 snapshot，不自动重试写入，invalid unlink 不关闭确认框。
- snapshot 保留 alive / epoch / user id / CSRF / provider / origin exact identity，并显式检查当前 controller 未 aborted。unmount 原本会使 alive=false 并 abort，两者现在均阻止解析。
- flow start/read/poll：原 current（closed、signal、调用方身份/窗口状态）之后调用 unknown parser；之后的发布、终态判断、计时及轮询全部使用 parser 返回的新 DTO，不再读原回执。
- cancel：回执没有业务消费者，继续只等待调用结束。不强加解析、后续读状态、确认成功、副作用或额外请求；请求拒绝时仍走原停止结果不确定提示。

## DTO 与接受集

`validateOAuthStatus(unknown, provider)` 返回完整 `OAuthStatus`；`validateOAuthLogin(unknown, provider, id)` 返回完整 `OAuthLogin`。两个 parser 均逐字段白名单重建，status 的 scopes / missing_prerequisites 也新建数组。额外顶层/嵌套字段、array 自有额外字段、secret 测试字段及原对象引用不传播到公开状态。

这不是“只有类型、接受集绝无变化”：

1. 显式拒绝 primitive、null 和 array 作为 DTO record。即使测试桩给 array 人为挂上全部合法 DTO 字段，也拒绝。
2. id / revision 落实原 DTO 的 string/null 契约。原正则会隐式转换 numeric/bigint/boxed-string 或带 toString 的非字符串 revision，甚至将 `[uuid]` 等非字符串 id 当字符串验证；现在拒绝这些形状。revision 的既有 `^[1-9]\d*$` 正十进制字符串规则保持；超 MAX_SAFE_INTEGER 的任意长度合法字符串原样通过、原样传回 expected_revision，不经 Number 转换。
3. enum、number/null、boolean、数组元素及所有既有必需字段均运行时验证后才构造 DTO；不是把 unknown 强断言为 DTO。

没有补充原先未验证的业务约束，正控特意保留：

- status 的未知 prerequisite 字符串、重复 prerequisite、非 connected 状态的重复合法 scope；available=false 可以没有 prerequisites。
- 非 connected 的 id/revision 可以同为 null；auto_renew / renewal_state 不增加新的交叉规则；Douyin status.authorization_mode=qr 的原接受行为不收窄。
- status 时间戳仍是 null 或正安全整数；login 的三种时间戳仍接受 0、负数和任意安全整数，不新增三者的先后关系约束。
- terminal login 只要两种 capability 为 null，保留原 mode/stage 组合接受集，包含 Douyin terminal mode=qr。
- pending web 原 Douyin/TikTok exact official origin/path、username/password/hash、单一 64 位小写 state 验证；pending QR 原仅 TikTok、aweme scheme / authorize host / 无 path、credentials、port、hash及单一 ticket 验证；8192 长度上限与额外 query 参数接受行为均保持。
- provider / request id exact binding、终态禁止 retained URL/QR capability、同一 id recovery、不隐式生成新授权、原 3 秒最小轮询与 180 秒恢复上界保持。

## 时序范围限制

只把既有 fence 放到解析之前，不引入新业务控制条件：

- refresh 保留原 serial；disable/unlink 不新增跨操作 serial 或写/读互斥机制。
- flow apply 不新增 post-await deadline gate。原已在途的 start/read/poll 若在本地 deadline 之后收到有效 terminal，仍接受并确认。三个入口均有正控，不能把本轮描述为修复所有过期 terminal 语义。
- JSON 网络回执是目标；poisoned getter 测试用于证明迟到/退役回执连字段也不触碰，并不声称支持任意带副作用的 current Proxy/getter 对象。

## 已执行验证

先 cmp 本工作树与 `/workspace/shared/rainsync-next-integration-20261010/package-lock.json` 完全相同，再 `cp -al` 复用现有 node_modules；`realpath node_modules/@rainsync/web` 已确认是本工作树 `apps/web`。未 npm install。

所有运行均先 `source /workspace/shared/refactor-tools/env.sh`，从本工作树执行：

```sh
RAINSYNC_ARTIFACT_DIR=/workspace/shared/rainsync-local-validation-20261011/oauth \
  ./node_modules/.bin/vitest run \
  tests/platform-oauth-response-boundary.test.ts \
  tests/platform-oauth-account.test.ts \
  tests/platform-oauth-component.test.ts --maxWorkers=1
./node_modules/.bin/vue-tsc --noEmit -p apps/web/tsconfig.json
./node_modules/.bin/eslint \
  apps/web/src/features/account/platform-oauth.api.ts \
  apps/web/src/features/account/platform-oauth-flow.ts \
  apps/web/src/features/account/OfficialPlatformAccountPanel.vue --max-warnings 0
```

- 最终定向：3 文件、197 测试通过，默认 timeout 未修改，最大 1 worker。
- 生产 vue-tsc：通过。
- 三个生产文件定向 eslint：通过。
- 覆盖原 OAuth 账户/组件回归，unknown 形状与每个必需字段、完整 DTO 白名单、两 provider 请求协议、超安全整数 revision、绑定与 URL 安全、start/read/poll 迟到 poisoned getter、状态读取/写入的 epoch/user/CSRF/provider/origin/abort/unmount 栅栏、refresh serial、重复点击、Cancel/Close、取消拒绝与不解析回执、终态/invalid 清除 login/QR image capability。
- 首轮两条新测试断言失败是 Vitest `not.toBe(raw)` 构造断言消息时读取 synthetic extra getter；改为比较对象引用的 boolean 后通过，没有为此修改生产行为。保留 initial 日志供核对。
- 证据：`/workspace/shared/rainsync-local-validation-20261011/oauth/{vitest-focused,vue-tsc,eslint}.log`。本轮没有全量 Vitest/aggregate typecheck、Rust/Cargo、DB、socket、native、网络、真实浏览器/真实平台/用户电脑操作或 push；跨接缝公共类型负控由父集成工作负责。

## 导航限制

未发现可用 GitNexus MCP；PATH、现有 node_modules 与工具安装目录中未发现可用 CLI。未安装或扩权，按 AGENTS fallback 做直接源码与整个 `apps/web/src`/相关测试调用者搜索。没有当前图索引、图 impact/detect_changes 或 native 证据声明。
