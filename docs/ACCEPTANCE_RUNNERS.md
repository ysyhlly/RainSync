# 同步、网络与 72 小时协调器

本次实现新增可执行协调器、独立测量和证据记录，但不把接口/合成夹具当成现场验收。NEXT_PLAN §12.2–12.4 仍为部分实现：还需要授权的隔离部署适配器、真实浏览器/双设备时间码核对、双向网络探针/故障注入，以及完整候选的正式运行。自有 RST1 样本已有实际像素解码与 FFmpeg 编码/解码验证，但不是现场同步验收。`control-load.mjs` 已有独立用户和持久化控制面负载；它不代表媒体并发能力。

## 无副作用预演

```sh
node tests/sync-network.mjs --config=tests/fixtures/acceptance/network-dry-run.json --output=/tmp/rainsync-network-plan --dry-run
node tests/soak.mjs --config=tests/fixtures/acceptance/soak-dry-run.json --output=/tmp/rainsync-soak-plan --dry-run
node --test tests/acceptance-measurements.test.mjs tests/release-evidence.test.mjs tests/acceptance-runners.test.mjs
```

输出目录必须不存在；预演不会导入适配器，不启动服务/浏览器，不改变网络或生成实际观测。`result=dry-run`、`accepted=false`。默认网络计划是 N1–N6 × control/media/shared × 3 次，每次稳态 30 分钟、预热 60 秒；完整矩阵超过 27 小时。默认 soak 是单个连续 72 小时窗口。

执行入口：

```sh
node tests/sync-network.mjs --config=/private/network.json --adapter=/private/approved-network.mjs --output=/private/run-001
node tests/soak.mjs --config=/private/soak.json --adapter=/private/approved-soak.mjs --output=/private/run-002
```

正式运行必须从最终冻结候选的 source 内执行；源文件、candidate.json、生产清单、两个锁文件、样本字节、镜像 ID 和三份实际二进制绑定检查均不能省略。正式配置需 `scope: "formal"`；短测用 `"smoke"`，夹具用 `"synthetic"`。合成适配器不能输出 formal。协调器报告通过也保持 `accepted=false` 和 `release_ready=false`，控制者仍须审阅原始证据；`release-evidence assess` 不会自动关闭网络/72h 门槛。

## 公共配置和适配器

JSON 配置字段：

- `kind`: `network` 或 `soak`
- `scope`: `formal`、`smoke`、`synthetic`
- `candidate_path` / `samples_path`: 冻结候选和已授权样本清单文件
- `environment`: `release-evidence inventory` 的 schema 1 硬件/OS/浏览器/工具结果，并补足实际设备信息
- `adapter_timeout_ms`: 单次操作截止，默认 30000
- `maximum_lateness_ms`: 超过就失败，禁止压缩补跑；network 默认 2000，soak 默认 5000
- `redaction_values`: 可选，需要从自由文本中擦除的确切秘密值，至少四字符；不写入报告。不要把密钥作为命令行参数

CLI 自己记录实际命令。`createAdapter(config)` 必须返回 `schema_version: 1`、`id`、`mode: "real"|"synthetic"` 及以下方法。适配器模块自身 SHA-256 进入元数据。方法签名都是 `(input, { signal })`；必须真正响应取消并有界停止自身子进程。JS 超时无法强制停止忽略 signal 的外部任务，因此真实适配器必须有外部监督、独占资源标记和独立紧急清理途径。

通用方法：

- `prepare({run_id,binding,schedule})`: 只准备本次独占测试资源，保存其精确 ID；部分准备失败也必须允许 cleanup
- `artifactIdentity()`: 实测 `{observation_id,image_id,source_sha256,binary_sha256}`，后二者必须匹配候选；不能原样回传配置冒充测量
- `collectArtifacts({failed})`: 返回有界 JSON 对象，含已脱敏服务日志、失败请求/帧、原始统计文件和哈希。大文件由适配器写入私有产物目录，并在这里返回清单；不要回传凭据/签名媒体 URL
- `cleanup()`: 只清理本次所有资源，返回 `{confirmed:true}`，不确认即整次失败

SIGINT/SIGTERM 会取消执行、抓取失败证据，再尝试清理。SIGKILL/宿主崩溃无法运行 finally，不能伪称已清理；依靠外部监督器回收，缺少最终报告的目录始终算中断。

## 独立浏览器采样驱动

`scripts/acceptance-browser.mjs` 导出 `createBrowserMeasurementDriver({clients, decodeTimecode, saveFrame})`。观察驱动允许一个或多个客户端，以支持 direct-1 soak；网络协调器仍独立要求每房间至少两个不同客户端。clients 每项包含真实 Playwright `page`、`client_id`、`room`、显式样本原片坐标 `media_origin_ms`、当前精确 `source_url`。URL 只留在私有内存，不输出。样本源/页面/video 实例改变时拒绝沿用映射，需重建驱动、重校准并重新时间码核对。

