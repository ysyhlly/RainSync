# E：房间权限、队列与事件恢复交付

基线：总控 `integration/v0.1-next` 的精确提交 `252100dee29cf4d13df00cbda55f0fa4814deb25`。
工作区：`/workspace/RainSync-lanes/e-room-events`；分支：`codex/e-room-events-v01`。
已完整读取 `docs/PARALLEL_CONTRACT_V01.md`；未修改 viewer/plan generation 公共契约或 0031 迁移。旧分支 `codex/e-room-events` 的 `e48467f` 保留原 5ce1c849 WIP；新分支以 `e140f0f` 安全迁移，无冲突。
本次仅交付 E01 的独立切片，不代表 E01 或发布门槛全部完成。未推送、合并或部署。

## 已有实现与本次改动

保留已有 active → closing → closed → archived、关闭/重开 epoch 撤销、暂停重开、归档只读、owner/admin 管理、所有权转让及旧 NAS 因果范围和正向清理证明。没有改动 cleanup、Agent、媒体队列、上游预约/观测、公共协议或数据库迁移。

- `apps/server/src/room_delivery.rs`：control、持久化 chat、可替换 CLIENT_STATUS 独立逻辑队列，容量分别为 128/128/32 个信封。控制先发；连续八个控制信封后给已就绪的后台流一个槽位，聊天与状态交替。控制自身保持 FIFO。状态积压不挤掉控制；控制断档获取权威快照，聊天断档断开当前连接，让现有 REST chat cursor 补页。容量是信封数，不宣称是完整进程字节/内存上限。CLIENT_STATUS 是现有播放观测，不能据此宣称已实现 presence 契约。
- `apps/server/src/rooms.rs`：接入上述内部模块，初始 SNAPSHOT 与 Ping 同样使用五秒发送截止。聊天在房间锁之后取得成员行 key-share，覆盖新消息及同 key 重放；成员移除与聊天提交互相排序，移除先提交后不再落消息。心跳复核当前 membership，未获授权的闲置连接退出。初始 snapshot 同事务锁定会员后签发凭据；每个入站应用帧与出站信封重新复核成员，续凭据的等待后也再次复核，阻止删除已提交后的新准入。网络发送前释放成员查询，不持 DB/room 锁等待慢连接。
- `apps/web/src/features/rooms/room-runtime.ts`：EVENT/ACK 等非快照帧出现 revision 缺口或 clock epoch 改变时，先清控制凭据并重连，使用现有 RESUME 请求权威恢复；不把跳跃帧的 action、owner 或 lifecycle 直接套用。旧连接迟到帧不能覆盖恢复基线。
- `crates/room-core/src/replay.rs`：纯控制/所有权 reducer 重放内核，固定 reducer version，逐步核对完整 committed post-state；未知版本、缺 revision、错 actor、非有限/逆序事件时间、不同 clock、篡改结果失败。无数据库、网络、聊天或媒体副作用接口。通过 `crates/room-core/tests/replay.rs` 的直接模块引用验证；**尚未从 lib.rs 导出或接上持久化事件**。
- `tests/room-runtime.test.ts`、`tests/room-events-isolation.mjs`：补前端缺口/迟到连接/ACK/clock 恢复，以及真实 PostgreSQL、多设备 TCP 慢消费者和撤权竞态回归。

## 新总控基线测试证据

产物与日志均在仓库外：`/workspace/RainSync-lane-artifacts/e/v01`。
Rust：`1.98.0`；Node：`24.19.0`；原生 PostgreSQL：`17.11 (Debian 17.11-0+deb13u1)`。使用独立 target、一次一个 Rust 编译任务、随机 loopback 端口、随机密码和一次性 PostgreSQL 集群。未使用生产数据库或 Docker。

以下最终新基线验证命令退出码均为 0：

| 检查 | 本次结果 | 日志 |
| --- | --- | --- |
| `cargo fmt --all -- --check` | 通过 | `fmt.log` |
| `cargo clippy --locked -p rainsync-server -p room-core --all-targets -- -D warnings` | 通过 | `clippy.log` |
| `cargo test --locked -p rainsync-server -p room-core` | 19 server + 8 room-core + 2 replay，共 29 项通过；doc-test 0 项 | `rust.log` |
| `npx vitest run` | 18 文件、125 项通过 | `frontend.log` |
| `npx vue-tsc --noEmit -p apps/web/tsconfig.json` | 通过 | `web-types.log` |
| `node tests/room-events-isolation.mjs` | 下列隔离组合通过 | `room-events-integration.log` |
| `node tests/room-ownership.mjs` | 原权限、成员/版本竞态、转让审计、重启、多设备旧凭据/旧命令回归通过 | `room-ownership-integration.log` |
| `node tests/room-lifecycle.mjs` | 原 close/PLAY 竞态、epoch/邀请/授权撤销、closing 重启、暂停重开、归档只读回归通过 | `room-lifecycle-integration.log` |
| `node tests/chat-idempotency.mjs` | 重试/并发一次持久化、变载荷拒绝、room/user 作用域、旧帧兼容和重启通过 | `chat-idempotency.log` |

本次 server 二进制 SHA-256：`e928fed91c0146a59bee78c610a02dc9ad49844549855ddeb47b6d2933aeb548`。

