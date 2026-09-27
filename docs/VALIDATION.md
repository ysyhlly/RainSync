# 本轮验证记录

## 2026-09-27：探测与字幕有界输出及进程回收

进程树所有者移到 media-core，探测和字幕转换接入同一生命周期。Windows 工作区 43 项测试通过，另有 2 个刻意忽略、由测试显式启动的子进程夹具入口。新增 capture 用例检查正常完成、输出超限、截止和取消 future 的后代回收；Windows 用进程句柄确认退出。Clippy 全目标且 warnings 视为错误、格式、工作区二进制/示例构建和生成契约一致性通过。

对应 Linux build 镜像中，media-core 11 项和 Worker 15 项 release 测试通过，2 个子进程夹具入口忽略。最初直接测试缺少 verify_fixtures 示例引用的 JSON，随后只读挂载仓库 `tests/fixtures` 后完整重跑通过；没有改产品构建或下载新依赖。测试命令：`docker run --rm --network none --mount type=bind,source=C:/rainsync/tests/fixtures,target=/build/tests/fixtures,readonly rainsync-capture-build:local cargo test --release --frozen -p media-core -p rainsync-media-worker`。

最终镜像 `sha256:b2756d191f5f3f0c33d6a83525468ba343d9befece41cbcc709f574efa0b72c7` 的完整 Worker 故障矩阵通过，报告 `.runtime/worker-processes/rainsync-process-940f0dfc/report.json`。新增两个真实 HTTP 接口各三个场景：正常调用实际 ffprobe/字幕 FFmpeg 返回 200，包装脚本注入超量输出和卡住则返回 502；六次响应返回后包装进程和遗留后代均已退出，Worker 保持运行。原编码进程树、首段解码、逐段/最终产物、ENOSPC、缓存权限、读租约、预算、数据库中断、SIGTERM 和旧 Worker 恢复矩阵同时通过。重跑用 `WORKER_TEST_IMAGE=rainsync-capture-validation:local node tests/worker-processes.mjs`（PowerShell 先设置该环境变量）。

`node tests/integration.mjs` 完整通过，含远程自动探测、字幕交付、播放请求恢复、读租约、旧代次回收、NAS 万条索引及备份恢复；100 控制连接快照 314ms 仍仅为本机冒烟。本轮没有网页修改，未重复浏览器或前端测试。运行服务未部署更新；系统退出/runtime 排空、慢编码和完整计划其余门槛继续保留。

## 2026-09-27：编码与首段解码进程树

Windows 原生 `cargo test --workspace --locked` 通过 42 项测试，另有 2 个刻意忽略的子进程夹具入口。新测试覆盖终止、Drop、正常主进程退出及取消等待，并检查后代真正退出。Clippy 全目标且 warnings 视为错误、格式检查、生成契约一致性、工作区二进制/示例构建均通过。完整隔离 PostgreSQL 集成通过，包含既有 NAS、读租约、队列、播放就绪、旧目录清理和备份恢复回归；100 连接快照 258ms 仅是本机冒烟。

Linux 构建阶段镜像运行 Worker release 单元测试，16 项通过、2 个子进程夹具入口忽略。最终运行时镜像 `sha256:e498436c52026ad3f7d79e82417ca61471192a00f3d6c3c8e6e9de6d9a8f865a` 的完整真实 FFmpeg 矩阵通过，报告 `.runtime/worker-processes/rainsync-process-301f4378/report.json`。新增停止会话、SIGTERM、正常编码完成三个场景：包装进程、真实 FFmpeg 和故意遗留的后代均已消失，检查时容器仍在运行，预算已释放。既有首段解码、只读/权限/ENOSPC、逐段与完整 HTTP 解码、HEAD/Range、数据库中断、旧 Worker 失租恢复及旧目录清理同时通过。旧 Worker 恢复后 attempt 2 保持运行且当前产物未变。

第一次矩阵在测试脚本调用精简镜像缺少的外部 `kill` 时失败；改用 shell 内建命令后完整重跑通过。最终镜像使用锁定依赖的本地 vendor 构建输入和 `--frozen`，未修改部署 Dockerfile；构建输入仅保存在忽略的 `.runtime` 下。机制与重跑入口见 [进程树](PROCESS_TREES.md)。

本轮未修改网页，未重跑前端或浏览器测试。cgraphy 变更审查超时，改用 Git diff 审查；格式与差异空白检查通过。镜像仅用于隔离测试，未部署。探测/字幕进程调用链、Windows 系统退出事件、强制杀死 Worker、慢编码和完整计划的其余门槛仍待验收。

## 2026-09-27：旧执行代次独立回收

迁移 0017、按代次读租约与独立 Worker 清理循环接入。Rust 41 项测试、Clippy（所有目标，warnings 视为错误）、格式、生成契约一致性和工作区二进制/示例构建通过。完整隔离 PostgreSQL 集成通过：新增示例验证旧读者/历史未绑定读者保护、当前读者不阻挡、过期清理者不能完成、并发单一领取及重复检查；实际 Worker 在会话仍有效时删除旧目录，并再次删除模拟晚写文件。HTTP 背压测试确认租约保存实际 attempt，续期及失租断流仍通过。既有 NAS、恢复与控制面回归通过，100 连接快照 264ms 仍仅为本机冒烟。

独立镜像 `sha256:f559fb231a6adc47e931fc7d0d0b88fc05064c506aef7b2e38871989a407af4c` 的完整真实 FFmpeg 故障矩阵通过，报告 `.runtime/worker-processes/rainsync-process-28f28e69/report.json`。旧 Worker 暂停失租后，新 Worker 使用 attempt 2；恢复旧 Worker 后无残留 FFmpeg，旧目录回收，新 init 内容保持不变。只读/权限/ENOSPC、首段解码、逐段和最终 HTTP 解码、读租约、预算、SIGTERM 和数据库隔离均同时回归。

本轮未修改网页，未重复前端或浏览器测试；不把旧结果计成本轮实测。cgraphy 变更审查超时，提交审查使用 Git diff。镜像只用于隔离测试，未部署；W05 的慢编码、进程组及其余完整计划验收仍待完成。机制与升级限制见 [旧代次清理](OUTPUT_CLEANUP.md)。

## 2026-09-27：W05 阶段提交检查点

本次汇总缓存读租约与写入预算、带执行代次的持久化产物发布、首段实际解码、播放就绪区间查询、容量限制和按用户轮转调度，以及缓存访问错误契约。包含迁移 0012–0016 与同步生成的协议；升级约束见各专题文档。

提交前重新运行前端 31 项测试、桌面/移动尺寸浏览器 36 项回归、类型检查和生产构建，全部通过；构建仍有非阻断的包体积提示。Rust 40 项、Clippy、格式/生成契约检查、完整隔离集成和真实 FFmpeg 故障矩阵沿用下方同一运行时代码的最新结果。浏览器移动尺寸测试不代替移动实机验收。

cgraphy 变更审查未返回，提交前改用 Git diff 检查并通过空白检查。三个无关的根目录演示文件排除在提交之外。本检查点不部署服务，也不关闭 W05 或完整计划的剩余验收项；下方“未提交”等措辞记录各历史阶段当时的状态。

## 2026-09-27：缓存访问错误契约

缓存输出目录创建按操作系统错误类型区分只读、权限拒绝和空间耗尽，保存稳定原因；新增 CACHE_READ_ONLY / CACHE_PERMISSION_DENIED 文案提示修复环境后重新准备，均不自动重试。Server 就绪查询与 Worker 读取共用终态错误白名单，容量和重试耗尽也不再在状态查询里丢失具体原因。未知任务错误仍统一映射 MEDIA_JOB_FAILED，不返回原始路径、系统文本或任意存储的错误码。TS/JSON Schema 同步生成。

Rust 40 项、前端 31 项、Clippy、构建和契约检查通过。前端回归覆盖这两个终态错误不会触发同键自动重试。完整隔离集成验证容量、只读、权限拒绝、重试耗尽及私有字符串在两种入口上的状态/错误码一致，且不可重试；NAS、备份恢复及 100 控制连接冒烟亦通过（315ms，非持续负载）。

新镜像 `sha256:754fc6339a4afaaa0adcc70bbc7f23b5d64ddbf38a2c7ff0228bb5c218b3d624` 的完整实际 Worker 故障矩阵通过，报告 `.runtime/worker-processes/rainsync-process-5bd7fe83/report.json`。真实 tmpfs 故障确认数据库保存对应稳定原因，并保持无清单、无预算残留、无剩余 FFmpeg。报告字段改为 `no_encoder_remaining`，避免把启动前失败误读为曾经启动再回收编码器。镜像用于隔离测试，没有替换部署服务。

分类目前只施加于已知缓存写入点，不把源读取或进程启动权限问题归入缓存故障；FFmpeg 编码中途的非零退出仍保守处理，其他可确认原因的细分和恢复仍待推进。本轮未提交、部署。

## 2026-09-27：只读和不可写缓存

在既有独立镜像 `sha256:93e53591d921779d91917ab80791f7bf18a667e80fc0d551eea0755c3033ecc1` 上扩展并通过完整真实 Worker 矩阵，报告 `.runtime/worker-processes/rainsync-process-62f210ba/report.json`。新增只读 tmpfs 和 UID 10001 的 0500 不可写目录，使用真实写操作分别确认 Read-only file system 和 Permission denied；任务均进入 failed，没有可见清单、残留写入预算或存活/僵尸 FFmpeg，Worker 仍运行并可正常关闭。所有卷和媒体均为测试容器专用。

两项可能在启动编码前失败；报告的 `child_reaped` 在这些场景只表示失败后没有残留 FFmpeg，不证明曾启动编码。它们不代替编码中途更改权限的测试，也不证明访问权限恢复后的自动重试。当前错误为通用 MEDIA_JOB_FAILED，细分诊断仍在计划中。其余首段解码、实际 ENOSPC、逐段/最终 HTTP 解码、SIGTERM、数据库隔离及暂停后代次接管回归同时通过。

本轮只修改测试和文档，格式检查通过；未重复 Rust/前端矩阵，未提交、部署。

## 2026-09-27：按用户公平领取

