# 运维与验收

## 启动与诊断

`docker compose up --build -d` 后检查 `docker compose ps` 和 `docker compose logs server worker`。数据库只暴露给 Compose 网络。

管理员登录后可读取 `/api/v1/metrics`，包含稳态同步误差直方图、缓冲样本计数、房间数量和转码排队数量。统计来自客户端采样，不能替代画面级同步测试。

前端缓冲样本与稳态误差分别计数；报告 p95 时同时报告缓冲比例。通过配置 `CACHE_MAX_BYTES` 调整缓存，默认 20GiB；Worker 在创建和运行任务期间检查缓存与 10% 磁盘余量。

空间不足时只淘汰非活跃会话缓存；仍不足则任务失败，当前不自动排队重试或降低媒体质量。应先扩容或释放可回收空间，再重新创建播放操作。

登录限速为每个用户名 60 秒最多 10 次尝试，PostgreSQL 保存用户名摘要及计数，重启不清零；最多保留 1000 个活动摘要，过期项按请求及后台周期清理。它不替代部署入口的按来源流量治理。WebSocket 保留每连接固定秒窗口 30 条消息的限制，边界可突发。

邀请链接可复用，24 小时过期或由控制者撤销，房间最多 10 位成员；当前不支持 max_uses。路径安全检查要求根目录与目标媒体已经存在，Windows/Linux 都会拒绝不存在路径，不应绕过 canonicalize 检查。

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


## Jellyfin 隔离兼容测试

测试镜像固定为 `jellyfin/jellyfin:10.11.0`，已获取摘要 `sha256:59417f441213e236a9f907d4e71a13472042409d85f9e9310dbdd87ee33d7bd4`。隔离容器名 `rainsync-jellyfin-verification`，仅将管理端口映射到 `127.0.0.1:18096`，加入 `rainsync_default` 网络，并只读挂载演示媒体目录。

`node tests/jellyfin-setup.mjs` 仅用于这个全新测试实例，配置向导和专用随机密码保存在被忽略的 `.runtime/jellyfin-fixture.json`。不要把它指向个人生产 Jellyfin。`node tests/jellyfin-playback.mjs` 验证 RainSync 的真实索引、播放方案和 FFmpeg 解码，创建独立验证房间和片源。测试容器需要保留到兼容性调试结束；移除后需重新配对测试凭据和片源。
