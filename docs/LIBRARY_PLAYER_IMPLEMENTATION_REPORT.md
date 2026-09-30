# 媒体库、播放器与公共控件实施报告

> 后续独立审计发现的三项 P2 及 T9 前向修复证据，见 [审计修复报告](LIBRARY_PLAYER_AUDIT_FIX_REPORT.md)。本文保留首轮实施的历史验证范围；后续结论以修复报告为准。

执行日期：2026-09-29，Asia/Shanghai。分支 `front/rainsync-implementation`；起点 `75c45d82f784ad6f2bf60241c67f65544627faef`。执行依据为 [原计划](superpowers/plans/2026-09-28-library-player-polish.md)，过程见 [进度记录](LIBRARY_PLAYER_PROGRESS.md)。

本轮已实现双层改名、认证封面队列、统一选择器/抽屉关闭、奶油空态、聊天上方播放信息、视频内控件、五秒全屏显隐及持久播放。源码和测试仅本地提交，未部署。下述验证覆盖有界隔离环境，实机与特定媒体边界单独列在“未验证项”，不视为已验收。

## 1. 工作区及执行边界

- 先完整读取计划/AGENTS 并核实实际分支、HEAD、未提交状态。cgraphy 未暴露可调用工具，采用常规检索/审查；没有 enrich/store_summaries。
- 所有提交 Author 和 Committer 均为 `Rainfrost <luo005962@gmail.com>`，不改全局配置。未使用 reset --hard、推送、PR、部署、外部消息或效果图。
- 用户的 `deploy/Dockerfile` 修改和 `oil-pumpjack.html`、`pelican-bike.svg`、`pumpjack.html` 三个删除保留且不进入任何本轮提交。Dockerfile 末次 SHA256 与起点相同：`C567DB9DD4C6CA56C62D7F4591976FCD838782D512C6E4DE9BBA6B12C45CB5BD`。
- 所有临时视频、图片、缓存、Cargo target、Vite 输出、浏览器 trace、数据库目录和日志位于 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-library-player-polish-20260929-impl`。测试仅使用新建 PostgreSQL 和随机账号/密钥；不连接用户数据库写入。
- 原服务容器 ID 保持 web `798a32173f2b`、server `ce83ea1a67fe`、worker `2ff0fef108e5`、db `ab89f5bc20bb`、live-dashboard `f51ce53e5554`。8088 监听 PID 25668/28292、SnowLuma 5099 PID 752 保持一致。证据为 services-before、processes-before/after、listeners-after、ownership-final.json。
- Docker Hub 初次连接超时后，根据用户提供的 7897，仅在构建命令进程和 Docker build args 中使用代理；独立镜像构建成功。未更改系统代理或 Docker Desktop 设置，未重启用户服务。测试镜像保留供复现，所有本任务运行实例由 finally 清理。

## 2. 需求与证据矩阵

| 需求 | 实现与实际证据 | 范围 |
| --- | --- | --- |
| R1 抽屉 | primary pointer 按下/抬起都在矩形外才关闭；busy/canClose、Escape、嵌套菜单优先级保留。完整浏览器 drawer/admin/account 用例 | 手机全宽抽屉无外部区域，相关外部点击用例跳过，关闭按钮保留 |
| R2 配色 | 页面 #FFF4D5，空视频 #FFF8E5，有媒体留边独立黑色；六宽度、页面/抽屉/菜单计算颜色与对比度 | 未改变视频内容或导航匀速动画 |
| R3 选择控件 | 七处 AppSelect 自绘 listbox，number/null 类型、键盘/焦点、Popover 子树层级；分段标签、radio/checkbox 统一样式 | 浏览器真实 dialog/Fullscreen API 操作；无实机 Safari |
| R4 封面 | local/HTTP/NAS/Jellyfin/Emby；顺序解码黑两秒、首帧、暗/全黑/损坏/竖屏/边缘亮画面，像素验证；RIFF/640×360/256KiB；租约/预算/认证/失效 | E08/E09/E10；新 Linux Worker + Jellyfin 10.11.0/Emby 4.10.0.40 产品联调，不仅 mock |
| R5 名称 | admin/Alice/Bob 双层回退、独立 CAS、首插并发、CSRF、搜索、队列、重扫/重启；前端冲突/丢响应读回/身份清空/旧封面响应 | E07/E11/E12，media-catalog 单测及 media-library 浏览器 |
| R6 信息位置 | 桌面聊天顶部左对齐，手机视频下/分段标签上；直接进房详情读取，长标题换行 | layout/player-chrome + 真实双用户标题 |
| R7 普通播放器 | 桌面 hover、触屏点按、菜单/拖动/键盘锁；迷你模式保留控制及返回；音量本地、房间倍速保留权限 | 状态机、app/recovery 浏览器、真实用户同步 |
| R8 全屏 | document.fullscreenElement 为播放器，零 padding，视频 contain；4999ms 仍显示、5000ms 起隐藏，动画终点 opacity/cursor，活动恢复 | 真实 Chromium API + 暂停时钟；菜单内倍速命令和音轨/字幕业务断言 |
| R9 可访问性 | 键盘 Tab/箭头/Enter/Escape、焦点、触摸面积、reduced-motion、API 不支持时提示 | 手机为 Chromium 触摸模拟；实机限制见末节 |
| R10 持续播放 | 同一 DOM video、同一 WS、相同准备请求与 DB session 数；媒体库改名→管理→资料→房间→全屏，进度连续 | E12 真实 Server/Worker/PostgreSQL/两用户，未使用路由 mock |
| 旧功能 | 登录竞态/注销/聊天幂等/同房间重入/字幕与快速音轨/导航匀速回弹；Worker 进程、relay 生命周期 | 完整浏览器 + E13/E14/E15 |

## 3. 关键实现与设计调整

名称使用迁移 0023 的 shared_title/revision 和 media_user_titles；原始 title 不改语义。清空个人覆盖保留版本墓碑。详情/列表/队列均按当前用户解析，别名不进入房间广播或资源定位。前端 catalog 按身份 epoch 同步清空，标题按字段版本合并，封面按请求序号抑制迟到数据；队列元信息刷新并发上限 4。元信息刷新不调用 loadMedia/enter。

迁移 0024 的 media_previews 独立于 media_jobs/playback_sessions。领取用 SKIP LOCKED；15 秒租约、5 秒续租、3 次尝试、2/5 秒退避、60 秒后手动重试。发布验证 owner/attempt/lease/source generation。全局事务锁协调容量和 LRU；不可见/旧源任务不占可领取容量，图像超缓存预算转 unavailable。

封面优先 Backdrop→Primary→视频，640×360 静态 WebP ≤256KiB。每帧完整画面缩放采样判黑（低于24的灰度占99.5%），接受后用另一分支等比裁剪，避免先裁剪把边缘有效画面丢掉。完整帧采样并非原始分辨率逐像素判定；输出保持比例不拉伸。image2pipe 避免 Bookworm FFmpeg 5.1 webp 管道封装缺陷。

Worker 输入授予每 attempt 的随机、不透明目标地址，累计输入预算，不把源 token/path 交给浏览器。HTTP/嵌套 HLS 同源校验，重定向直接拒绝。local/NAS 用属性/source_version；HTTP 同 attempt 检查 ETag/Last-Modified，无长期强版本时采用扫描和24小时失效策略。

技术偏差：Jellyfin/Emby 视频回退使用认证的 Static=true 视频流，未调用 PlaybackInfo 创建上游转码；两真实产品已通过静态流测试。需要动态转码且无法提供静态流时会 unavailable。避免封面依赖房间播放授权，但不承诺所有上游转码资源均可生成封面。

播放器视频没有 v-if/key/Teleport 重建。信息组件无副作用；控件移入原 video-frame，设置 Popover 留在播放器子树。普通鼠标 focus 不永久锁定，键盘焦点、菜单、拖动各自锁定。播放方式仍需“重新加载”；音轨切换沿用重载；字幕保持标识；全屏失败诚实提示，不用 CSS 铺满冒充。

配置/错误码/DTO/状态契约见 [MEDIA_LIBRARY_API.md](MEDIA_LIBRARY_API.md)，架构说明见 [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md)。

## 4. 实际验证记录

产物根目录记为 ARTIFACT_ROOT，即前述 Desktop/杂项 专用目录。每条记录的 `logs/<名称>.json` 保存完整命令、UTC 起止时间、退出码和超时标志；对应 `.log` 为原始输出。运行前执行：

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-library-player-polish-20260929-impl'
$env:PLAYWRIGHT_BROWSERS_PATH='C:/Users/ALIENWARE/AppData/Local/ms-playwright'
```

