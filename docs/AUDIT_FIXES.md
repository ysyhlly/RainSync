# 四项 P2 审计修复与回归记录

对应用户提供的2026-09-28（Asia/Shanghai）实现审计。四项问题均先复核并获得失败证据，再实现修复；本轮正式测试与临时审计仓库分开保存，没有修改原审计报告或探针。

分支为`front/rainsync-implementation`，修复前提交`982936a7db58460fee7b259e4d2f9fd045eefe5d`。该提交是用户要求压缩、改名及更正作者后的原实现，与被审计`f625241…`的文件树相同。旧阶段SHA仅代表当时执行记录，不应再用原报告的15提交列表做当前分支回退。本轮修复提交的SHA由最终回复提供。

后续本仓库Git作者和提交者使用`Rainfrost <luo005962@gmail.com>`，已设置仓库本地配置，未修改全局配置。原有三个根文件删除单独保留，不纳入修复提交。没有推送、PR、部署或委派。cgraphy仍不可用，使用常规源码检查，未调用enrich/store。

## 修复与证据链

| 项目 | 失败证据 → 根因 | 修复路径 → 验证 |
|---|---|---|
| 迟到认证Cookie覆盖后一次登录 | `auth-cookie-red`在真实Chromium Cookie下复现：Bob登录后放行Alice旧响应，资料页变为Alice。`auth-unit-red`捕获认证写入未串行、实际会话不符仍被接受 | `session.store.ts`协调login/register/logout：取消前项并等待请求结束后再发后项；页面卸载取消所属认证请求，阻止旧页面跳转；接受身份前读取auth/me核对账号、CSRF及注册返回ID。单元、桌面/手机Cookie回归均通过 |
| 播放清理阻断注销 | `logout-red`复现撤销网络失败、远端DELETE挂起时未注销，注销自身错误被媒体错误遮蔽 | AppShell先同步停止本地播放/连接，远端清理后台执行，不等待其成功；认证注销独立执行并呈现自身结果。保留未清理请求编号，远端session DELETE增加5秒期限。`logout-green`桌面/手机6例通过 |
| 同房进入失败后无法重试 | `room-retry-red`：清理抛错仍有room=A但无socket，同房入口被跳过 | 清理成功并核对入口序号之后才赋值room。失败保持未激活，恢复网络后同房重试可建连接；已激活同房仍复用。`room-retry-green`及最终单元通过 |
| CHAT重试重复落库 | `chat-dedup-red`在真实Server/Postgres连续发送同编号CHAT，收到两个不同数据库消息ID | 0022增加可空client_message_id及房间/用户/编号唯一索引；冲突后读原记录，同正文仅向重试者确认原消息，不再次广播；不同正文拒绝。`chat-dedup-green`真实重复、并发、作用域、重启测试通过 |

### 认证时序和不确定结果

epoch继续隔离普通异步响应，不承担阻止浏览器写Cookie的职责。共享认证任务持有AbortController，新动作先中止前项并等待结束；普通会话load等待认证任务完成。每项认证操作有20秒客户端期限，登录/注册页面退出时取消所属请求并清除密码输入。

登录不能只凭POST返回值更新界面：之后auth/me必须与提交账号及返回CSRF一致，注册还核对返回ID。注册页改用session.register，不再绕过共享层直接POST并accept。浏览器回归覆盖“登录→注册→登录”和“注册→登录”，放行迟到Set-Cookie后，Cookie、资料页和侧栏仍为后一次账号。

Cookie竞争测试使用真实Chromium与受控接口，验证同一应用实例的跨路由时序；没有称其为真实Rust登录竞争。实际Server注册/登录/资料另由四套账号集成及真实视频联合测试验证。客户端取消不等于撤销已提交注册事务，未知结果确认/正常登录恢复保留，不自动重发注册。

### 注销和房间清理

runtime.leave开始时失效房间/连接序号、关闭socket、取消重连及采样，并同步暂停/清空video、销毁HLS、取消媒体等待。远端清理失败不阻止auth/logout；注销成功才清认证状态并跳转，失败显示注销错误。PlaybackRequests持久取消编号保留，供后续同账号重新清理。

房间清理成功且入口仍有效才成为激活房间，所以RoomPage同房判断不会把失败入口当成可复用连接。正常跨路由保持video/WS/session逻辑未改，原38项播放回归全部保留。

### 聊天持久幂等契约

- `migrations/0022_chat_idempotency.sql`只增加可空UUID字段及`(room_id,user_id,client_message_id)`唯一索引；旧消息内容/ID和历史迁移不变。
- 有效UUID同键同正文只插入一次；重放返回相同消息ID和正文，只向请求连接确认。并发由数据库唯一索引协调，冲突后的独立查询读取已提交原记录。
- 同键换正文返回既有INVALID_REQUEST，不覆盖原消息；显式非法UUID拒绝。旧客户端缺字段或null仍每次创建消息，迁移前记录保持null。
- 去重区分房间与发送者；重连/Server重启后仍有效。原10秒未知提示和显式同编号重试保留，现在具备实际服务端去重保障，未新增自动重发。

`tests/chat-idempotency.mjs`通过真实WebSocket和Postgres验证顺序重放、两个并发socket、正文冲突、两用户/两房间相同编号、无编号旧帧、重启及历史唯一记录。新增`npm run test:chat`并接入CI；远程CI未运行。

