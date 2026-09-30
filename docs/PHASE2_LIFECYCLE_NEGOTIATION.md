# 第二阶段：房间生命周期、清理回执与实际媒体协商

日期：2026-09-30，UTC。当前移植基准为 `399d699269280a1c897021a2183efaf6306646fc`，工作树 `RainSync-main399`。本报告记录推送前的本地验证；发布提交与远程 CI 结果另行核验，未部署。原 6227469 分支及其已测结果已保留，第一阶段范围见 [历史报告](PRIORITY_REMEDIATION.md)，不能将旧通过数移作本次主线移植证据。

**当前状态：在同一 399d699 基准上完成 0030 旧 NAS 因果范围修正；13 项因果范围、实际旧库迁移与下列最终冻结二进制组合复验全部通过。上游 `0025_upstream_reservations.sql` / `0026_playback_observations.sql` 原文保留；累计补丁包含 `0027_room_ownership.sql`、`0028_room_lifecycle.sql`、`0029_room_cleanup.sql`、`0030_legacy_nas_scope.sql`。已列隔离用例通过不等于真实库、设备、持续运行及发布门槛通过，仍不可直接发布。**

此前已交付 `RainSync-cumulative-remediation-main399.zip`（131 文件、0027–0029，SHA-256 `296626011a24353f5e526c6c58bee40569ae5d40966899b29d3479eded497767`）保留原文和证据。新版累计包 `RainSync-cumulative-remediation-main399-causal-scope.zip` 是以同一主线 SHA 为基准的完整累计替换包，不应叠加到旧补丁上。旧包通过数不替代本轮验证。

**受影响存量房间仍有发布阻断：未知旧 NAS 传输的可能房间保留 `legacy_agent_drain_unconfirmed`；0030 只排除可证明因果上晚于该传输的新房间，不表示旧资源已释放。全部迁移前房间都在迁移前旧记录的范围内，仍可能无限期 closing。没有受支持的人工对账写入或强制关闭入口。** 范围外的新房间仍须完成自身所有释放证明，晚到旧 Worker INSERT 还可能扩大后续记录涵盖的房间范围。

## 1. 本阶段实现

| 范围 | 已实现行为 | 仍须区分的边界 |
| --- | --- | --- |
| 生命周期与权限 | active → closing → closed → archived；close/reopen 增加 epoch；管理检查 owner/admin、成员与 revision；关闭同事务撤销命令、邀请、播放请求/会话并入清理队列；暂停重开须新凭据/新授权 | END_MEDIA/片单循环不关闭房间；归档只读不公开历史；未新增私人库或完整 Moderator/Viewer 模型 |
| 准备/执行/上游清理 | 不可变准备尝试、每任务 attempt 与交付所有者登记；进程树、已启动 blocking I/O 正向排空后回执；上游协商意图与返回身份先持久化，start/progress/stop 受准入与操作状态保护；清理器重启可重试 | cancelled/租约到期/HTTP waiter 消失不是物理释放证明；未知上游身份、进程崩溃后丢回执或不可中断 I/O 保持 closing |
| NAS 释放证明 | 分发前持久化意图；Agent 完成 socket/文件/blocking 操作排空后发送已认证 UUID 回执；本地落盘、重连/重启重发、幂等 ACK 与队列背压；无回执关联记录不被普通保留期删掉 | 旧 Agent/旧历史没有新证明；服务端信任已认证自托管 Agent 的资源声明，不是硬件证明 |
| 实际媒体候选 | 本地和版本绑定 NAS：最多四个实际候选、五分钟加密绑定、准确 codec/尺寸/码率/声道信息、浏览器有限配置回报、准备/发布二次校验；自动模式仅解码错误有限回退 | 无稳定文件版本的 HTTP/Jellyfin/Emby 保留明确理由的旧协商；并未证明所有编码族、HDR 或真实设备可播 |

