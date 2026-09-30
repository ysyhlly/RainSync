# F：指标、验收与发布准备交付

日期：2026-09-30（Asia/Shanghai）。本路分支 `codex/f-release-evidence-v01`，基线为总控 `integration/v0.1-next` 的精确提交 `252100dee29cf4d13df00cbda55f0fa4814deb25`，已完整读取 `docs/PARALLEL_CONTRACT_V01.md`。旧分支 `codex/f-release-evidence` / `a8ec001` 保留为历史，本路改动从新基线独立重放并重新验证。本路没有推送、合并、部署或启动正式长测；历史通过数和总控的104 Rust/122前端没有搬入本路结论。**这是独立准备工具与隔离验证交付，不是发布就绪声明。**

## 1. 已有实现与本路改动

已有 `apps/server/src/metrics.rs` 保留缓冲样本计数、同步误差 histogram、控制连接/Actor/队列、数据库池及排队任务指标。缓冲样本比例不能当成时长占比。Server 与 Worker 的 `/health` 仍只是固定 liveness。已有 `tests/control-load.mjs`、`tests/nas-soak.mjs`、源码冻结/镜像/二进制绑定、隔离 PostgreSQL 夹具及旧升级/回滚测试继续使用。

| 文件                                                                                                   | 独立交付内容                                                                                                                      | 集成边界                                                                                              |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/server/src/health.rs`                                                                            | Server/Worker readiness 的纯判定器；缺失、未知、过期、未来检查时间、失去所有权、排空、磁盘失败均不能 ready；返回 200/503 状态建议 | 尚未接线，也没有执行 DB/锁/磁盘/FFmpeg 探针；当前 HTTP `/ready` 不存在                                |
| `scripts/acceptance-measurements.mjs`                                                                  | 首帧、连续播放窗口、有效吞吐、控制/媒体重连、原片坐标同步误差的离线统一聚合                                                       | 不新增共享协议，不改变播放器/生产 telemetry；埋点由各负责人和总控批准后接入                           |
| `scripts/release-evidence.mjs`                                                                         | 工具/资源盘点、冻结源码与实际样本 hash 验证、正式验收计划、候选绑定的持续控制/NAS证据门禁                                         | 默认为 prepare-only；不启动工作负载、不配置 host 网络、不部署；弱网/72h/设备/旧库要求负责人审查       |
| `deploy/postgres-recovery.mjs`                                                                         | 只读迁移清单/SQLx SHA-384 预检；AES-256-GCM 流式加密 pg_dump；验证完整密文后只新建随机空库恢复；迁移清单往返校验                  | 仅 loopback 隔离库；不执行迁移/down、DROP、--clean 或覆盖已有库；不备份公开源密钥；不代表应用完整灾备 |
| `tests/*-measurements.test.mjs`、`tests/postgres-recovery.test.mjs`、`tests/release-evidence.test.mjs` | 无网络纯聚合/门禁回归和真实隔离 PostgreSQL 合成数据演练                                                                           | 模拟口径及合成 schema 不计真实产品/旧库/设备验收                                                      |

未修改协议、迁移、`main.rs`/`lib.rs`、依赖锁、CI、总台账，也未修改其他路业务文件。

## 2. 总控接口需求（待统一契约）

1. **Server 入口接线：** 总控在 `apps/server/src/main.rs` 声明独立 `health` 模块及 `/ready`；数据库探针需有界（建议 1 秒、独立探针周期，HTTP 不等待无界 SQL），实例所有权由真实实例锁 owner 提供。`SELECT 1` 成功不能代表实例锁仍有效。排空即时设置 `AcceptingWork=Failed`。HTTP 输出只含低基数 check 名称和状态，不含 DB URI、路径或凭据。
2. **Worker 信号：** D/总控提供 `Database`、`InstanceOwnership`、`AcceptingWork`、`WritableCache`、`Ffmpeg`、`ClaimLoop` 的正向新鲜证据，全部使用 `Instant`。成功的空队列领取轮询也算健康；上一次任务完成时间不能替代领取循环健康。`max_age` 当前由调用方提供（建议起点 10 秒）；长时间陈旧不能保持 ready。F 不改 Worker 主入口或进程模块。
3. **跨模块埋点：** A 提供确认播放/准备/装载/首呈现/前后台及播放意图时间轴，D 提供各层已交付字节和传输窗口，E 提供测试器确认网络恢复到应用全状态快照的时间；原片坐标/倍速/seek/buffering 与独立时钟校准由 A/E/测试器配合。当前离线 schema 只是 F 专用证据接口，不是已获批准的公共 wire 类型。
4. **迁移与升级：** 总控固定最终迁移集合及受支持的旧版本组合，拥有应用迁移及共享入口接线。新基线包含0031计划代次高水位，预检扫描总控冻结的全部1–31文件，保留旧1–30不可改写。预检拒绝已安装未知版本/改写校验和，不能替旧二进制认领新迁移，也不能证明任意旧库兼容。真实旧库、正确/错误 source key、账号登录、Agent 重连、浏览/播放/seek/stop、回退组合均待独立演练。
5. **SIGKILL 与旧资源证明：** D 当前 owner/subreaper 与 Worker 同进程，SIGKILL 会同时消灭 owner；普通 TERM/STOP/DB 回归和 PDEATHSIG 不证明孙进程已排空。外部 supervisor/cgroup、启动代次与正向资源释放证明需总控契约。本工具不补造 ACK、不删旧历史、不 force-close，旧 NAS 范围中的 unknown 仍阻断升级关闭。

## 3. 统一测量口径

| 指标     | 定义与缺失处理                                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首帧     | 用户确认播放到第一个可呈现视频帧；包括排队/探测/准备。优先 frame callback，备用必须同时观察 playing 与时间推进；loadedmetadata 不合格。阶段不完整时只报总时长，不虚填阶段。                                                                                                  |
| 卡顿     | 首帧后、前台、期望播放窗口中的 rebuffer 时长 / 完整期望播放时长；startup、autoplay-blocked、background 单列。seek 时长单列并留在期望播放分母；同步稳态排除 seek。区间必须连续，不能省掉失败窗口；无分母返回 null。                                                           |
| 有效吞吐 | 每层成功交付媒体字节 / 所有该层传输活跃墙钟区间的并集时长；失败字节单列但失败传输时间保留分母。并发不能重复累加时间，NAS/Worker/上游不能互相累加字节。                                                                                                                       |
| 重连     | 测试器确认网络恢复到应用有效全状态快照；媒体追赶独立计时，无媒体证明返回 null。                                                                                                                                                                                              |
| 同步误差 | 用独立校准的单调时钟/参考偏移，把原片位置与倍速投影到同一参考时刻；不能先后读 currentTime 直接相减。默认样本 age ≤1s、单端时钟不确定度 ≤50ms；陈旧/后台停播/seek/buffering 排除且计有效覆盖率。按房间报 peer p50/p95/p99/max、authority 误差和时钟不确定度；不平均房间 p95。 |

离线聚合不自动证明独立校准链正确；真实样本仍需可见时间码和真实设备核对。生产 Prometheus 标签继续限制来源/模式/错误/阶段等低基数维度，room/session/媒体标题留受控原始证据，不新增时序标签。

## 4. 实际环境条件与定向验证

本路实际确认：Linux x86_64、5 可用 CPU、约 33 GiB 总内存；运行初期约24 GiB可写磁盘只是早期快照，2026-09-30 21:51:39（Asia/Shanghai）再次采样剩余约8.4 GiB（9,062,903,808字节），共享负载会持续变化，不能视作正式长测容量或租期保证。Node 24.19.0、FFmpeg 7.1.5、PostgreSQL 17.11、Chromium 151.0.7922.173、Docker 28.4.0/vfs 本地 daemon 可用。Playwright 用系统 Chromium 真实启动并读回独立空白页 DOM 成功；直接 Chromium `--dump-dom` 首次未完成，已仅终止本路进程，不能写成该命令通过。此检查不代表 RainSync 播放器测试。

实际通过本地 daemon 拉取 `postgres:17.11-bookworm`，registry digest `sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652`。TLS、分层校验和与现有代理信任保持开启；这里只证明该 registry 路径，不替 Jellyfin/Emby 产品验收。环境配置工具虽返回 desired unrestricted，network state 仍 unknown，所以没有用配置状态代替实际访问证明。

| 本路检查                | 结果                                     | 证据/边界                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| readiness 独立 Rust     | 5 passed，0 ignored                      | `rustc --test`，不依赖未获批准主入口接线                                                                                                                                                                   |
| 统一测量＋候选/持续门禁 | 14 passed                                | 含改动源码/链接/样本篡改、短测/历史/拼接、103.2 分钟、100用户与72h计时误认拒绝；保持image ID时篡改/缺失production manifest及三二进制hash均拒绝                                                             |
| 恢复工具                | 5 passed，0 skipped（设置 native PG 后） | 真实独立 PostgreSQL 合成2行/1条合成迁移＋流式3MiB加密、错误密钥/篡改、未知迁移/错误 checksum、源库不变及临时明文删除；另以当前完整1–31 SQL在全新空库创建schema，加密恢复并核对31项SHA384；不是用户真实旧库 |
| 产品正式门槛            | 未执行                                   | 无最终总控冻结候选；不借用旧 setup/旧分支通过数                                                                                                                                                            |

新基线产物根目录：`/workspace/RainSync-lane-artifacts/f/v01/`，旧基线产物保留在上级目录，不当作新通过。首轮解密失败路径存在 descriptor 双重关闭，测试发现后已改为显式 FileHandle 所有权，成功重跑；保留首轮失败 report。父任务只读复核还发现门禁没有比较production/binary字段，已完整补验并新增全部变异拒绝回归。最终日志、文件摘要与精确退出码见新目录 `final-verification.json`；工具/样本/计划短演练属于 `f-preparation-v01-reviewed-smoke`，不是总控正式冻结候选。集中集成须取完整 `252100..codex/f-release-evidence-v01` 提交序列，不能只取末提交；完整SHA在交付消息和 `git log --reverse` 中列出。

## 5. 可复现入口

```bash
source /workspace/.rainsync-cloud/env.sh
export RAINSYNC_ARTIFACT_DIR=/workspace/RainSync-lane-artifacts/f/v01
export RAINSYNC_NATIVE_POSTGRES_BIN=/workspace/.rainsync-cloud/postgres/usr/lib/postgresql/17/bin
export CARGO_TARGET_DIR="$RAINSYNC_ARTIFACT_DIR/cargo-target"
export CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
node --test tests/acceptance-measurements.test.mjs tests/release-evidence.test.mjs tests/postgres-recovery.test.mjs
rustc --edition 2021 -D warnings --test apps/server/src/health.rs -o "$RAINSYNC_ARTIFACT_DIR/readiness-tests"
"$RAINSYNC_ARTIFACT_DIR/readiness-tests"
node scripts/release-evidence.mjs inventory --output=<新的产物目录>
node scripts/release-evidence.mjs plan --candidate=<candidate.json> --environment=<inventory.json> --samples=<samples.json> --output=<新的计划目录>
```

`plan` 实际校验冻结 source/锁文件与样本文件 hash，支持既有候选 schema 1 的 source-frozen/built；source-frozen 不冒充 image built。样本清单使用 F 专用格式：`schema_version:1, files:[{path,bytes,sha256,authorization:"self-owned"|"licensed"}]`，path 相对清单目录，授权由样本负责人确认。计划所有 gate 初始 `not-run`，候选批准/镜像实核/持续资源租期初始 false。

备份/恢复只从环境读取连接和独立 backup key 文件：

```bash
# DATABASE_URL 必须由隔离环境安全提供；不在命令参数或日志填密钥。
# RAINSYNC_BACKUP_KEY_FILE 指向单独保管的32字节二进制key，Unix权限0600。
node deploy/postgres-recovery.mjs preflight --migrations=<总控冻结的迁移目录>
node deploy/postgres-recovery.mjs backup --output=<新的备份目录>
# 恢复时 DATABASE_URL 指向同一隔离实例的 postgres 或 template1。
node deploy/postgres-recovery.mjs restore --backup=<备份目录> --output=<新的演练目录>
```

备份是 custom pg_dump 的 AES-256-GCM 密文；完整 header/payload/tag 经认证后才 createdb。恢复库为随机 `rainsync_restore_*`，失败新库保留供诊断，不会删除其他库。源配置密钥、部署配置和 Agent 凭据需要另外安全保管，本工具仅在清单列缺失材料，不生成/打印/复制它们。备份过程中若迁移版本/校验和变化则拒绝签发正常备份清单；迁移应由总控暂停。角色/ACL不包含，独立恢复使用该隔离实例既有角色；生产角色及权限重建仍需单独审查。

## 6. 未验收矩阵与后续顺序

| 门槛               | 准备情况                                                                                                                                   | 未验收条件                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 持续100在线        | 复用 frozen source 的 control-load；10×10、50×2 各 ≥3600s；ACK p95≤300ms、合法命令0丢失、完整状态/持久化恢复                               | 总控批准最终候选/实际镜像、100独立账号和持续资源；不是100路视频容量                                              |
| NAS两小时          | 复用 nas-soak ≥7200s；连续真实呈现比例≥95%、资源趋势和自有资源清理证明                                                                     | D最终候选冻结、真实样本/链路；旧103.2分钟失败不拼接，不降低分母                                                  |
| 弱网               | N1-N6矩阵已列；每场景稳定30min且至少3次；真实测RTT/抖动/带宽/丢包，正常peer p95≤300ms、弱网≤800ms，10s断网后5s控制恢复                     | 独立测试netns/真实网络施加器和双客户端测试协调尚缺；不可 host-wide tc，不能用TCP字节损坏模拟2%包丢失并记真实验收 |
| 72小时             | 最终镜像/source/sample/environment绑定、连续259200s和同负载phase RSS/FD/socket/process/cache趋势；循环/seek/join/leave/cache/fault矩阵已列 | 完整工作负载协调runner、稳定租期、SIGKILL正向所有者证明契约尚缺；计时器/短测/版本拼接不能通过                    |
| 移动/arm64         | 必须记录实机OS/浏览器/硬件、实际制品、样本和运行记录                                                                                       | Android Chrome、iOS Safari、桌面Safari、arm64未提供，桌面viewport模拟不能替代                                    |
| 真实旧库/灾备/回退 | 只读迁移checksum预检、加密备份、新空库恢复已可运行                                                                                         | 任意用户真实旧库、正确/错误source key、应用链、受支持旧NAS对账与旧二进制回退组合未验收                           |
| `/ready`与生产埋点 | 纯判定器/统一口径已交付                                                                                                                    | 共享main与D/A/E等owner信号接线待总控批准；当前接口不可宣称发布可用                                               |

总控先确认共享契约并集中集成，再冻结最终源码/制品/样本/环境。各负责人准备的短测和本路工具回归只作独立证据；正式长测从冻结候选的零起点重新开始。任一资源生命周期修复后，重新开始受影响长测。
