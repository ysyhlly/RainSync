# 运维与验收

## 启动与诊断

`docker compose up --build -d` 后检查 `docker compose ps` 和 `docker compose logs server worker`。数据库只暴露给 Compose 网络。

管理员登录后可读取 `/api/v1/metrics`，包含稳态同步误差直方图、缓冲样本计数、房间数量和转码排队数量。统计来自客户端采样，不能替代画面级同步测试。

前端缓冲样本与稳态误差分别计数；报告 p95 时同时报告缓冲比例。通过配置 `CACHE_MAX_BYTES` 调整缓存，默认 20GiB；Worker 在创建和运行任务期间检查缓存与 10% 磁盘余量。

空间不足时只淘汰非活跃会话缓存；仍不足则任务失败，当前不自动排队重试或降低媒体质量。应先扩容或释放可回收空间，再重新创建播放操作。

登录限速为每个用户名 60 秒最多 10 次尝试，PostgreSQL 保存用户名摘要及计数，重启不清零；最多保留 1000 个活动摘要，过期项按请求及后台周期清理。它不替代部署入口的按来源流量治理。WebSocket 保留每连接固定秒窗口 30 条消息的限制，边界可突发。

邀请链接可复用，24 小时过期或由控制者撤销，房间最多 10 位成员；当前不支持 max_uses。路径安全检查要求根目录与目标媒体已经存在，Windows/Linux 都会拒绝不存在路径，不应绕过 canonicalize 检查。

## 旧 NAS 记录与房间关闭升级门槛

0029 保留未知旧资源；0030 用数据库分配的不可变房间出生序号和旧传输范围上限，只排除可证明晚于该旧传输的新房间，不补造释放回执。迁移前全部既有房间仍在迁移前旧 NAS 行的可能范围内，可能长期 closing。晚到旧 Worker 写入会捕获当时范围，可能涵盖此前新建房间；升级须先停止并排空旧 Server/Worker/Agent，再迁移并启动配套版本，不支持旧写入在最终关闭检查后继续出现。

必须将完整 Agent 身份映射到所有主机/容器及服务管理器，禁止旧签发和自动重启、保存冻结的 legacy ID 集合，再取得整个进程树的 supervisor 正向退出或可验证主机启动代次证据。新心跳、状态、租约过期和 PID 不存在都不足够；迁移前 24 小时历史清理可能已删行，空查询也不是旧资源释放证明。当前没有真实生产部署完成此核验的记录。