命令均由 `node scripts/run-check.mjs <名称> <秒数> <命令>` 记录。Worker 回归另设 `WORKER_TEST_IMAGE=rainsync-polish-fixture:20260929`。镜像命令仅构建专用标签，不启动用户服务。

| 证据 | 日志名称 | 实际命令 | 退出码 |
| --- | --- | --- | --- |
| E01 | rust-unit-final | `cargo test --workspace --locked` | 0 |
| E02 | rust-build-boundaries | `cargo build --workspace --bins --examples --locked` | 0 |
| E03 | rust-format-final | `cargo fmt --all --check` | 0 |
| E04 | protocol-check-final | `cargo run -p protocol --example export --locked -- --check` | 0 |
| E05 | frontend-unit-acceptance | `node node_modules/vitest/vitest.mjs run` | 0 |
| E06 | frontend-build-acceptance | `cmd.exe /d /c npm.cmd run build` | 0 |
| E07 | titles-final | `node tests/media-titles.mjs` | 0 |
| E08 | previews-boundaries | `node tests/media-previews.mjs` | 0 |
| E09 | preview-sources-nas-final | `node tests/media-preview-sources.mjs` | 0 |
| E10 | preview-products-acceptance | `node tests/media-preview-products.mjs` | 0 |
| E11 | media-migration-upgrade | `node tests/media-migration-upgrade.mjs` | 0 |
| E12 | library-player-real-final | `node tests/library-player-real.mjs` | 0 |
| E13 | worker-processes-polish | `node tests/worker-processes.mjs` | 0 |
| E14 | relay-cancel-final | `node tests/input-retries.mjs --relay-cancel` | 0 |
| E15 | agent-relay-final | `node tests/input-retries.mjs --agent-relay` | 0 |
| E16 | preview-image-final | `docker build --build-arg HTTP_PROXY=http://host.docker.internal:7897 --build-arg HTTPS_PROXY=http://host.docker.internal:7897 -f deploy/Dockerfile -t rainsync-polish-fixture:20260929 .` | 0 |
| E17 | fullscreen-fallback-final | `node node_modules/@playwright/test/cli.js test --config playwright.polish.config.ts player-chrome` | 0 |