migration 0016 增加持久轮次。领取事务在短调度锁下选择最久未分配的用户，保留用户内创建顺序、SKIP LOCKED、有效会话、重试上限与退避条件；轮次和新 attempt 的产物记录一起提交。数据库例子验证 A 的三条积压与 B 的两条交替、独立连接继承轮次、并发不同用户领取、产物插入失败不消耗轮次、锁住任务及退避不阻塞其他可领取任务。无用户历史任务合为一个桶，不把每条历史任务当成新用户。

Rust 40 项、Clippy、格式和生成契约检查通过。完整隔离集成通过，包括公平队列、容量、现有执行代次/租约、NAS 10001 条分页、备份恢复和 100 控制连接冒烟（331ms）。公平性只针对领取机会，不抢占长编码，也不代表 CPU 时间或等待时延均等；完整负载验收仍未完成。

当前源码独立镜像 `sha256:93e53591d921779d91917ab80791f7bf18a667e80fc0d551eea0755c3033ecc1` 的真实 FFmpeg 矩阵全部通过，报告 `.runtime/worker-processes/rainsync-process-0eb02c0c/report.json`。覆盖首段解码拒绝/检查超时回收、缓存读租约、写入预留、实际 ENOSPC、逐段和最终 HTTP 解码、SIGTERM、数据库中断、旧 Worker 暂停后的代次接管。镜像只用于隔离测试，未部署；本轮没有修改网页代码，未重复浏览器矩阵。W05 累积改动尚未提交。

## 2026-09-27：可配置会话与队列容量

新增 `PLAYBACK_SESSION_LIMIT`（默认 2）和 `MEDIA_QUEUE_LIMIT`（默认 20），并加入 Compose 和示例环境。会话上限保留原有用户行锁和准备记录去重；任务上限通过事务级数据库锁把计数、会话、任务与方案提交串行化。队列满新增 `MEDIA_QUEUE_FULL` 契约，网页有限重试沿用原 key，生成的 TS/Schema 已更新。部署变化及尚未实现的公平调度见 [容量说明](MEDIA_CAPACITY.md)。

Rust 40 项、前端 31 项、Clippy、生产构建、格式及生成契约检查通过。隔离数据库新例子验证并发争抢最后一个名额只有一次成功、失败的会话回滚、运行任务计数和撤销后容量释放。API 场景验证满队列返回可重试 503、没有孤立活跃会话/任务、直放仍成功，释放容量后同 key 的第二次准备成功。既有每用户并发验证显式配置 8，默认 2 和非法配置由单测检查。

第一轮完整集成发现入队函数将 sqlx 错误包装为 anyhow 后，插入约束失败从 DATABASE_ERROR 变成 INTERNAL_ERROR。改为保留 sqlx 错误类型后，完整集成通过，包括失败注入回滚、NAS 10001 条分页索引、独立数据库备份恢复和 100 控制连接冒烟（309ms，不是持续负载验收）。本轮没有修改 Worker 编码过程或浏览器播放器流程，未重新运行真实 FFmpeg/浏览器矩阵；没有提交或部署。

## 2026-09-27：在途生成区间查询的取消

新增两个浏览器场景：生成区间查询保持在途时换房，以及通过房间状态收到区间外 SEEK。两者都观察到旧 HTTP 请求中止；延后释放旧 ready 响应后，新媒体地址保持不变，没有第三次播放准备、额外旧查询、错误横幅或未处理异常。SEEK 的新准备位置还验证位于新的 120 秒目标附近，未沿用原来的约 1800 秒位置。桌面和移动尺寸共四项通过。

这些测试使用受控媒体区间和 API 响应，验证真实网页取消与事件流程，不代替真实编码、Safari 或移动设备解码。本轮只新增测试及记录，未修改运行时代码；没有重复运行上一轮已通过的 Rust/数据库/FFmpeg 验证，也未提交或部署。

## 2026-09-27：生成区间和同会话等待

就绪响应增加相对方案原点的 `available_until_ms`；查询 `relative_position_ms` 时，未完成任务只在目标严格位于已发布区间内返回 ready。区间从数据库中当前 attempt 的清单求和，忽略私有文件与旧 attempt。隔离集成验证 3999/4000/5000ms 边界、负数及 NaN 拒绝；完整回归通过，100 个控制连接为 269ms，本地冒烟。

网页首次等待持续使用最新房间目标；播放自然追上生成末端时暂停纠偏并等待同一会话，用户主动远距离 seek 仍重建方案。Rust 共 39 项、前端 31 项、桌面/移动模拟浏览器 32 项、Clippy、生产构建及生成契约检查通过。本轮未更改 Worker 编码或发布流程，未重新运行真实 FFmpeg 矩阵。

首轮浏览器回归发现原生错误恢复与较早区间等待竞争地址，已在恢复开始时取消旧等待。新增测试首次还暴露了夹具时长为 3600 秒、实际 seekable 仅短样本长度的不一致；将两者统一为受控区间后验证“等待中不增会话、就绪后按房间位置重取入口”，最终全套通过。此项是浏览器流程验证，不是实际 Safari 或慢编码性能证明。真实慢编码持续追赶、设备恢复和时间戳偏移矩阵仍待完成；W05 改动尚未提交、部署。

## 2026-09-27：播放入口就绪接口

新增 GET 播放会话状态及生成的 TS/JSON Schema，网页等待当前代次发布首段后才绑定媒体地址。细节与未覆盖的生成区间语义见 [播放入口状态](PLAYBACK_READINESS.md)。Rust 38 项、Clippy、前端 30 项单测、生产构建、协议只读生成检查及格式检查通过。现有浏览器 28 项与新增准备等待测试的桌面/移动模拟 2 项分别通过；移动模拟不代表真机验收。

完整隔离 PostgreSQL 集成通过：直放状态、其他用户读取拒绝、停止会话拒绝、版本 2 当前代次尚未发布/已有首段/完成状态，以及失败和取消终态。受控旧代次产物不会使当前代次提前就绪。整套回归同时覆盖 NAS 10001 条分页、数据库备份恢复和 WebSocket 错误帧；100 控制连接取得快照为 322ms，仅本地冒烟。Worker 的真实 FFmpeg 矩阵沿用上一节已完成的独立镜像证据，本轮未重新构建或部署该镜像。

浏览器新增测试证明准备中不绑定媒体地址、ready 后加载、仅一次 POST。前端单测另外验证外部取消不变成超时、180 秒截止、临时网络故障、错误会话标识，以及准备完成后等待失败仍按原 key 撤销。当前 W05 改动尚未提交或部署。

## 2026-09-27：W05 首段实际解码

migration 0015 将新产物设为校验版本 3，保留旧版本 2 的完整性语义。首次可见清单和快速编码后的最终发布均经过同一个首段解码检查。Rust 38 项、Clippy、格式检查和完整隔离集成通过；集成的 100 个控制连接取得快照为 348ms，仅本地冒烟。

独立镜像 `sha256:b8963590bc61ae80c9c0f6b7cab12dd3b85aa62586401008db5f192b88fd6f5c` 的实际进程矩阵通过，最终报告 `.runtime/worker-processes/rainsync-process-6bf6ddbc/report.json`。损坏样本保留非空、边界合法的 ftyp/moov 顶层结构，但内部不可解码；隔离 FFmpeg 包装器仅控制编码器产物的暴露时点，随后由真实 FFmpeg 解码，测试确认检查进程已经启动且任务失败前后都没有可见清单。正常首段可在编码继续时发布，最终 HTTP 清单仍可完整解码。

另两项注入将检查进程替换为等待进程：十秒截止后，Worker 仍运行时确认检查 PID 和编码进程均消失，数据库执行保持可恢复；SIGTERM 在待决检查期间五秒内正常退出，任务回到 queued，写入预算释放。这两项验证取消/截止与直接子进程回收，不冒充真实慢解码或任意后代进程组验收。原缓存保护/预算、ENOSPC、缺片、数据库隔离、旧 Worker 恢复矩阵同时通过。首轮报告 `.runtime/worker-processes/rainsync-process-273d160e/report.json`；最终轮增加检查启动与关闭时限断言。

本轮未提交、未部署。首段 FFmpeg 解码不代表整片或全浏览器兼容；状态接口、旧代次独立回收等 W05 范围继续保持待办，细节见 [产物发布](OUTPUT_PUBLICATION.md)。

## 2026-09-27：W05 持久化逐段发布与内容摘要

migration 0014、版本 2 发布任务及 HTTP 摘要检查已接入。隔离 PostgreSQL 验证证明缺失/变化回滚、同一证明重试、旧完成 API 不可绕过、owner/停止会话隔离；锁测试通过 pg_stat_activity 确认发布查询确实等待行锁，再让租约过期，验证不能发布。触发器注入最终更新失败后，任务仍 running、清单仍没有 ENDLIST，移除故障后才一起提交成功。删除任务时证明随产物级联清理。

路由测试验证旧版本兼容、新版可见清单不受私有清单半写影响、等长载荷损坏及证明缺失被拒绝；GET、HEAD、Range 都复核整片内容。Rust 全 workspace 37 项通过，后续哈希读取边界补强再次通过 Worker 13 项，另一个 ignored 为显式启动的监督子进程夹具。Clippy 和格式检查通过。

独立镜像 `sha256:a140bf672ff444fbca9421f5a77505e5820f25d6a3cae0097d2ece272cb4cd69` 的实际 FFmpeg 故障矩阵全部通过，报告 `.runtime/worker-processes/rainsync-process-90de1196/report.json`。编码中读取的实际分片字节与数据库长度/SHA-256 一致；私有清单半写期间已提交版本仍返回 200；正常完成后的清单经 Worker HTTP 完整解码，HEAD/Range 正常。缓存保护/预算、ENOSPC、缺片、SIGTERM、数据库隔离、旧执行恢复场景全部通过。

首轮完整隔离集成通过（100 控制连接快照 270ms，仅本地冒烟）。哈希读取上限与锁等待断言补强后，最终版本的第二轮完整集成也通过，包括真实数据库证明、读取回归、Agent 分页索引、重启和备份恢复；100 控制连接快照 305ms，仍不等于持续负载验收。当前未提交、未部署；逐段状态接口、首段运行时解码、旧代次独立回收等仍待完成，详见 [产物发布](OUTPUT_PUBLICATION.md)。

## 2026-09-27：W05 增量分片结构检查