遇到 `legacy_agent_drain_unconfirmed`，保全数据库、服务版本、房间和 transfer ID；授权只读检查 `rooms.cleanup_birth_ordinal` 与 `agent_transfer_runs.possible_room_cutoff`，同时保留不可变执行/上游身份和日志。不要仅凭时间戳或无 session 关联判定无关，不要删除旧行、改计数器/范围、手填 ACK/reaped 或直接改 closed。当前没有人工对账写入或 force-close；普通 ACK 和保留期也不能解除旧记录门槛。范围外房间仍须完成自身全部资源释放证明。详见 [无损诊断清单](PHASE2_LIFECYCLE_NEGOTIATION.md#2-升级门槛与无损诊断) 与 [清理协议](ROOM_CLEANUP.md)。

## 备份

停止媒体写入窗口内进行数据库备份；示例使用容器内部文件，避免 Windows shell 二进制重定向差异：

```sh
docker compose exec db pg_dump -U rainsync -Fc -f /tmp/rainsync.dump rainsync
docker compose cp db:/tmp/rainsync.dump ./rainsync.dump
```

同时备份 `.env` 中的加密密钥及 Agent 凭据卷。将备份保存到独立存储。恢复前先在新的 Compose project 中演练，禁止直接覆盖唯一数据库。媒体缓存可以重建，源媒体须独立备份。

数据库包含用户信息、媒体元数据和本地文件路径；media_jobs.spec 的 root/resource 并非加密字段。只有部分凭据和票据字段被加密，因此数据库、转储和管理连接必须按敏感运维数据管理，不能作为公开诊断附件。站点密钥应与转储分别控制访问权限。

## 发布前尚需执行的真实环境验收

1. 使用固定版本 Jellyfin 和 Emby，验证服务专用账户、列表分页、播放协商和服务端会话回收。
2. Chrome、Firefox、Android Chrome、iOS Safari 实机验证直放、HLS、自动播放和休眠恢复。
3. Linux `tc netem` 限制 RTT 300ms、抖动 100ms、丢包 2%；媒体带宽足够与不足分别测试。
4. 100 个控制连接与真实媒体吞吐分开测量，记录机器规格与转码并发。
5. 72 小时记录进程 RSS、FFmpeg 子进程、任务租约、缓存和磁盘余量。
6. 杀死 Worker、Agent、数据库和 Server 后恢复，验证截断错误、任务回收和房间暂停。
7. 备份恢复、旧版本升级及清空缓存重建。

这些项目没有运行报告时，不得将 100 在线、p95 或 72 小时稳定性描述为已经达标。


## 远程媒体处理

Compose 中 Server 使用内部 `WORKER_URL=http://worker:8081` 探测 HTTP/NAS 片源。原生分进程部署需设置该变量；默认是 `http://127.0.0.1:8081`。Worker 同时最多运行两个 ffprobe，探测超时 30 秒；失败返回 `source_probe_failed`，临时播放授权随即停止。

FFmpeg 通过 Worker 自身地址读取原片：WORKER_BIND 为通配地址时使用同族回环地址，为具体 IP 时使用该 IP 和端口。上游请求头继续由 Worker 注入，不进入播放方案或任务明文。自动模式优先直放 H.264 8-bit/AAC MP4 或兼容 HLS，容器或音频不兼容时转封装/转换音频，其他普通视频编码转 H.264/AAC。HDR 自动模式明确拒绝；这仍不是完整的设备解码能力协商。

开发 Dockerfile 的 FFmpeg 尚未固定包版本。正式发布前必须固定基础镜像 digest、APT 快照和包版本并重跑媒体矩阵；一次基线采集不能替代可复现构建。Caddy 现提供基础 CSP，同源脚本/连接及 blob 媒体/Worker；保留内联样式兼容 Vue。真实 Safari/HLS 与外部来源扩展仍需专项验证。逐项审查结论见 [F-01 至 F-14](REVIEW_FINDINGS.md)。

Agent 默认将数据连接指向 `SERVER_URL` 的同一入口，Caddy 必须同时代理 `/api/v1/agents/ws` 和 `/agent-data/*`。如控制与数据部署在不同入口，可在 Agent 设置 `AGENT_DATA_ORIGIN`，其值为可达的 HTTP(S) 基址。Agent 不需要开放入站端口。

`node tests/remote-playback.mjs` 使用本机 Compose、20 秒演示文件和 Docker FFmpeg，创建临时源站及 NAS 容器，验证远程自动选择、转封装、转码、非零时间起点和会话撤销。测试源配置与验证房间会保留；临时容器在结束时移除，设备凭据撤销。勿在正式用户正在使用的实例执行验收脚本。


## NAS Agent 升级与 0019 迁移

`0019_agent_source_versions.sql` 保留已有 NAS 媒体及其 ID，但旧行的 `source_version` 为 `NULL`。服务器不能从路径、旧探测信息或文件名推断文件版本；在完整的新版 Agent 索引提交前，播放会返回 HTTP 409 / `SOURCE_VERSION_REQUIRED`，不会授予无版本的播放或 relay 权限。不要通过 SQL 填入虚构版本或绕过该检查。

升级步骤：

1. 按上面的备份流程保存数据库、站点密钥和 Agent 凭据。升级 Server、Worker 和 NAS Agent，保留原有 Agent 凭据及媒体目录。
2. 启动或重新连接新版 NAS Agent。Agent 每次连接会自动提交完整索引；已连接的新版 Agent 也可通过管理员“扫描所有片源”或 `POST /api/v1/agents/{id}/scan` 重新扫描。
3. 管理员读取 `GET /api/v1/agents`，确认该设备 `source_version_status=ready` 且 `unversioned_count=0`。`connected` 只表示本 Server 的活动控制连接，`ready` 只表示已有索引均具有版本，两者不能互相替代。`empty` 表示没有可用索引，不能证明成功找到媒体。
4. `rescan_required` 表示尚有旧的无版本索引，需要新版 Agent 完整扫描；若运行的仍是旧 Agent，先升级。`upgrade_required` 表示本次连接已提交缺少版本的旧格式索引。扫描接口也会返回 `status=upgrade_required` 及 `unversioned_count`，不能将它作为播放恢复成功。`unsupported` 表示不支持手动扫描，需升级并重新连接；`offline` 表示先恢复设备连接。
5. 扫描完成后重新发起播放。之前以 `SOURCE_VERSION_REQUIRED` 失败的幂等请求编号不会自动变成新授权，须使用新的播放操作。相同媒体 ID、播放列表引用和用户改名保留；首次补充版本或文件版本变化会清除旧探测元数据。

`source_versions` 是当前连接的能力线索（`null` 表示未知），不是授权依据。能力声明、未完成的分页索引、断线回滚都不会解除旧行的版本限制。文件变化后原播放授权仍返回 `SOURCE_CHANGED`；重新扫描并发起新播放后才能读取新版本。

隔离回归：先 `cargo build --workspace --bins --examples --locked`，设置外部 `RAINSYNC_ARTIFACT_DIR` 后运行 `node tests/nas-upgrade.mjs`。脚本从真实 0001–0018 迁移及旧 NAS 数据启动，再由最新 Server 应用后续迁移，覆盖旧 Agent 缺版本、分页中断、新版真实 Agent 完整扫描、完整/Range/HEAD relay，以及同大小文件变化后的拒绝与重扫恢复。仅操作脚本创建的临时数据库、文件和进程，需要 FFmpeg 与已构建的三个 Rust 二进制。默认使用 Docker 创建 PostgreSQL；也可设置 `RAINSYNC_NATIVE_POSTGRES_BIN` 指向 PostgreSQL 可执行目录，使用隔离的本地临时集群。


## Jellyfin 隔离兼容测试

测试镜像固定为 `jellyfin/jellyfin:10.11.0`，已获取摘要 `sha256:59417f441213e236a9f907d4e71a13472042409d85f9e9310dbdd87ee33d7bd4`。隔离容器名 `rainsync-jellyfin-verification`，仅将管理端口映射到 `127.0.0.1:18096`，加入 `rainsync_default` 网络，并只读挂载演示媒体目录。

`node tests/jellyfin-setup.mjs` 仅用于这个全新测试实例，配置向导和专用随机密码保存在被忽略的 `.runtime/jellyfin-fixture.json`。不要把它指向个人生产 Jellyfin。`node tests/jellyfin-playback.mjs` 验证 RainSync 的真实索引、播放方案和 FFmpeg 解码，创建独立验证房间和片源。测试容器需要保留到兼容性调试结束；移除后需重新配对测试凭据和片源。
