# 房间所有权转移（E01 的已实现子项）

2026-09-30，本文记录推送前的隔离环境实施与验证；发布提交与远程 CI 结果另行核验，未部署。

本文仅描述房主转让子项。第二阶段已另行实现关闭/重开/归档，见 [房间生命周期](ROOM_LIFECYCLE.md) 与 [当前验证报告](PHASE2_LIFECYCLE_NEGOTIATION.md)；完整角色/私人库模型和存量升级门槛仍未关闭。影片结束和前端离房不等同于房间关闭。

## 接口和权限

- `GET /api/v1/rooms/{id}/members`：本房间成员或实例管理员可查看成员的 ID、账号和显示名，用于选择转移目标。
- `POST /api/v1/rooms/{id}/owner`：请求体为 `{"owner_id":"目标用户 UUID","expected_revision":7}`。需要登录、正确 Origin/CSRF；只有当前房主或实例管理员可操作。非管理员还必须仍是该房间成员。实例管理员允许干预尚未加入的房间，但目标仍必须是已加入的成员。
- 目标必须为有效的 `room_members` 行；不能将房间转给任意账号，也不能重复转给当前房主。当前版本没有另一个账户停用状态，今后增加停用功能时还需纳入本校验。
- 过期 revision 返回 `REVISION_CONFLICT`。操作没有自动重试：响应丢失时先读取当前房间/重连再确认，不用旧请求盲目覆盖新状态。
- 成功响应包含新 `owner_id`、权威 `state` 和审计 `event_id`。房间 owner 与快照 controller 在同一事务更新；当前 v0.1 中二者同时交接，不暗示已有 Moderator 或私人库角色系统。

网页在房间成员列表中选择目标，并在提交前显示权限变化和不可自行取回的提醒。转移后前房主继续观看和聊天；管理员依旧保留实例管理权限。

## 事务、撤权与实时更新

1. 事务先锁 room，再锁 snapshot，随后锁所需成员行。目标成员使用 `FOR KEY SHARE`，确保并发删除在检查前完成时转移会失败，或者在转移提交后才能完成。未来的移除成员接口必须同时保护当前房主不被移除。
2. room 使用 `FOR NO KEY UPDATE`：房间主键不变，既串行化所有权变更，也不阻塞播放授权等现有数据的 room 外键检查。控制凭据签发、播放命令提交遵循 room → snapshot 的锁顺序，避免凭据外键与管理操作死锁。
3. 核对 owner、成员与 expected revision 后，更新 owner/controller、revision，写入原有 room_events 和新的 room_ownership_events，并删除该房间的旧 control_epochs；全部原子提交。
4. 所有已连设备收到携带 owner_id 的 EVENT 和新凭据。旧成功命令也必须先通过 epoch 校验，不能凭去重缓存重放。新凭据不赋予旧房主控制权，也不会自动重试旧命令。
5. 房间播放 actor 在每次处理命令时重新读取权威快照；最终提交再次在锁内校验 epoch、revision、controller。转移期间已经完成内存计算的旧命令也不能落库。
6. 新连/重连 SNAPSHOT 以及广播丢帧恢复快照包含 owner_id；网页忽略低 revision 快照，不因转移拆卸视频、重建播放会话或关闭观看连接。

转移保留当前媒体、media_generation、播放状态、时间轴、播放票据和既有邀请；它不改变媒体来源所有权，也不自动分享私人媒体库。既有 END_MEDIA 的播放列表前进/循环以及重播逻辑保持原样。

## 数据和兼容

`0027_room_ownership.sql` 只新增 `room_ownership_events`：记录事件 ID、房间、操作者、原/新房主、revision 与数据库时间；随房间删除级联清理，独立于 24 小时 room_events 清理。没有重写旧 RoomState、邀请或播放会话，也未改变 Rust/TS 的原有播放命令协议。

旧网页可继续观看和播放，能够从 state.controller_user_id 观察控制权；它没有新转让界面。顶层 owner_id 和管理 EVENT 是兼容的增量字段。恢复旧服务实现时需保留迁移文件和审计表，不得删表或清理 SQLx migration 记录来强行回退；旧二进制内嵌的 SQLx migrator 不认识新增版本，不能据此宣称原版二进制可直接回滚。应使用保留全部已应用迁移的兼容构建，并另做回退验证。本次已验证 1–26 的真实旧结构/房间数据升级及新服务重启，未验证旧二进制回退。

## 验证入口

- `cargo test --locked -p room-core`：转移仅改 controller/revision、旧房主与旧 revision 拒绝、溢出保护，以及已有播放核心回归
- `npx vitest run tests/room-runtime.test.ts`：转移更新管理权限、旧快照不恢复原房主、切房后晚到转移响应不污染新房间，以及已有离房清理回归
- `node tests/room-ownership.mjs`：真实 PostgreSQL + Server + WebSocket；成员/房主/管理员权限，目标删除竞态，同 revision 并发转移，旧控制命令等待提交时发生转移，旧成功命令重放，原房主多设备与重连，播放状态保留，审计与重启
- `node tests/room-ownership-migration.mjs`：应用原始 1–26 迁移并种入旧房间/成员/邀请，然后启动当前服务应用 27，检查数据与重启保留
- `npx playwright test tests/browser/room-ownership.spec.ts`：桌面/移动网页转移确认、失去管理按钮、同一个视频元素和播放方案保留；此项为模拟 API 的真实浏览器测试，不替代数据库并发测试

集成测试必须设置 `RAINSYNC_ARTIFACT_DIR`。默认使用隔离 Docker PostgreSQL；受限环境可显式设置 `RAINSYNC_NATIVE_POSTGRES_BIN` 使用同样随机数据库/密钥的独立本机 PostgreSQL 子进程，绝不接收用户数据库 URL。

本轮已执行并通过：room-core 8 个单元测试、room-runtime 4 个测试、上述两个独立 PostgreSQL 集成脚本，以及网页生产构建。浏览器测试已编写但**未执行测试主体**：本环境 Chromium 在创建进程 socket 时报告 `Operation not permitted`，没有产生成功截图，不能将其记为浏览器通过。

## E01 范围与验收边界

生命周期/epoch、持久化清理和暂停重开已在第二阶段另行实现，不能再把它们列为全部缺失。完整角色/邀请模型、私有媒体授权、通用事件重放及发布矩阵仍未完成；尤其旧资源缺少释放证明的恢复/人工对账仍是受影响存量部署的发布阻断。0030 仅排除因果上晚于旧 NAS 传输的新房间，不解除旧记录可能范围内房间的门槛，转让房主也不改变房间出生序号。接口和证据以 [生命周期](ROOM_LIFECYCLE.md)、[清理协议](ROOM_CLEANUP.md) 和 [当前报告](PHASE2_LIFECYCLE_NEGOTIATION.md) 为准。

399d699 此前截至0029的所有权/迁移定向回归已通过，含0030的新累计包已另行通过所有权/迁移及完整组合复验。先前 6227469 分支的测试数不视为当前完整验收；当前云端浏览器限制不抹掉其他基线的历史浏览器结果。