新增清单增量结构验证与文件读取前检查，行为和边界见 [读取检查](OUTPUT_READINESS.md)。Rust 36 项通过（另一个 ignored 是监督器显式调用的子进程夹具），Clippy、Rust/JavaScript 格式和 diff 空白检查通过。路由回归已覆盖临时分片等待、最终重命名后交付、临时/未公布文件拒绝、缺片及截断后的 GET/HEAD/Range 拒绝，并保留慢消费者租约验证。

独立镜像 `sha256:ff72f82a7017c203231f817f23f673add0942842746501fffd2a69ca94b43dd8` 的实际 FFmpeg 矩阵全部通过，报告 `.runtime/worker-processes/rainsync-process-2ab595ae/report.json`。新增场景暂停编码进程、保持 Worker 正常运行，读取尚未结束的清单和已生成分片；恢复并完成后，通过 Worker HTTP 地址完整解码，同时验证 HEAD/Range。其余缓存、ENOSPC、SIGTERM、数据库隔离、执行代次故障回归均通过。结构夹具测试不等同于解码验证。

完整集成前三次在 WebSocket ERROR 等待处超时。首轮 35 帧突发可能跨固定窗口；提高到 65 帧并增加调用位置/连接状态诊断后，确认限速连接已异常关闭、错误帧未到达。Server 现于主循环结束后进行最多两秒的关闭握手，避免未读突发帧导致直接断开；三轮突发均已验证收到 RATE_LIMITED 且关闭码不是 1006。Worker 镜像矩阵在这项 Server 修正之前完成，握手修正由本机 Server 的完整隔离集成验证。最终整套集成通过，包括 10001 条 Agent 分页索引、会话撤销、重启及独立数据库备份恢复；100 个控制连接取得快照耗时 267ms，只是本地冒烟，不是持续负载验收。

当前改动未部署、未提交；持久化逐段发布、分片内容摘要等 W05 剩余范围仍未完成。

## 2026-09-27：W05 写入预算

迁移 0013、Server 产物估算和 Worker 编码前预留已接入。真实 PostgreSQL 验证并发申请只能一方使用同一测量、剩余额度不足拒绝、释放导致旧测量失效、owner 隔离，以及过期/消失任务预算回收。取消状态在执行租约仍有效时保留预算，明确回收子进程后才主动释放。

独立镜像 `sha256:e5fab549e3ddff3371ac9527a412465984a6e7882b97a858fec0f2ae44cc37cc` 的小卷实测验证超额请求在编码前失败、可回收空闲目录先淘汰再准入、后续准备失败释放预算；SIGTERM 和 ENOSPC 收尾均确认预算行消失。为保留真正的 ENOSPC 注入，测试中的小卷任务故意申报 1 MiB 低估值，不把它当作 Server 的正常估计。证据 `.runtime/worker-processes/rainsync-process-52431d90/report.json`，其余真实 FFmpeg 故障场景全部通过。

Rust 35 项、Clippy、完整隔离集成、格式检查及 Compose 静态配置验证通过。当前保守计费会将运行中的实际文件与整笔预留同时计算，具体边界和配置见 CACHE_BUDGET.md。未部署，W05 整包仍未完成。

## 2026-09-27：W05 缓存读取保护

后续恢复补强重新通过 Rust 34 项、Clippy、完整隔离集成及实际进程故障矩阵。数据库验证额外覆盖清理者过期拒绝提交、完成后残留租约移除、仍有会话引用时保留淘汰记录；隔离卷覆盖“文件已删、数据库未确认”且已无空间压力的恢复。镜像 `sha256:4faf2a516caee17616ccad4430ec9a3cb72d9068a48682d5ff1a1c146795dc68`，证据 `.runtime/worker-processes/rainsync-process-98e24c91/report.json`。

迁移 0012 增量扩展旧缓存表，Worker 缓存路径接入三十秒读租约、独立五秒续期和带 owner 的淘汰状态。真实 PostgreSQL 示例 verify_cache_leases 验证停止后已有读者保护、过期不能续活、并发淘汰唯一获胜及旧 owner 隔离。真实 Worker 的 100 MiB 响应在客户端暂停六秒期间仍续租，强制租约过期后传输中断。完整隔离集成与备份恢复通过。

独立镜像 `sha256:91669f7a2c57466a48a964e1462bbff8c0e7225364bea241aad59654addeeee9` 的实际缓存删除及 FFmpeg 故障矩阵全部通过；证据 `.runtime/worker-processes/rainsync-process-3af7bbcd/report.json`。低配额清理保留有读租约目录、删除空闲目录，租约过期后可回收；继续验证 ENOSPC、产物完整性、SIGTERM、数据库隔离、配额和旧代次恢复。Rust 34 项、Clippy 和格式检查通过。本轮未改网页，也未部署服务。剩余范围见 CACHE_LEASES.md，不将整个 W05 标为完成。

## 2026-09-27：追加缺陷 21–26

- 空房间选择在 enter 修改连接/播放状态之前返回。桌面和移动尺寸回归确认套接字、播放方案和当前资源保留。
- 扫描改为事务外探测、每 32 项短事务提交，完整成功后才下架缺失条目。迁移 0011 的扫描编号在批次提交及最终核对时防止旧扫描继续写入。接口注入第二批数据库失败，确认首批 32 项保留、旧条目仍可用；后续完整扫描恢复正常。
- 对 Jellyfin/Emby 分别测试缺失总数、字符串总数、第二页缺失总数及提前空页，均拒绝扫描并保留旧片库。
- 片库默认 100、最大 200，UUID 游标翻页并支持服务端标题搜索。350 项接口测试覆盖无遗漏、无重复、隐藏下架条目；浏览器测试覆盖前后翻页和新搜索清空游标。兼容及升级说明见 LIBRARY_SCANNING.md。
- NAS 每轮最多发送一条传输，回到 select 后更新心跳并处理输入/索引确认；索引确认也有三秒发送截止。真实数据库注入每次领取延迟 1.2 秒，连续 16 条期间逐次确认 last_seen 小于五秒，避免原来的整批等待。
- hls.js 的 409 恢复以房间时间减 timeline_origin 为起播位置，不再传 -1。原生 HLS 的媒体错误最多三次重新加载带缓存区分参数的入口 URL，并附当前房间时间。恢复期间等待 EVENT 清单覆盖目标位置，兼容 duration=Infinity 时的 seekable 区间，不因短清单新开播放会话。受控事件回归验证两种分支；不声称该注入用例是 Safari 实机测试。
- Rust 34、前端单元 26、桌面/移动尺寸浏览器 28 项通过；Clippy、构建、格式和生成契约检查通过。完整隔离 PostgreSQL 集成通过，既有 VFR 样本 native/MSE 的真实解码及 seek 共 20 项通过。未变更运行中部署。

## 2026-09-27：追加缺陷 16–20

- 16：拆卸前移除媒体事件回调并清空当前方案；新回调绑定加载序号、方案及元素，只报告当前资源的真实错误。保留 load() 释放旧资源。浏览器回归注入拆卸后的异步 error，验证重载、切房不误报，当前资源的 code 4 仍提示格式错误。
- 17：产物校验截止与容量检查使用同一可恢复的 LeaseInterrupted 分类，超时不调用永久失败收尾，交由过期租约和现有三次尝试策略重做。实际校验发现缺片/损坏仍失败，绝不发布未经校验的输出。此前容量检查超时已有恢复路径，本轮补齐校验超时。确定性测试验证超时与真实校验失败分类；不声称复现机械盘长片超时。
- 18：本地运行中 fMP4 清单读取有 2 MiB 上限，验证 EXTM3U、完整行、初始化文件、成对 EXTINF/连续分片和结束标记；只发送本次已验证的快照。截断时有界重试，每次复核任务代次。接口回归写入两种半写清单，确认不立即返回，恢复完整内容后得到 200。
- 19：首个内联字幕时间戳允许等于 cue 起点，后续仍严格递增并小于终点；保留跨起点裁剪。单测覆盖相等、重复、倒退、超界，Worker 字幕接口亦验证该边界。
- 20：NAS 按扩展名返回 MP4/WebM/Matroska/QuickTime 类型，未知使用 octet-stream，测试覆盖大小写。当前 HTTP/NAS 自动模式原本已在临时授权提交后探测，本轮明确区分 requested_mode；新增真实 Server 接口加受控探测响应验证 HTTP 自动选择 direct/remux/transcode，不把该测试当作实际远程解码证据。
- 验证：Rust 34 项通过（另有一项 ignored 子进程入口）、前端单元 26 项、桌面/移动尺寸浏览器 22 项、完整隔离 PostgreSQL 集成、Clippy、生产构建、格式、生成协议一致性全部通过。既有真实 VFR HLS 样本的 native/MSE 共 20 项 App 解码/seek 回归通过。
- 重建的隔离镜像 `sha256:6e413e3da9d0759bbd8d55cfca95820c9d9da5044cf24620f99aceeca2960c04` 通过真实 FFmpeg 进程故障矩阵（写满、发布、缺片、SIGTERM、数据库隔离、配额及过期代次替换）。证据 `.runtime/worker-processes/rainsync-process-2abcd38f/report.json`；浏览器证据 `.runtime/fixtures/seek-vfr-58f16685-484f-48ea-8ffc-96ca0b9be0b0/browser-report.json`。未更新运行中的部署。

## 2026-09-27：播放、房间与 Agent 的 15 项缺陷修复

