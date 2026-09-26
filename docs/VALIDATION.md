# 本轮验证记录

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