生命周期、操作与事件细节见 [ROOM_LIFECYCLE](ROOM_LIFECYCLE.md)；资源完成条件见 [ROOM_CLEANUP](ROOM_CLEANUP.md)；NAS 身份/持久化/背压见 [AGENT_TRANSFERS](AGENT_TRANSFERS.md)；候选与回退见 [PLAYBACK_CAPABILITIES](PLAYBACK_CAPABILITIES.md)。当前新增 0027–0030，保留主线既有 1–26 迁移，不改写其原文或校验和。上游关闭已复用 `upstream_reservations`，0029 只为它增添 lifecycle_epoch，不建立平行账本。保留上游实际观看观测、身份/幂等、按来源公平有限清理、五次失败与六十秒总截止；房间重试不会重置预算，cleanup_failed 继续阻挡关闭。

## 2. 升级门槛与无损诊断

本分支 0029 仅保留原本存在的正向回收证据；旧 failed/cancelled/abandoned、缺失输出或准备未知项不能凭状态补成已释放。0030 为房间分配不可变 `cleanup_birth_ordinal`，为 `legacy_unconfirmed=true` 传输保存不可变 `possible_room_cutoff`。两种 INSERT 更新同一个 `room_cleanup_birth_counter` 单行计数器，持锁到事务提交，以因果顺序而非墙钟、created_at 或未提交 sequence 分配判断。

关闭条件仍阻止 `possible_room_cutoff >= cleanup_birth_ordinal` 的可能房间；NULL 上限防御性地按全局未知处理。全部迁移前房间都纳入迁移前旧行范围，只有因果上晚建的房间可排除。房间 ID/出生序号、播放会话的房间身份、legacy 标记和上限不可改写。晚到旧 Worker INSERT 会捕获当时范围，可能涵盖此前已创建的新房间；计数器不保证任意旧程序在最终关房检查后继续写入的安全，升级必须停止并排空旧组件，再运行配套版本。

普通保留期、租约过期、逻辑终态及晚到 Agent ACK 均不清除 legacy 门槛，数据库删除保护继续拦截旧 Server 的无过滤历史清理。只排除不可能关联的新房间，没有任何旧回执被补造或状态被标为 drained。仅正向本地准备/执行回执可在无待处理房间清理时过 48 小时删除。**迁移前的 24 小时历史清理可能已删掉旧 transfer 行，因此“查不到旧记录”并不证明旧所有者已经消失。** 停止旧服务、看到新心跳或空查询也不补出缺失的持久化证明。

以下检查用于定位和保全事实，不修改清理状态：

1. 保全数据库、关联加密密钥、服务版本及日志，先在隔离恢复库验证升级。诊断材料不含密钥、源令牌或签名资源 URL。
2. 授权读取 `GET /api/v1/rooms/{id}/lifecycle`，记录 room ID、epoch、revision、cleanup attempts/last_error/completed，以及不可变 preparation session、job/attempt/execution、transfer UUID 和上游会话身份。
3. 若为 `legacy_agent_drain_unconfirmed`，由有数据库诊断权限的管理员只读核对该房间序号与所有可能覆盖它的旧行，不能仅凭 session 关联或时间戳排除。下面查询只返回 transfer ID、Agent ID 和范围上限；将占位值换成待诊断房间 UUID，在已有授权连接中执行，不导出 resource、凭据或令牌。

```sql
BEGIN READ ONLY;
SELECT t.id AS transfer_id, t.agent_id, t.possible_room_cutoff
FROM rooms AS r
JOIN agent_transfer_runs AS t
  ON t.legacy_unconfirmed
 AND (t.possible_room_cutoff IS NULL
      OR t.possible_room_cutoff >= r.cleanup_birth_ordinal)
WHERE r.id = 'REPLACE_WITH_ROOM_UUID'::uuid
ORDER BY t.possible_room_cutoff NULLS FIRST, t.id;
ROLLBACK;
```

