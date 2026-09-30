# NAS Agent 传输生命周期

## 当前版本与验证范围（2026-09-30）

本文整合主线 `399d699` 已有源版本、自动索引和背压机制，以及本次 0028/0029 生命周期/释放回执及 0030 旧 NAS 影响范围补强；当前移植后的结果见 [第二阶段报告](PHASE2_LIFECYCLE_NEGOTIATION.md)，尚未取得的新验证不以旧分支通过替代。源版本自 `13262053` 已存在，历史 E15 及上游 Windows/Linux 验证继续保留。候选 D 两小时 NAS 在 103.2 分钟失败，两种控制拓扑各 60 分钟通过；它们不是最终新候选验收，详见 [计划审计](PLAN_AUDIT.md) 和 [验证记录](VALIDATION.md)。

## 源文件版本绑定

迁移 `0019_agent_source_versions.sql` 为索引增加可空 `source_version`。新 Agent 在完整索引中报告 `stat-v1:` 版本；文件版本变化会清空旧探测元数据和时长。Server 将版本固定到探测授权和最终播放会话，探测结果只在索引仍为同一版本时保存。Worker 的一次性传输请求携带该版本，并核对 Agent 成功响应中的版本；缺失或不一致的版本不能用于播放。

版本来自已打开文件的身份、大小与修改/变更时间：Linux 使用设备/inode/mtime/ctime，Windows 使用卷/文件 ID 及文件时间。Agent 在同一已打开句柄上读取，每个块读取前后检查版本；不会校验路径后重新打开另一个文件。替换后旧授权返回 `SOURCE_CHANGED`，原地改写或缩短导致已开始的响应中断，不追加第二份错误首部。相同大小且恢复 mtime 的替换和原地改写有实际回归。

`stat-v1` 是文件系统变化检测，不是内容哈希、不可变快照或跨会话缓存复用证明。不能保证任意不可靠远程文件系统都会报告变化，也不能撤回已经交付的字节。获取新版索引后需重新发起播放；旧方案不会自动改绑新版文件。

自动播放探测保留 Worker 确认的 `SOURCE_CHANGED` / `SOURCE_VERSION_REQUIRED`（409，不可盲重试），未知上游错误仍脱敏为探测失败。转码任务保存同样的固定失败原因，只执行一次，不发布旧源产物，且释放写入预留；后续读取任务清单仍返回明确的 409。

升级时停止旧 Worker，由新 Server 执行迁移，再启动新 Agent 和 Worker。旧索引的 NULL 版本不会自动回填为可信版本；Agent 重新连接并完成索引后才能播放。旧 Agent 的无版本成功响应会被拒绝并提示升级，旧播放授权需重新创建。该规则补充下文迁移 0018 的生命周期升级顺序。

## 自动索引与快照失败隔离

`AGENT_INDEX_INTERVAL_SECS` 默认六十秒，可配置为五至 86400 秒。控制连接保持独立处理心跳和传输；后台扫描按 ACK 推进，每次连接只保留一个扫描，共享扫描名额防止重连时重叠。每页最多 128 条且受字节上限约束。

单个可识别视频无法打开或无法取得可信版本时，索引记录 `available:false`、`source_version:null`；其余视频继续更新。恢复可读后的完整扫描重新恢复可用状态。目录无法枚举等全局扫描失败发送 `INDEX_ABORT`，Server 撤销暂存快照并确认，不把不完整结果发布为片库删除，也不关闭仍有效的控制连接。断线同样回滚暂存快照；只有完整提交才标记真正消失的文件。

验证入口 `node tests/agent-index-refresh.mjs` 使用真实 Server/Agent/PostgreSQL、权限故障及透明控制代理，覆盖延迟 ACK、扫描期间读取、恢复、目录失败、删除和断线回滚。文件系统仍须提供可靠身份/变化时间；网络文件系统的专门验收继续。

## 持久化状态与一次性授权