Rust：57 通过、2 个原有子进程 fixture ignored（它们由父级生命周期测试按需启动）；前端：55 通过。类型检查、Vite 生产构建、cargo fmt、协议导出只读检查均通过。完整浏览器最终数字在下面“最终核验”列出，历史失败日志保留，不以历史绿色结果代替最终结果。

E10 真实产品测试包括 Linux Server/Worker 和两真实产品镜像的用户初始化、真实库扫描、上传蓝色 Backdrop、红色视频回退，使用像素判定选择来源；E09 为确定性 HTTP/HLS 错误协议 fixture 与真实 NAS Agent，用于覆盖错误分支，两者不可混称。

E12 真实浏览器证据位于 `library-player-real/64c6ba4c-71b7-4152-9c3d-ac00e79232b7/evidence.json`。E13 回归证据位于 `worker-processes/rainsync-process-621556b4/report.json`；包含进程组、输出限制、正常退出、SIGTERM、ENOSPC、数据库分区和旧 Worker 恢复。E14/E15 各自 `input-retries/*/report.json` 记录取消、租约、恢复、真实 Agent 文件句柄、版本与撤销场景。

Evidence → Finding → Path：E07/E11 确认双层名称独立且重扫/迁移重启保留，对应 Server media_titles→SQL CAS→catalog；E08/E09/E10 确认认证小图不创建播放 session，对应 enqueue→claim→preview input→sequential decode→fenced publish→authenticated cover；E12 确认 UI 重布局没有重建播放，对应 AppShell→persistent PlaybackHost→room-runtime。

## 5. 调试记录与修复

- 基线 NAS drawer 在 busy 时 Escape 的时序问题，测试改为等待关闭入口启用，保留 busy 保护。
- 新封面 HLS 子目标缺少扩展名被 FFmpeg 拒绝，加入受限扩展名且仍解析不透明 UUID，真实 HLS 通过。
- 队列重排计入自己的旧槽位、失效媒体占队列、过小图像预算不终止已修复并以真实 PostgreSQL 测试。
- 首轮新前端 DTO/测试 fixture 语法和 window stub 错误已修复，单测/构建通过。
- 手机设置菜单超出视频被导航遮挡，改为所属播放器内 Popover。
- 五秒测试最初未暂停 Playwright 时钟导致4999ms观察跨越截止时间；现固定时钟并核验真实计算样式。
- Emby 上传封面与首次后台库扫描竞争；测试等待扫描结束和列表元数据出现，最终真实产品测试通过。
- relay-cancel 与 agent-relay 一起运行会复用被前者故意杀死的 Worker；添加互斥检查，分别新建 fixture 运行，两项通过。
- 不支持 API 的手机测试采用真实 tap，避免模拟鼠标移动先显示、click 又切换隐藏造成的测试误操作。

## 6. 未验证项和实际限制