驱动提供可组合到网络适配器的 `clients`、`clockExchange`、`sample`、`timecodeChecks` 和 `dispose`：

- 控制器独立发起五次四时间戳交换，使用各 page 的 performance.now 和独立 clock epoch，不使用被测同步算法的 offset/target
- 以保守上下界交集校准，记录全部交换、往返分布、漂移界和校准有效期。非对称链路不会被假设对称
- 按 requestVideoFrameCallback 的真实 mediaTime/单调时钟记录呈现样本，原片位置只加显式夹具 origin；不把 loadedmetadata 当呈现
- 记录播放状态、seek/buffer/foreground/意图和连续状态区间；`setPlayIntent` 必须由驱动控制动作同步调用，不能把自动播放受阻算成正常播放
- 要求 `decodeTimecode(png)` 真正读取自有样本可见时间码，返回 `{original_position_ms,method}`；不能读播放器 currentTime 代替解码。`saveFrame` 在解码前保存私有原始截图并返回 `{path,sha256}`，失败截图也保留。截图用前后呈现样本包围，容差 100ms，证据保留两端、帧哈希及解码器提供的帧号/量化说明
- 没有 rVFC 时明确失败；尚未实现低精度 fallback，不偷偷降低口径

`scripts/acceptance-timecode.mjs` 的 `createVisibleTimecodeDecoder(manifest.decoder_config)` 提供可直接接入的 RST1 实现；`scripts/generate-timecode-fixture.py` 生成自有 H.264 样本、数字时间码、原始/编码后 PNG 与源码/媒体摘要。仅支持固定布局、明确 ROI 和 1/2 倍像素比例，拒绝 checksum、对比度、身份、边界和数码不一致。范围、量化误差和使用命令见 [TIMECODE_FIXTURE.md](TIMECODE_FIXTURE.md)。

该驱动负责观察，不负责创建用户/房间或改变部署网络。`tests/acceptance-browser.test.mjs` 是真实 Chromium 生命周期短测，输入是自生成 canvas/WebM；它不验证 RainSync、烧录时间码或 packet shaping。默认跳过，显式设置 `RAINSYNC_PLAYWRIGHT_MODULE` 指向安装的 `@playwright/test/index.mjs`、可选 `RAINSYNC_BROWSER_EXECUTABLE` 后运行。

## 网络适配器具体契约

配置可设 `duration_seconds`、`warmup_seconds`、`repeats`、`sample_ms`（最多 1000）、`calibration_ms`（最多 60000）、`scopes`、`scenarios`。正式范围禁止缩减 N1–N6/三个流范围/三次重复/30 分钟。

除通用方法，提供：

1. `inspectIsolation({run_id,scenario})`: 返回相同 run_id、`namespace_id`、接口列表 `interfaces` 和 `host_network:false`。必须实测所有权，不能根据用户给的 namespace 名称猜测。所有权核对发生在 apply 前
2. `applyNetwork({scenario,isolation,run_id})`: 返回 `{mode,namespace_id,observation_id,settings}`；settings 保留实际应用的上下行规则和受限成员。协调器不提供 tc/防火墙 shell，也不会替你申请特权。real 必须在实际取得本次动作批准后设 `network_change_approved:true`，该标记本身不授予权限
3. `restoreNetwork(...)`: 即使 apply 部分失败也必须恢复，返回 `{restored:true}` 及恢复观测
4. `probeNetwork(...)`: 返回 `{mode,observation_id,method,start_ms,end_ms,sent_packets,lost_packets,rtt_ms,jitter_ms,uplink_bps,downlink_bps,uplink_delay_ms,downlink_delay_ms,video_demand_bps}`；用真正的独立双向探针。实际测量与请求设置分开记录，任何合成探针都只能 synthetic
5. `clients()`: 每个房间至少两个不同 `{client_id,clock_id,room}`；观察通道应在被测链路之外，弱网上控制器往返不确定度过大会降低有效覆盖率
6. `clockExchange({client_id,clock_id})`: 返回客户端身份/epoch、`client_receive_ms`、`client_send_ms`；控制器自己记录参考 send/receive，不接受适配器伪装的参考时间
7. `timecodeChecks({clients})`: 每个客户端需 `{client_id,method:"visible-frame-timecode",observation_id,frame_sha256,visible_original_position_ms,sample_original_position_ms,tolerance_ms}`；必须保存并可审阅真实帧
8. `sample(...)`: 返回全部尝试客户端（不可用也显式返回），每个含单调时钟、原片位置、倍速、playing/buffering/seeking/foreground、`playback_intervals`；可直接组合浏览器驱动。另补 `authority[room] = {reference_ms,original_position_ms,playback_rate,playing}`，reference_ms 必须属于控制器的独立参考域。它只用于单独权威误差，不替代跨客户端误差