迁移 `0018_agent_transfer_runs.sql` 增加独立的生命周期记录，保留 `offered → connected → streaming → completed/failed/cancelled`。短期 `agent_transfers` 仍只负责分发一次性票据；Worker 在同一数据库事务内消费票据并进入 `connected`，第二个连接不能再次使用。有效元数据接受后写入 `streaming`；HEAD 和空正文也经过该状态，再进入终态。

记录包含 Agent、授权资源描述的 SHA-256、方法、Range、时间、交给 HTTP 响应体的字节数和固定内部原因，不存数据通道 URL、令牌或明文源路径。这里的资源摘要用于关联授权描述，**不是文件内容版本或内容校验**；独立的 `source_version` 绑定见上文。

领取、续租、阶段推进及终态写入先锁定对应行，再用独立语句的 `clock_timestamp()` 检查有效期；不会沿用事务开始时或等锁前的时间判断。失效租约不能被旧所有者延长，也不能把过期任务补写为成功。

转码读取遇到传输失租时，记录为可恢复输入故障，沿用媒体任务最多三次的执行上限；不会因为本次 relay 的租约失败而立即记为不可重试的编码失败。

HTTP 处理及正文持有同一生命周期登记。正常的完整正文、HEAD 或空正文标记 `completed`；已确认的错误首部、上游错误状态、断流等标记 `failed`；提前丢弃请求/正文为 `cancelled`。第一个确定的终态保留，迟到的连接关闭或清理不得覆盖。`completed` 表示所需字节已交给 HTTP 层，不证明客户端收到全部字节、解码完成或用户观看完成。活跃字节计数随续租采样，正常结束再记录最终计数；失租或崩溃时只保留最后确认值，不能当作客户端实际收取字节的精确统计。

独立所有者先原子写入票据和状态，再通知请求继续；即使 HTTP 在 INSERT 期间取消，也在插入结束后原子提交终态并清理票据。活跃租约为三十秒，每十秒续期，续租及终态收尾各最多等待三秒；续期失败/超时或租约已失效会停止通道和 HTTP 流，不继续使用不确定的所有权。长传输不会因最初票据的三十秒有效期结束而中止。Server 的每分钟清理将无终态且租约到期的记录标为 `failed/transfer_owner_lost`；数据库恢复后也可处理崩溃遗留。普通终态保留二十四小时后清理；本轮 0029 的房间关联传输如果缺少 Agent 释放回执，不能随普通历史清理删除，必须继续阻止房间宣告关闭。只有非 legacy_unconfirmed 且符合普通清理条件的记录继续按原保留期清理；旧未映射 NAS 历史按 0030 的不可变 possible_room_cutoff 保留为可能房间的关闭门槛，不能因无 session 关联或范围外新房间获准关闭而删除。

迁移 0018 的升级顺序为先停止 Worker，备份数据库，再由新 Server 执行迁移，最后启动对应版本 Worker。该迁移会删除没有生命周期所有者的旧短期票据；正在等待它们的请求需重试。0018 本身未改变 Agent 消息格式；0019 另增加下述源版本协议。回滚应用版本前应停止活跃传输，生命周期审计不视为跨版本持续会话恢复。

## 源版本升级就绪反馈

本轮新增就绪信息用于区分“索引存在”与“版本绑定可用”：Agent 列表含 `indexed_count`、`unversioned_count`、`source_versions` 与 `source_version_status`（`empty`、`ready`、`rescan_required`、`upgrade_required`）。新版 HELLO 声明 `source_versions: true`；连接/扫描能力与索引就绪分开表示，离线设备也可能保留 `ready` 索引。无版本旧快照可以保留供浏览，但不能作为播放恢复成功；手动扫描仍有无版本条目时返回 `upgrade_required`。具体升级与重扫步骤见 [运维说明](OPERATIONS.md)。旧分支定向记录见 [第一阶段历史报告](PRIORITY_REMEDIATION.md)，当前移植验证见 [第二阶段报告](PHASE2_LIFECYCLE_NEGOTIATION.md)。

## 播放授权撤销与源所有权