4. 从完整 Agent 身份清单映射到所有主机、容器和服务管理器，覆盖可能的旧进程副本。先禁止旧传输签发及自动重启并保存冻结的 legacy ID 集合；核对完整进程/子进程树的 supervisor 正向退出记录，或可验证的主机启动代次证据，确认旧代次资源不能仍存活。只看到新 Agent 心跳、在线状态、租约到期或 PID 不存在都不充分。当前没有用户生产环境完成此清点和正向证据的记录。
5. 其他 last_error 按实际所有者追踪：`playback_preparation_drain_unconfirmed` 查准备；`media_execution_drain_unconfirmed` 查进程树/文件操作；`agent_transfer_drain_unconfirmed` 查同 Agent、同已分发 UUID 的持久回执；`upstream_operation_unconfirmed` 查未知协商/start/progress；`upstream_cleanup_pending` 查 stop 响应；`upstream_cleanup_failed` 保留已耗尽预算；`legacy_upstream_cleanup_unconfirmed` 查缺少预约/观测证明的旧授权。`room_cleanup_retry` 结合数据库/服务日志，不猜测为已释放。
6. 运行配套的新组件后，仍存活且完整登记的所有者可继续排空、回执和自动重试；再读 lifecycle 确认同一 epoch 只完成一次。范围外房间可在自身证明齐备后关闭，范围内旧未知记录继续保留。无法证明的旧资源、未知远端身份和不可重建回执仍是存量升级阻断。
7. 即使上述人工核对有正向证据，当前也没有受支持、审查过的对账写入接口把它转成旧行的持久证明。须另行实现并验证限定 owner/epoch/资源身份、审计和竞态保护的方案；不提供填充 ACK/reaped 时间、修改范围/计数器、直接写 closed、删除历史或 force-close 的捷径。

真实库恢复、旧版本组合和回退兼容尚未验收。原主线二进制的 SQLx migrator 不认识新增 0027–0030，保留表不代表可直接回滚；不得删表/迁移记录绕过检查。

## 3. 候选协商的准确范围

本地文件用 ffprobe 前后句柄/文件身份验证；NAS 通过有 lifecycle 约束的临时 Worker 探测授权，探测结束停止授权，只在 source_version 仍匹配时保存证明。候选绑定用户、房间、媒体代次、lifecycle epoch、media/source version、音轨和服务端原始配置，客户端不能自行声明任意媒体参数。

候选顺序为原 MP4 直放、符合零起点/旋转/VFR 约束的复制转封装、复制视频并转 AAC，以及固定 SDR 1280×720/30fps/AVC High Level 3.1 的全转码。AVC/AAC 配置取实际编码字节和探测字段，缺失不猜；无音轨不虚构音频。浏览器最多等 500ms 后冻结回报；passthrough 需要对应 decodingInfo 明确支持，API 不可用只对固定保守转码允许 MIME 提示。

HTTP/Jellyfin/Emby 等来源返回 `provider_requires_legacy_negotiation`，沿用既有保守提供者路径，不能宣称已有同等实际文件绑定。缺 source_version 的 NAS 返回 `source_version_required`，不得作为无版本 NAS 播放许可。计划提供 decision_reason/selected_candidate_id，源变化或过期绑定拒绝，而不静默套用旧报告。

自动模式只在解码错误时排除候选，每路线一次、最多三条路线；原生 HLS 保留一次 native→MSE。网络、鉴权或首帧超时不触发追加转码；首帧 20 秒给出错误。关闭、换媒体、离房取消迟到链路。旧兼容样本提示继续存在，不能把它与实际候选证明混为一谈。

## 4. 本轮源码与验证

当前基准仍为 `399d699`。0030 与相关边界修正的最终源码/二进制绑定、基础和列明的运行矩阵全部通过；各组合命令退出0。先前 131 文件包的通过记录保持独立。本轮日志根目录 `/workspace/shared/rainsync-main399-causal-artifacts/`；旧包日志保留在 `/workspace/shared/rainsync-main399-artifacts/`。