sample 还可返回增量 `recoveries` 和 `invariants`：

- N3: `{disconnected_ms,control_ms,media_ms,observation_id}`；从外部探针确认恢复开始计时，控制端点是应用有效快照，媒体追赶另记
- N4: `{kind:"bandwidth-response",buffering_ms,existing_quality_reductions,unrequested_seeks,observation_id}`
- N6: `{kind:"single-member-isolation",restricted_client_ids,authority_before_sha256,authority_after_sha256,healthy_connections_lost,healthy_peer_p95_ms,observation_id}`；authority 摘要应覆盖限速动作前后同一权威状态版本，不能混入正常时间推进

报告含每房间分位数、全部有效观测的 pooled 分布、最差房间、排除原因、全部尝试计数、漂移不确定度和真实区间缓冲时长。N1/N2 最差房间 p95 限制分别为 300/800ms；95% 有效覆盖率是本协调器显式质量门槛。N2 实测容差为 RTT 200–400ms、jitter 50–150ms、loss 0.5%–5%；N4 是需求带宽的 60%–80%。这些容差不是被测系统输出的常量断言，原始探针必须保留。N5 报告偏差/不确定度，不套用 N1 的位置精度承诺。

## 72 小时适配器和资源驱动

默认调度循环播放 60s、切片 90s、seek 120s、join/leave 180s（错开）、淘汰 300s、F1–F4 故障轮转 900s；按绝对单调时间调度，保存完整计划和实际执行。默认每 600s 切换 direct 1/2/5/10 阶段。正式运行需添加支持的 transcode 阶段，或提供实测不支持的证据，不能把 WS 数当视频路数。

配置：`duration_seconds`、`warmup_seconds`（默认 1800）、`sample_seconds`（默认 60）、`identity_seconds`（默认 300）、`phase_seconds`（默认 600）、`phases:[{id,mode,concurrency}]`、`faults`、`cadence_seconds`。正式故障必须真实批准后 `faults_approved:true`。

prepare 返回 `{owned_resource_ids,host_mutations:false,isolated_fault_targets:true}`。`perform(event)` 接收明确 run/资源 ID、phase、kind、ordinal、计划时刻；返回 `{mode,action,observation_id,completed:true,evidence}`。evidence 的必要观测：

- phase: `mode,requested_concurrency,active_concurrency,controlled_rejections`
- loop-playback: `presented_frames,original_advanced_ms`
- slice: `completed_segments,failed_segments`
- seek: `requested_original_ms,presented_original_ms,presented_frames`
- join/leave: `members_before,members_after,authority_snapshot_verified`
- cache-evict: `evicted_bytes,cache_bytes,cache_quota_bytes,active_files_removed`
- fault 公共: `fault, injected_at_ms,recovered_at_ms`
- F1: `signal:"SIGKILL",old_attempt_writes:0,generation_drain_verified:true,external_supervisor_verified:true`
- F2: `false_acks:0,writes_after_lock_loss:0`
- F3: `isolated_volume:true,explained_failures,corrupt_successes:0,orphan_processes:0`
- F4: `new_requests_denied,long_stream_close_ms`（不超过 10000）

`prepare.owned_resource_ids` 必须是非空、不重复的资源 ID 列表，协调器保留不可变副本。每次资源采样必须恰好包含全部预期资源各一次；缺失、重复、越界、无效行或显式 unavailable 都使本次运行失败，记录 resource-coverage 和失败原始样本。缺失资源另记录 resource-unavailable，不会被静默丢出趋势分母。

`sampleResources({phase,elapsed_ms})` 返回每资源 `{entity,instance_id,phase,observation_id,rss_bytes,fd_count,socket_count,process_count,cache_bytes,cache_quota_bytes}`。按资源/相同负载阶段/实例世代分组，排除预热；每组至少六个样本，报告完整分布、早/晚三分段均值、全时序回归斜率。重启不能混成一个实例；缺样不能算“未增长”。`resource_limits` 为每项配置显式 `{maximum_slope_per_hour,maximum_late_growth}`；没有配置就不会通过趋势检查。缓存不得超过配额，尾部平台也要审阅，不能只比较两个 RSS。

