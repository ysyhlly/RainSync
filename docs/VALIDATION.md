# 本轮验证记录

## 2026-10-01：提交后的任务事件观测

194个后端输入、三服务和独立driver的最终冻结构建通过，完整workspace严格Clippy及22项收集器/guard检查通过。13组实际PG/API/Worker矩阵通过，其中独立driver一组含17条事务检查，不把17再当17组API相加。源摘要、报告SHA、正向清理及原始子进程PID归属局限见 [任务事件证据](JOB_HEALTH_EVENTS.md)。HTTP前端没有改动，沿用原字节的457项结果，不宣称本批新浏览器验收。

此前d8418a7完整CI第一轮未进入应用验证：Ubuntu镜像源下载媒体依赖超过900秒退出124；已仅重试失败job，保留原始失败。其独立固定上游原始8/10和RainSync账户权限执行30/30均已按当前源码报告核对，不能把原始两失败改称全绿。

## 2026-10-01：可靠单文件HTTP候选集成检查点

后端具体候选绑定、当前身份/来源门控、每次准备独立pin、Binary-only网关和固定DB时钟期限已接通。28组新实际API与32组既有HTTP续接在最终同一冻结后端通过；完整摘要、SHA256、近到期合成注入与真实资源关闭边界见 [HTTP候选契约](HTTP_FILE_CAPABILITY_BINDING.md)。受影响Rust280项通过/12项明确忽略，严格workspace Clippy、格式与生成协议检查通过。当前云端重新实现并合并Web消费者后，457项测试（33个文件）、Vue类型及Vite构建通过，其中50项新HTTP运行时检查包含真实请求管理器在时钟回复先后顺序下的同键高水位。旧云端任务未取得的代码/报告未计入。本批未发布，远程CI及真实浏览器/设备检查未新增。

此前25组新API和随后27组检查分别属于较早源码；最终28组额外覆盖确定的输入拒绝及准备租期夹紧，不混用旧绑定。既有本地/NAS候选七条结果在时钟修正及夹紧前后对应的已执行轮次保留；它们不是本批移动实机或完整浏览器验证。


## 2026-10-01：任务、进程与缓存当前观测

本批最终后端冻结192个输入，源码摘要 `b5032a0663d84143d57f2e9b2d2b462a1ef2390f9b0f7000db4e1a74d365fffa`，绑定SHA256 `bf99fb2570c09d7d204984ccb9384f44557e8c3492990c972470ae971c12cbfe`。Server/Worker/Agent可执行文件和所有后端输入在实际检查前后核对一致；缓存完成时间补强后的最终报告不借用此前源码结果。范围见 [任务健康观测](TASK_HEALTH_OBSERVATIONS.md)。

- 新入口 `tests/task-health-observations.mjs` 十二组实际Server/Worker/PostgreSQL检查通过，报告 `3cb8646e-0529-46e7-a3ba-9cd1e1c72683`，SHA256 `30d023103372930ab40fb07c084f3345e610f149376424aa63f7295d2561b39e`。九条合成持久任务验证固定状态、过期/缺失租约、创建年龄与未来重试资格的区别；没有执行这些任务，不把库存断言称为任务转换证据。
- 两个真正等待库存SQL的请求分别在登出/管理员降权后返回401/403。取消轮观察到11个数据库后端并全部退出；同一表锁仍持有时，新一轮出现10个不同后端、16个期限请求在1.183秒内返回503，另有12次新身份查询成功。这只证明实际观察到的容量重用，未声称覆盖所有池槽或黑洞响应。
- Worker真实空目录与小目录分别报告已知零值、4个常规目录项/13逻辑字节；硬链接按目录项重复计数，两条符号链接不计。目录故障时省略计数，恢复后重新观测；实际工具版本进程期间所有者可见，退出后归零。精确六秒、迟到/未来完成时间及清理失败状态使用受控Rust回归，不能冒充真实挂载或任意后代进程验收。
- 既有 `tests/runtime-metrics-production.mjs` 十三组实际字节/输出/失败/取消/缓存回归全通过，报告 `5e424703-bbbd-4b61-a1fc-26efee1b3a4f`，SHA256 `b70f0bda7ce0570db9d59af76e062febbeec8ccc678a739e5ce6fe4eb127f5a9`。旧收集器断言仅排除四个新库存名称，原字节、终态、直方图和真实hit/miss断言保留。首轮共享卷remux失败有实际 `CacheCapacityExceeded` 日志；十个百分点保留规则未放宽，改在已有独立临时卷运行隔离夹具后通过。
- Server相关25项、Worker readiness14项及metrics24项检查通过；3处Worker数据库专用检查（含一个重复引入的入口）明确忽略；新矩阵不冒充这些忽略入口已经重跑。公共进程所有者8项通过、1个子进程入口明确忽略。最终格式、严格workspace Clippy和冻结workspace二进制/示例构建通过。受限环境不允许Unix socket夹具，替代的FIFO只验证特殊文件不计数，未宣称Unix socket通过。
- 两套最终实际报告均正向确认所有自建服务、PostgreSQL、监听端口、工具包装进程及资源已关闭。报告的原始临时卷目录保留，另有字节相同的持久副本。无迁移、协议或前端变更；完整远程CI需本批发布后核验，设备和持续负载验收未新增。


## 2026-10-01：NAS Range与所有方案初始数据装载