在原有传输租约和 Agent 撤销之外，本轮 Worker 媒体交付增加 `playback_access` 守卫：从等待上游首部、清单/字幕缓冲等响应准备阶段开始复查，响应首部提交前再查一次，并持续保护正文。每两秒复查 session/token、到期时间、停止状态、房间媒体代次及成员资格；本轮生命周期实现同时要求房间 active 且 lifecycle_epoch 与播放会话匹配。每次数据库检查最多三秒，最近成功授权检查的最大年龄为五秒；拒绝、错误或超时都取消当前准备/读源操作。

准备期监控持续到首部提交前的最后复查完成，不能在已有 Response、尚未提交首部时留下无监控空窗。授权 SQL 使用事务局部的 2500ms `statement_timeout`；被取消或出错的检查关闭自己的连接，成功检查才正常归还连接池，避免锁住的查询在响应结束后长期占用共享池。事务局部设置不会改变其他 Worker 查询的超时配置。

这增加了数据库负载：稳定正文每条流每两秒约一次检查，每次健康检查执行 BEGIN/SET LOCAL/SELECT/COMMIT；100 条持续流约 50 次检查、200 条 SQL/秒，另有准入/准备检查。该数值是源码估算，不是实测容量结论。五秒授权年龄是可调度 runtime 中的应用截止，不能当作实时系统、停机进程或任意内核 I/O 的绝对保证；持续 100 在线与资源成本门槛仍开放。

复查与正文生产位于独立任务，消费者停止读取不会暂停复查。取消正文生产会释放其拥有的本地文件、HTTP 上游响应或 NAS 传输登记；下游丢弃也中止该任务。额外应用队列最多一块 64KiB，撤销后不再交付队列内字节。源自身、网络库、内核及浏览器缓冲不包括在此上限中，已经交出的字节无法收回；这不是对客户端最后一个字节到达时间的五秒承诺。具体运行结果和未覆盖平台见本轮报告。

## Agent 数据任务生命周期

Agent 的数据任务绑定到创建它们的控制连接。本轮改为 watch 通道协作取消：控制连接结束后通知所有数据任务，等待 JoinSet 中的任务及其已开始的 blocking 文件操作真正退出，再按现有间隔重连，不以 abort future 当作文件释放证明。旧授权连接的任务不跨重连继续运行。默认 16 个文件传输名额保持不变；过载拒绝使用另一个最多 4 个任务的预算，避免拒绝流量本身无限创建连接。拒绝预算也满时不再连接该票据，并为要求回执的已接收 UUID 记录未打开资源的释放回执；Worker 的既有等待期限结束请求。

控制连接握手最多十秒，控制帧发送最多三秒。数据连接握手最多十秒，元数据写入及正文无进展最多三十秒，关闭收尾最多一秒。有效传输租约下，Worker 在等待本地消费者队列时每五秒发送精确 `rainsync-backpressure-v1` Ping；Agent 保留同一次正文写入 future，并用这类健康信号延长其无进展期限。普通 Ping/Pong 不延长期限；Worker 的真实字节读取期限也不被健康信号重置。停止、消费者关闭或失租会停止健康信号并取消通道。

传输同时读取对端，Close/EOF/连接错误触发取消；路径解析、文件打开/版本检查、seek/read 由可登记的 blocking 任务执行。取消等待者后，已启动操作仍须返回并释放文件，等待 JoinHandle 结束后才释放名额并生成回执。内核 I/O 持续阻塞则保留未确认状态，不伪造释放。

普通 SIGTERM/Ctrl+C 同样走协作取消与排空，不以操作系统直接结束进程代替回执。连接建立和重试等待可被停止信号中断；已有资源全部排空后，退出前继续重试尚未成功的回执落盘。重启只重发已完成并保存的 UUID，不给前一进程未完成的工作补造证明。不可中断 I/O 或存储持久化失败仍可能让正常退出等待。真实暂停流的定向验证见 `tests/agent-graceful-shutdown.mjs`：退出前已落盘，重启 ACK 后房间关闭；当前最终组合状态见 [第二阶段报告](PHASE2_LIFECYCLE_NEGOTIATION.md)。

按初始文件长度发送精确字节数。源文件在传输中缩短会返回内部错误并结束连接；响应元数据一旦开始发送，之后的错误只关闭连接，不再追加 404 元数据。开始发送前的路径/文件错误仍使用原有 404，Range 无效为 416。