- Web：首个有效时钟样本之前不准备/校正播放；重连重新采样，前台恢复保留偏移。拖动期间不覆盖滑块；切房在任何等待前作废旧连接，异步房间数据按序号丢弃。登录失效清空用户并返回登录表单。
- 播放续期仅为仍在使用的失效播放会话提示错误，服务端播放 410 使用 INVALID_PLAYBACK_SESSION，与登录过期分开。重连通过消息 ID 分页补拉并去重。HLS 致命 409 最多三次重取未固定代次的入口清单，不创建额外播放会话。
- Worker：监督器的三秒健康截止只覆盖续租；续租失败/超时杀死并回收子进程后保留租约回收路径，不写成永久编码失败。执行中的容量扫描独立并发运行，不占续租截止时间，扫描缓慢不杀编码器；执行前/完成后仍检查容量。完成检查超时同样交由租约回收；明确容量不足仍是容量错误。
- 上游 PlaybackInfo 的转码地址在保存令牌授权前校验 scheme/host/port 同源，拒绝外部绝对地址、协议相对地址和内嵌凭据。
- Agent：扫描线程经有界通道分批发送，每页最多 128 项、目标 128 KiB（按序列化 UTF-8 字节预算）；逐页等待 INDEX_ACK，失败或确认超时回到两秒重连。服务端独立入库任务允许心跳/控制帧继续处理，完整索引事务提交前不替换旧目录。消息和单帧均限制 1 MiB，Ping/Pong 不断线。传输逐条锁定、成功发送后领取，未发送部分可重投。
- 迁移 0010 为媒体增加 available。完整本地/NAS 扫描将消失的文件逻辑删除，隐藏于片库且不能新开播放；保留历史房间/播放会话的外键引用，重新出现恢复原 ID。取消一万项整次失败限制及片库查询的一万项截断。Server 与 Agent 应一并升级；旧单包 INDEX 仅兼容不超过 256 项的小目录。
- 房间名/聊天按 Unicode 标量分别限 120/2000；聊天收到本次消息的服务端回显才清空，拒绝保留输入。已知时长夹紧 seek，未知时长统一限制七天。邀请创建/撤销与加入均先锁 rooms 行，随后才锁快照/修改邀请。
- Rust 30 项测试通过（另有一项供子进程测试调用的 ignored 入口），含本地/NAS 各 10001 个真实目录项；前端 26 项单测、20 项桌面/移动尺寸浏览器回归、Clippy、构建、格式和生成契约检查通过。HLS 错误注入用替代的 Hls 事件源验证恢复调用及上限，不冒充真实网络/解码故障测试。
- 完整独立 PostgreSQL 集成通过：Unicode、105 条断线消息分页、撤销等待房间锁、总量超过 1 MiB 的 10001 项索引、Ping/Pong、心跳、半途回滚、消失文件、未发送传输保留；原有幂等播放、权限、上游模拟、NAS 中继、恢复与 100 连接冒烟保持通过。本次 100 连接快照 260ms，仅为本机冒烟。
- 实际 Linux/FFmpeg 故障回归通过，数据库暂停后任务保持可恢复并进入下一 attempt；ENOSPC、完成产物、缺片、SIGTERM、零容量、旧 Worker 恢复保持通过。证据：`.runtime/worker-processes/rainsync-process-d4c9bd99/report.json`，镜像 `sha256:386456cc81df8aea4f55512f25d80c66a51c6523022a984f46d9a7b5042952e8`。隔离容器已清理，未部署到现有服务。
- 真实 VFR 短样本 20 组 Chromium 原生 HLS/MSE 起播、实际解码推进和 seek 映射通过，证据 `.runtime/fixtures/seek-vfr-58f16685-484f-48ea-8ffc-96ca0b9be0b0/browser-report.json`。前一次运行被格式化触发的 Vite 热更新打断，固定源码后完整重跑通过；这不替代移动实机验收。
- 本批关闭的是上述 15 项缺陷，不代表 NEXT_PLAN.md 全部工作包完成；读取租约、逐段发布、实机/真实上游兼容及长期验收仍按原台账推进。

## 2026-09-27：W05 产物记录与原子完成

- 迁移 0009 增加 media_outputs（job/attempt 主键，含 owner、相对目录、状态、校验版本、清单 SHA-256、分片数及发布时间）。领取任务与 writing 记录创建在同一事务中；完成更新校验有效租约/会话/owner/attempt，成功状态与 published 记录原子提交。没有验证结果、没有匹配 writing 记录时不能成功。正常退出标记 abandoned，失联重领保留旧记录并新建当前记录。
- 真实数据库测试以合成摘要隔离验证事务行为：拒绝缺少验证结果，故意令产物状态不匹配，确认任务成功更新回滚且仍为 running；恢复 writing 后可提交 published。该合成摘要不是媒体验证证据，真实媒体另走 Worker 结构校验。
- Worker HTTP 对新完成产物读取记录并验证清单摘要；修改磁盘清单后返回 502，恢复原字节后可读。旧完成产物迁移为 legacy/version 0，无伪造摘要；新验证版本为 1。清单读取上限为 2 MiB。旧 Worker 必须在迁移前停止，不支持混跑。
- Worker 七项测试、全目标 Clippy、工作区构建与格式检查通过。清单摘要不覆盖分片内容，数据库原子完成不等于逐段发布与读取租约完成；W05 保持未完成，未部署。
- 完整隔离集成通过。当前源码 Linux 镜像的真实完成产物摘要与数据库 published/version 1 记录一致；删除分片后的产物记录为 failed，旧 Worker 租约过期后记录为 abandoned，新 attempt 为 writing。ENOSPC、退出与数据库故障回归同时通过；证据：`.runtime/worker-processes/rainsync-process-cdce3557/report.json`。测试容器已清理。

## 2026-09-27：W05 本地产物结构检查与结束标记

- 新增 `outputs::validate`，本地任务完成前以十秒截止检查限定的 FFmpeg fMP4 布局。清单限制 2 MiB，要求非空连续分片、初始化段、有效正数时长与结束标记；拒绝越界路径/符号链接/非普通文件，检查顶层 box 不超出文件边界且包含所需 ftyp/moov、moof/mdat。它不是任意 HLS 或完整 MP4 语义解析器，不等同逐帧解码。
- Worker 单测七项通过（另有一个由测试显式启动的 ignored 子进程入口），覆盖缺片、截断、越界引用、NaN 时长、错误 init 和未结束清单。全目标 Clippy、工作区构建和格式检查通过。
- HTTP 路由按当前 attempt 的成功提交状态决定是否显示 ENDLIST。隔离集成用同一份磁盘清单验证 running 时隐藏、succeeded 后显示，同时保留旧代次拒绝、容量错误和取消错误检查。完整隔离集成通过。
- 当前源码 Linux 镜像验证真实完整 HLS 正常进入 succeeded；另一次编码结束后、Worker 提交前删除首分片，任务进入 failed/media_job_failed 且无 FFmpeg 残留。ENOSPC、SIGTERM、数据库暂停、零配额、旧 Worker 恢复同时回归通过，证据为 `.runtime/worker-processes/rainsync-process-cc047754/report.json`。测试容器已清理。
- 结构检查与结束标记门槛不替代独立 media_outputs、逐段原子发布校验、内容解码验证及缓存读取租约。未部署，W05 不关闭。

## 2026-09-27：W05 完成前容量复查

- 新增隔离 8 MiB tmpfs 的真实 ENOSPC 注入：先等 HLS 清单落盘，暂停 Worker 并确认 T 状态，dd 写满后明确返回 No space left on device；等待 FFmpeg 退出形成可观测的 Z 状态，再恢复 Worker，覆盖编码器先于周期容量检查退出的窗口。仅测试容器 tmpfs 被填满，不触碰宿主机磁盘余量。
- 初次使用全部三分钟输入时，FFmpeg 没有在二十秒内退出，测试失败；改为处理样本最后三十秒后，旧实现的终态错误字段为空，与容量失败断言不符。该失败推动完成路径增加最多三秒的只读容量复查，复查不清理缓存，以免掩盖刚发生的容量问题。容量不满足时保存 failed/cache_capacity_exceeded，无法确认容量的成功结果也不能直接提交成功。
- 工作区构建、全目标 Clippy、格式检查及完整隔离集成通过；原有请求/重启恢复、媒体错误、NAS、数据库恢复与 100 连接冒烟保持通过。本轮未改前端和协议。
- 当前源码 Linux 镜像的五项实际故障检查全部通过：写入 ENOSPC、SIGTERM、数据库暂停、零配额、旧 Worker 租约过期后恢复。证据：`.runtime/worker-processes/rainsync-process-a0c60982/report.json`；测试容器已清理。
- 这不替代产物完整性校验：空间在完成检查前被外部释放、清单损坏或缺片仍需由后续原子发布与产物验证处理。W05 仍未完成，未部署。

## 2026-09-27：W05 容量与任务终态错误契约

- 缓存容量预检/巡检使用类型化 JobFailure，完成写入保留 cache_capacity_exceeded。Worker 读取终态时只按白名单生成公开错误，分别返回 CACHE_CAPACITY_EXCEEDED / 503、MEDIA_JOB_CANCELLED / 410、MEDIA_JOB_RETRY_EXHAUSTED / 502；未知原因回退 MEDIA_JOB_FAILED，三个新增终态均不可通过重读旧 URL 恢复。
- 真实 Worker HTTP 回归逐项验证错误码、HTTP 状态、retryable=false，并注入内部原因字符串确认不回显。TypeScript 与 JSON Schema 重新生成，一致性检查通过；25 项前端测试、前端类型/生产构建、四项 protocol 测试、工作区构建、全目标 Clippy 和完整隔离集成通过。构建保留已有前端 chunk 体积提示。
- 此处证明 HTTP 契约，不代表原生 HLS 播放器会展示 JSON 错误说明。FFmpeg 非零退出、写入中途 ENOSPC、临时网络分类仍待验收，未部署，W05 未关闭。
- 当前源码 Linux 独立镜像通过真实 Worker `CACHE_MAX_BYTES=0` 容量拒绝：任务保存 failed/cache_capacity_exceeded，没有 FFmpeg 残留；SIGTERM、数据库暂停和旧 Worker 恢复三项同时回归通过。证据为 `.runtime/worker-processes/rainsync-process-34e727d5/report.json`，测试容器已清理。零配额验证不能替代真实磁盘写满测试。

## 2026-09-27：W05 失联重试上限与退避

- 迁移 0008 增加 max_attempts（默认 3）及 available_at。租约失效后首次排队等待 2–3 秒、第二次 5–6 秒；领取时同时检查就绪时间和上限，第三次失效写入 failed / media_job_retry_exhausted。停止或过期播放会话先归为 cancelled，不把取消混入耗尽失败。正常退出释放也遵守执行上限。
- 隔离 PostgreSQL 的生产函数测试验证三次递增后不能再领取、退避区间、重复轮询不改变 available_at，以及停止会话的取消原因。定时区间由数据库实际时间测量；为推进后续次数，测试显式把到期时间移到过去，不能将它称为三次真实墙钟等待测试。
- 完整隔离集成、工作区构建、全目标 Clippy 和格式检查通过。原有重启恢复、备份恢复、NAS 和媒体路由回归保留。FFmpeg 非零退出仍保守终止，本轮不声称完成临时网络/永久编码错误分类和自动重试。
- 当前源码重新构建 Linux 镜像后，真实 FFmpeg 的 SIGTERM、数据库暂停和旧 Worker 暂停到实际租约过期后恢复三项全部通过；新增退避没有破坏 attempt 2 重领和旧进程回收。证据：`.runtime/worker-processes/rainsync-process-4b8b8356/report.json`。测试资源已清理，未替换已部署服务；W05 仍未完成。

