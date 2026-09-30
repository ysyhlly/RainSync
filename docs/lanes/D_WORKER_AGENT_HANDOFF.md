# D 路：Worker / Agent 可靠性交付

当前基线：`integration/v0.1-next = 252100dee29cf4d13df00cbda55f0fa4814deb25`；交付分支 `codex/d-worker-agent-v01`；隔离工作区 `/workspace/RainSync-lanes/d-worker-agent`。已完整阅读 `docs/PARALLEL_CONTRACT_V01.md`。原 `5ce1c849` 基线分支 `codex/d-worker-agent` / `20035d3085a3a7b74b4398e15c440444260e2bc6` 保留，在精确新基线上无冲突 cherry-pick 为 `14278b6eeb0c1234bc9e23b9d64b46e2c563c1b0`，另有本次预览队列修补提交。未推送、合并、部署，也未操作用户数据库或媒体盘。本交付不关闭 W05 / W07。

## 独立实现

`apps/media-worker/src/transfer_state.rs` 修复 NAS relay 续租把一次三秒数据库未知直接当成失租的问题。每次续租先在持久行锁后确认未终结、租约未过期，再获取数据库剩余租期；本地单调截止扣除完整请求 / commit 耗时。未知结果只在上次已确认截止内每秒重试；明确失租、到达截止和截止后的迟到回复均终止流。HTTP 取消与执行授权结束可以打断挂起查询。初始 offer 的执行租约使用数据库 `clock_timestamp()`，不能借事务起点或慢回复增加执行时间。

保留现有十秒正常续租、三秒查询截止、三十秒数据库租期，以及所有 attempt / 发布 / 缓存 / 源版本 / drain 不变量。逻辑失租没有改写物理释放证明；已分发传输仍须真实 Agent 的认证 drain 回执。未改入口、协议、迁移、锁文件、CI、总台账、C 路交付模块或 Agent 主入口。

`crates/persistence/src/media_previews.rs` 与 `apps/media-worker/src/previews.rs` 修复独立复现的竞态：预览 POST 先排队，Agent 扫描随后推进 `preview_generation`，旧 queued 请求无法领取。`claim_with_limit` 与 enqueue / finish 共用容量事务锁，接收 Worker 实际 queue_limit，每轮至多恢复一个有效且 source generation 已变化的 queued / 已失租 running 请求，绑定当前源代次、新 UUID 和三次预算。有效 running 旧 owner 不重领；同代次三次耗尽不因轮询复活；迟到 owner / attempt 拒绝续租与提交；容量满时保留旧请求等待空位。**自动恢复仅覆盖 source_generation 变化，没有宣称 recipe / TTL 单独过期自动恢复。**

没有写入或补造 `media_executions` / `agent_transfer_runs` 释放字段。新 example 的表计数只证明未增行，完整未写 drain 字段还依据生产 diff 静态复核；逻辑到期、新 attempt 或恢复 ready 均不能证明旧资源排空。

预计文件及接口已在实现前交总控，后续独立队列修改得到总控授权。实际生产修改仅上述三个独立模块。新增独立入口为 `tests/worker-reliability.mjs`、`tests/relay-lease-health.mjs`、`tests/preview-queue-recovery.mjs` 和 `crates/persistence/examples/verify_preview_recovery.rs`；另有本交付说明。

## 新基线短故障矩阵与证据绑定

使用 Linux 原生 PostgreSQL 17、真实三服务 dev 二进制、FFmpeg、真实隔离 Agent / 本地 NAS 文件及随机端口。完整修补后汇总 `/workspace/RainSync-lane-artifacts/d-v01-after-recovery/new-baseline-binding.json` 的 8 项均退出 0，输入摘要 `7039dd8ed802ce36b75cbebcad2f14de76b7a1935f80296c36d99f218d6bf36d`。随后仅在预览测试末尾加入 example 二进制 SHA 复核，生产源码与其余既有输入逐项确认未变；补跑汇总 `/workspace/RainSync-lane-artifacts/d-v01-final-checks/new-baseline-binding.json` 的 4 项均退出 0，输入摘要 `caa0baa47f3179e8f94a07a5d51bc66b51002674be869ca7d8755b9a56f05d1f`。两轮保留各自实际测试源码，不把后一摘要套到前一轮。