| 本轮检查 | 状态 | 证据 |
| --- | --- | --- |
| 0030 旧范围、未来房间与事务并发 | **13/13 通过，退出0；资源清理确认**，最终13脚本组合再次通过 | `legacy-nas-scope-final.log`、`legacy-nas-scope/ad453d2c-5acb-47cb-8516-f0292e95d80c/report.json` |
| 真实旧库迁移及保留期 | **1–28→29/30 通过**，未知项保留、范围外新房间重启后可关闭 | `room-cleanup-migration-final.log` |
| 格式/Clippy/协议/锁定构建与单元 | **Rust102 passed +3 ignored；前端109 passed/17 files**；fmt、Clippy全目标-D warnings、协议、vue-tsc与Vite通过，保留852.07kB主JS提示 | `final-checks.log` |
| 旧功能/账号/聊天/优先项/片单扫描组合 | **通过，退出0**；完整集成含隔离pg_dump/restore、100快照冒烟，17流场景、NAS/房主迁移及扫描恢复通过 | `final-legacy.log` |
| 生命周期与协商13脚本 | **全部通过，退出0**；含0030、真实FFmpeg清理、三组件正常退出、NAS回执/索引和实际候选 | `final-lifecycle.log` |
| 状态精度/真实PG Worker健康 | **3组精确f64 DB/WS +6健康故障场景通过**；健康ignored入口已另行实跑 | `final-lifecycle.log` |
| 原上游预约/实际观测/崩溃未知 | **19/19、24/24、1/1通过，退出0**；全部清理及源码/二进制身份检查通过 | `upstream-reservations-final.log`、`upstream-observations-final.log`、`upstream-crash-unknown-final.log` |
| 当前浏览器/镜像/设备/长期 | 当前云端浏览器启动受限，无新UI执行证明；Docker/部署镜像、实机/arm64、两小时/72小时和最终负载未执行 | 上游历史证据独立保留 |

本轮17项流撤销最大单流源释放4.255秒；12槽位阻塞组4.818秒断流，同池无关请求6ms。Agent普通退出4ms前已保存回执，重启确认后房间关闭。三个ignored为两个子进程辅助入口及单独实跑的真实PG健康测试，未当成单元通过。毫秒值仅为隔离实测；应用截止依赖runtime可调度，不能泛化为强杀或内核不可中断I/O保证。

绑定入口 `scripts/bind-native-backend.mjs` 在锁文件固定的工作区二进制/示例构建前后核对后端输入和迁移，记录三服务实际 SHA-256；`backend-binding-path.txt` 指向对应候选的 `backend-binding.json`。本轮已包含迁移30，128项后端输入摘要为 `732d42efad1a0541beee23eb66c023e084d0865e75c3bb4b456a6107193c93e9`，绑定文件 SHA-256 为 `f60d8d53eb0b6373d9400e21ae4410fb9acdaf1903018fb67865a87b6a5956c0`；原上游运行前后128项输入和三二进制未变。日志/绑定使用新目录保留旧包证据。受控 Jellyfin/Emby 接口验证不冒充真实产品部署兼容。

**此前 131 文件包（0027–0029）的历史验证：** Rust102 passed +3 ignored、前端109 passed/17 files、格式/Clippy/协议/vue-tsc/Vite通过；`final-legacy.log` 和 `final-lifecycle.log` 两链退出0，`final-roundtrip-health.log` 为3组精确状态和6健康故障通过；原上游预约/观测/崩溃未知19/24/1通过。旧源码摘要为 `0da0d22f944ae7e1b29db7c425c84f35b24ed589c202d59055bc6a5adcc78181`，只适用于该历史包。其17项流撤销最大单流4.254秒、12槽位组4.835秒/无关请求6ms，Worker普通退出10.006秒、迟到准入2.952秒、Agent落盘退出3ms均为当时隔离实测，不是新候选结果或生产承诺。旧记录及原失败保留；三个ignored未计通过，其中真实PG健康入口另行实跑。

该历史包已经修复并验证普通退出时的资源所有者排空、上游正向证明保留、实际候选及旧扫描预期；本轮改变旧NAS范围后已按上表重新验证。普通SIGTERM能排空不等于SIGKILL、不可中断I/O或未知上游身份可得到回执。上游45秒所有者等待超时仍保留 `upstream_owner_drain_unconfirmed`；房间重试也不重置五次/六十秒上游预算。