独立短测绑定文件：`/workspace/RainSync-lane-artifacts/e/v01/e-source-binding.json`。实际执行的 Server 是 `/workspace/RainSync-lane-artifacts/e/cargo-target/debug/rainsync-server`；绑定文件列出其路径、SHA-256、尺寸和修改时间，以及所有检查的日志路径、SHA-256、实际退出码 0 和环境版本。未调用全候选冻结流程。

- 当前生产/构建输入：221 文件，摘要 `fe394a7305d101a6dcc618dd8ef9ceb05d54f3fc361215204ac3b11f6ca391e3`；包括 apps/crates/packages、迁移和 manifests/lockfiles。
- 当前测试/协调输入：151 文件，摘要 `4a486a9514ab4bb0d2d5c5665de41e0737c845a84dccd2174431d87d3ceb6cde`；包括 tests/scripts、crate tests 和测试配置。
- 每组摘要按排序的 `path + NUL + file_sha256 + newline` 计算 SHA-256；逐文件清单在绑定 JSON 中。文档与生成输出不计入源码摘要。
- 本路未运行浏览器；`/usr/bin/chromium` 已存在也不构成 UI 或真实设备证据。PostgreSQL 仅为一次性自有集群。


新真实 PG 组合覆盖：暂停一条测试 TCP 读端；同一个成员六个设备共 120 个大 CLIENT_STATUS 帧；正常同房控制/事件继续；连续 delta 恢复；控制日志保留断档补完整快照；两种恢复的末状态与数据库完整 state 精确一致；已成功但 epoch 过期的旧命令不重执行；成员 DELETE 持行锁时 CHAT 等待并最终拒绝、不落库；删除提交后 CLIENT_STATUS 不再广播，owner 新 CHAT/EVENT 不再向被移除成员下发；JOIN 在等待房间锁时被删会员，不发 snapshot 或新增 control epoch；重新加入后的恢复。自有 Server/PostgreSQL 进程与 loopback 端口已确认清理。
最终样本中正常控制 ACK/见证事件为 20ms，仅是该隔离单次样本，不是 p95 或容量保证。保留断档只在一次性测试库删除 `room_events` 的一行，未触碰 NAS、transfer、cleanup 或资源释放回执记录；不是绕过旧 NAS 清理的路径。

撤权生效点是成员 DELETE 事务提交。提交后开始的新 frame admission 查询拒绝；提交前已准入、已进入传输缓冲或已下载的字节不能撤回。这是逐请求准入边界，不宣称能撤回在途字节。

保留原基线目录 `/workspace/RainSync-lane-artifacts/e` 的初次问题与旧证据：`room-delivery-unit.log` 的 `room_delivery` 筛选实际执行 0 项，只能作为构建日志；后续正确 `rooms::delivery` 筛选实际通过四项，最终全测包含五项队列场景。`room-replay-unit.log` 保留测试代码 Rust 借用生命周期编译错误，修正后两项实际通过。`*-before-idle-fairness.log` 为增加无控制时聊天/状态公平性前的隔离通过记录，不能替代新基线四组复验。`server-build-membership-initial-error.log` 保留新 helper 误用 server Result/Error 别名的编译失败；修正后新基线 Clippy/29 Rust/构建及四组集成已实际通过。

## 接口需求与尚未完成项

以下由用户总控统一契约，本路未修改相关路径：

1. **presence 公共协议**：需要服务端签发的连接身份、按用户多连接汇总、连接心跳租期、当前可替换快照及独立 presence 序号/进程 epoch。设备/连接退出或重连不增加控制 revision；不把永久成员表当在线状态。具体 wire 名称、字段及 Web 公共类型由总控确定。待该基线后接入房间功能。
2. **事件诊断与迁移**：`room_events` 当前仅有 room/revision/state/time，缺 actor、command、schema/reducer version、原因和服务器时钟身份。需要总控提供可版本化诊断信封、对应迁移以及控制/转让/生命周期同事务写入基线；日志必须脱敏，不能写资源签名或秘密。纯 replay 内核不虚构目前没有的事实，CHANGE_MEDIA/END_MEDIA 的服务端媒体元数据/片单选择也须显式记录或提供固定上下文。生命周期或 server clock 切换先使用明确检查点。本次未验收完整线上历史离线重建。
3. **共享入口接线**：`crates/room-core/src/lib.rs` 的 replay 模块导出由总控负责；本路仅以 integration test 引用验证，无公共 API/协议自行变更。
4. **完整控制提交 membership 门控**：聊天事务、初始 snapshot 会员锁、逐入/出帧准入及心跳已经完成；`crates/persistence/src/lib.rs` 中 `previous()` / `commit()` 仍需总控在 room → snapshot → membership 锁顺序下复核当前成员并持 key-share 到事务结束，覆盖命令排队后成员被删除及既有 command result 重放。已入队命令仍可能在成员 DELETE 后由最终事务提交，socket 的输入/输出准入不能关闭这个窗口。`issue_control_epoch()` 也需要总控在共享事务内部绑定会员，避免续签查询与删除之间创建未下发的新凭据；E 会在续签后再次查会员并禁止下发。无需新增 wire 字段；不能把本次聊天/逐帧/心跳通过写成最终控制提交竞态已闭合。

未执行：真实浏览器 UI、新 presence 契约、全部角色/Moderator 模型、完整诊断信封迁移、真实旧库升级、真实 NAS 清理证明恢复、私人库、持续 100 在线、两小时/72 小时或实机。现有生命周期脚本的自有资源 owner 释放模拟只验证清理状态机，不证明任意真实旧资源已排空。本次不改历史、不补造旧 NAS 回执、不 force-close。