以下路径除另列外相对 `/workspace/RainSync-lane-artifacts/d-v01-after-recovery/`：

| 矩阵 | 检查与边界 | 新基线结果 / 证据 |
| --- | --- | --- |
| Relay 数据库短故障 | 行锁跨截止后恢复；持续未知到确认截止；确认终态停止；行锁中 HTTP 取消 / 执行授权结束；迟到回复不复活；过期不补 drain | `worker-reliability/d_reliability_301bfe56a6124380820fdc88944c9e94/report.json`，6 场景通过，入口退出 0 |
| 真实 NAS relay | 暂停 HTTP 正文持有真实 Agent 句柄；14.5 秒行锁后同 transfer 恢复；撤权释放句柄，认证回执先于 closed | `relay-lease-health/9a279e56-e7b7-4e08-9a9d-28ed0f6c57c3/report.json`，2 场景通过，入口退出 0 |
| Agent drain / 索引重连 | 认证、背压、关闭、延迟 ACK / Server 重启、控制失联、4096 回执；source version、逐文件不可用、INDEX_ABORT 与完整扫描恢复 | `agent-drain-receipts.stdout` 6 场景、`agent-index-port.stdout` 4 组，均退出 0 |
| 队列 / 缓存 / Worker | 7 个既有 PG persistence examples、attempt fencing、缓存预算 / 读租约、发布及清理；Worker 单元 | 同 worker-reliability 报告逐项退出 0；36 passed，1 ignored 辅助子进程，2 个真实 PG 测试 filtered，不算普通单元通过 |
| 总控 v0.1 契约 | viewer high-water / 并发 / 1024 cap / legacy / 重启 / close-reopen / drain 区分；实际旧 schema 1–30 → 31 | `playback-plan-generations/764e4ced-7db9-4b35-8ede-5746bce79599/report.json` 14 组、`playback-plan-migration/f90f6542-b6e8-4c46-ae3b-62d28f45b40f/report.json` 19 项，均退出 0 |
| 换源预览 / 新队列 | POST 后真实文件替换、Agent 重启推进源版本；无第二 POST 解码蓝色新图；live / expired / old / foreign owner、三次预算、limit=1 并发 claim / enqueue、不可用源、无新增释放行 | 最终 `/workspace/RainSync-lane-artifacts/d-v01-final-checks/preview-queue-recovery/82d4209d-e93d-4380-8047-cc75f1125245/report.json`，真实解码加 5 个 PG 矩阵输出通过，退出 0；example 源码 / 二进制摘要已采集并复核 |
| 既有预览 / 静态检查 | 原预览的真实解码、容量、私有图 / ETag、失租 / source invalidation / 重启；preview_queue 并发 fencing 和事务 LRU；锁定构建、persistence / Worker all-target Clippy -D warnings、变更模块 rustfmt | 最终目录 `media-previews.stdout`、`clippy.stderr`、`rustfmt.stderr` 及完整运行构建，全部退出 0 |

修补前本路失败保持在 `/workspace/RainSync-lane-artifacts/d-v01/preview-queue-recovery/89fe9f4a-d5a0-4cab-ba4e-f4b19b728c5e/report.json`，退出 1：真实扫描后 media generation=2，但 queued source_generation=1 / attempt=0 / owner=NULL 持续到十秒截止。保存状态证明本路独立竞态，**不证明 C 历史失败的根因，也不把 C 原失败改为通过**；C 旧树 45 秒恢复失败待总控集中集成后联验。

修补前新基线汇总 `/workspace/RainSync-lane-artifacts/d-v01/new-baseline-binding.json` 及下方旧基线矩阵仅留历史。最新结论使用上表两轮修补后绑定；没有性能容量或正式长测结论。