- Safari/macOS、iOS 原生全屏、Android 真机、真实触摸键盘和 assistive technology 未验证；手机覆盖为 Chromium 仿真。
- 旋转 display-matrix 视频尚无独立回归；竖屏比例已测。极高分辨率/HDR/非常长 GOP/复杂加密 HLS 与大型真实媒体库长期压力未全面验证。超时、预算和 unavailable 是这些输入的真实边界。
- Primary 封面分支已实现，真实产品本轮像素验收重点为 Backdrop 优先和无封面回退；独立 Primary-only 产品场景未覆盖。
- HTTP 上游替换若未扫描且不在一次读取内改变，最多24小时才保守失效；不提供跨请求即时内容一致性或内容哈希承诺。
- 真实浏览器为合成 H264 视频；全屏音轨和字幕业务断言使用确定性 API fixture + 真实 video/TextTrack，并非多轨真实 Jellyfin/Emby 端到端全屏测试。
- 测试证明可见项批量≤24、单批并发、后台取消和60秒停止的实现/边界；未进行百万项目数据库或持续数日滚动的负载测量。
- 原有两个 Rust ignored 是父测试启动的子进程入口，不作为独立测试计入57项；不将“ignored”计为通过。没有远程 CI、生产服务或真实用户媒体的验证。
- 旧后端二进制在包含0023/0024迁移记录的库上的回滚兼容性未实测；已实测旧结构/数据升级和新二进制重启。

## 7. 本地提交与回滚

全部本地提交的作者/提交者已审计为指定身份：

| SHA | 内容 |
| --- | --- |
| `489b58e89e8cdacaf6a2a74f45cded968486b4fb` | docs: record library and player implementation baseline |
| `a76dd91fd49a6b64832d10c154075aeea4adc503` | feat: support shared and personal media titles |
| `8895bd0667d45212bc99acbde538b6fa30f85649` | feat: generate authenticated media previews outside playback sessions |
| `4ea845d7f3c46408418482e3e7ab8949f13e0fe8` | test: verify preview source paths and Bookworm encoder compatibility |
| `eadd0edf1add81c008f5785bf444b1d307d1f02a` | feat: unify selection menus and drawer backdrop dismissal |
| `32060e1a851f697d102d4859f3401378b45fe26e` | fix: align empty player with the cream theme |
| `7acdcaf1d756d99cf2e29248c03f36cd04ed26b4` | feat: add media covers and personal or shared rename controls |
| `6299fbd22a0248db12001760a43a497c2424d015` | feat: add clean video controls and idle fullscreen behavior |
| `0e9031328b2a229b60c49ac1e079dbe7305f2eb4` | test: validate isolated media products and harden preview boundaries |

后续收尾提交记录在最终回复和 `git log`。报告所在文档提交本身不能在内容中引用自身 SHA，最终回复给出准确 HEAD。

依赖顺序：T1名称迁移→T2队列/Worker→T3读取验证→T4控件/T5配色→T6资料→T7播放器→T8边界与真实验证→T9文档。仅当用户另行决定回滚时，按 `git log` 从最新收尾提交到旧提交逆序 `git revert <SHA>`，不改写历史，不操作本次保留的四项用户变更。

只回退 UI 时可保留新表；数据库中的个人/全站名称为用户数据，不删除。缓存可再生成，但不能通过盲删迁移/表解决 SQLx 历史不匹配。后端完整回退需要包含迁移兼容信息的构建或前向修复，并在隔离库先验证。未提供或执行部署操作。


## 8. 最终核验

- 完整浏览器 `browser-complete`：**120 passed，2 skipped，0 failed**，退出0。跳过为手机标准全屏测试和全宽抽屉外部点击测试；手机触控/不支持全屏的提示已测试。
- 前端单测55项、Rust57项、类型/生产构建、格式、协议检查均退出0，详见 `acceptance-manifest.json`。清单包含最终采用日志的 SHA256、命令和完成时间。
- 最后功能收尾提交 `9d8a2ef60c0cb742534ee8034cf5bd3de9637fcb`：队列/重进/焦点资料刷新、全屏错误提示、音量拖动捕获、无效预览重新请求以及全屏音轨/字幕/不支持API验证。
- 运行中的容器仅剩起点5个用户容器；没有本任务 Server/Worker/Agent/FFmpeg 残留。浏览器验证的自有 Vite 随套件退出清理。保留外部证据目录和专用测试镜像供复查，不删除用户资源。
- 计划 T0–T9 的实现、隔离验证、本地提交和报告步骤已执行；第6节的未验证边界仍明确保留，不能将此报告理解为所有设备/媒体变体均已覆盖。