### 历史证据的适用范围

**已保留的 6227469 分支证据：** Rust 77 passed +2 ignored、前端 87 passed、类型/构建和定向生命周期/清理/NAS 回执及迁移通过。日志包括 `/workspace/shared/rainsync-phase2-workspace-final.log`、`rainsync-phase2-frontend-final.log` 和 `rainsync-artifacts/{room-lifecycle,room-cleanup,agent-drain}-*-latest.log`。这些是旧源码/旧迁移编号下的历史，不能证明当前 399d699 补丁。

**主线已有证据不能抹掉：** [PLAN_AUDIT](PLAN_AUDIT.md)、[VALIDATION](VALIDATION.md) 记录了源版本/自动索引、Windows/Linux Agent、浏览器、部署镜像定向验证，以及上游预约/实际观测 API/旧库兼容检查。候选 D 的 NAS 两小时尝试在 **103.2 分钟提前停流而失败**；十房×十人、五十房×两人两种控制拓扑各 **60 分钟通过**。后续 Worker 已区分数据库结果未知与确认失租，但新候选两小时仍需重新验收；不能拼接旧候选时长，也不能把历史控制通过泛化为最终媒体联合负载通过。

本次云端浏览器执行曾被环境权限阻断，没有新 UI 执行证明；这不等于历史浏览器测试从未运行。当前候选的 Docker/部署镜像、真实硬件、长期运行尚未执行，保留上游历史结果但不借用为当前版本通过。

复现入口 `npm run test:lifecycle-capabilities` 现包含13脚本（生命周期/迁移、0030因果范围、清理/上游、三组件正常退出、NAS回执/索引与候选），新增单项 `npm run test:legacy-nas-scope`，另运行 `npm run test:priority-remediation`、既有 `tests/integration.mjs` 及上游预约/观测回归。使用仓库外产物目录、自有合成媒体和独立数据库；可选 native PostgreSQL 配置见 [本地验证说明](CLOUD_LOCAL_VALIDATION.md)。CI 新组合入口仅表示已配置；本报告不声明远程 CI 通过，推送后须另查发布提交及其 CI。

## 5. 尚未关闭的门槛

- 本地移植/迁移回归不替代任意真实库的升级/回退验收
- 存量未证明资源的受支持对账/恢复路径、真实库升级与回退；旧 NAS 可能范围内的房间可长期无法关闭；未来房间豁免不解除真实旧资源核验和对账门槛
- 真实 NAS 两小时持续观影、候选 72 小时、持续 100 在线/弱网、资源趋势与授权复查成本
- Docker/部署镜像、Windows NAS/各文件系统、Safari/iOS/Android 实机与 arm64
- 完整角色/私人库授权、所有提供者的实际媒体候选、HDR 和其余 `NEXT_PLAN.md` 扩展包

本阶段证明的是已列场景的实现及隔离验证，不宣布整份计划、任意旧库迁移或所有设备验收完成。

## 6. 主线整合与复验记录

1. 已保留 6227469 工作树/补丁与证据，并以 399d699 建立独立移植树；旧通过记录不改标为 399d699 通过。
2. 已整合 upstream reservations、viewer observations、已确认 Worker 租约、背压/自动索引与本分支生命周期/回执；上游仍为一份预约账本，定向结果见上表。
3. 已保留上游 0025/0026，新增房主/生命周期/清理为 0027/0028/0029；随后追加 0030，只按不可变因果范围排除旧NAS不可能关联的新房间，不标记旧资源已排空。
4. 此前旧结构/全新库、混合误插入、重启和回执竞态验证保留为历史；0030 的13项范围/并发/身份不可变检查、实际升级及最终13脚本组合均通过。用户真实库及人工旧记录对账仍须独立验证，不由范围修正自动解除。
5. 新累计替换包仍以同一目标SHA构建，已按本轮128项输入与三二进制绑定完成基础、两组合链和上游矩阵验证。浏览器、Docker、设备、长时验收及旧库对账继续开放，不能据此宣布发布就绪。