## 旧基线历史矩阵

以下是原 `5ce1c849` 基线历史证据，位于仓库外 `/workspace/RainSync-lane-artifacts/d/`，不算新候选验收。入口记录源码、制品摘要、退出码与资源清理，没有明文凭据或签名地址。

| 矩阵 | 检查与边界 | 本次结果 / 证据 |
| --- | --- | --- |
| Relay 数据库短故障 | 行锁跨三秒截止后恢复；持续未知到确认截止；已确认终态立即停止；行锁中 HTTP 取消；执行授权结束；迟到回复不复活；过期不补 drain | `worker-reliability/d_reliability_4b61f43561f249628a4d4bea014fc81f/report.json` 与 `relay-cases.json`，6 场景通过，入口退出 0 |
| 真实 NAS relay | 真实 Agent 文件句柄与暂停 HTTP 正文；14.5 秒行锁后同 transfer 恢复；随后撤权释放句柄，认证回执先于 closed | `relay-lease-health/4af02ed8-8a8c-463b-bce0-a6ca4ade629e/report.json`，2 场景通过，入口退出 0 |
| Agent drain 短矩阵 | 外来回执拒绝、未分发拒绝、重复 ACK；超过三十秒真实背压；关闭后释放；延迟 ACK / Server 重启重发；控制失联排空；4096 队列背压 | `agent-drain-receipts.stdout`，6 个原有场景输出通过，入口退出 0 |
| 队列 / 缓存 / 产物 | 7 个现有 persistence examples：attempt fencing / 有限重试、预留与旧测量、读租约与淘汰恢复、全局容量、用户轮转、快照原子发布、旧产物清理 | 同一新入口逐个通过、各退出 0；使用真实 PostgreSQL，发布字节是受控证明，不能记作媒体解码验收 |
| Worker 单元 | 已确认租期、输入失败优先级、执行隔离、进程回收、源版本与产物边界 | 新入口 `worker-unit.stdout`；36 passed，1 ignored 辅助子进程，2 项真实 PG 入口 filtered，未计作普通单元通过 |
| 格式 / Clippy / 构建 | Rust 独立模块格式检查、Worker 全目标 `-D warnings`、三服务锁定 dev 构建 | 均退出 0；`clippy.stderr`、`backend-build.stderr` 与新入口构建记录 |

这些都是独立短测。没有性能容量结论，没有将旧候选、多个短测或历史两小时失败的时长合并成通过。

```bash
cd /workspace/RainSync-lanes/d-worker-agent
source /workspace/.rainsync-cloud/env.sh
export RAINSYNC_ARTIFACT_DIR=/workspace/RainSync-lane-artifacts/d-v01-new-run
export CARGO_TARGET_DIR=/workspace/RainSync-lane-artifacts/d/cargo-target
export CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
export RAINSYNC_NATIVE_POSTGRES_BIN=/workspace/.rainsync-cloud/postgres/usr/lib/postgresql/17/bin
cargo build --locked --workspace --bins --examples -j1
node tests/preview-queue-recovery.mjs
node tests/media-previews.mjs
node tests/worker-reliability.mjs
node tests/relay-lease-health.mjs
node tests/agent-drain-receipts.mjs
node tests/agent-index-port.mjs
node tests/playback-plan-generations.mjs
node tests/playback-plan-migration.mjs
cargo clippy --locked -j1 -p persistence -p rainsync-media-worker --all-targets -- -D warnings
```

上述命令用于新运行；实际 profile / 环境变量已记录于本路绑定报告。复用本路旧 target 的锁定编译缓存，原三服务制品另存 `/workspace/RainSync-lane-artifacts/d/history/20035d3-binaries/`。`node_modules` 是本路 ignored 链接，指向 `/workspace/RainSync/node_modules`；其锁文件与本基线相同，仅复用读取，没有新增依赖或写共享依赖目录。

## 两小时 NAS 入口