`scripts/acceptance-docker-observer.mjs` 提供可复用、只读的 `artifactIdentity` 和 `sampleResources`。输入精确 64 位 container ID、role、cache_path/quota、binding 和 run_id；容器须有 `org.rainsync.acceptance-run=<run_id>` label，拒绝 host network，逐次检查存活和镜像。只连显式本地 Docker socket。检查三份实际 `/usr/local/bin/rainsync-*` 哈希；采集 PID 1 RSS/FD、容器 TCP socket/进程数和目录 bytes。注意进程/TCP 计数包含短暂采样开销；该参考观察器不采集 GPU 或所有子进程 RSS，需部署适配器补足这些维度。

当前未提供通用的 `perform`、双向 netem/probe 或任意素材时间码 OCR：它们依赖具体服务、媒体、隔离卷、成员与故障权限。RST1 自有素材像素解码已单独实现，仍需真实浏览器与实际测量适配器集成验证。不能用填 true 的占位函数验收。建议从已有 control-load / nas-soak 的真实独占部署与正常 API 流程抽出所需 driver 后完成集成，不重跑或绕过被平台拒绝的 Agent 控制实验。

## 有界 native 调度资格验证

`tests/soak-native-qualification.mjs` 是独立的 native 子集入口，配置 `kind:"soak-native-qualification"`、`scope:"native-qualification"`、`native_binding_path`，计划负载窗口最多 180 秒（不是已证明的总墙钟上限），显式指定 direct 阶段及 `actions`（slice/join/leave/stop-stream/fault 子集）；fault 只允许真实自有 membership-SQL F4。join/leave 必须成对。默认选中动作在窗口内错开一次，周期和起点可分别配置。正式 `tests/soak.mjs` 固定执行镜像候选验证及全套动作，不能由 JSON 选择 native verifier 或减少矩阵。

native 子集使用真实适配器操作，并逐阶段/检查点核对不可变 native source/binary/coordinator 绑定及实际 nativeIdentity。全部 Server/Worker/PostgreSQL 资源必须持续出现在采样中，各行进程世代保持固定。Stop/session-DELETE 与 membership-SQL F4 为不同 receipt；共用长流 actor 的动作重叠立即失败。phase 保留 pending barrier，排空后再次核对绝对调度迟到界限。

结束时先排空工作和采集独立最终存活身份，再释放 fixture callback 清理 workload/services；之后收集已终结原生报告并完成产物/日志链。取消信号在 prepare 之后仍绑定 lifetime；清理/报告错误不能覆盖主要调度失败，未知清理不能算确认。`result:"passed"` 仅表示显式选择的有界子集完成；`qualification_only:true`、所有剩余正式门槛为 `unfulfilled`，始终 `accepted:false`、`release_ready:false`。正式镜像/呈现/淘汰/F1–F4/完整容量与趋势/连续 72h 仍开放；`membership_sql_f4_completed` 只记录已选原生子案例，上游账号与 Agent 撤权未验证，所以完整 F4 始终为 unfulfilled。报告分别保存 prepare/action/final-identity/cleanup-wait/collect 的现有适配器调用预算与最晚计划调用截止；source/journal I/O、完整 ownership drain 和总墙钟上限未证明，保留 null。公开 timeout 不结束 fixture 的清理所有权。新 native runtime 运行仍暂停；本次只执行 filesystem、fake clock 和内存替身测试。详见 [OWNED_SOAK_ADAPTER.md](OWNED_SOAK_ADAPTER.md)。

## 证据与剩余验证

每次新目录有 `schedule.json`、`metadata.json`、`observations.jsonl`、适配器产物清单、最终 `report.json` 或 `failed-report.json`、`artifacts.json`。JSONL 顺序编号、前项 SHA-256 和当前 SHA-256 形成可验证链；最终清单保存链尾及产物摘要。报告包含源码/生产摘要、commit/工作区差异摘要、镜像/二进制、锁文件、环境、样本授权/哈希、实际命令、单调时长、失败样本和清理结果。产物权限为私有；结构化秘密字段（含 source/encryption key、数据库 URL/DSN/connection string，支持大小写和命名风格变体）、HTTP/PostgreSQL/WebSocket URL 的查询/账户信息、常见认证字符串和显式秘密值会脱敏；有明确 SHA-256 字段名且值为 64 位十六进制的摘要保留，非摘要伪装值仍被擦除。适配器大文件及任意自由文本仍须人工检查后分享，不能宣称过滤器能识别所有秘密。

2026-10-02 的本地验证：Node 合成/不变量测试通过；Chromium 启动在普通和经审核提升权限后都被环境 `socket() EPERM` 阻止，未进入页面测试。Docker 观察器未对部署执行。没有实际网络变更、正式 30min×3、两小时、72h 或设备验收结果。