## 2026-09-27：W05 Linux 真实 FFmpeg 故障

- 从当前源码通过 `deploy/Dockerfile` 构建独立镜像 `sha256:d13d5f14fbf5c2889cce3f24b0fca247a8e1a128071ba61dfeccf9c1977dd08b`，运行 `node tests/worker-processes.mjs`。不替换现有服务；脚本创建并清理独立网络/数据库/Worker，使用真实三分钟 H.264 样本和 FFmpeg 5.1.9，先确认 FFmpeg 仍在执行且 HLS 清单已落盘再注入故障。
- SIGTERM：约 571 ms 后正常退出，退出码 0，当前任务恢复 queued 且 owner 清空。数据库暂停：约 4293 ms 后 `/proc` 中无运行或僵尸 FFmpeg，Worker 仍可在数据库恢复后正常退出。
- 旧 Worker 暂停：先验证进程为 T 状态，等待真实三十秒租约过期，另一 Worker 以 attempt 2 在同一缓存根目录重领。检查两个 FFmpeg 命令分别指向各自 attempt 目录；恢复旧 Worker 后约 1502 ms 旧 FFmpeg 消失，新任务仍为 `2:running`，新 FFmpeg 仍运行，init 文件字节不变。没有缩短数据库租约来替代真实等待。
- 故障脚本最初因精简镜像没有独立 kill 命令而失败；改用 shell 内建后发现容器 PID 1 未被 SIGSTOP 暂停，租约仍续期。最终使用 Docker init 并直接暂停 Worker 子进程，增加 T 状态断言；前两轮均不计入暂停/恢复成功证据。此前不带 init 的 SIGTERM 单独测试也通过。
- 最终证据：`.runtime/worker-processes/rainsync-process-f717ceab/report.json`，含镜像、样本和 init 摘要及各故障耗时。Linux release 构建、脚本语法/格式、diff 检查通过；本轮未改变生产代码，没有重复无关单元测试。
- 该证据覆盖直接 FFmpeg 子进程，不替代任意后代进程组、Windows 系统信号、HTTP 请求级子进程、缓存读取租约或完整原子产物发布。W05 仍未完成。

## 2026-09-27：W05 队列退出与子进程监督

- Worker 接通 Ctrl+C/Unix SIGTERM 的停止通知，队列不再领取新工作。准备阶段可取消；运行子进程经统一监督器结束并 wait 回收后，才条件释放当前有效代次。领取/收尾数据库操作最多三秒，运行健康检查（含缓存）最多三秒；HTTP 最多排空十秒，主程序保留运行时等待队列收尾。
- Windows 下生产监督器启动真实 Rust 测试子进程：退出通知在健康检查挂起时仍可立即触发回收；挂起检查三秒截止；失锁和数据库错误均回收子进程。Worker 测试共六项通过，另一个 ignored 测试为显式启动的子进程入口，不是未执行的功能验收。
- PostgreSQL 生产函数回归增加当前代次释放后立即重领、attempt 递增、旧代次及停止会话不能释放。全目标 Clippy、工作区构建、格式检查及完整隔离集成通过，含请求恢复、代次路由、NAS、备份恢复与 100 连接冒烟。
- 这些证据不等于真实 FFmpeg 暂停恢复、Unix SIGTERM、Windows 控制台信号或后代进程组退出验证；HTTP 探测/字幕等请求级子进程的完整退出矩阵也仍需验收。未部署，不关闭 W05。

## 2026-09-27：W05 Worker 执行代次

- 新增 `0007_media_job_attempt.sql` 和生产 `persistence::media_jobs`：领取递增 attempt，续期和完成同时校验 owner、attempt、有效租约及有效会话。输出使用独立 `{job_id}/{attempt}` 目录；旧 completed 目录通过 attempt 0 保留，旧 running 任务迁移后重新排队。升级要求停止旧 Worker，不能混跑，详见 WORKER_ATTEMPTS.md。
- 隔离 PostgreSQL 中运行 `verify_job_attempts`：并发领取唯一、已过期租约不能复活/完成、同 owner 重领仍拒绝旧 attempt 更新、旧目录迟到写入不覆盖新目录、会话停止后不能续期/完成。测试直接调用生产函数，不复制 SQL 作为被测实现。
- `tests/worker-attempts.mjs` 通过真实 Worker HTTP 验证 init 和媒体分片 URL 均带 attempt；重领后旧地址返回 409，新的清单交付新目录字节；无 attempt 的分片拒绝，已有文件也不能绕过失败状态。产物为受控字节，不宣称 FFmpeg 暂停/恢复或解码已验收。
- 重复集成发现共用样本目录会残留 init.mp4 并被下一次媒体扫描收录；每轮现在使用独立 UUID 目录，避免依赖手工清理或误读上次产物。
- 工作区 Rust 测试、全目标 Clippy、构建与完整隔离集成通过；原有播放请求、控制 epoch、数据库恢复、NAS 与 100 连接冒烟均保留。心跳加入三秒数据库等待上限，并在失锁/查询失败时显式 kill/wait 子进程；尚需真实进程故障注入证明系统级行为。
- 未部署；完整 media_outputs/原子发布、读取租约、重试上限与退避、退出排空和长期故障矩阵仍待完成，不关闭 W05 整包。

## 2026-09-27：W06 VFR seek 与中段画面

- `tests/seek-fixtures.mjs --vfr` 生成 12 秒短样本，逐帧探测确认约 42/83 ms 的实际间隔。真实元数据传入生产参数导出器，两种请求模式均实际选择 CFR 转码；十条转换通过，另十条 CFR 回归通过。
- 保留首帧 PSNR > 30 dB、零视频 PTS、剩余时长及严格全量解码断言，新增输出 1.5 秒处的独立画面比较。最初一律取目标时刻之后的源帧会错误拒绝仍显示前一帧的结果；只取前一帧又无法表达 CFR 重采样。最终参考严格限定目标时刻两侧紧邻源帧，准确边界只允许一帧，并记录匹配时间和有符号误差，不进行更宽范围匹配。VFR 最低 PSNR 35.92 dB、最大绝对误差 41.667 ms；CFR 为 35.77 dB、17 ms。
- 转换证据：`.runtime/fixtures/seek-vfr-58f16685-484f-48ea-8ffc-96ca0b9be0b0/report.json` 和 `.runtime/fixtures/seek-274a707b-be12-4118-9628-3003816a61a5/report.json`。报告记录源帧间隔、元数据、源文件摘要和实际参数。
- 最终 VFR 产物通过 Chromium 原生 HLS、hls.js/MSE 各十组实际 App 验收，检查起播、解码推进和房间 seek 映射；证据在 VFR 目录的 `browser-report.json`。媒体是真实产物，API/房间消息受控，不能作为 Server/Worker 完整端到端验收。
- 本轮仅扩展测试与文档，语法、格式和 diff 检查通过；未修改生产逻辑，未部署。短样本的帧级精度证据不替代长片、真实上游、移动实机、弱网或持续运行验收，W06 仍未完成。

## 2026-09-27：W06 Chromium 原生 HLS 与 MSE

- 新增 `tests/seek-browser.mjs`，启动独立 Vite 服务、实际 App.vue 与部署 CSP，使用上一轮真实 seek 产物，API/房间消息受控。最初未区分传输的运行实际走了 Chromium 原生 HLS；补充 blob URL 断言发现后，改为原生与强制 MSE 两个独立分支，未把原生结果计入 MSE。
- Chromium 153.0.8010.12 上二十组通过：十条产物（零点及四个非零位置、两种请求模式）分别经过原生 HLS 与 hls.js/MSE。所有初始 currentTime 实测为 0，readyState >= 2；播放超过 0.6 秒且解码帧数增加，房间 origin+1.5 秒的 SEEK 使播放器停在 1.5 秒附近。
- MSE 分支仅覆盖 HLS canPlayType 返回值，强制实际 App 选择 hls.js；MSE/解码/时钟仍为真实实现。原生分支无覆盖。没有 pageerror，实际 duration 与剩余片长符合 100 ms 容差。
- 证据：`.runtime/fixtures/seek-997d8cbc-24ba-473a-80b6-575f787a0680/browser-report.json`，含浏览器版本、App.vue/锁文件摘要、实际清单和分片 SHA-256。脚本静态语法与 diff 检查通过；本轮只新增验收脚本和文档，未重复运行未变更的后端测试，未部署。
- 不据此声称 Safari、移动实机、长片、VFR seek、弱网或真实 Server/Worker 端到端重建通过，W06/W09 仍未完成。

## 2026-09-27：W06 长 GOP seek 与输出零点

- 对 12 秒/24 fps/10 秒 GOP 的 H.264/AAC 文件，旧参数在 5.25 秒请求 stream-copy 时输出完整 12 秒，首帧约 83 ms；旧转码虽只保留 6.75 秒，但首帧同样移位。不能把这种输出直接按请求值声明 origin。
- 非零起点的本地 HLS 现在精确解码并丢弃 preroll，服务端将 remux 请求升级为实际 transcode，Worker 构造器对旧入队参数也执行相同规则。转码关闭 B 帧重排；所有 HLS 禁止自动负 DTS 平移，零点 stream-copy 仍保留。代价是非零位置重建需要视频编码。
- 十条真实转换通过：0、1.25、5.25、5.267、8.125 秒 × 请求 remux/transcode。首帧与从原片头独立解码、按源帧时间筛选的参考图像 PSNR > 30 dB；非零位置比旧关键帧至少高 10 dB。首视频 PTS 与零差 < 1 ms，输出时长与剩余片长差 < 50 ms，完整音视频严格解码通过。证据：`.runtime/fixtures/seek-997d8cbc-24ba-473a-80b6-575f787a0680/report.json`。
- 十六条 HLS 边界样本及四条实际选轨声音回归通过；证据分别为 `.runtime/fixtures/hls-2f2d944b-4390-44cc-be61-748074d7ec28/report.json` 和 `.runtime/fixtures/audio-0a072c2d-ee99-4db7-8765-70ca64ecdf87/report.json`。完整隔离数据库集成、七项 media-core 测试、工作区构建和全目标 Clippy 通过。
- 非帧边界 seek 以第一张不早于请求位置的源帧为参考，保留帧采样精度边界；未证明长片、VFR seek、实际浏览器 MSE 起播、远程上游 origin 或 discontinuity 映射。未部署，W06 未完成。