沿用已有 `tests/nas-soak.mjs`，与 F 路协调器保持相同 `candidate.json` 契约：`schema_version=1`、`status=built`、固定 `image.id`、`source_directory=source`、源码 / 生产输入清单与三二进制摘要。正式入口必须从总控冻结候选的 `source` 目录运行：

```bash
cd /absolute/path/to/frozen-candidate/source
VALIDATION_CANDIDATE=/absolute/path/to/frozen-candidate/candidate.json \
  node tests/nas-soak.mjs --duration-seconds=7200 --sample-seconds=30
```

该入口创建有 run 标签的独立 Docker 网络 / 数据库 / 三服务、合成 MP4、真实 Web 与 Chromium，记录实际解码与墙钟时间、源文件 / 镜像 / 二进制身份、RSS / 文件句柄 / socket / 子进程、传输字节、停止回执与清理。默认也是 7200 秒；更短运行明确标为 smoke，不能通过两小时门槛。正式执行前须具备可信 Docker 镜像、浏览器、持续运行资源及源 / 制品绑定；阅读云 runtime 的 Docker 代理 / CA 指南。

**本路没有执行正式两小时长测，没有生成最终冻结候选，也没有把当前 native dev 制品当作 Docker 候选。** 既有 103.2 分钟失败保持失败；总控集成冻结后启动一轮完整新长测。真实 NAS 文件系统、网络盘及设备仍须各自验收。

## 等待总控的接口与未验证项

1. **媒体细分错误。** 当前 `apps/media-worker/src/main.rs` 将编码 stderr 丢弃，`crates/media-core/src/child_process.rs` 也丢弃诊断输出；仅凭非零退出码不能区分 codec / container 不支持、损坏媒体或运行依赖失败。建议总控批准有限、脱敏、与执行代次绑定的内部诊断管道，给独立分类模块提供受限字节；新增公开 422 错误须总控统一 `crates/protocol`、公开白名单与客户端契约。现有缓存访问 / 容量、源变化 / 缺版本以及明确上游临时故障继续按已有类型处理；未虚构新的细分验收。
2. **SIGKILL 与重启物理恢复。** Linux 的进程组 / subreaper owner 与 Worker 在同一进程；强杀会丢失 owner，现有 TERM / STOP / lease 恢复测试不能证明强杀本体后的整树排空。需要总控确定外部 supervisor / cgroup 边界、不可变启动代次及受支持的正向恢复证明。仅添加 PDEATHSIG 不能证明孙进程排空。未加这一契约，未将 lease expiry / PID 消失 / 重启 / 成功重领替代旧 `media_executions` 或旧 NAS 的 drain 回执。
3. **Agent 主逻辑与 durable receipt 边界。** 数据执行 / 并发 / 重连主要在 `apps/nas-agent/src/main.rs`，新增生产逻辑或拆分接线待总控。回执现有原子 rename 与文件 sync 的跨平台掉电 / 目录持久化、内核不可中断 I/O、Windows 系统退出及真实文件系统仍未验收；本轮只验证已列重启 / 重连流程。
4. **Worker readiness（与 F 对齐）。** 总控入口提供只读 `Database`、实际 `InstanceOwnership` / 任务租约 owner、`AcceptingWork`、`WritableCache`、`Ffmpeg`、`ClaimLoop` 成功轮询证据。每信号包含单调 `checked_at` 与 `Ready / Failed / Unknown`；空队列成功轮询有效，缺失 / 过期 fail-closed，失租 / draining 返回 503。不能用 `SELECT 1` 推断持锁或领取循环健康。本路未改 Worker 入口埋点。
5. **容量与完整长矩阵。** 16 并发 / 第 17 拒绝、直放与转码的实测吞吐容量、强杀 / 掉电、实际 ENOSPC 小卷、网络文件系统、Windows / arm64、最终两小时 / 72 小时均未在本候选执行。队列 / 字节预留事务矩阵只证明有界准入和 fencing，不是可支持播放路数。

总控集成时仅选取本分支提交；B / C / E / F 工作区没有被修改。
