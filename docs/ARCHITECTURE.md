# 工程约定

本文描述 `399d699` 上已整合的第二阶段语义移植代码。主线 0025/0026 保持原文，新增为 0027 房主、0028 生命周期、0029 清理、0030 旧 NAS 因果范围。含0030的128项后端输入及三二进制已绑定，基础与列明组合复验全部通过；此前0027–0029记录独立保留为历史。见 [第二阶段报告](PHASE2_LIFECYCLE_NEGOTIATION.md)。

## 组件

- `server`：认证、房间 Actor、媒体索引与上游协商、Agent 控制连接。
- `media-worker`：鉴权后的 Range/HLS 服务、FFmpeg 队列、Agent 数据连接。
- `nas-agent`：只读目录索引、主动控制和数据连接、16 路传输信号量。
- `web`：Vue 界面，独立 TypeScript 时钟校准与纠偏模块。
- PostgreSQL：快照、事件、命令去重、账户、播放会话、任务和设备。

媒体与控制不共享发送队列。FFmpeg 参数通过参数数组传递；视频字节通过流传输，不读入整个内存。

## 状态与事务

每个房间的播放命令由单 task、有界队列串行处理，依次检查权限、command_id、revision、media_generation。快照、事件和命令结果在同一数据库事务中提交，提交成功后才广播。房主管理可通过独立 HTTP 事务修改快照，因此播放命令仍须重新取得持久化状态，并在提交事务内校验 revision/控制权，不能把 Actor 内存状态当作唯一权威。

房主转让由当前房主/实例管理员选择已有成员，以预期 revision 提交；事务同步 owner/controller、快照、事件和 migration 0027 审计，并撤销旧 control epochs。它不转移片源所有权。接口见 [房主转让](ROOM_OWNERSHIP.md)。

迁移 0028/0029 加入独立房间生命周期：active → closing → closed → archived，只有 closed 可显式重开为暂停的 active。关闭/重开增加 lifecycle_epoch，归档保持已关闭 epoch；自然 END_MEDIA 与播放列表循环不关闭房间。管理和播放准入按 room → snapshot 顺序加锁，准备完成必须验证原来捕获的 epoch，不能在 close/reopen 后取新 epoch 继续发布旧工作。

close 在同一事务内暂停、撤销命令/邀请/播放请求与会话、取消任务并插入持久化清理任务。closing/closed/archived 拒绝写入，已授权成员可读取历史。重开需要新命令凭据与新播放授权，不恢复旧邀请或自动播放。权限与事件语义见 [房间生命周期](ROOM_LIFECYCLE.md)。

### 关闭完成证明与旧库边界

清理器独立重试，只有旧 epoch 的不可变准备尝试、Worker 执行/交付、进程树与已启动 blocking I/O、上游身份/操作、NAS 远端文件所有者全部有明确释放证明才转 closed。资源处理不在房间数据库事务内等待；最终检查与新增资源登记共享生命周期准入锁。租约过期、取消状态和 socket 关闭均不是释放回执，详细所有者/失败恢复见 [清理协议](ROOM_CLEANUP.md)。上游复用主线 `upstream_reservations`，0029 为其加 lifecycle_epoch；保留独立设备身份、五次失败/六十秒总预算、公平有界清理和真实 video 观测，没有第二份上游资源账本。关闭房间不重置已失败的清理预算；Emby 仍须 Stopped 与匹配设备/SID 的 encoder DELETE 两项正向确认，未知在途操作不能假关闭。48 小时上游保留期还要求关联授权已有正向 closed marker 且房间无待处理清理，marker 失败仅能从已 closed 的账本修复，不能删除最后一份完成证明。

0029 不能把旧 failed/cancelled/缺失输出记录改写为已回收。0030 为 rooms 增加不可变 cleanup_birth_ordinal，为 legacy_unconfirmed NAS 行增加不可变 possible_room_cutoff；同一 room_cleanup_birth_counter 行锁随插入事务持有到提交，以因果顺序而非时间戳划定可能房间。cutoff 大于等于房间序号仍返回 legacy_agent_drain_unconfirmed，NULL 防御性视为全局；所有迁移前房间都在迁移前旧行的范围内，只有因果上晚于该旧行的新房间可排除。房间及播放会话身份不可转移以绕过范围。普通 ACK/保留期不清除旧标记，数据库删除保护继续保留证据，未产生任何旧资源释放证明。

晚到旧 Worker 插入会取得当时范围，可能涵盖先前已创建的新房间；升级必须停止并排空旧组件、使用匹配版本，任意旧写入在最终检查后出现不在保证范围内。范围内未知旧义务仍可使房间一直 closing；无人工对账写入或 force-close 入口，受影响存量部署仍须另行验证对账方案，不能盲填时间戳或删记录。详见 [第二阶段报告](PHASE2_LIFECYCLE_NEGOTIATION.md)。

Server 正常停止先关闭准备/上游准入，排空真正接收的探测/协商/报告所有者并提交其回执或观测确认；数据库锁后迟到的登记观察既有停止信号，不再启动新 probe。上游所有者排空最多45秒，超限显式保留 upstream_owner_drain_unconfirmed，不能以HTTP宽限结束代替完成证据。