## 2026-09-27：W06 统一字幕偏移与裁切

- 新增生产 WebVTT 处理器，统一减去 origin，裁切跨零点 cue、丢弃已结束 cue，行内时间标记同步移动；接受 BOM/CRLF，拒绝损坏/倒置时间戳、无效 UTF-8、超大内容及尚未支持的 X-TIMESTAMP-MAP。本地字幕不再靠 FFmpeg 的输入 seek 代替 cue 裁切，远程字幕不再原样返回。
- 本地外挂文件与转换输出增加 2 MiB 上限；FFmpeg stdout 有界读取，超限/超时通过 kill_on_drop 停止子进程。保留 30 秒转换截止，修复本地字幕 HEAD 也返回正文的问题。
- 七项 media-core 测试通过。真实 UTF-8/BOM 中文 SRT 经 FFmpeg → Rust → ffprobe 验证，origin=3 秒时两条保留 cue 的起点/时长为 0/2 秒与 2/2 秒。证据：`.runtime/fixtures/subtitles-2c292ac0-77dd-4fbc-a26f-7a870a51a003/report.json`。
- 完整隔离数据库集成通过：Jellyfin/Emby 受控端点都验证凭据仍在 Worker 代理，真实 Worker 正确处理 BOM、已知 origin、HEAD、损坏和超大远程 WebVTT。origin 在测试授权记录中注入，本轮未证明上游实际时间轴映射；原会话、配额、取消、重启、备份恢复和 100 连接冒烟仍通过。
- 工作区构建、全目标 Clippy、格式及 diff 检查通过。无原生 FFmpeg 的本机采用容器测试本地转换，不将其标成原生 Worker 本地字幕端到端验收。未部署，W06 仍未完成。

## 2026-09-27：W06 字幕选择与重载

- 网页新增按字幕稳定 index 保存的选择状态，不再按下拉列表位置直接切换 TextTrack；渲染新方案后及 loadedmetadata 时重新应用选择。同片源重载保留编号，所选编号消失时关闭；媒体代次变化时清空字幕选择。
- 桌面/移动尺寸浏览器使用真实 H.264 MP4 和 WebVTT：视频达到 readyState >= 2，中文 TextTrack 成功解析一条 cue；新方案反转轨道顺序后仍显示中文，关闭再重载保持关闭，换片后重置为关闭。持有控制凭据的房主操作字幕不发送房间控制命令。
- 可提交的黑色视频样本保存在 `tests/fixtures/browser-video.base64`（约 2.5 KB），避免 CI 依赖本机忽略的 `.runtime` 样本。生成配方和镜像见 MEDIA_FIXTURES.md；API 和字幕响应受控，不作为真实 Worker/上游字幕交付验证。
- 25 项前端测试、10 项浏览器测试通过。构建发现当前 tsconfig 不含 DOM iterable，遍历改用 Array.from 后 TypeScript 与生产构建通过；保留已有 chunk 大小提示。未修改后端、未部署 Compose。
- Worker 的统一 origin 偏移、跨零点 cue 裁切、中文/BOM/损坏时间戳和远程字幕完整矩阵仍未验收，W06 未完成。

## 2026-09-27：W06 网页快速切轨与迟到清理

- 新浏览器用例先复现：初始会话的 DELETE 被挂起，用户连续选第二轨、第一轨，新方案已绑定后再释放旧 DELETE；旧版随即按 key 撤销新方案，桌面/移动尺寸均在“新 key 不应被撤销”断言失败。
- `stopPlayback` 在第一次异步等待之前调用请求管理器 stop，使取消绑定当时的旧操作；旧 session DELETE 与该取消并行等待，迟到响应不再触发对当前操作的取消。
- 修复后真实 App 下拉选择发出的最终请求包含第一轨编号和 1250 ms 原片位置，新旧操作 key 不同；较早的第二轨选择不再发送过期 POST。释放旧 DELETE 后，新方案 URL、下拉值及 sessionStorage 内的新 key 均保留，旧 key 被清理。带有效控制凭据的房主选择音轨也没有发送房间控制命令。
- 25 项前端单元测试、TypeScript/生产构建、8 项桌面/移动尺寸浏览器测试通过；加强控制凭据/下拉值断言后，新增两项浏览器用例再次通过。构建保留已有 chunk 体积提示。
- 浏览器使用受控 API 和空媒体响应验证调用链及竞态，不声称浏览器完成真实音频解码；实际输出声音由上一节 FFmpeg 验收证明。未改后端，未重复运行数据库集成，未部署 Compose；长片、上游及实机验收仍未关闭。

## 2026-09-27：W06 显式音轨与真实声音

- 修复本地/HTTP/Agent 请求 `direct` 且携带合法音轨编号时仍交付原文件、忽略选轨的问题：显式选轨进入本地 HLS 映射链路，再检查客户端 HLS 能力。无 HLS 能力时明确返回 422；上游自身的协商逻辑不变。
- 音轨映射移入共用 `hls_args` 参数，使用绝对流编号；Worker 不再临时替换参数字符串。`node tests/audio-fixtures.mjs` 调用同一构造器生成两轨 × remux/transcode 四条输出，解码中间一秒为 PCM，非静音且所选 440/880 Hz 能量大于另一轨 100 倍。四条路径通过，不存在的 99 号流让 FFmpeg 失败而不退回默认轨。
- 声音证据：`.runtime/fixtures/audio-7d0032e8-9188-4510-ba5f-f4e9c9ab588b/report.json`，包括镜像 ID、源文件摘要、实际参数、RMS 和频率能量比。此测试不是用语言标签推断声音内容。
- 完整隔离 PostgreSQL 集成通过：auto/direct/remux/transcode 请求均保留第二轨绝对编号和 1.25 秒起点，视频流编号 0 与不存在的编号 99 返回 INVALID_AUDIO_TRACK，缺少 HLS 传输返回兼容性错误。取消、旋转、租约、重启、备份恢复及 100 连接冒烟继续通过。
- 工作区构建、示例构建、全目标 Clippy、格式及 diff 检查通过。未修改前端，本轮未重跑浏览器测试，未部署 Compose；网页实际切轨、真实上游多音轨、长片同步仍待 W03/W06 验收。

## 2026-09-27：W02 本地 HLS 边界转换

- 使用生产 `hls_args` 构造器、同一不可变 FFmpeg 镜像，对九类非 HDR 样本执行十六条真实转换。最初失败证据：90° MP4 stream-copy HLS 丢失 display matrix，显示宽高比改变；VFR stream-copy 清单声明 2 秒，与约 3 秒源片不符。
- 本地 HLS 选择完成后，对非零旋转或名义/平均帧率相差超过 1% 的输入保守升级视频转码，转码显式 CFR。直放源文件不受影响，上游自产 HLS 不纳入本地决策。此帧率判据不是完整 VFR 检测，缺失或相等元数据仍需后续逐帧验证。
- 修复后十六条路径通过严格解码、H.264 8-bit/AAC 或无音轨、显示比例 1% 容差、源/输出时长 150 ms 容差及 ENDLIST 检查。旋转输出 180×320/SAR 1:1；非方形像素输出保持 SAR 4:3；VFR 清单时长 2.958333 秒。证据：`.runtime/fixtures/hls-f3bbeb3e-7306-4c80-b2f7-adcb12a35172/report.json`，记录请求/实际模式、参数、输入摘要与输出元数据。
- 四项 media-core 单元测试、工作区构建及全目标 Clippy 通过。完整隔离 PostgreSQL 集成通过，新增直接/显式 remux/HLS-only 能力三种方案验证，并确认转码任务的 spec 与返回模式一致；原取消、重启、恢复和 100 连接冒烟继续通过。
- 没有部署现有 Compose。这里未验证浏览器旋转显示、第二轨选择、长片随机 seek 或完整 VFR 识别，不据此关闭 W02/W06。

## 2026-09-27：W01 扩展媒体短样本

- `node scripts/media-fixtures.mjs` 实际生成、探测并严格解码十类约三秒样本。新增两条音轨（eng/jpn、440/880 Hz）、90° display matrix、4:3 sample aspect ratio 和实际帧间隔约 42/83 ms 的 VFR。显式解码全部音轨，使用 `-xerror` 拒绝解码错误。
- 本次使用本地不可变镜像 `sha256:601d17a36464b22699564fc37ffcf7c402e37d288d447c25295125eff2a8d7f8`，FFmpeg `5.1.9-0+deb12u1`。逐文件摘要、完整元数据和边界断言结果保存在 `.runtime/fixtures/manifest.json`。这不是生产 FFmpeg 版本固定，也没有变更现有服务。
- `cargo build -p media-core --example verify_fixtures` 和 `node tests/fixture-manifest.mjs` 通过：十类样本调用真实兼容路线函数，选择多音轨时要求 remux；缺失、重复、错误内容摘要和修改期望四类清单被拒绝。验收器从源码目录读取期望，核对实际磁盘文件，不能只信清单自报通过。
- `cargo clippy -p media-core --all-targets -- -D warnings`、Rust 格式及 diff 检查通过。说明见 [媒体样本](MEDIA_FIXTURES.md)。浏览器显示/同步、长片 seek、字幕及实机矩阵仍未验收；不据此关闭 W01 或后续整包。

## 2026-09-27：断线准备所有权与独立重试预算