该批最终e7ef0d1的[完整CI](https://github.com/ysyhlly/RainSync/actions/runs/36888979539)于17:02:05UTC成功，包含Rust381通过/11忽略、前端407、Playwright178通过/2跳过、六组NAS Range以及browser-real/playlist-real。首次1e77800仅因Rust1.99弃用Atomic别名而失败的证据保留；等价try_update修复没有提升部署Rust1.98要求。下列本地证据仍保持原提交身份。

- NAS六组真实有限检查与28次精确HTTP/Agent字节断言通过；报告ID、SHA256、192输入源码绑定和清理边界见 [NAS交付验证](NAS_RANGE_SEMANTICS.md)。初次/file路由和随后公开416 JSON的夹具假设失败记录保留，均未修改生产逻辑或放宽成功字节断言。
- 受影响Rust包194项检查通过、9项环境/子进程入口明确忽略；严格workspace Clippy、冻结workspace二进制构建通过。此前单独的2项共享解析与4项文件交付回归是早期定向检查，不重复计入194。
- 最终合并前端407项通过，Vue类型/Vite构建和所改运行时/测试Prettier通过。前期149项聚焦检查和379项合并检查不与最终407相加。覆盖无候选方案、迟到/重入回调、Stop/换身份/换片/离房、同会话native→MSE、手势、隐藏页面及异常时钟；这些是受控媒体事件，不能当作实际呈现或移动系统证据。
- 独立审查发现同方案恢复的load()/pause()可能拒绝旧play()，从而把AbortError误当自动播放限制并无限暂停装载计时；已在源替换前使旧动作失效，仅NotAllowedError建立手势门控。当前源中断有可恢复提示，失败不再每500ms重复play，显式手势不等待play()完成才恢复计时。新增因果夹具覆盖旧promise拒绝/成功、MSE恢复、已就绪中断和错误保留。
- Windows Agent夹具的HEAD+Range期望更新为200完整长度及无Content-Range，仅语法检查；本机浏览器原有OS socket权限限制没有被绕过，未新增实际浏览器执行。远程完整CI需在本批发布后按精确提交核验。


## 2026-09-30：版本 1 实际播放观测与 Worker 健康检查

本批新增实际 video 观测、数据库固定起点/时长及序号、Start/Progress 领取序号、Stop 最终样本和网页请求取消顺序；未协商的旧客户端保持兼容。具体设计和仍待真实上游/撤权验证的范围见 [上游会话核对](UPSTREAM_SESSION_AUDIT.md)。此前候选 D 和 W03 第一批证据均保持原身份，本批没有新两小时或七十二小时结果。

网页最终播放器回归 `.runtime/w03-viewer-frontend/frontend-final-verification.json`（SHA `97a0420f2a78b0b5f51baa27944b9d32cd92f018ef07452b288c206e97fabf5a`）记录构建、七十七单测和三十八浏览器场景全通过，106 个输入前后稳定；使用实际 MP4 解码和正确 Range 206，受控 REST/WS。桌面和移动 viewport 不代表移动实机、原生 Server 或真实 Jellyfin/Emby。新增错误允许列表只改变前端绑定中的生成 TS/Error Schema 两文件，增量构建与七十七单测再次通过，`.runtime/w03-viewer-frontend/public-errors-retry/report.json` 的 106 个输入前后稳定；没有改播放器或挪用旧绑定声明新浏览器重跑。初次增量 wrapper 因 PowerShell 将 Vite stderr 的分块提示当成异常提前退出，原日志和 `public-errors/wrapper-failure.json` 保留，修正 wrapper 后才得到实际退出码。

Worker 最后一次故障入口 `.runtime/worker-health/rainsync-worker-health-c88da2a7/report.json` 通过六场景：真实行锁跨越三秒查询期限后仍同 attempt 恢复；发布未知不提前暴露分片、后续完整证明事务恢复；确认会话撤销停止；阻塞查询期间主动停止及时回收；连续未知不超过最后已确认数据库租期；旧 owner/attempt 拒绝。普通二十九项测试通过，两项 PostgreSQL 入口平时 ignored 的场景由该真实入口执行。Clippy/fmt 通过。确认租期扣除整个 SQL 往返，过期后的迟到成功不能复活；这些结果证明受控阻塞下的修复，不确定原 D 阻塞的具体根因。owned PG/匿名卷及实际子进程清理已核对。

首次版本 1 原生集成 `.runtime/w03-viewer-backend/native-integration/50223841-2af0-4e19-9720-ed208412e4ef/report.json` 全通过（187.588 秒），旧绑定 SHA `334d6fce63aa0257b67a2aa89229b20192ec118903770b424a3ae66336d4b722`、121 源及三 exe/十六示例前后稳定，38 个 owned 后代及 PG/匿名卷清理。首次严格 API `.runtime/upstream-observations/5b99319b-c813-464a-a462-93c24f30fefc/report.json` 前三组通过，第 4 组相同序号不同正文已正确返回 409，但新增原因缺少公开枚举而回退 `REVISION_CONFLICT`，按精确公开码断言失败；原证据保留。另一次绑定目录 preflight 失败未启动 PG 或 Server，不能计作业务测试。

补齐九个公开码、安全固定说明及精确映射单测后，受影响十九项 Rust、全工作区 Clippy、fmt、生成协议 `--check` 和 workspace bins/examples `--locked -j2` 构建通过。最终绑定 `.runtime/w03-viewer-backend/public-errors/backend-binding.json` SHA `7a7f0c23bde32b428f0bf70856726c4d5c6a73cb69d716c56c9eb617ba7f9497`；121 源摘要 `f460d3e58e70a0c3f0df477b9375a62ee82f19c9245d31ed7999bd8daea4360e`，Server `e070f491ed643ff5c2634a4e28fdb45fba32a87b8126584b7efc66ed388ad851`，Worker `b663f7d27851f721cab5ae7f26198fb8813a8fb69056fb1fc0a10672edb615af`，Agent `5cd04b9df03303a3b570e91d44871d57f3a23d352a19564a0c03fdb1b5cbed8e`。正式构建 `04:49:59.212Z–04:50:37.451Z`；旧绑定、副本和报告未覆盖。

最终原生集成 `.runtime/w03-viewer-backend/native-integration/fdc529c8-532e-4728-ac9d-b60e429cb173/report.json` 通过（173.847 秒），SHA `55ecd224d9dcea725b8cf4e6747c256a013a34724b6057b97a6394a763880950`；121 源、三实际 exe 副本、十六预构建示例和十二入口输入前后稳定，35 个观察的 owned 后代、PG 及匿名卷全部查空。完整媒体、缓存、控制 epoch、NAS、10001 条索引和备份恢复门槛执行；100 连接 267ms 为共享宿主短测。根入口十九场景在同一新绑定也全通过（`04:59:41.520Z–05:01:39.043Z`），`.runtime/upstream-reservations/841a10f8-70ad-402f-8506-68844c4f1770/report.json` SHA `54b36f7a41989bb2d3d3a9260dbe3e7767e70dc54b9902207989045349d405e0`；旧客户端、实际协商超时、IO 迟到、重启未知 SID 及 Stop 预算均保留，隔离清理通过。

公开码修后 API `.runtime/upstream-observations/214edeed-96d9-470b-af88-b3dcd4203b66/report.json` 前九组通过，第十组夹具错误要求永久 `NO_MEDIA_SOURCE` 的同 key 重试变成成功，实际按既有不可重试契约返回相同 502。只加强夹具：保留该 502/no 新协商与已知 SID 补偿检查，另用真实 PlaybackInfo 503 验证临时错误的同 key 新 UUID/seq 0 恢复、旧未知 SID 不假闭合和停止墓碑。原失败保留，生产和新绑定不变。

修后唯一完整 API 入口最终二十四组全通过，`.runtime/upstream-observations/7d942359-adb9-4baa-89b1-3b0365f79416/report.json` SHA `218fac7f8a136efabbaf04466b1dbb0b26d352241195cc9f3db69bdb7228dce9`，实际 `05:00:47.306Z–05:03:08.905Z`。两种提供者分别覆盖版本拒绝、未播放不 Start、独立暂停/seek、相同/旧序号、位置/速率范围、最终 Stop、外部用户隔离、代次与成员撤销、迟到 IO 不确定、失败准备及重启后序号。所有精确公开码、数据库状态、受控上游实际 HTTP 正文/响应和旧失败证据保留；入口、导入、新绑定、121 源和实际副本前后稳定，owned PG/匿名卷与控制/上游资源清理通过。这是真实认证 API/数据库/原生 Server 的受控上游验证，未宣称真实产品解码。

最终升级入口 `.runtime/upstream-reservations-upgrade/00213c90-5b94-4d97-b8e3-d5592a46527f/report.json` 五十项检查通过（162.323 秒，`05:10:03.013Z–05:12:45.336Z`），SHA `6896afdc6a9dfbee1613da6a075f87df2a551a46aad38ff0ac9732af86e61f6a`。真实旧 Server `a4efce0d…` 创建四十六个授权后迁移 1–24→26；同 key 重放保留原 UUID/加密 scope、不重新协商、不增加观测字段，0026 表开始/结束均为零，不回填为真实播放。四十二个活跃旧授权仍公平收到 Progress，高 UUID 停止不受四十四个低 UUID 活跃授权阻挡；已知 Jellyfin、未知 SID、旧 Emby 不可恢复设备和实际 Stop 失败均保持原边界、最多五次与稳定窗内无第六次。新绑定和旧/新实际 exe、入口/导入及 121 源前后核对稳定，137 个收尾/身份核对步骤全通过、PG/匿名卷释放。所有本批回归使用隔离随机命名空间；与用户服务共享宿主，不能当作独占 SLO。

`tests/fixtures/upstream-real.mjs` 与 `tests/upstream-real-playback.mjs` 提供固定隔离产品的后续真实播放入口，新增九十秒/源帧时码/受限非管理员/撤权及完整四模式矩阵目前仅做语法、格式和独立静态安全审查，未启动实际产品服务。最终摘要分别为 `f478355633dcff63ffa859fbefbc60565e07b50b5214b43dba4158012c561458` / `57c65df92ba298943d8e90915f4728550e4b300e730e4274d8757ac33628dd66`。先前二十秒管理员 setup 的旧摘要证据另存，不作为这些新方法或真实播放兼容通过证明。执行完整矩阵仍须新绑定、真实版本/镜像/源码、时间轴源帧和所有 owned 资源前后核对。实跑前还需补强两处诊断失败路径：原生日志排空超时可能跳过后续 PG 回收，上游日志写盘失败可能跳过该 owned 容器删除；均会失败而非假通过，也不能宣称所有异常清理已经验证。

## 2026-09-30：候选 D 持续控制终态与联合证据

原控制进程正常 exit 0，`rainsync-load-f01d14c6/report.json` 终态 `sustained-passed`，SHA `4002e01d5cb62037050a2fdd9cf1e44f4cb63df56b660abda2905d5231830759`。十房×十人实际 `01:04:30.742Z` 至 `02:04:30.7598975Z`（3600.0179 秒）、3600 条持久命令，ACK p95 12.233ms；五十房×两人实际 `02:05:11.079Z` 至 `03:05:11.121777Z`（3600.0428 秒）、18000 条持久命令，ACK p95 33.1ms。每种拓扑一百个独立身份，完整状态/重连/每条持久命令检查通过；属于控制面容量，不是视频容量。

原只读观察器 15448 自主 exit 0，于 `03:06:03.578Z` 确认两入口终态及 owned 容器/网络全部释放，共 491 份采样，没有重启。独立冻结汇总 `.runtime/validation-joint/w07-w08-20260930-d/final-20260930T031456860Z/assessment.json` SHA `9b63f4fb85296814f41b40e1ee5d030c7d24b24aa07428718f515260573361e7`，十二份原输入的 pre/post/copy 哈希全部匹配，原报告/采样器未修改。

失败 NAS 报告缺少完整播放区间字段，不能把联合原测量区间为空解释为没有重叠。另以起播 `01:07:00.126Z` 和最后实际观测 `02:50:12.3287798Z` 求得控制重叠 6151.8837 秒；若严格截止于真实源取消 `02:49:56.589Z`，重叠为 6136.1439 秒。二者都不是完整两小时。六次 Docker stats、两次 Docker state 和不可直接识别的控制当前阶段保持 unknown；开发 sidecar 的十二条缺 UTC 记录保留为 unattributed，编译、隔离原生 PG 测试及其它共享负载如实说明。这轮证明两项控制六十分钟门槛，NAS/完整联合时长门槛仍失败，不能作为独占 SLO 或拼接后续候选时间。

## 2026-09-30：候选 D 两小时 NAS 失败

原 `rainsync-soak-a38b55a9` 于 `02:50:16.976Z` 终态失败，未重启或拼接时长。实际观察 6192.203 秒（103.2 分钟）、呈现 61917 帧，仍是原 session/attempt 1，十次网页续租成功，无计数重置或控制断连。`02:49:56.589Z` 源因 consumer_cancelled 结束，早于测试 DELETE；失败采样源文件已关闭、FFmpeg 已退出，严格持续传输门槛失败。报告 `D/source/.runtime/nas-soak/rainsync-soak-a38b55a9/report.json` SHA `1435cd5759483fea1ae67700fe29ea892b9176a40857f80ca0550b71780101b1`，日志、截图和原始采样保留。

Worker 续租查询和产物发布末端查询分别达到 3.001/3.012 秒期限，现有健康路径把数据库结果未知当作租约失效，提前终止编码。失败后数据库仍显示正任务租约约 10.52 秒；sqlx 超时丢弃查询也会记录默认 rows_affected=0，不能据此证明失去所有权。发布事务会持有同任务行锁，但现场未留 PG 活动/锁快照，数据库锁、Docker VM 或 I/O 停顿的具体原因仍未知；两次临界资源采样不可得也不能当作零负载。后续须受控阻塞回归并区分确认撤销与暂时未知，不能只放大期限。

实际 DELETE 200 后 0.776 秒释放，全部传输终态、会话停止、任务取消，owned 容器/网络清理。独立 post-run verify exit 0，D 冻结源码与不可变镜像保持原身份。原控制长测继续：十房×十人已完成实际六十分钟，ACK p95 12.2ms；五十房×两人尚在原进程运行，不能提前认定通过。联合资源和开发活动证据单独保存，不作为独占 SLO。

## 2026-09-30：W03 旧会话公平收尾

独立审查发现并修复旧会话固定最低 UUID 批次导致的清理饥饿。待清理和有效进度分开查询/调度，复用各自全局四路、每来源两路预算后独立执行；进度按最近上报时间轮转且不超过十秒频率。领取在数据库中原子核对状态、IO 租约和预算，只有实际领取才计入最多五次；退避最多十六秒，六十秒总期限的剩余预算扣除 SQL 往返时间后限制真实 HTTP，总期末零余量不发请求。完成仍需匹配原 claim 和有效租约；不改旧加密 scope/设备/SID。

八生产文件新摘要 `894a1463163c836fa4b6a39b0011b18cf9b916a3887474c505358083e14ec1b3`；新绑定 `.runtime/w03-backend/fairness/backend-binding.json` SHA `56e9586f285afa757678f2e4d5ac5f0a8bec9d5652e9429bf7c529f457f8953a`。实际 Windows Server `3d512f80c1ab0ac3abcf542cd2e910c39ffe3039f1126625475cd07a73c4f1d4`，Worker/Agent 与首批相同。新受影响十五项测试、全工作区 Clippy、格式、生成协议检查及全部二进制/示例构建通过；旧 e7bf/775ef 绑定和源码归档保留，未混作新版本证明。

最终 `tests/upstream-reservations.mjs` 同一入口一次十九场景全通过（116.524 秒），`.runtime/upstream-reservations/a96bbdb3-b6a4-4a55-87f7-90e4ef38626a/report.json`。入口仍为 `52f8550e…`，新增崩溃恢复与十八个既有契约门槛全部执行；实际 Server 副本/八源/入口前后稳定，失败为零，owned PG 和匿名卷清理通过。

新版本完整原生集成也通过（175.524 秒），`.runtime/w03-backend/native-integration/4f2d0b78-886c-4d72-a500-cf8c0b9c6828/report.json`：八源/三 exe/八预构建例子/入口与导入前后稳定，全部既有媒体/控制/任务/索引/备份恢复门槛保持通过，owned PG/匿名卷和登记的三十四个进程查空。100 连接快照 256ms 是共享宿主短测，不是独占容量 SLO。D 两个原持续进程及三套本批回归实际 UTC 重叠另记 sidecar。

密集旧库升级最终一次通过全部五十项检查（161.197 秒），`.runtime/upstream-reservations-upgrade/96f6eb44-3f7f-4596-9b8b-2e8d39801337/report.json` SHA `c463a487bb266fbf52d6566c4d0ef84baff7bb37c125bccda5f3b8805196da24`，入口 SHA `c96b9b9a4f1e8e43f93b6d6fccc58b93b0cdf168d09db12cdbc6d7ac8504a3f6`。四十六个真实旧 API 授权实际迁移 1–24→25；四十二个正常存活授权持续收到 Progress 204。被停止的高 UUID 会话之前仍有四十四个低 UUID 活跃授权，原设备/SID 的一次 Stopped 204 正确关闭，不再饥饿。三种失败均实际领取五次；已知 Jellyfin 五次 503，旧 Emby 五次 Stopped 204 但无可恢复设备且不发 DELETE、不假闭合，未知 SID 零 HTTP Stop。等待第五次真实 HTTP 响应及 IO claim 结束后检查，失败窗 47.902 秒、另 14.641 秒稳定窗无第六次。八源、新旧 exe、绑定、夹具和入口前后稳定，二十四项 owned 清理核对全部通过。

此前两份密集失败证据保留：首轮把四十人放同房触发正常 `ROOM_FULL`，夹具改为五个各八人的真实房间，通过正常创建/邀请/WS 切片源；第二轮在第五次领取与响应之间过早断言，修为等待 IO 结束及第五次实际响应。没有抬房间配额、绕过 API 或降低预算门槛。

## 2026-09-30：W03 上游预约、取消补偿及旧库升级

第一批增加迁移 0025、独立上游预约/设备身份、SID 先持久化、独立协商执行者、有界并行清理及累计分步确认。网络 Start/Progress 结果未知时保留 `io_uncertain`，不把本地租约当成上游取消保证；旧 Emby 无可恢复 DeviceId 时不猜测身份或假记编码已停止。实际视频触发 Start/每观看者进度与真实固定 Jellyfin/Emby 矩阵仍待下一批，本批没有改动指定分支前端，也没有部署。机制及边界见 [上游会话核对](UPSTREAM_SESSION_AUDIT.md)。

冻结后端八文件摘要 `e7bf20826e5f2f54857beaf4e5d20a4d1890050299df4260f14b5909dab173b7`，绑定 `.runtime/w03-backend/backend-binding.json`。成功原生构建实际 Server SHA `775ef9e09523244f3135e787b34b4cf6015007faeedaf8bfb257cb18a6c8284e`、Worker `ea98d517dd9e7fddff067f1f8e1422d0f2949115686219898fe8d9f75af8cf60`、Agent `5cd04b9df03303a3b570e91d44871d57f3a23d352a19564a0c03fdb1b5cbed8e`。工作区 71 项 Rust 测试通过、两项子进程夹具入口忽略；最终 Server 十项再次通过，全部目标 Clippy、格式、生成协议检查及二进制/示例构建通过。首次类型推断编译错误及修正后日志保留，不压低检查要求。

真实 Windows Server/隔离 PostgreSQL 与受控 HTTP 的十八场景通过（114.233 秒），报告 `.runtime/upstream-reservations/a2c65d49-bc47-444b-ae07-2143f72ed7b1/report.json`。覆盖两种服务的独立尝试/加密/幂等、成功 SID 后的空流/音轨/URL 校验失败、取消迟到响应、提交事务失败、真实房间换代、重启保留其他有效授权、Emby 一次 Stopped 成功后只重试失败的 DELETE、慢 Stop 不阻塞独立会话、最多五次清理和未知 SID。协商超时使用真实三十秒期限，收到请求至返回 30.022 秒；健康会话在慢 Stop 连接关闭前完成，实际清理 1.448 秒。迟到 Start 在已成功补偿 Stop 后实际重新生效，测试要求本地仍 `cleanup_failed / io_uncertain`，不将远端不确定性伪装成释放通过。入口 SHA `e209c43b7dfaaae250e2f31c13888e611dec6e05829b2074ac12669cc7fe87b7`，该精确版本保存在报告旁 `tested-entry.mjs`。

同一冻结后端另行补测进程在 held PlaybackInfo、SID/响应均未保存时真正终止，再启动新 epoch、释放旧上游迟到响应并用原 key 重试；旧行保持 `unknown / cleanup_failed`、无授权/旧 SID Stop，新尝试有独立设备/SID，真实 Start 活跃后单独 Stop 成功，旧行在新 Stop 后仍不假闭合。独立审查补上 Start 前活跃及 Stop 后旧行断言后，唯一最终单选运行通过（15.423 秒），报告 `.runtime/upstream-reservations/41a97163-38d9-4e4c-ac9d-3aea5c959e11/report.json`，入口 SHA `52f8550eb9f2f20d0e499a117f79e9417d3514db8f3592c9cddb4545414cdfaa`。十八场景与补测是不同入口版本/随机运行，未称为最终入口一次十九场景实跑；首次补测版本也归档在原报告旁。

旧库升级另行通过九项检查（100.933 秒），报告 `.runtime/upstream-reservations-upgrade/a15b46dd-b7a1-4a1b-a464-60e32a2899fd/report.json`，入口 SHA `a2704bdaeec2e8c0ab1f154372fdba69cfa5e7d7d8bc97fcda50e678f8ffcfea`。旧 Server `a4efce0d…` 创建六个真实 API 授权，确认实际迁移 1–24→1–25，新增预约表未凭空回填；ready/renew 保留原 scope/SID、不新增协商。已知 Jellyfin 使用原 `rainsync` 身份收到 Stopped 204，另两个 Jellyfin/Emby 授权仍活跃。三种失败各最多五次：已知 Jellyfin 五次 HTTP 503、旧 Emby 五次 Stopped 204 但无 DeviceId/不发 DELETE且远端编码仍活跃、未知 SID 五次本地领取且零 HTTP Stop；均不标记 closed。实际预算观察 65.56 秒及额外 13.92 秒稳定窗无第六次领取。

三轮最终实跑的入口/夹具/实际 exe 与八文件后端输入前后稳定；各自随机隔离容器及登记匿名卷清理通过。这些证明受控协议和本地恢复，不代表真实 Jellyfin/Emby 解码兼容。D 长测继续使用原镜像与 frozen source；上述开发和测试 UTC 区间另记共享资源的 `development-activity.jsonl`，不可混合候选身份或宣称独占 SLO。cgraphy 差异上下文再次长时间无返回，停止该只读调用，采用符号源码、独立审查和 Git 差异复核，没有 enrich。

随后完整 Windows 原生集成首次失败，`.runtime/w03-backend/native-integration/04e0fb36-8492-44fd-be89-132e9609f79e/report.json` 与 `stdout.log` 保留。既有媒体/幂等/恢复检查通过后，控制 epoch 检查遇到 WS 已关闭；测试在活连接后同步 `cargo run cleanup_control_history`，隔离 target 漏预构建该示例，实际发生冷编译，观测产物时间跨度 69.545 秒超过服务端 45 秒无心跳期限。首次输出未捕获 Server 退出原因，不能声称生产退出已证实。测试现要求执行预构建例子、缺失即明确失败，原 epoch/48 小时/锁等待断言与期限保留；单例 `-j2` 构建通过，完整重跑继续。首次隐藏 Cargo 的实际并行数未知，另行如实记录，不能事后填成两个任务。

修正后完整集成在原冻结后端通过（176.144 秒），`.runtime/w03-backend/native-integration/6354293b-0aac-4f36-ab4a-44274fec8a19/report.json`：控制 epoch/48 小时/锁等待、WS 限流、真实媒体/任务/缓存/NAS、10001 条索引及 PostgreSQL 备份恢复均通过，100 连接快照 268ms 仍只是短测。修后 `control-epochs.mjs` SHA `cd74c725981210f70df636c3b762a3e21d2ec45a49408e04a9198b07e43ad7f8`，执行的预构建例子 SHA `0f93394802b7355371aaefb5afa46e3738a8b957d15b7cff1f5bab4d5fdf9e6c`；八生产源/绑定/三实际副本 exe、入口及导入前后稳定，隔离 PG/匿名卷和登记的三十个进程查空，未观测到新的 Cargo/rustc。原八份源码及绑定另外保存在 `.runtime/w03-backend/pre-fairness-e7bf2082`，这轮仍不是公平性修后的证明。

提交前独立审查另发现旧会话批次按最低 UUID 固定取 32 条，持续有效的旧授权可能长期阻挡较后面的清理。小规模升级回归没有覆盖该公平性问题；正在分离旧会话清理与进度轮转，并扩充超过 32 个真实旧授权的回归。修后须重新构建、绑定并重测受影响矩阵，现有八文件/775ef 原生证据只证明其原版本，不作为修后证明。

## 2026-09-30：候选 D 短测与持续验证启动

D 从干净提交 `036ac194a5bbbfce081c55f7421170b67da0ba6c` 冻结、实际构建并独立 verify：`.runtime/validation-candidates/w07-w08-20260930-d/candidate.json`。镜像 `sha256:90a49394c7e17198992a6eef6b2edd48b4ddfe4822fd4548b5a0f95b54487aaa`；全源码 `f83940c9bfa08ffd87a6e8124a53f5030c2f14ba878268ebdcab88f0f81c4970`、生产 `39dbd5a4b3c930df10caeab17c2784b256c57d6d2da7df36be4adbbe9e730c32`，372 份源码、105 份生产清单项。实际前端仍为 `262cb8eb414fdc3861816fee1655cdf0e05a9a538541e83fabd3a0bec41fc54c`，指定分支提交 `7f17ab7`；相比 C，生产清单只增加精度回归及 Cargo float feature，Cargo.lock 未变。五个镜像 label、A 只读 vendor、FFmpeg 5.1.9 和三份实际 Linux 二进制核对通过，独立证据 `D/independent-identity-proof.json`；Server `70552ac613da24b5bf5d1bdafe17910d95058549e6d210c7649ef5b543d401b9`、Worker `7def067ba34ab6137ccf9ea7543ac357e8b705f5efa1676e2155bc4c03afbcb4`、Agent `1ea2405d5831b4b0e328af2e6beebfe1d69e335d79026ae39c968f4e2e6042ab`。

D 两种拓扑各二十五秒短测通过，`D/source/.runtime/control-load/rainsync-load-2dfdcd82/report.json`：十房×十人 ACK p95 29.5ms/30 条命令，五十房×两人 32.5ms/150 条命令，两阶段均至少 100 个在线独立身份，完整状态/重连/持久化一致。真实 Ctrl+C 另行通过，`D/source/.runtime/control-interrupt/c9e3c6e6-fc65-48ac-b63c-8ddc09bc77a6/report.json`：排队 ACK 中约 1661ms 非零退出、failed 报告且 owned 容器/网络清理。正常短测与中断测试是不同随机运行，未把预期失败报告当成正常门槛通过。

D 新完整窗口 NAS 九十秒短测通过，`D/source/.runtime/nas-soak/rainsync-soak-58e0b91b/report.json`：首帧 92.346 秒，实际帧计数窗口 90.8214 秒、呈现 902/907.733 帧（99.3684%），媒体前进 90.8 秒；掉帧 2、缓冲 0.6823 秒（0.7513%）、无计数重置。最终 fresh counter 2→904 包含末采样之后新增八帧。持续真实源句柄、正租约、任务 attempt 1、同方案；停止 3.8142 秒内三流终态、源文件与编码进程释放，候选前后 verify、全部隔离清理通过。

D 背压五场景通过，`D/proofs/agent-backpressure-64e3d610-132b-4f0b-a1fd-d25c094648e2/binding.json` 与 `D/source/.runtime/agent-backpressure/rainsync-agent-backpressure-673bed03/report.json`：21 次健康信号/43.771 秒后精确恢复 64MiB；先收到健康信号再 Close 181ms、控制丢失 168ms 释放/2.009 秒重连，失健康 29.227 秒释放。完整前后候选/实际二进制核对和 owned 容器/卷清理通过。三组短测共享宿主资源，不能称作独占单场景 SLO。

上述短门槛通过后才启动两份持续负载：控制 `rainsync-load-f01d14c6` 默认串行十房×十人、五十房×两人各 3600 秒；NAS `rainsync-soak-a38b55a9` 请求 7200 秒、30 秒采样，真实起播 `2026-09-30T01:07:00.126Z`。唯一不可变 D 镜像和 frozen source 保持绑定，长测未完成前不关闭时长门槛。外层只读采样器在 `01:03:27.462Z` 先于两入口启动，`.runtime/validation-joint/w07-w08-20260930-d` 保存精确 argv、D 身份、两项 run bindings、15 秒共享 Docker/宿主资源快照；代码 SHA `6707c8def06e061f148df44ec046223ad4cde0dd5d50311eb86e9861ea59562b`。缺失或无法确认的阶段保持 unknown，重叠只用入口报告的实际测量区间，不能把两个负载写成独立单场景 SLO。

NAS 真实样本 8340.061 秒，1.10 读取设置并保留实际准备之后约 289 秒覆盖余量。十分钟检查已实际收到网页定时同会话续租 200（不是 initial manual），持续真实解码、源字节/租约及单 attempt；这些仅为运行中检查点。活仓库后续 W03 源码和测试不混入 D，若同宿主编译，命令/两个并行任务限制和 UTC 区间另记 `development-activity.jsonl`，最终评估需一并呈现。

## 2026-09-30：候选 C、精度回归与完整呈现窗口

C 从 `a9d5ee7` 冻结并实际构建、独立 verify 通过：`.runtime/validation-candidates/w07-w08-20260930-c/candidate.json`，镜像 `sha256:65f18d489cf5a16d527051fc4fc0ca8b4b3b20df405b9ab5d082726309a56c6b`，全源码 `02974c5ab56e910ef3f9b17a6607d5f8f53aac31c333f63ccb6fb9bf22444b2c`，生产 `2d9365348a8c617476aa32bd0f77a3f982e1e51afea10ddb26988af26056165d`，实际前端 `262cb8eb414fdc3861816fee1655cdf0e05a9a538541e83fabd3a0bec41fc54c`。370 份源码、五个 label、只读 A vendor、实际三份二进制及 FFmpeg 5.1.9 全部核验；Rust 产物哈希与 B 相同，前端分支提交仍为 `7f17ab7`，实际前端包含已验证的增长恢复修复。

C 严格 NAS 九十秒短测通过，报告 `C/source/.runtime/nas-soak/rainsync-soak-6a891b01/report.json`：首帧 92.305 秒，实际观察 92.594 秒、呈现时间前进 91.8 秒、真实新增 917 帧，掉帧约 0.22%，缓冲 0.096 秒（约 0.10%）。仅初始装载、零 detach/计数重置/新方案，任务 attempt 1、真实源字节 9,830,400→13,631,488，Agent RSS/FD 无增长；停止 2.770 秒内全部三流、句柄及 FFmpeg 释放，清理通过。该轮前端冻结绑定正确，仍是短测。

C 控制短测十房×十人二十五秒通过（ACK p95 28.6ms，30 条持久命令），五十房×两人刚开始时严格重连状态检查失败：原位置 `32546.403021000006` 重读为 `32546.40302100001`，其余状态相同。失败报告 `C/source/.runtime/control-load/rainsync-load-1c639c70/failed-report.json` 保留；本次隔离容器和网络再次核验已清理。失败后未继续 Ctrl+C 或长测，C 保持原样。

新增 `crates/protocol/tests/room_state_roundtrip.rs` 在原依赖配置精确重现这两个值的 typed JSON 失配，日志 `.runtime/frontend-merge/float-roundtrip/logs/float-roundtrip-before.log`。工作区启用当前锁定 serde_json 1.0.151 的 `float_roundtrip`，不升级依赖或改 Schema；修后 typed JSON 和 PostgreSQL 使用的 JSON Value 往返均严格保留状态与浮点位值。依据为 [该版本解析源码](https://github.com/serde-rs/json/blob/v1.0.151/src/de.rs)，实测日志同目录 `float-roundtrip-after`。最终工作区 67 项通过、两项子进程夹具入口 ignored；Clippy 所有目标、二进制/示例构建、生成协议 `--check` 与格式均通过。D 将重新冻结生产及全部源码。

原生 `tests/room-state-roundtrip.mjs` 最终版在实际 PostgreSQL 17.11、双身份 API/WS 与新 Server 上通过（24.168 秒），报告 `.runtime/frontend-merge/float-roundtrip/room-state-roundtrip/fd3ba80d-42de-48ad-a8f1-4e9ac3b952f8/report.json`。三个精度样本共 66 次独立完整状态和四个 f64 位值核对，覆盖 JOIN/RESUME、六条实际 SEEK/SET_RATE 的 ACK/EVENT、快照/事件/命令结果持久化及逐条重放；原始数据库 JSON 文本由 Node 独立解析，不能用 ACK 自身作为位置预期。入口 SHA `b8c2912b7b2f6b0c0e78225fe86871020d8aac49c99dc6ba01a9a3cd7d0d8ce7`，Server SHA `a4efce0dc7845a4cf369777dba22f37534277db9eebda98789dcde880614e0e9` 前后稳定，失败为零，本次容器及登记匿名卷清理通过。首次夹具取错媒体字段的失败保留、资源也已释放；曾复制的“旧”宿主 exe 实际已含修复，不能算修前证据，修前证明仅为上面的 C 失败及 Rust 回归。独立只读审查确认严格失败断言、身份/epoch 绑定和清理成立；GET /rooms 仅核对成员可见性，不含房间状态精度证明。

活观影入口进一步将 95% 呈现门槛的分母改为完整实际观察窗口×真实源帧率，最终资源采样完成后再读取真实 video 计数，包含尾部停顿；报告请求时长、浏览器计数窗口、完整宿主窗口、首尾计数和公式，不以最后呈现 PTS 截短停顿。旧 C 的 917 帧按完整窗口保守重算为 99.09%，活诊断 57c1b86b 为 96.21%，均仍满足 95%；没有降低门槛。旧报告的计数采于末次样本开始、wall 在样本结束，约有 0.77 秒尾差，新入口补齐尾计数。准备等待原为各自的 readyState 120 秒、API 60 秒、playing/真实帧 30 秒；不存在合并的首帧 120 秒硬门槛，最新入口明确记录各阶段。

Windows 原生 `library-player-real.mjs` 在新精度修复后通过（30.230 秒），报告 `.runtime/library-player-native/runs/da7f8dd6-b2ff-4df9-aa45-51dda2830b1b/report.json`：两个真实 Chromium 用户、实际 Server/Worker/PostgreSQL、真实 FFmpeg/FFprobe 9.0.2，片库封面预览不创建会话，私人名称隔离、实际播放/聊天、路由/资料改名/全屏保留 video 与连接/准备/DB 会话数，倍速同步通过。已有基线累计 WS=2、准备=1、DB 会话=2，后续不增加；不声称初始历史只连接一次。入口、全前端/协议/生产清单及三份原生 exe 前后哈希一致；此本地源用例未启动 Agent。所有本轮服务、浏览器和媒体进程已释放，不能把 Windows 产物证明冒充 C/D Linux 镜像。

## 2026-09-30：增长清单播放恢复诊断

B 指定前端的严格 NAS 九十秒短测失败，报告 `B/source/.runtime/nas-soak/rainsync-soak-f332b580/report.json`：实际呈现 512/899.52 帧（56.92%），缓冲 39.698 秒（44.1%），同方案/同 attempt 出现 23 次 MSE 重建；首帧约 100 秒、停止约 1.763 秒完成释放。后续活入口+B 镜像的 1.10 读取速率诊断在 64.852 秒失败，报告 `.runtime/nas-soak/rainsync-soak-9a54b4f5/report.json`：累计真实呈现帧仍不足、缓冲 20.152 秒（31.07%），17 次 MSE 重建，停止约 3.787 秒释放。两轮源输入持续活跃，播放会话和任务 attempt 均为 1，没有致命 HLS 错误或 ended；不能把媒体时间前进当成连续呈现通过。

诊断捕获完整因果链：新分片已 BUFFERED，readiness 返回同 attempt 的 ready/complete=false，`waitForGenerated` 随即对相同 URL 调用 `loadSource`，hls.js detach MediaSource，原生计数归零。后端所有公开清单均为 growing EVENT，未误标完整。活前端改为保留同 attempt 的 Hls/MSE/缓冲，继续清单轮询；正在播放且未完整的任务须有一个四秒分片的公开余量才结束准备等待，查询与房间目标时间保持真实位置。409 换代恢复仍保留原有限重建路径。构建及 58 项单元测试通过；新增浏览器增长回归继续，尚未冻结 C 或启动两小时。

观影入口改用 rVFC 的实际 mediaTime，并保留 DOM currentTime、呈现时间和计数重置证据，避免 MSE 重载瞬态 DOM=0 造成错误时间回退判断。实际呈现至少 95%、原生掉帧最多 2%、首帧与五秒释放门槛均未下调；缓冲时长和比例如实记录，原入口未设独立缓冲比例门槛。名义读取 1.10 下，上一轮实际公开区间增长约 1.044 倍；读取设置不能代替实际呈现证明。

活前端修正+B 不可变镜像的严格九十秒诊断通过，报告 `.runtime/nas-soak/rainsync-soak-57c1b86b/report.json`：首帧 88.560 秒，实际呈现 873/899.523 帧（97.05%），掉帧 3/876（0.34%），缓冲 2.733 秒（3.04%）；只有一次初始 loadSource/attach，没有 detach、计数重置或新播放方案。连续观察真实输入/有效租约/源句柄与字节增长，任务 attempt 1；停止后 2.784 秒释放全部三条预览/探测/播放传输、源句柄和 FFmpeg，清理通过。Agent RSS/FD 均未增长，Worker 约 1.46MiB，Server 约 4KiB。此轮是活源码诊断，不能代替 C 冻结绑定或两小时门槛。

修后全部浏览器文件分别验证：其余十五文件 120 项通过、两项移动不适用跳过（1.6 分钟），报告 `.runtime/frontend-merge/playback-growth/other-browser/playwright-report/index.html`；恢复文件桌面/移动尺寸共 32 项通过（30.7 秒），报告 `.runtime/frontend-growth-regression-final/playwright-report/index.html`。新增组件回归真实 GET/解析三轮 EVENT 追加，验证初次和增长时四秒余量、同 Hls 与实际 MediaSource 对象身份、零多余 loadSource/detach/准备请求/END_MEDIA，并继续四个实际 HTTP 409 验证原三次换代重建上限。该 Hls 替身不解码，真实呈现证据来自上面的 NAS 诊断。恢复文件 SHA-256 `3ce139024075c05dffe4fce3163bc08fdc6fa952103a4f84741acaef94434fa3`。

原生 `tests/registration.mjs` 在指定分支配套服务端通过，原始记录 `.runtime/frontend-merge/7f17ab7/logs/frontend-registration.{json,log}`：邀请注册/自动会话/资料/聊天、非消耗校验、响应丢失、事务回滚、同码竞争、撤销/过期锁竞争、用户名不可变、普通身份、Origin/JSON、重启持久共享限速和可信代理链。独立 `account-rules.mjs`（15.4 秒）、`registration-invites.mjs`（8.8 秒）、`avatar-upload.mjs`（16.9 秒）也通过，日志同目录 `frontend-account-rules`、`frontend-registration-invites`、`frontend-avatar-upload`：真实规则和密码空格、普通角色、邀请批量/幂等/回滚/撤销/权限/重启、实际 PNG→512×512 WebP 编解码、畸形/动画/尺寸拒绝、头像版本与操作幂等/并发/tombstone/超时回收、昵称与重启持久化。原生头像仅在子进程 PATH 使用已验证的 FFmpeg 9.0.2。

`avatar-container.mjs` 在 B 的不可变 Linux Server 镜像另行通过（6.3 秒），原始日志同目录 `frontend-avatar-container`：透明头像和详细大输出均为完整 RIFF WebP，实际容器 FFmpeg 5.1.9。两平台头像结果分别记录；隔离测试容器已清理。

## 2026-09-30：候选 B 与验证入口预算

B 已从 `7271c78` 冻结并真实构建，`candidate.json` 位于 `.runtime/validation-candidates/w07-w08-20260930-b`。镜像 `sha256:f75d4095c8464f64ad8fb49e5f1d9499a98cfd3026369c7edfc63da40322ff30`；全源码摘要 `82cef71aceb27c1707919fa98acb25db9c30eb512dbc2489dc3372d40b4321d3`，生产摘要 `2d9365348a8c617476aa32bd0f77a3f982e1e51afea10ddb26988af26056165d`，前端摘要 `1183cbb025efa4e876a73efc4c2cd7f3f95c729c188b25625bb9496a7663e790`。前端分支固定 `7f17ab7`；独立 verify 核对源码、只读 A vendor、五个镜像 label 与三份实际二进制哈希全部通过。容器 FFmpeg 5.1.9-0+deb12u1。

B 控制短测在正常 API 账号准备阶段失败（`B/source/.runtime/control-load/rainsync-load-32d5dccc/failed-report.json`）：五路同时建号/登录触发新后端默认共享密码哈希并发预算，接口返回 429，尚未进入持续控制测量。隔离容器已清理。活入口改为测量前串行准备账号；测量仍为 100 独立身份，次数/调度/ACK/事件/数据库门槛不变，生产预算未修改。B 冻结副本保留原样，后续 C 需重新绑定全源码。

修正后的活控制入口使用 B 不可变镜像完成两种拓扑二十五秒短测，报告 `.runtime/control-load/rainsync-load-83746a94/report.json`：100 个独立正常 API 身份，十房×十人 ACK p95 25.9ms/30 条命令，五十房×两人 37.0ms/150 条命令，动作/全状态/事件/持久化/调度与清理通过。活源码仅作为此轮诊断，不代替 C 全清单绑定。真实 Ctrl+C 在排队 ACK 期间通过，报告 `.runtime/control-interrupt/82883d59-f248-41c3-926a-b9cebc1ed173/report.json`：约 1647ms 非零退出，failed 测量报告且资源全部清理；每拓扑六十分钟仍待运行。

B 强化背压五场景通过：健康信号 21 次、43.753 秒存活，恢复准确交付 64MiB；Close 前和控制断开前均先收到健康信号，源句柄分别 167ms/172ms 释放，控制重连约 2.107 秒；停健康信号后约 29.306 秒退出。绑定证据 `.runtime/candidate-backpressure/132afbcb-8190-4223-8ebb-30084d633d82/binding.json` 及 `B/source/.runtime/agent-backpressure/rainsync-agent-backpressure-6c8f8c7f/report.json`。前后完整冻结候选核查通过，容器/volume 已清理。

隔离准备 Windows FFmpeg/FFprobe 9.0.2 及公开 SHA-256 后，仅设置本次子进程 PATH；真实原生 `media-preview-sources.mjs`（107 秒）及 `playlist-real.mjs`（29.8 秒）均通过。前者覆盖本地/HTTP/HLS/NAS、错误与恢复、撤销及没有播放会话；上游海报是协议夹具。后者用真实 Chromium 自然结束后自动下一项、循环及空列表重播，保持同一 video 和单个 WebSocket。完整证据 `.runtime/tooling/windows-ffmpeg/ffmpeg-9.0.2-1f9837cfbc4b44fab9db3ad46b57f1b6/native-validation-report.json` 保存下载来源/摘要、实际版本与原生二进制前后哈希；两轮容器已清理，未改全局 PATH。

## 2026-09-30：指定前端分支集成

`git fetch origin` 后 `origin/main` 仍为 `d699418`；指定前端为 `origin/front/rainsync-implementation`，提交 `7f17ab7`。先将 NAS 索引、源版本、执行取消和持续验证入口保存为本地检查点 `8b3d5de`，再合入前端及配套服务端/Worker 接口。合并冲突集中在 Agent、Server 索引控制和输入回归入口；保留现有 ACK 分页、周期扫描、全局扫描许可、单文件隔离及目录失败回滚，补入 HELLO/SCAN/SCAN_BUSY，并让匹配的 INDEX_ABORT_ACK 结束手工扫描为 failed。

当前 `npm ci`、`npm run build`、`npm test` 通过：11 个单元测试文件、58 项测试。完整 `npx playwright test --workers=4` 通过 150 项，另两项移动不适用场景跳过，耗时约 1.8 分钟；报告位于 `.runtime/frontend-merge/7f17ab7/playwright-report/index.html`。这些浏览器回归使用 API/媒体夹具，不等于移动实机或真实 NAS 持续播放。Rust 生成协议 `--check` 已通过，工作区和服务集成结果继续追加。

旧前端与 A 镜像最后一轮 90 秒诊断通过，报告 `.runtime/nas-soak/rainsync-soak-78f813dd/report.json`：实际媒体 90.018 秒，rVFC 呈现 880 帧/预计 899.52 帧（97.83%），原生累计掉帧 0.565%，缓冲 2.36%，视频所有样本完整可见，停止约 1.755 秒完成释放。八次原生计数重置均记录同会话增长清单重载证据；此前停止瞬时采样不能证明超过五秒的资源泄漏。该诊断仅校验测量方法，不作为指定前端或两小时验收。

新预览 NAS 输入已接入独立 attempt 的生命周期停止信号；正常完成、超时、租约失效、Worker 停止和读取预算耗尽均通知 relay，任务被 Drop 也能停止。三项新增回归验证未消费的 HTTP Body 仍能被停止，以及旧/新预览和普通播放的隔离。Worker 27 项测试通过，另一个子进程夹具入口忽略；全工作区 Clippy（所有目标，warnings 视为错误）、格式及二进制/示例构建通过。

最终原生工作区统一重跑 66 项测试通过，两个子进程夹具入口忽略，无失败；命令/原始日志为 `.runtime/frontend-merge/7f17ab7/logs/frontend-rust-workspace.{json,log}`。Clippy 首次指出新测试模块后仍有生产函数，已将测试移至文件末尾并重新全工作区检查通过，没有压制 lint。cgraphy 差异上下文仍因内部错误或长时间无返回不可用，采用符号源码与 Git 差异复核，没有 enrich。

原生完整 `tests/integration.mjs` 在新二进制通过：持久化/缓存/授权/播放幂等/任务预算/旧代次/真实 NAS/10001 条分页索引/回滚/备份恢复等既有矩阵保持通过；100 连接快照 273ms 仅是本机短测。手工扫描入口 `tests/playlist-scan.mjs` 的真实 Agent 矩阵通过，扩展受控控制端中止回归也通过：API 18.9135ms 返回 failed/count0，旧索引保留且 partial 未落库，同一连接重新扫描成功；报告 `.runtime/frontend-merge/7f17ab7/playlist-scan/17027518-c01a-4bd9-8ca6-1d4ebb6378be/report.json` 保存实际二进制哈希，隔离容器已清理。

候选工具新增 `--frontend-ref`，记录分支提交、基线树和最终冻结前端清单，并将前端提交写入镜像 label。指定前端的真实服务短测和持续门槛必须使用重新构建的新候选。原生媒体预览源矩阵首次因宿主 PATH 缺少 FFmpeg 在生成素材前失败，尚未测到产品；单独准备验证依赖后重跑，容器内 FFmpeg 的证明单独记录。

## 2026-09-30：自动索引、背压修复与持续验证入口

自动索引候选 `sha256:65a541c773eb2aaabe5c23936c0cff003828dcb11feb56e25868ceb243eb2fcb` 的 `node tests/agent-index-refresh.mjs` 七场景通过，报告 `.runtime/agent-index-refresh/rainsync-index-refresh-da2839a8/report.json`。真实 Server/Agent/PostgreSQL，1406 条索引、九次完整提交及一次断线回滚；11.5 秒 ACK 延迟无重叠扫描，扫描期间两路数据流与新 Range 持续成功。不可读视频恢复、同尺寸同 mtime 的版本变化与元数据清空、目录失败保留旧库、真实删除及重连恢复均覆盖。既有 Windows 原生十一场景在索引及最新背压源码重新通过，最后报告 `.runtime/agent-native/run-74274db8-a15c-4e53-9bfa-a3b5a72afef2/report.json`。

低码率真实观影入口在约 32.4 秒发现 Agent 把正常发送背压误判为写入超时，句柄提前关闭；失败证据 `.runtime/nas-soak/rainsync-soak-15a08d1d/report.json`。修复使用有效租约、本地消费者队列等待期间的精确健康 Ping；普通 Ping/Pong 不延长期限，字节读取无进展与取消路径保持各自期限。

冻结候选 A 的镜像 `sha256:69e02cc605067ddfbfc25c3daab4f2d502823a299815aca46435f4bd376e7ac3` 已由完整源码/生产清单、构建输入、label 和三份二进制证明绑定。生产摘要 `8581d1ad8e77793bed8927ba7c80a4faf4ea5cb47c49ff1306ea5b5471d48cea`，全源码摘要 `134ae0903ccbb432c3c5ec6443a996a4bb982ff5b386c90775295fdc0287834a`。`agent-backpressure.mjs` 通过 43.742 秒健康等待/21 Ping，恢复后精确交付 67,108,864 字节；普通 Ping/Pong 两路按期限退出，停专用信号后 29.019 秒释放，Close 173ms，控制丢失含重连 2.019 秒。报告在候选 `source/.runtime/agent-backpressure/rainsync-agent-backpressure-34031143/report.json`。最后两项的本次新流未先明确等待健康 Pulse；下一候选入口补充该条件，不能把这份证据扩大为已续期后取消。

候选 A 的低码率浏览器短测跨过旧故障点，四十三秒仍真实播放并保持源句柄/租约。但约五十四秒同一播放方案发生 MSE 重载，原生帧计数 437→101 导致入口失败，原始报告 `source/.runtime/nas-soak/rainsync-soak-4042a62c/report.json`。实际媒体时间继续前进，不把失败计为观影通过；正在核查重载原因、累计呈现帧的计量方式和停止后传输收尾。两小时尚未启动。

`node tests/control-load.mjs --duration-seconds=25` 在上述指标候选通过两个拓扑：十房×十人 ACK p95 44.0ms、三十条命令；五十房×两人 32.4ms、一百五十条命令。报告 `.runtime/control-load/rainsync-load-a8222b78/report.json`。100 个独立 `/auth/me` 身份及精确房间成员已核对；PLAY/PAUSE 动作、完整 ACK/EVENT 状态、逐 revision 数据库事件/命令及最终快照一致。各项计划次数和实际调度迟到、聊天持久化、时钟回复与重连均检查；真实行锁阻塞暴露排队命令指标。早期夹具误把所有房间用于单房间队列证明的 revision 检查，修正限定房间后完整重跑。二十五秒结果仅为短测，不能关闭每拓扑六十分钟门槛。

Windows 真实 Ctrl+C 回归 `node tests/control-load-interrupt.mjs` 在行锁阻塞和 ACK 等待期间通过，报告 `.runtime/control-interrupt/b1a575db-74a1-444e-8ccb-0aec4b7ade1a/report.json`。隐藏独立控制台收到信号后约 1735ms 非零退出，负载报告为 failed，所有本次容器和网络已移除；没有附着用户控制台。随后新增重连立即完整快照核对及重复 EVENT 拒绝，需在下一冻结候选重跑正常短测。

`scripts/validation-candidate.mjs` 将允许的源码、测试及依赖清单复制到独立冻结目录，并把镜像源码 label、镜像 ID、实际二进制哈希与构建输入清单保存到 `candidate.json`。持续入口使用冻结副本和镜像摘要，核对整个清单；后续活仓库修改不能混入同次测量。隔离测试验证凭据路径拒绝、源码篡改/额外文件拒绝、活仓库继续编辑隔离、禁止覆写及冻结 vendor 的严格复用范围。入口和统计口径见 [持续验证](SUSTAINED_VALIDATION.md)。基底镜像及 FFmpeg 发布版本固定仍属 W10 后续要求。

最新原生工作区 51 项 Rust 测试、两个 ignored 夹具入口及 Clippy 全目标检查通过。当前 cgraphy 差异上下文返回内部 NoneType 错误，采用 Git diff 和各符号源码复核，没有 enrich。持续两小时、两种拓扑各六十分钟和最终七十二小时尚未完成；真实设备/网络文件系统仍须按 [全计划核对](PLAN_AUDIT.md) 逐项验证。

## 2026-09-30：NAS 版本错误闭环与 Windows 原生 Agent

同步 `origin/main` 后 HEAD 为 `d699418`，工作区原先干净。先用现有版本绑定镜像 `sha256:95e965184e2200294e9c38908ce792b37140bea704d0e87610349c5d0caa3298` 重跑真实 Server/Worker/Agent 链路，报告 `.runtime/input-retries/rainsync-input-84e8757a/report.json`；同大小同 mtime 的替换拒绝旧授权、重新索引清空旧 metadata、原地修改中断旧流均通过。发现新增版本错误在默认 auto 探测中仍被转成可重试探测失败，转码任务也只保存通用失败。

修复为执行作用域内的固定 `SourceChanged` / `SourceVersionRequired` 分类，确认源冲突不被并发通用/网络失败覆盖。Worker probe 无论 FFprobe 成功或失败均先检查分类；Server 仅传播这两项 409 白名单，未知错误仍脱敏。转码失败保存相同固定原因并返回不可重试的 409，不发布产物，释放写入预留。无新增迁移/公开错误枚举，生成协议只读检查保持通过。

最终隔离镜像 `sha256:e69bd13cbe3cda5ed6e20257d847a5b4d5a5ff07b306e0e011f943e60d2b4af9`：

- `node tests/input-retries.mjs --source-version-playback` 十项通过，报告 `.runtime/input-retries/rainsync-input-6f8378e1/report.json`。真实 Worker/Server/PostgreSQL/FFprobe、受控 Agent 数据端，覆盖正常 probe/auto、显式源变化、成功首部缺版本/错版本、未知错误脱敏；失败准备 grant 已撤销，同请求编号重放不再探测且 attempt 保持 1。首次夹具使用错误的 `/playback` 地址造成 404，改为实际 `/playback-sessions` 后完整重跑；不是产品路由故障。
- `node tests/input-retries.mjs --nas` 十八类输入故障通过，报告 `.runtime/input-retries/rainsync-input-8d00d9a2/report.json`。六项新增场景覆盖 Agent 源变化/缺版本 409、成功首部版本不符/缺失、授权缺版本和未知冲突脱敏。确定版本冲突仅一次执行，无产物发布；原网络恢复、退避、三次耗尽、失租、权限/撤销及 Ping 回归通过，成功产物仍由 FFmpeg 解码。
- `node tests/input-retries.mjs --agent-relay` 六组真实链路场景通过，报告 `.runtime/input-retries/rainsync-input-4e34d7c3/report.json`。HTTP 取消释放四路文件 186ms，Agent 重启后的新 Range 恢复约 5409ms，管理员撤销释放旧文件 211ms；源替换旧授权 409/新授权 206，原地修改中断流。终态 4 cancelled、19 failed、2 completed，无活跃传输遗留。

`node tests/agent-native.mjs` 使用当前源码编译的真实 Windows exe，通过十一组场景，约 31.8 秒，报告 `.runtime/agent-native/run-b353a753-10cd-4f1e-a2f4-c541c27146fd/report.json`，同目录保存构建/Agent 日志及源码、锁文件、入口和二进制 SHA-256。十六路独立大文件证明活跃句柄，第十七路 503；Close/TCP 混合取消八路在 452ms 内释放，控制断开在 406ms 内释放所有源，消费者恢复读取前即通过逐文件 `FileShare.None` 验证。另覆盖槽位复用、重连 Range/HEAD/404/416、十秒握手期限、同大小同 mtime 的原地修改及替换、源缩短、三轮十六路取消（458/440/444ms）。私有内存由 3,993,600 增至 11,591,680 字节，增长约 7.25MiB；所有文件释放、夹具删除且进程退出。

原生工作区 51 项 Rust 测试通过，两个子进程夹具入口 ignored；Clippy 全目标且 warnings 视为错误、二进制/示例构建、格式与生成协议检查通过。完整 `node tests/integration.mjs` 在最终原生二进制通过，含鉴权/幂等/真实 NAS/索引/HLS/队列缓存事务/恢复与备份；100 个本机控制连接快照 272ms 仍仅为冒烟。新增 JS/PowerShell 入口的格式与 JS 语法检查通过。cgraphy 差异审查未返回，终止后用 Git diff 复核，未进行图 enrich。

这些证据没有关闭两小时连续观影/内存趋势、移动实机、网络共享文件系统、内核不可中断 I/O 或完整 Windows Server/Worker/Agent 链路。句柄身份/时间检测不是内容哈希，路径替换也不保证已经持有的旧文件句柄必然中断。自动索引与单文件故障隔离的后续结果见本页最新记录。未部署，改动保留在本地工作区。

## 2026-09-27：NAS 持久化传输状态与租约收尾

迁移 0018 增加 `agent_transfer_runs`，与原短期授权票据分开。原子登记/领取、收到首部后的阶段推进、取消/失败/完成终态、字节计数及活跃续租接入 Worker；Server 负责崩溃租约和二十四小时终态清理。等行锁后重新检查数据库当前时间；传输失租接入现有可恢复输入故障分类。字段含义、旧票据升级处理与剩余范围见 AGENT_TRANSFERS.md。

最终隔离镜像 `sha256:52257a457a3a141c2a741a885631cd031262e5172c080eeb008a1bf5c64ed91d` 的 `node tests/input-retries.mjs --nas` 十二类故障通过，报告 `.runtime/input-retries/rainsync-input-115f6149/report.json`。新增失租场景在第一次读取首部前使数据库租约过期，任务在 attempt 2 恢复并通过产物实际解码；原断流、重置、超时、无进展、离线恢复、三次耗尽、权限/非法数据/撤销及正常 Ping 回归保持通过。

`node tests/input-retries.mjs --relay-cancel` 的十九场景在同一最终镜像通过，报告 `.runtime/input-retries/rainsync-input-5853e059/report.json`。数据库触发器强制状态插入失败，检查票据随事务回滚；两秒延迟 INSERT 中取消仍能正确收尾；其余场景覆盖各阶段取消、HEAD/正文完成、并发领取、非法首部/断流/错误状态、票据及租约在行锁等待期间过期、超过三十秒票据期限的传输续租、失租断流、强杀 Worker 后的真实租约过期清理和终态保留。二十四小时保留测试回拨一条终态记录的时间，不冒充真实二十四小时运行。夹具最初将事务失败的既有 Worker 502 契约误写成 500，核对错误映射后修正并完整重跑通过。

同镜像的真实 Server/Worker/Agent 测试通过，报告 `.runtime/input-retries/rainsync-input-3da4281a/report.json`。HTTP 取消四路后 194ms 释放对应文件；重启恢复约 4752ms，新 Range 返回 90 字节；管理员撤销后 454ms 释放旧文件。最终数据库恰有 4 条 cancelled、16 条 failed 和 1 条 completed，没有活跃记录遗留；成功项保存 `bytes=10-99` 和 90 字节。

最终原生 Worker 19 项测试通过，另一个子进程夹具入口 ignored；新增测试检查部分交付不算完成、终态不被迟到清理覆盖。Clippy 全目标且 warnings 视为错误、工作区二进制/示例构建、格式和生成协议一致性检查通过。完整隔离集成在最终原生二进制上通过，含事务回滚、幂等、真实 NAS、扫描/索引、鉴权和备份恢复；100 控制连接快照 275ms 仅为本机冒烟。cgraphy 差异审查未及时返回，终止后使用 Git diff 和新文件源码复核。

尚未完成源文件版本绑定、替换检测、两小时连续观影与内存趋势；生命周期资源摘要不是文件内容摘要，HTTP 交付完成也不是客户端解码证明。未部署。

## 2026-09-27：Server 实例锁失联后的进程树回收

Server 将媒体进程及其 I/O 驱动、所有者任务放在独立 runtime。实例锁查询每两秒执行，三秒无结果也按失联处理；最外层先销毁应用 runtime，再等待媒体回收，返回非零退出码。正常退出仍保留最多十秒 HTTP 排空及其间的实例锁；排空中的锁故障可中断等待。无协议或迁移变更，机制及边界见 PROCESS_TREES.md。

先在上一版镜像 `sha256:b52075257273d06e8ced320c8e13bdc36b0c40f03fe7e85bd4deac68315b1bcf` 运行 `node tests/server-shutdown.mjs --lock-loss-only`，终止持锁 PostgreSQL backend 后 Server 退出，但 `/proc` 中仍有探测进程，故障复现记录为 `.runtime/server-shutdown/rainsync-shutdown-14fea821/failed-report.json`。测试容器保持运行，没有用容器清理掩盖残留。

修复镜像 `sha256:cb7b872ffc4f8633f4fbae99a521b59d970fdb2e65224beb507aca6852251e30` 通过 Linux 五场景，报告 `.runtime/server-shutdown/rainsync-shutdown-5c72c4ba/report.json`：SIGTERM/SIGINT 保持正常排空且退出码为零；终止持锁连接、暂停该数据库进程、正常排空期间终止连接分别约 1686/4892/3595ms 完成非零退出。全部检查探测及其后代消失、观看 WebSocket 关闭、实例锁最终可取得；其中暂停场景在检查 Server 退出后才恢复数据库进程。

Windows 原生 `node tests/windows-shutdown.mjs` 七场景通过，报告 `.runtime/windows-shutdown/7b28a68e-bc15-479c-a99f-b727c423876c/report.json`，含二进制摘要。Server/Worker 的 Ctrl+C、Ctrl+Break 和关闭隐藏控制台均正常退出；Server 实例锁连接终止约 1074ms 非零退出。事先保留探测与后代进程句柄，确认全部变为退出状态。首次运行遇到 PostgreSQL 初始化临时实例的就绪竞态，夹具改为 TCP `pg_isready` 后重跑通过。

工作区 48 项 Rust 测试通过，另两个子进程夹具入口 ignored；新增单元测试先销毁应用 runtime，再检查独立所有者的回收结果。Clippy 全目标且 warnings 视为错误、二进制/示例构建、格式与生成契约一致性检查通过。完整原生隔离集成通过，包含鉴权、播放幂等、扫描/索引、真实 NAS、HLS、备份恢复和重启；100 个本机控制连接快照 283ms 仅为冒烟。cgraphy 差异审查未及时返回，终止后使用 Git diff 复核。

同一修复镜像的 `node tests/worker-processes.mjs` 全矩阵通过，报告 `.runtime/worker-processes/rainsync-process-33bc0f2c/report.json`：真实编码/解码及探测字幕进程树、取消/退出、磁盘写满、只读目录、数据库断连、旧 Worker 恢复和新代次隔离均回归通过。确认共享进程模块的默认运行方式仍可正常回收并发布可解码产物。

这不保证撤销数据库已接受的写入，也不替代多实例 fencing；强杀本体、不可中断内核 I/O、Windows 注销/关机和完整持续运行门槛仍待验收。未部署。

## 2026-09-27：真实 Server/Worker/Agent 的取消、重启与撤销

`node tests/input-retries.mjs --agent-relay` 使用已验收镜像 `sha256:b52075257273d06e8ced320c8e13bdc36b0c40f03fe7e85bd4deac68315b1bcf`，隔离 PostgreSQL、Server、Worker 和真实 Agent。八路 HTTP GET 暂停读取，真实控制连接分发一次性票据、真实数据连接转发稀疏文件；本轮没有修改 Rust、数据库或前端代码。

报告 `.runtime/input-retries/rainsync-input-35b82b50/report.json`：取消四路 HTTP 后 179ms 内 Agent 文件句柄从八降到四；补回八路后重启 Agent，旧 HTTP 响应全部不完整中止，新 Range 请求收到正确的 90 字节，重启至恢复约 4456ms。再次启动八路后，通过登录且带 CSRF 的管理员 DELETE API 撤销设备，429ms 内 Agent 文件句柄归零，八个旧 HTTP 响应中断而非正常完成，新读取返回 503；没有遗留 agent_transfers 票据。

共享夹具支持 DELETE 并新增真实 Agent 模式后，HTTP 七类故障回归全部通过，报告 `.runtime/input-retries/rainsync-input-03617d3a/report.json`；脚本格式与差异检查通过。默认镜像统一到已验收的 `rainsync-worker-validation:local`，仍可用 `WORKER_TEST_IMAGE` 指定。cgraphy 差异审查未及时返回，终止后使用 Git diff 复核；未重复无改动的 Rust/前端测试。

测试为传输路径直接建立已授权播放会话，未覆盖实际影片解码、网页同步、完整配对/播放准备或两小时连续观影。它补上了此前受控控制端测试缺少的真实撤销传播证据，不替代其余 W07 门槛。未部署。

## 2026-09-27：真实 Agent 的并发、取消和控制断开

新增 `node tests/agent-lifecycle.mjs`，真实 Linux Agent 使用独立 1GiB 稀疏文件卷，受控控制连接与数据消费者制造网络背压。上一版镜像 `sha256:5e2e2d099175386f1f9440603e6a9569203a4460bb4ddab2e75b671673861355` 在“control disconnect releases all files”的五秒期限失败，确认控制连接结束后数据任务仍持有源文件。

最终镜像 `sha256:b52075257273d06e8ced320c8e13bdc36b0c40f03fe7e85bd4deac68315b1bcf` 通过六组场景：16 路活动文件及第 17 路 503；混合 Close/TCP 关闭取消八路并复用名额；控制断开后所有文件和数据连接退出；重连后的 Range/HEAD/缺失文件；16 个停滞握手的十秒期限；传输中文件缩短且不发送第二份元数据。取消八路的文件句柄从 16 降到 8 用时 194ms，控制断开从 16 降到 0 用时 165ms；复用名额另断言少于五秒。

报告 `.runtime/agent-lifecycle/rainsync-agent-life-ea4d9078/report.json`：基线 RSS 5188KiB，16 路背压时采样 11612KiB，控制断开后采样 8400KiB。该值不是峰值或长期上限。Range `bytes=10-99` 实际收到 90 字节；截断场景声明 1GiB，实际收到 5439488 字节后关闭，只有一份元数据。测试直接读取 Agent `/proc` 文件描述符并确认目标可执行文件，未把测试进程或容器退出当作资源释放。

Agent 两项原生单元测试、Clippy 全目标且 warnings 视为错误、二进制/示例构建、格式及生成契约检查通过。夹具修正了关闭收尾与名额释放的时序假设，并在观察旧数据连接 EOF 前停止自动再次暂停，仍保留五秒回收与名额复用断言。cgraphy 差异审查未及时返回，终止后使用 Git diff 审查。

最终原生二进制的完整隔离集成通过，包含真实 Agent 配对/分页索引/relay/撤销、Range/HEAD/416、权限、幂等与备份恢复；100 控制连接快照 282ms 仅为本机冒烟。前端、Worker 与数据库逻辑未改动，未重复其独立故障矩阵。

受控控制端不等于真实 Server/Worker 的全链路撤销，也不证明 Windows 或不可中断文件 I/O 的回收期限。传输状态机、持续两小时和其他 W07 门槛仍未完成，详见 AGENT_TRANSFERS.md。未部署。

## 2026-09-27：NAS 等待登记与取消竞态

新增 `node tests/input-retries.mjs --relay-cancel`。先在上一版镜像 `sha256:ac7801db2f42a41c352b5346acd0d3201f5cbfbb0356fba621ed6187b58e9bc0` 上复现：隔离数据库的测试触发器将 INSERT 延迟两秒，HTTP 已断开但 INSERT 完成后仍留下票据，测试在“late INSERT did not recreate a cancelled offer”断言失败。

修复镜像 `sha256:5e2e2d099175386f1f9440603e6a9569203a4460bb4ddab2e75b671673861355` 通过十个场景：延迟 INSERT 取消、五次等待连接取消、等待首部取消、正文取消、HEAD 完成与正常正文完成。延迟场景 2403ms 清理，其余取消 192–460ms，均低于五秒；晚到数据连接返回 401/410，已连接 WebSocket 关闭。报告 `.runtime/input-retries/rainsync-input-71869792/report.json`。单元测试另确认内存登记及通道在数据库清理通知前已经释放。

Worker 18 项测试通过，1 个子进程夹具入口 ignored；Clippy 全目标且 warnings 视为错误、二进制/示例构建、格式与生成契约检查通过。同步锁仅用于登记映射，不跨 await。cgraphy 差异审查未及时返回，终止后使用 Git diff 与源码复核。

相同最终镜像的 NAS 十一类故障回归通过，报告 `.runtime/input-retries/rainsync-input-0f097533/report.json`，包括正文停滞及持续 Ping 的期限、有限重试、永久失败与实际产物解码。完整原生隔离集成通过，含真实 Agent relay、Range/HEAD、权限、幂等、分页索引及备份恢复；100 控制连接快照 266ms 仅为本机冒烟。本轮没有前端和编码/缓存改动，未重复这些独立矩阵。

测试使用真实 HTTP、PostgreSQL 与 WebSocket 数据对端，未验证真实 Agent 在所有文件 I/O 状态下的文件句柄期限；数据库不可用时也不承诺物理行立即删除。完整传输状态机、撤销与持续运行验收继续。未部署。

## 2026-09-27：NAS 数据通道的任务重试与无进展期限

NAS relay 将执行级故障观察值传到已授权的数据通道；未撤销设备离线、等待/正文超时和截断可有限重试，撤销、无权限、非法首部和超量数据不自动重试。Ping/Pong 不截断正文、不刷新无进展期限；队列背压不计入等待下一段上游正文的期限。沿用现有三次上限、退避、代次隔离及公开错误契约，无迁移。

工作区 46 项 Rust 测试通过（另 2 个夹具入口 ignored），最终背压计时调整后 Worker 的 17 项测试再次通过；Clippy 全目标、二进制/示例构建、格式和生成契约检查通过。最终隔离镜像 `sha256:ac7801db2f42a41c352b5346acd0d3201f5cbfbb0356fba621ed6187b58e9bc0` 的 HTTP 七类故障回归通过，报告 `.runtime/input-retries/rainsync-input-67a618c6/report.json`。

最终镜像的 `node tests/input-retries.mjs --nas` 十一个场景通过，报告 `.runtime/input-retries/rainsync-input-a0d7bad3/report.json`。截断、连接重置、首部超时、正文停滞和离线后恢复均在 attempt 2 成功，持续 503 在 attempt 3 耗尽；401、超量正文、非法首部和撤销设备均在 attempt 1 终止；正常夹带 Ping 的传输在 attempt 1 成功。恢复产物经 Worker HTTP 实际解出视频帧，旧代次 abandoned、预留释放和公开错误码检查通过。首部/正文停滞时每 250ms 发送 Ping，两次首请求间隔分别 13.895/34.036 秒，包含既定期限与退避，且均在测试的 45 秒场景上限内结束。

最终原生二进制的完整隔离集成通过，包含真实 Agent 配对、万条分页索引、relay 与撤销、Range/HEAD、播放幂等、权限及备份恢复；100 控制连接快照 259ms 仅为本机冒烟。本轮未修改前端、编码监督器或缓存处理，未重复浏览器与完整 Worker 缓存故障矩阵。

测试里的 NAS 对端是使用真实一次性票据的受控 WebSocket 夹具，用来精确注入故障；不把它称为真实 Agent 两小时播放或完整 W07 验收。传输状态持久化、取消/撤销资源回收、慢消费者计量和持续运行等剩余门槛继续。cgraphy 差异审查未及时返回，终止后使用 Git diff 与源码复核。未部署。

## 2026-09-27：确认 HTTP 输入故障后有限重试

Windows 工作区 46 项测试通过，另有 2 个按设计 ignored 的子进程夹具入口；Clippy 全目标且 warnings 视为错误、二进制/示例构建、格式与生成契约检查通过。新增真实 TCP 断连和截断响应测试，覆盖 reqwest 的响应体 Decode 错误分类；执行标识测试验证旧请求及其他会话不能影响新执行。

`node tests/input-retries.mjs` 使用隔离 PostgreSQL/Server/Worker 和真实 HTTP 来源，七个场景通过：503、截断响应、连接重置、HLS 子分片 503 均在第二次执行成功并通过最终 Worker HTTP 输出解码，断言实际视频帧数大于零；持续 503 在第三次终止，401 与完整传输的非法媒体在第一次终止。检查退避下限、旧产物 abandoned、写入预留释放与公开错误码/不可重试属性。最终报告 `.runtime/input-retries/rainsync-input-1152ddf5/report.json`，镜像 `sha256:4573ffd3bb487717a05f3e4bd5c831d692d6c7ec54afd62f80a46b7350c6aa33`。

真实 HLS 测试暴露 FFmpeg 5.1 在 fMP4 输入上执行多余 `-ss 0` 时的解码错误。零起点改为正常打开后通过；非零起点原有逻辑保持。相同镜像的 `tests/seek-fixtures.mjs` 验证 0、1.25、5.25、5.267、8.125 秒的 remux/transcode 请求，十项均确认首 PTS、源帧与剩余时长，报告 `.runtime/fixtures/seek-ddb6fadc-4f96-4148-aab2-3f1b7033fc31/report.json`。

完整隔离集成通过，包含生产 finish 的重试事务、重复提交、旧续租拒绝及退避检查，Server/Worker 终态契约，NAS 万条分页索引、幂等恢复与备份恢复；100 控制连接快照 271ms 仅为本机冒烟。

同一最终镜像的完整 Worker 故障矩阵通过，报告 `.runtime/worker-processes/rainsync-process-c70d46e1/report.json`：实际编码/解码、首段失败与检查期限、进程树与探测字幕回收、缓存权限/ENOSPC、读租约和预算、完成产物 HTTP 解码、数据库中断及暂停旧 Worker 后的代次替换均通过。

此轮只分类已确认的 HTTP 输入故障；NAS relay 和具体媒体编解码失败分类仍未完成，不代表完整 W05 或发布验收完成。cgraphy 差异审查未及时返回，终止后使用源码与 Git diff 核对。未部署。

## 2026-09-27：真实慢编码与原生 HLS 回退

新增 `node tests/slow-playback.mjs`，隔离 PostgreSQL、Server、Worker 和浏览器，40 秒真实 H.264 样本；只给编码器输入加 `-readrate 0.5`，不替换 API、清单、分片或解码结果。Vite 使用部署的 CSP。先走 MSE 与先走原生 HLS 两个场景均完成首段播放、追上生成边界后等待、暂停房间让编码追赶、在权威位置恢复并继续解码；每场仅一个播放会话，任务保持 attempt 1/running。

真实 Chromium 153.0.8010.12 原生 HLS 对增长清单报告 `DEMUXER_ERROR_COULD_NOT_PARSE`，并暴露 seekable 为空而 buffered 有内容的状态。网页新增空 seekable 时使用 buffered 的恢复判断；原生解码/格式错误且支持 hls.js 时只回退一次到 MSE，保持会话及最新房间位置，不往返重试。原生网络错误仍沿用有限入口重取。专门的受控浏览器回归验证空 seekable 不阻止播放；真实场景验证原生错误后 MSE 实际解码，不能把这一结果称为原生 HLS 成功。

最终报告 `.runtime/slow-playback/rainsync-slow-e6f45a15/report.json`：生成区间增长率分别约 0.5305/0.5343 倍；暂停房间锚点 4598.055/4667.961ms，恢复播放器位置 4598.054/4667.960ms；随后分别前进至 5205.857/5290.658ms，解码帧由 4 增至 17。两个场景没有页面异常、错误横幅或额外准备请求。报告保存媒体 SHA-256、App.vue SHA-256、Chromium 版本、请求及媒体管线事件，测试同时检查运行期间 App.vue 未改变。

后端镜像复用已验收的 `sha256:82985eaf2f309542fd55463dd68543afefb940f804f963782312f6fc46cedb4b`，本轮没有 Rust 或数据库改动。前端 31 项测试、38 项桌面/移动视口浏览器测试、类型检查与生产构建通过；构建保留现有大块体积提示。cgraphy 未找到 Vue 节点，差异审查也未及时返回，改用源码与 Git diff 核对。未部署。

此证据覆盖暂停房间后追赶；持续以 0.5 倍生成不可能追上始终 1 倍前进的房间，不承诺这种条件下无缝同步。原生 Safari/真机、不同时间戳样本、长时间运行以及完整计划其余门槛保持未完成。

## 2026-09-27：Windows 关闭控制台的退出期限

Windows 首个退出事件为 CTRL_CLOSE_EVENT 时，Server/Worker 跳过普通十秒 HTTP 等待；Ctrl+C/Break 和 Unix 信号保留原来的等待。注册失败也跳过等待后进入清理。Windows 工作区 44 项测试、Clippy 全目标且 warnings 视为错误、二进制/示例构建、格式与生成契约检查通过，另有 2 个按设计 ignored 的子进程夹具入口。

`node tests/windows-shutdown.mjs` 在独立隐藏控制台验证 Server/Worker 各自的 Ctrl+C、Ctrl+Break、关闭控制台，共六个真实服务场景。关闭场景对测试控制台发送 WM_CLOSE，发送辅助进程先脱离该控制台；没有关闭用户窗口。Server/Worker 分别在 235/233ms 正常退出，发送前持有的探测及后代进程句柄均确认退出，低于默认五秒系统期限。普通 Ctrl+C/Break 仍约十秒。报告 `.runtime/windows-shutdown/1c97c77b-8202-4a11-a403-742fec4ac06a/report.json`；Server SHA-256 `60d555a4dcc9255cffda2a8bda44fcb3449ad2e83a9fa992b047acb9d53804b5`，Worker `b49345c466e412a358243a40f08fc49517a78fc3e9eab963b45c7fa55ec92829`。

Linux Server SIGTERM/SIGINT 回归通过，约 11.162/11.039 秒正常退出，探测后代、观看连接及实例锁检查通过，报告 `.runtime/server-shutdown/rainsync-shutdown-76cad28f/report.json`。同锁定依赖离线构建的运行时镜像为 `sha256:82985eaf2f309542fd55463dd68543afefb940f804f963782312f6fc46cedb4b`。

同一镜像的完整 Worker 故障矩阵通过，报告 `.runtime/worker-processes/rainsync-process-c4297162/report.json`：真实编码/解码及探测字幕进程回收、缓存权限、ENOSPC、读租约、预算、逐段与最终 HTTP 解码、数据库中断和旧代次恢复均通过。并发探测/字幕退出为 11.237 秒；旧 Worker 恢复后旧 FFmpeg 回收、旧目录清除，attempt 2 保持运行且 init 摘要不变。

完整隔离集成通过，含 NAS 万条分页索引、播放幂等恢复、权限与备份恢复；100 控制连接快照 306ms 仅为本机冒烟。cgraphy 差异审查长时间未返回，改用 Git diff 审查。

系统关闭期限可以配置；本轮不证明数据库/磁盘阻塞时也能在该期限完成，不覆盖普通排空期间再关闭控制台、注销/关机、强杀或 Server 实例锁失联退出。没有前端变化，未重复浏览器测试；未部署。

## 2026-09-27：Windows 原生 Ctrl+C / Ctrl+Break

Server/Worker 的普通退出监听合并到 media-core，Windows 新增 Ctrl+Break，Unix 保持 SIGTERM/SIGINT；注册错误返回前仍执行清理。Windows 工作区 44 项测试、Clippy 全目标且 warnings 视为错误、二进制/示例构建、格式与生成契约检查通过，2 个 ignored 子进程夹具入口保持原用途。

`node tests/windows-shutdown.mjs` 使用真实 Windows 服务进程、隔离 PostgreSQL、各自独立的隐藏控制台与受控 ffprobe 后代。Server/Worker 各自收到真实 Ctrl+C、Ctrl+Break 后均正常退出，四次耗时分别 10.287、10.299、10.281、10.304 秒。发送前取得的后代进程句柄均确认退出；子进程以 CREATE_NO_WINDOW 启动，不依赖同一控制台广播来终止。收紧启动环境变量并在创建服务后移除临时配置之后，完整四场景再次通过。

原生报告 `.runtime/windows-shutdown/60ec417e-ad44-458a-ae4e-792acec7b0ec/report.json` 保存二进制 SHA-256：Server `819f49e476669bec04fb320c1b341d3ab162b027afc26daacbaef7ff6fb51094`，Worker `4c240538441cf35b4faea6e588e28daaffbd14cab82cbc5a463acb8506f5f5b3`。Linux Server 的 SIGTERM/SIGINT 同样通过，约 11.045/11.130 秒退出，探测后代、房间连接和实例锁检查通过，报告 `.runtime/server-shutdown/rainsync-shutdown-935a8bfc/report.json`。本轮 Linux 镜像为 `sha256:cfb883a75c781cfa13945c2cf1992eebcbb653d5514be9794175dca8b50b0a64`。

同一 Linux 镜像的完整 Worker 故障矩阵通过，报告 `.runtime/worker-processes/rainsync-process-6de6422a/report.json`：SIGTERM、并发探测/字幕排空、真实编码进程树、缓存权限与 ENOSPC、首段解码、逐段/最终 HTTP 解码、读租约、预算、数据库中断及旧 Worker 换代恢复均通过。完整隔离集成通过，含 NAS 万条索引与备份恢复；100 控制连接快照 359ms 仅为本机冒烟。cgraphy 差异审查未及时返回，改用 Git diff 审查。没有前端变化，未重复浏览器测试；未部署。关闭控制台、注销/关机、Server 实例锁失联立即退出及强杀路径仍未完成验收，不能用 Ctrl+C/Break 的证据代替。

## 2026-09-27：Server 正常信号退出与探测回收

Server 接入 SIGTERM/SIGINT、有界 HTTP 等待和共享媒体进程排空。Windows 工作区 44 项测试通过，2 个子进程夹具入口按设计 ignored；Clippy 全目标且 warnings 视为错误、格式、二进制/示例构建及生成契约一致性通过。Linux 运行时镜像使用同一锁定依赖及离线构建方式完成构建，没有修改部署文件。

`SERVER_TEST_IMAGE=rainsync-server-shutdown-validation:local node tests/server-shutdown.mjs` 在隔离 PostgreSQL 与真实 Server 容器通过。测试保留已加入房间的 WebSocket，并用 ffprobe 包装进程及 sleep 后代卡住本地扫描；SIGTERM/SIGINT 分别在 11.108/11.076 秒后正常退出。两次都确认后代消失、观看连接关闭、容器仍运行，以及实例锁在退出等待期间不可取得、进程退出后可取得。第二次启动同时验证前一实例已释放锁。此测试没有把容器销毁当作子进程回收，也不声称 WebSocket 收到了关闭帧。

完整 `node tests/integration.mjs` 通过，包含鉴权/房间、播放幂等恢复、控制权限、远程探测/字幕、NAS 万条索引、读租约/旧目录清理及备份恢复；100 控制连接快照 330ms 仅为本机冒烟。Worker 运行时代码未改，本轮未重复其完整 FFmpeg 故障矩阵。cgraphy 差异审查未及时返回，提交审查使用 Git diff。

报告 `.runtime/server-shutdown/rainsync-shutdown-3870ca1a/report.json`，镜像 `sha256:7f6c487f70ced5ecc6290c03fd728df767b0ad13dc4608503821a58d9d4bf4d5`。Windows 真实控制台/系统退出事件、Server 实例锁连接失联的立即退出路径及强杀进程不在此证据范围。没有前端变化，未重复浏览器测试；未部署，完整计划继续进行。

## 2026-09-27：Worker runtime 退出前排空媒体进程

新增进程登记表，将关闭启动入口与登记新进程串行化；关闭等待覆盖仍持有句柄与已 Drop 的所有者。Windows 工作区 44 项测试通过，Linux release 的 media-core 12 项及 Worker 15 项通过；各平台另有 2 个用于主动启动的 ignored 子进程夹具入口。新增测试确认取消关闭等待不会重新开放入口，重复关闭等待仍能确认全部后代退出。Clippy 全目标且 warnings 视为错误、格式、工作区二进制/示例构建及生成契约一致性通过。

完整隔离 PostgreSQL 集成通过，100 控制连接快照 274ms 仅是本机冒烟。首次 Worker 矩阵通过并发探测/字幕退出检查，但最后旧目录回收在 15 秒门槛超时；此门槛未覆盖产品已有的 60 秒删除重试间隔。测试改为等待 75 秒并保留失败时数据库清理状态，不强制推进 cleanup_after，也不改变产品清理逻辑。关闭等待的原生用例另改为明确 poll 到 Pending 后取消，避免依赖 1ms 超时；Windows/Linux 对应用例重新通过。

同一运行时代码镜像 `sha256:53559aea9e7c47d039750e99df9b5f07b8bde6d64f9daa05a7f1db97c0786c21` 完整重跑通过，报告 `.runtime/worker-processes/rainsync-process-65a83e61/report.json`。探测与字幕同时卡住时发送 SIGTERM，11.267 秒后 Worker 正常退出，容器继续运行，四个包装/后代进程均已消失；不是靠两次 30 秒执行截止或容器销毁回收。旧 Worker 恢复后 FFmpeg 退出、旧目录回收，attempt 2 正常运行且 init 摘要未变。首段解码、进程树、输出上限、缓存权限、ENOSPC、读租约、预算、逐段及完整 HTTP 解码与数据库中断回归全部通过。运行命令为设置 `WORKER_TEST_IMAGE=rainsync-drain-validation:local` 后执行 `node tests/worker-processes.mjs`。

本轮 cgraphy 差异审查未在等待期间返回，改用 Git diff 审查。没有网页改动，未重跑前端或浏览器测试；未部署。Server 退出排空、Windows 系统退出事件、强杀 Worker 与内核不可中断 I/O 等不能由本轮证据覆盖，完整计划继续进行。

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