## 房间关闭与 Agent 释放回执（本轮 0028–0030）

本节是房间生命周期补强，不能用上面的历史 relay 终态测试代替。`agent_transfer_runs` 新增 `session_id`、`dispatched_at`、`agent_drained_at`。Worker 创建关联房间播放的 relay 时绑定会话并请求 `drain_receipt_required: true`；Server 在网络发送前事务性记录分发意图，网络发送失败仍视为可能已暴露，不能假设 Agent 没有收到。

Agent 只有在数据 socket、文件对象及所有已登记的 blocking 文件操作释放后才发送 `TRANSFER_DRAINED { id }`。请求已收到但因预算已满或配置校验而完全未开始资源操作时，也记录该 UUID 的无资源回执。Server 使用已认证控制连接的 Agent ID，且要求该行有分发记录；另一个 Agent 或从未分发的 UUID 不能写入释放时间。重复合法回执保留首次时间。`completed`、`cancelled`、连接断开或租约过期都不能代替这个回执。

已完成释放的 UUID 写到凭据文件旁的 `.drained.json`，不含 token、文件名、内容或数据 URL；重连和进程重启会重试。每次心跳最多发送 32 条。仅 `accepted: true` 或 Server 明确返回的 `rejected_permanently: true` 才删除待确认项；数据库失败不发送 ACK。文件通过随机同目录、create_new、Unix 0600 临时文件写入并同步后原子替换，避免固定临时文件的符号链接覆盖。该机制未声称提供断电后的跨文件系统事务保证。

4096 条待确认项时暂停接收新资源工作；新收到但尚未开始资源工作的 UUID 仍须先保存，不能丢弃已分发义务。加上已经在途的至多 20 个任务，短暂超出阈值是有界的。无法保存回执或存储不可用时不承诺可自动恢复，Server 保持可观察的 closing；持久化日志会报告故障。

关闭房间先事务撤销授权，再由清理器等待独立的准备、Worker 本地资源、上游和 NAS 回执。只有所有义务已确认完成，房间才进入 closed。缺失 Agent 释放证据的关联终态不按 24 小时普通日志保留期删除，避免因历史清理把未确认状态变成假成功。自托管 Agent 是受信任的资源所有者，本协议是认证后的进程释放证明，不是对已被攻陷 Agent 的硬件证明。

升级门槛：`legacy_unconfirmed` 旧未映射记录在 possible_room_cutoff 大于等于房间 cleanup_birth_ordinal 时返回 `legacy_agent_drain_unconfirmed`；0030 前全部既有房间仍在旧记录范围内，只有可证明因果上晚建的房间获豁免。两个值由同一事务计数器及持有至提交的行锁分配，不能依赖时间戳推断，也不能修改标记、范围或房间/会话身份规避。豁免不表示旧资源已排空，普通 ACK/保留期仍不解除范围内门槛，当前没有人工对账写入或强制关闭接口。

停止并确认旧 Server、Worker 和 Agent 的活跃传输/进程已退出，再备份数据库、迁移并启动配套的新版本。晚到的旧 Worker INSERT 会捕获当时的范围上限，可能涵盖此前新建房间；任意旧写入在最终关闭检查后出现不在保证范围内。旧 Agent 不生成新回执；0029/0030 也不能从旧任务的 cancelled/failed 或未关联会话的历史行推断操作系统资源已释放。范围内房间可能无限期 closing；不要滚动混用旧服务并声称房间关闭具有完整回执保证，也不要手工填充时间戳绕过未知资源所有权。