- 服务端在 begin 之前将预留、45 秒准备及 fail 收尾交给独立 Tokio 任务；丢弃 HTTP waiter 不再丢弃执行者。显式取消接口与原有 guard 继续阻止晚到结果提交，崩溃/数据库故障仍有恢复与租约边界。
- 隔离 PostgreSQL 集成中，真实 abort 掉 Jellyfin/Emby 协商中的 HTTP 请求，不再发送 POST 干预，记录仍在租约到期前变为 completed 或 failed。成功同 key 重放仍为 attempt=1 且不重复协商；失败立即同 key 再准备，attempt=2。
- 受控 Worker probe 响应在真实探测授权提交后挂起，断开客户端 HTTP 后返回 502；验证请求变为 failed、原探测会话 stopped=true，无需等待一分钟授权/租约过期。此用例验证生命周期，不作为真实媒体解码验收。
- 前端传输和准备失败各自最多三次，总预算由 200 秒调整为 335 秒。新增假时钟用例分别覆盖两次 TypeError 或两次 65 秒 HTTP 超时，再加两次 45 秒准备中断和第三次 45 秒准备成功；始终同 key、没有撤销、没有遗留定时器。持续 pending 仍在总截止终止，三个纯传输超时仍在 197 秒终止。
- 25 项前端测试、15 项 Rust 测试、6 项桌面/移动尺寸浏览器测试、生产构建、Clippy、格式与 diff 检查通过。完整后端集成（含重启、取消、配额、备份恢复与控制凭据）通过。未部署运行中的 Compose；计划整体仍未完成。以下记录中的 200 秒为此前历史预算。

## 2026-09-27：W01 控制凭据与独立去重窗口

- 新增迁移 `0006_control_epochs.sql`。真实 PostgreSQL 验证缺失、未知、跨用户、跨房间及过期控制凭据均不执行命令；过期命令在成功结果仍存在、结果已删除两种条件下都被拒绝。原凭据在进程重启后仍有效的重放继续返回当前时钟状态，不增加 revision。
- 持有真实快照行锁让有效命令进入最终事务等待，再将凭据设为过期，释放锁后得到 CONTROL_EPOCH_EXPIRED，快照不变；新凭据和新命令 ID 可继续控制。
- 调用生产使用的 cleanup_control_history 函数，25 小时命令结果保留、49 小时结果清理、过期控制凭据清理。房间事件 24 小时清理不再控制命令去重记录的寿命。
- Rust 15 项测试、前端 23 项测试、6 项桌面/移动尺寸浏览器回归、生产构建及协议导出一致性检查通过。浏览器确认过期 ERROR 更新凭据且不会自动重发旧命令，下一次用户操作携带新凭据和不同 command_id。完整后端集成继续验证媒体、取消、重启、备份恢复及 100 连接冒烟。
- 部署/远程/Jellyfin 验证脚本已携带 control_epoch，本轮仅做静态语法检查，未运行它们去修改现有部署。协议行为变更和升级要求见 [控制命令](CONTROL_COMMANDS.md)。W01 其他接口契约、扩展样本及后续工作包仍未完成。
- 故障注入增加了日志量，隔离测试原先不消费子进程 stdout，可能阻塞错误帧发送；已持续排空日志管道，不改变生产限速规则。协议生成明确将毫秒时间戳导出为 JSON 对应的 TypeScript number；Clippy 及 git diff --check 通过。

## 2026-09-27：取消语义与慢准备预算

- 请求中的主动 abort 和重试等待中的取消均返回 PlaybackCancelled，定时器与监听器清理；操作/HTTP 真正截止返回 PlaybackTimeout。旧准备即使清理晚失败也保持取消结果，不能覆盖新播放。
- 前端假时钟验证：第一、第二次分别在 45 秒返回可重试中断，第三次再用 45 秒成功，总计 137 秒，完整请求与 key 不变，没有发送取消。到第 65 秒时第二次请求仍未被 abort。另覆盖三次 HTTP 各挂起 65 秒后于 197 秒终止、持续 pending 在 200 秒截止。
- 23 项前端测试通过；TypeScript 与生产构建通过（保留原 chunk 大小提示）。6 项 CSP 下的桌面/移动尺寸浏览器测试通过，新增连续重新加载中旧请求晚失败、新方案成功后没有取消/超时提示，也没有未处理 rejection。
- App 的 run 只允许当前操作更新错误/忙碌状态；loadMedia 自身屏蔽过期加载及主动取消，tick、元数据/唤醒及普通状态应用均处理异步失败。此轮没有修改后端，未重复执行后端集成，也未部署 Compose。

以下历史记录中的“65 秒总超时”已由本节的每次 65 秒、全程 200 秒取代。

## 2026-09-27：F-01 至 F-14 核对

- 完整结论见 [审查处理表](REVIEW_FINDINGS.md)。新增迁移 `0005_login_attempts.sql`，并用 persistence/build.rs 追踪迁移目录，解决新文件未触发本地增量编译的问题。
- 真实隔离 PostgreSQL：12 个并发登录请求严格得到 10 个认证失败及 2 个限速；Server 重启后仍限速，把窗口时间移到 61 秒前后可再次校验。控制权检查在另一个连接锁住快照时实际等待 PostgreSQL 行锁；非控制者仍被拒绝。5 次并发列表插入产生不同排序值并成功清理。
- 直放和真实 NAS Agent 的 `bytes=-0` 均返回 416；原播放配额并发、重启、加密方案、取消、上游模拟、备份恢复及 100 控制连接冒烟继续通过。
- Rust 工作区 15 项测试通过，包括全部 URI 属性、引号内逗号/文本、相似属性名、Unicode 和损坏属性边界；Worker URL 覆盖 IPv4/IPv6 通配、回环与具体地址。Clippy 全目标通过。
- Caddy 用当前 Caddyfile 校验通过；临时隔离容器真实 GET 返回 200 和预期 CSP 响应头，随后容器移除。浏览器 6 项桌面/移动尺寸测试在同一 CSP 下通过。此处未把受控空媒体响应算作 HLS 解码或 Safari 实机验收。
- 当前没有固定生产 FFmpeg 包版本，没有部署到运行中的 Compose，也没有把固定窗口限速、磁盘自动降级等后续事项标为完成。

## 2026-09-27：命令权限与准备取消（第二轮审查，本地源码）

- 非控制者 PLAY 返回 `CONTROLLER_REQUIRED`，同一真实 WebSocket 随后仍可完成 CLOCK_SYNC。前端对 `CONTROLLER_REQUIRED` 和旧 `FORBIDDEN` 都只显示命令失败；桌面/移动尺寸浏览器发送错误后仍保持同连接并可聊天，登录过期仍停止重连。
- 新增 `DELETE /playback-requests/{key}`。真实数据库覆盖先取消再 POST、准备中取消后晚到结果拒绝、取消已提交会话及媒体任务、跨用户相同 key 隔离；连续十次创建后按 key 取消不耗尽 8 路配额。接口复用现有请求表，不需要额外迁移。
- 网页准备管理器覆盖三次网络结果不确定后清理、65 秒超时后清理、切换期间晚到方案拒绝；未确认的清理编号保存到 sessionStorage，模拟重新加载后清理失败会阻止新 POST，恢复后先取消旧 key 才创建新 key。浏览器进一步验证三次丢失响应、取消 503、再次点击仍不新建、恢复后清理再创建的实际 App 调用链。
- `PLAYBACK_REQUEST_INTERRUPTED` / `SOURCE_PROBE_FAILED` 等瞬时失败继续在一次操作内复用完整原请求；第三次服务端可重试失败直接返回不可重试 `PLAYBACK_REQUEST_RETRY_EXHAUSTED`，不要求客户端额外发送第四次。网页展示该终止原因后清理操作。
- `npm test`：19 项通过；浏览器桌面/移动尺寸共 6 项通过；生产构建通过（保留原 chunk 大小提示）。Rust 13 项测试、Clippy 全目标、完整 PostgreSQL 集成及生成契约 `--check` 通过。`PLAYBACK_REQUEST_RETRY_EXHAUSTED` 已在上一轮生成契约中，本轮新增的 `PLAYBACK_REQUEST_CANCELLED` 也已重新导出。

取消断网时无法立即撤销远端授权；此时保留旧 key 并停止继续创建。存储验证覆盖同一标签页刷新，不宣称彻底关掉标签页后的后台回收已完成。未替换运行中的 Compose。

## 2026-09-27：审查修复（本地源码）

- 心跳故障注入：在隔离 PostgreSQL 临时重命名登录过期字段，使真实心跳查询失败；收到可重试 `SERVICE_UNAVAILABLE`，恢复字段后原 cookie 的 `/auth/me` 和新 WebSocket 快照均成功。浏览器桌面/移动尺寸验证该错误后重新连接，而真正 `SESSION_EXPIRED` 仍停止重连。
- 播放请求恢复：真实受控上游先返回 502 后恢复，同 key 第二次完成；连续三次失败后第四次返回不可重试的 `PLAYBACK_REQUEST_RETRY_EXHAUSTED`。另注入已记录的 `source_probe_failed` / `media_unavailable`，同 key 恢复并停止旧授权。
- 晚到任务隔离：分别在真实上游协商期间把租约设为过期、把 owner_epoch 改为其他实例；同 key 新请求接管，旧请求返回中断，新请求完成且旧请求不能覆盖它。杀死并重启 Server 后，遗留 pending 同 key 恢复为新的 session_id；已完成方案仍复用原 URL。
- 保留期：将已完成请求 expires_at 设为过去、会话保持有效，仍返回原播放 URL；续期延长记录及会话剩余时间的既有回归继续通过。并发测试同时覆盖用户配额锁与会话外键锁相容性。
- `cargo test --workspace --locked`：13 项通过；Clippy 全目标、工作区构建、协议生成 `--check` 通过。TS 与 JSON Schema 包含 idempotency_key、四个原播放请求错误码和新增重试耗尽错误码；CI 改为无写入一致性检查。
- `npm test`：14 项通过；`npm run build` 通过（仍有原 chunk 大小提示）；`npm run test:e2e`：6 项通过。真实 PostgreSQL 完整集成包含原鉴权、媒体、NAS、备份恢复和 100 连接冒烟，不等于持续负载或真实上游兼容验收。

新增迁移 `0004_playback_request_attempt.sql`。上游在失联或崩溃之前可能已收到请求，接管会再次协商，因此不承诺上游副作用恰好一次。当前修改未部署到运行中的 Compose。以下第三批记录保留当时行为，其中“中断不重执行”“明确失败不重试”已由本节修正。