Worker 的 App 级交付登记表统一关闭准入、取消活跃交付并等待所有者排空；HTTP 的正常退出宽限结束后仍要等待释放及持久回执，不能让 runtime 结束时中止独立清理任务。数据库锁期间迟到的准入可在停止后完成登记，但不得打开新源。数据库不可用或文件系统操作无法返回时，退出与 closing 可以继续等待，不伪造回执；强杀后缺失证明仍按上述不确定性处理。

房间状态保留播放锚点、服务端单调时钟时间、时钟纪元、倍速和媒体版本。进程重启暂停所有房间、更新纪元和版本。实例 advisory lock 的专用连接断开后进程立即退出，避免失去锁仍继续写入。

客户端以四时间戳估计时差，选取低 RTT 样本；误差 <=150ms 忽略，150–2000ms 通过最多 ±5% 倍速修正，超过 2 秒或持续 15 秒不收敛时 seek，seek 冷却 5 秒。客户端等待、seek、自动播放受阻时停止纠偏。

## 播放路径

播放会话与用户、房间、片源代次及 lifecycle_epoch 绑定，30 分钟到期并可续期。Worker 每次媒体请求检查会话、当前媒体代次、active 状态和匹配的 lifecycle_epoch，并在首部提交前复查。响应准备与正文生产共用播放授权守卫：每两秒复查、单次最多三秒、成功授权最大年龄五秒，上游首部等待/清单缓冲或下游背压都不阻挡撤销和源释放。已进入网络/客户端缓冲的字节不能收回；参数与验证边界见 [传输生命周期](AGENT_TRANSFERS.md)。播放授权撤销检查与 Worker 任务执行租约不同：保留主线“数据库结果未知只在最近已确认租期内继续、确认失租即取消”的规则，不把一次查询超时冒充确认失租。浏览器只获得会话票据；上游服务凭据保留在加密资源中。

HLS 清单中的子清单、分片、初始化片段和 KEY URI 被重写为 RainSync 地址。上游地址使用会话绑定的加密授权，客户端无法自行生成其他资源地址。首版拒绝跨源清单资源与 HTTP 重定向，防止凭据越域转发；使用跨域 CDN 的源需要后续显式允许列表支持。

本地和有有效 source_version 的 NAS 文件可通过 `/api/v1/playback-candidates` 获得至多四条实际候选：原 MP4 直放、符合条件的复制转封装、复制视频/转 AAC，以及固定 SDR 720p/30fps/AVC High Level 3.1 转码。实际 AVC/AAC 配置来自源元数据与编码字节，缺失信息不猜测，HDR 不自动转换。五分钟加密绑定限制用户、房间、生命周期 epoch、代次、媒体/源版本、音轨和原始候选；发布时再次校验。

浏览器保留旧布尔与有限样本报告以兼容，实际候选仅探测服务端给出的配置，等待最多 500ms 并冻结回报。实际 passthrough 要求对应 decodingInfo 明确支持，API 不可用时仅固定保守转码可使用 MIME 提示；明确不支持不当作未知。自动模式仅解码错误可排除候选、每路线一次且最多三条路线；网络/鉴权/首帧超时不自动升级转码，20 秒首帧等待给出明确错误。原生 HLS 保留一次 native→MSE 回退，关闭/换媒体/离房取消后续链路。

HTTP/Jellyfin/Emby 等无稳定文件版本的外部来源返回 `provider_requires_legacy_negotiation` 并走既有保守路径；无版本 NAS 返回 `source_version_required`，不伪造文件证明。该区分与 `decision_reason`、候选契约/边界见 [能力协商](PLAYBACK_CAPABILITIES.md)，不代表所有媒体或设备已验收。

Agent 每次传输使用独立 WebSocket，一次性票据通过控制连接交付。Worker 16 个 64KiB 帧缓冲形成 1MiB 应用层上限；网络库与内核缓冲不包含在这个数值中。正文不足声明 Content-Length 会产生流错误。

NAS 索引与播放授权已有 migration 0019 的 `source_version` 绑定；Agent 以句柄身份/属性版本检查替换和原地变化，Worker 校验返回版本。它不是文件内容哈希或不可变快照。旧 NULL 索引需新版 Agent 完整重扫，扫描/就绪反馈不能把无版本索引报成播放恢复成功；详见 [传输说明](AGENT_TRANSFERS.md) 与 [运维步骤](OPERATIONS.md)。

关联房间的 NAS 分发先写持久化意图再发控制消息。Agent 协作取消并等文件/socket/已启动 blocking 操作实际结束后才产生 TRANSFER_DRAINED；Server 验证已分发 UUID 与已认证 Agent。待确认回执落盘重发，只有确认/永久拒绝后移除；4096 阈值暂停新资源工作，不丢已接收义务。缺少回执就保持 closing，自托管 Agent 的声明不是对被攻陷机器的硬件证明。

## 协议与持久化

HTTP 前缀 `/api/v1`，控制 WebSocket `/api/v1/ws`，媒体 `/media-delivery`，Agent 数据 `/agent-data`。Rust 类型生成的 TypeScript 和 JSON Schema 放在 `packages/protocol`；修改协议后运行导出命令。

首版不拆微服务，不引入 Redis，不支持多控制实例。多实例之前必须实现房间租约、fencing 和节点路由。对象存储、CDN/P2P 通过媒体分发边界扩展，不改变房间权威时间轴。