验证入口（含0030的新候选十三脚本链已重跑通过）：`node tests/agent-drain-receipts.mjs` 使用隔离 PostgreSQL、真实 Server/Worker/Agent 与 1GiB 稀疏文件，直接观察 Linux Agent 文件描述符，覆盖暂停消费者关闭、认证身份/重复/未分发回执、延迟数据库 ACK 后 Server 重启重发、控制连接独立丢失后的数据取消，以及受控服务端不确认时的 4096 条回执背压。播放会话为测试授权夹具直接入库，不等同于完整浏览器观影测试。NAS 单元测试覆盖取消 100ms blocking 等待者后仍等待真实释放、回执落盘/重读及临时文件符号链接防护。旧6227469记录不计作当前验证；`rainsync-main399-artifacts/final-lifecycle.log` 是此前0027–0029交付包的历史结果，含0030的新通过证据为 `rainsync-main399-causal-artifacts/final-lifecycle.log`，详见当前报告；不宣称本次回执机制已通过 Windows、不可中断文件系统、两小时观影或 NAS 长时内存门槛。

## 历史与其他定向验证

验证入口：

```powershell
$env:WORKER_TEST_IMAGE='rainsync-agent-lifecycle-validation:local'
node tests/agent-lifecycle.mjs
```

该脚本运行真实 Linux Agent 与独立稀疏文件卷，使用受控控制端和数据消费者制造背压。检查 16 路文件描述符、第 17 路拒绝、Close/TCP 关闭混合取消、五秒内名额复用、控制断开后的文件/数据连接退出、重连 Range/HEAD、握手期限以及文件缩短。报告记录镜像与几个负载阶段的 RSS；它不是两小时内存趋势或总内存上限证明。

端到端传输验证入口：

```powershell
$env:WORKER_TEST_IMAGE='rainsync-worker-validation:local'
node tests/input-retries.mjs --agent-relay
```

该入口启动真实 Server、Worker、Agent 与隔离 PostgreSQL，使用有授权的播放会话夹具读取独立稀疏文件。八路 HTTP 消费者制造背压，检查 HTTP 取消经 Worker 到 Agent 的文件关闭、Agent 重启后旧响应截断与新 Range 成功，以及管理员 DELETE 撤销经 Server 控制连接关闭到 Agent 文件释放、Worker 旧 HTTP 流中断和新请求拒绝。会话夹具直接入库，故不将它称为登录/配对/播放准备到浏览器解码的完整观影验收。

状态及恢复验证入口：`node tests/input-retries.mjs --relay-cancel`。它使用真实 Worker、Server 和 PostgreSQL，加受控 WebSocket 数据端，检查延迟 INSERT 的取消、各阶段取消、正常 HEAD/正文、并发领取、错误首部/状态/断流、超过票据期限的续租、失租断流、强杀 Worker 后的实际租约过期收尾和终态保留清理。保留清理测试主动回拨一条终态记录的时间，不声称实际等待二十四小时。

自动探测和错误传播的隔离回归入口：

```powershell
docker build -f deploy/Dockerfile -t rainsync-source-errors-validation:local .
$env:WORKER_TEST_IMAGE='rainsync-source-errors-validation:local'
node tests/input-retries.mjs --source-version-playback
node tests/input-retries.mjs --nas
node tests/input-retries.mjs --agent-relay
```

使用真实 Server/Worker/PostgreSQL 和 FFprobe，自动探测的 Agent 数据端为受控夹具；同时检查失败准备授权撤销和同请求编号重放不创建新探测。`--nas` 增加源变化、缺版本、版本不匹配和未知错误脱敏的转码任务场景。必须使用当前源码构建的镜像，既有同名本地镜像不保证包含本轮变更。

Windows 原生入口：`node tests/agent-native.mjs`，入口自动执行 `cargo build -p rainsync-nas-agent --locked`。使用真实 exe、独立本地媒体文件和受控控制/数据端，通过逐文件独占打开检查句柄持有及释放，并保存阶段内存样本。具体完成场景和环境见 [验证记录](VALIDATION.md)。

范围仍有缺口：真实设备进入内核不可中断 I/O、所有阻塞/远程文件系统及两小时连续观影与内存趋势。Tokio 文件操作底层使用 blocking I/O，丢弃异步 future 不代表能强制中断任意内核文件操作。Windows 原生夹具不替代完整 Server/Worker/Agent 的 Windows 链路，也不证明总内存上限；HTTP 请求登记清理见 [Worker 传输说明](WORKER_ATTEMPTS.md)。