## 2026-09-27：播放请求幂等（第三批本地源码）

- `cargo test --workspace --locked`：13 个 Rust 测试通过；Clippy 全目标、工作区构建、协议导出通过。
- `node tests/integration.mjs`：真实隔离 PostgreSQL 中 6 个同键并发调用只创建一个媒体任务；跨用户编号独立、不同参数冲突、加密方案可复用、停止后不复活、剩余有效期和续期保留窗口正确。12 个不同键并发创建受 8 个活跃会话/准备配额限制。故意使任务插入违反数据库约束时，播放会话和任务一起回滚，恢复数据库后同键仍复现已记录失败。
- 受控 Jellyfin/Emby 的 PlaybackInfo 延迟 1 秒，在真正进行中的第一次请求上重试得到 409 准备中，最终只协商一次。此证据仍是模拟上游契约，不代表真实上游兼容验收。
- 杀死并重启真实 Server 后，已完成请求返回相同 session_id/播放 URL；注入的 pending 准备记录被标为中断，其准备授权停止，不重新执行。原命令/媒体/Agent/范围/恢复集成继续通过。
- `npm test`：13 个前端测试通过，覆盖编号复用、权限/明确失败不重试、三次网络尝试上限和准备等待上限。
- `npm run test:e2e`：6 个桌面/移动尺寸受控浏览器测试通过。新增链路依次模拟网络失败、200 截断 JSON、409 准备中、有效方案，四次请求使用相同编号和参数，最后绑定原方案。空媒体响应仅用于请求生命周期检查，不把它算作解码验证。
- `npm run build` 通过，仍有原前端 chunk 大小提示。`git diff --check` 通过。

本轮新增迁移 `0003_playback_requests.sql`，没有改初始迁移。没有替换正在运行的 Compose；W01 的控制 epoch/命令保留、完整接口契约，以及 W06 方案代次/离房取消链仍未完成。机制和兼容边界见 `PLAYBACK_REQUESTS.md`。

## 2026-09-27：统一错误契约（第二批本地源码）

- Rust 工作区 12 个测试、Clippy 全目标、构建及协议导出通过；另新增 `cargo test -p http-api` 1 个边界测试，验证超大和永久 pending 的上游错误正文受限且不泄露原正文，错误头清理正确。随后 Clippy 再次通过。
- `node tests/integration.mjs` 在新编译的 Server/Worker 和独立 PostgreSQL 中通过：结构化 401/403、404/405、JSON 解析错误、413、无效路径参数；不回显伪造 request_id/私密 token；JSON 诊断编号与响应头一致；416 保留 Content-Range、HEAD 无正文；WS 非成员加入、损坏消息、命令冲突与配额错误均符合新契约。原媒体/Agent/权限/备份恢复回归继续通过。
- `npm test`：10 个测试通过，包含新旧错误解析、诊断显示数据、授权停止重连和等待时间校验。
- `npm run test:e2e`：4 个受控浏览器测试通过。桌面和移动尺寸各自验证 REST/WS 错误说明和诊断编号显示、失效会话显式错误与无错误消息关闭后的登录复查；推进模拟时钟 20/30 秒没有再次连接。此证据不等同于真实移动设备或网络仿真。
- `npm run build` 通过，仍有原前端 chunk 大小提示。`git diff --check` 通过。

当前改动仅在本地源码与隔离测试中验证，没有更新运行中的 Compose。错误形状属于 alpha 接口变更，升级顺序见 `API_ERRORS.md`；播放请求幂等、控制 epoch、其余接口 Schema 和后续工作包仍未完成。

## 2026-09-27：全计划推进第一批（本地源码）

- `cargo test --workspace --locked`：10 个 Rust 测试通过，含旧播放请求默认值兼容。
- `cargo clippy --workspace --all-targets --locked -- -D warnings`、工作区构建、协议导出通过。
- `npm test`：7 个测试通过；`npm run build` 通过，仍有前端单 chunk 大于 500 kB 的提示。
- `npm run test:e2e`：2 个桌面/移动尺寸布局交互测试通过，仍为受控 API/WS 样本。
- `node tests/integration.mjs`：隔离 PostgreSQL/Server/Worker/Agent 集成通过。新增相同 command_id 的动作/参数/revision/媒体代次/协议版本冲突、跨用户/跨房间拒绝、重启后的正常重放及旧 NULL 请求记录拒绝。原鉴权、广播、Range、NAS、HLS、事务回滚及备份恢复回归继续通过。
- `node scripts/media-fixtures.mjs`：六个 3 秒 320×180 样本由本地固定镜像内 FFmpeg 真实生成、ffprobe 探测并完整解码；输出 `.runtime/fixtures/manifest.json` 保存镜像、FFmpeg 版本、文件 SHA-256 和元数据。`cargo run -p media-core --example verify_fixtures` 的六项预期路线/拒绝检查全部通过。
- `node scripts/baseline.mjs`：源码和本地镜像清单写入 `.runtime/evidence/baseline.json`。本轮测试使用新编译的本地二进制，未将运行中的 Compose 镜像替换为此源码；镜像摘要仅为库存记录。

本轮未完成 W01 全包、旧版本真实升级、上游真实服务、移动实机、弱网或长时门槛。历史轮次如下，不与本轮证据混算。

测试环境：Windows 开发机，Rust 1.98.1、Node.js 24.21.0、Docker Desktop Linux 引擎。

## 已执行

- Rust 工作区编译、状态机/Range/HLS 重写单元测试。
- Clippy 所有目标，warnings 视为错误。
- TypeScript 检查、Vite 生产构建、5 个同步算法测试。
- Playwright 桌面和 Pixel 7 尺寸测试：房间选择、邀请、聊天、媒体库、设置、无横向溢出。此组使用模拟 API，不能当作后端验证。
- 真实 PostgreSQL 隔离容器集成：Cookie/CSRF、房间权限、邀请、两客户端广播、重复命令、版本冲突、聊天、Range/HEAD/416、播放会话撤销。
- 真实 NAS Agent 进程：配对、索引、主动数据连接、尾部 Range 字节校验、设备撤销。
- 真实 HTTP 模拟源：HLS 清单重写、分片字节校验、伪造资源授权拒绝。
- 真实数据库约束故障：事件写入失败后快照不前进；服务重启后暂停并更换时钟纪元。
- Jellyfin/Emby 模拟服务契约：列表、播放协商、凭据隔离、开始/停止上报通过；未将模拟结果等同于真实版本兼容。
- pg_dump/pg_restore 到另一数据库后，使用原密钥与备份会话成功重新扫描加密片源。
- 100 个本机 WebSocket 连接收到快照，单次耗时约 226ms。这只是建立连接冒烟，不是持续负载或跨地区 SLO。
- Linux 容器内 FFmpeg 生成 20 秒 640×360 测试视频；真实服务完成直放、转封装、转码，后两者由 FFmpeg 再解码 1 秒验证。
- 同名外挂 SRT 探测、WebVTT 输出、从第 4 秒启动转码后的字幕时间轴重映射通过。
- 两个真实 Chromium 浏览器经过实际 Caddy/Server/Worker 播放同一视频，均前进且单次位置差低于 1 秒；未把这一结果宣称为 p95≤300ms。
- npm 官方 registry 审计：升级 Vitest 后报告 0 个已知漏洞。

## 未执行

Jellyfin/Emby 实例兼容测试、iOS/Android 实机、弱网仿真、arm64 实机、72 小时稳定性、旧版本升级与真实媒体库灾难恢复。这些条件仍是正式发布门槛。

重跑入口：`tests/integration.mjs`、`tests/deployed-smoke.mjs`、`npm run test:e2e`。后者真实部署测试读取本机 `.env`，会创建名为“本地演示片源”和“RainSync 验证放映室”的数据，重复运行复用这些记录。


## 第二轮：远程媒体处理

- `tests/remote-playback.mjs`：真实 HTTP 源的自定义鉴权请求头、真实出站 NAS 容器；两种片源均通过自动直放、转封装、从第 4 秒开始转码及停止后 401 校验。
- 额外生成 MPEG-4 Part 2 不兼容样本，两种远程片源自动选择 H.264/AAC 转码，输出均用 FFmpeg 实际解码验证。
- 7 个 Rust 单元测试、Clippy、5 个同步算法测试、前端生产构建和 2 个桌面/移动尺寸浏览器测试通过。
- PostgreSQL/房间/Agent/模拟上游/备份恢复集成重新通过；本轮 100 个本机控制连接快照冒烟耗时 558ms，不能视作持续负载指标。
- 远端数据入口地址差异问题已通过 NAS 容器复现并修复。完整设备能力协商、真实移动端和长期验收仍未完成。


## 第三轮：播放传输能力协商

客户端检测 MP4 H.264/AAC、原生 HLS 和 MSE，传给播放会话接口。Rust 类型同步生成 TypeScript。8 个 Rust 测试、7 个前端算法/能力检测测试、Clippy 和生产构建通过。部署后验证仅支持 progressive 的设备请求 HLS 转码返回 422；本地直放/转封装/转码及两个真实 Chromium 播放回归通过。这只验证传输能力门控，不代表所有编码 profile 或真实移动设备均兼容。


## 第四轮：上游协商参数

上游请求已加入播放起点 ticks、音轨索引、直放/转码开关与客户端传输能力；返回音轨和时长映射到统一方案。9 个 Rust 测试、Clippy 及独立 PostgreSQL 集成通过。真实服务验证正在准备，不能据此宣称 Jellyfin/Emby 兼容验收完成。

协议依据：[Jellyfin PlaybackInfoDto](https://kotlin-sdk.jellyfin.org/dokka/jellyfin-model/org.jellyfin.sdk.model.api/-playback-info-dto/index.html)、[Emby PlaybackInfo](https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html)。真实验证先固定 Jellyfin 10.11.0，使用官方容器镜像，后续记录镜像摘要与实测结果。


## 第五轮：真实 Jellyfin 调试

已启动隔离 Jellyfin 10.11.0 并成功初始化用户、家庭视频库和两种编码样本。真实测试发现并修复家庭视频类型漏扫、自动模式未优先直放、HLS 代理资源后缀丢失三个问题。播放矩阵须在修复镜像重新验证之后才能标记通过；此阶段仍不代表 Emby 或移动端兼容完成。