## 本轮执行记录

ARTIFACT=`C:/Users/ALIENWARE/Desktop/杂项/RainSync-audit-fixes-2026-09-28`。下表每个名称对应`logs/NAME.json`及`.log`，JSON保存实际command/args、UTC started/finished、exitCode、timedOut；执行时间以这些原始记录为准，不与审计报告名或本机时区混淆。以下全部退出0、未超时。

| NAME | 实际命令（省略run-check包装） | 结果 |
|---|---|---|
| chat-server-build | `cargo build --workspace --bins --examples --locked` | 通过 |
| fixes-rust | `cargo test --workspace --locked` | 56通过，2个原有子进程fixture ignored，0失败 |
| fixes-clippy | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| fixes-fmt | `cargo fmt --all --check` | 通过 |
| fixes-protocol | `cargo run -p protocol --example export -- --check` | 生成一致 |
| fixes-unit-final | `node node_modules/vitest/vitest.mjs run` | 47/47通过 |
| fixes-types-final | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json` | 通过 |
| fixes-build-final | `node node_modules/vite/bin/vite.js build apps/web` | 通过，JS805.81kB/gzip263.06kB，保留chunk提示 |
| fixes-browser-final | `node node_modules/@playwright/test/cli.js test --workers=2` | 96/96通过，原86+新增10；Chromium桌面/Pixel7模拟 |
| fixes-accounts | `node --run test:accounts` | 四套真实账号/邀请/注册/头像集成通过 |
| chat-dedup-green | `node tests/chat-idempotency.mjs` | 真实聊天幂等/竞争/重启通过 |
| fixes-original-integration | `node tests/integration.mjs` | 原Server/Worker/NAS完整集成通过 |
| fixes-real-browser | `node --run test:browser-real` | 真实双用户视频/账户/头像/导航/重启通过 |
| fixes-compatibility-build | `cargo build --manifest-path …/compatibility/source/Cargo.toml --target-dir …/target --workspace --bins --examples --locked` | 基线业务+原样0020/0021/0022通过；精确路径在JSON |
| fixes-migration-upgrade | `node tests/migration-upgrade.mjs` | 真正0019→0022，旧凭据/会话/邀请及新资料功能通过 |
| fixes-rollback-data-final | `node tests/compatibility-rollback.mjs` | 兼容回退→前进→pg_dump/restore；在恢复库直接核对聊天键，账号/头像/批次保留 |

单元由44增至47，浏览器由86增至96。全量浏览器首轮`fixes-browser-first`为94通过/2失败：旧注册mock只返回正文，但auth/me仍声称未登录，无法满足新增实际会话核验。修正fixture使注册成功建立相同身份，完整重跑96通过；没有删除/放宽密码、身份或自动登录断言。真实注册联合验收已独立通过。

真实浏览器摘要：`ARTIFACT/browser-real/856b47bb-fe0a-4abb-abfd-d4c7dc4e476e/evidence.json`。本次新执行再次验证四方向实际512×512WebP、昵称/头像独立、普通权限、两人实际视频、跨路由同video及不新增WS/播放会话、重启持久性。故意Server重启造成的ECONNRESET/ECONNREFUSED代理日志保留。

本轮Docker可用，数据库全部由fixture创建为独立随机容器并自行清理，没有写用户部署。依赖/浏览器及Cargo缓存复用既有外部目录，新的日志、Vite输出、媒体、兼容源码都在本轮ARTIFACT。旧审计无法启动Docker的结果仍保留，本轮没有将先前日志当成重新运行结果。

## 复跑与升级

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-audit-fixes-2026-09-28'
$env:CARGO_TARGET_DIR='C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28/cargo-target'
$env:PLAYWRIGHT_BROWSERS_PATH='C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28/browsers'
node scripts/run-check.mjs chat-check 180 node --run test:chat
if ($LASTEXITCODE -ne 0) { throw 'Chat regression failed' }
node scripts/run-check.mjs browser-check 240 node node_modules/@playwright/test/cli.js test --workers=2
if ($LASTEXITCODE -ne 0) { throw 'Browser regression failed' }
```

缓存路径对应本机；新环境需先构建workspace二进制、安装锁定依赖及Chromium。启动新Server时SQLx自动应用0022；新增唯一索引需要数据库DDL锁，应在维护窗口备份并先用恢复副本演练。

回退必须保留原样0020/0021/**0022**及历史数据，不能直接用缺0022的旧SQLx二进制。保留新字段不会让旧服务端自动获得聊天去重，因此旧服务端须配旧前端，不能让含显式重试的新UI连接旧无幂等后端。步骤见更新后的[BACKEND_OPERATIONS.md](BACKEND_OPERATIONS.md)。

## 验证边界

未新增运行依赖、更换媒体架构或重做视觉。没有实际Safari/iOS/Android、真实软键盘、长时/弱网/生产负载及生产恢复证据。真实浏览器视频仍为progressive H264/AAC，HLS异常由受控浏览器和真实Worker集成覆盖。原大chunk提示未隐藏。原实现报告/36项清单保留为历史记录，本轮结论以上述新执行证据为依据。
