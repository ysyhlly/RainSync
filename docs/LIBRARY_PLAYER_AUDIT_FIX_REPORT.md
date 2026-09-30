# 媒体库与播放器独立审计修复报告

日期：2026-09-29（Asia/Shanghai）。分支：`front/rainsync-implementation`。本轮起点：`ae88f9fc3ceda46fa904073d641448bbf80c23da`。

本报告承接 [原实施报告](LIBRARY_PLAYER_IMPLEMENTATION_REPORT.md) 和用户提供的独立审计，处理三项 P2，并补齐原计划 T9 的隔离前向修复证据。T0–T9 的首轮实现不重复开发；本轮复核 T0，修复 T2/T3/T6，执行相关 T8/T9 验证与本地交接。仍未部署到用户服务。

## 1. 改动与回归

| 审计问题 | 原因 | 修复后的行为与证据 |
| --- | --- | --- |
| P2：焦点刷新推进旧改名草稿的版本，静默覆盖另一会话 | 保存读取共享 catalog 的最新 revision，未与载入草稿绑定 | 个人/全站分别保存草稿版本。背景刷新不能推进版本；409 后保留草稿、展示本次读到的最新值，用户再次保存才使用该版本。第二次背景并发修改仍会再次 409。桌面/手机均检查实际 PUT expected_revision、草稿与最终名称 |
| P2：图片临时失败后同 revision 永久占位 | failed 只在 revision 改变时复位，ready 状态没有重载入口 | 显示“封面加载失败”；手动重载一次，或媒体库成功刷新后重载同版本。监听字段值而非 cover 对象身份，改名/详情缓存更新不触发重试；没有 onerror→生成 POST 或自动循环。小尺寸待播封面提供可访问的 44px 重试按钮，真实测量其未被裁切 |
| P2：非方形像素封面内容变形 | 编码宽高比例被直接当作显示比例，随后 setsar=1 | 在编码帧上按含 SAR 的显示比例中心裁剪，再缩放到 640×360、设置方形像素。保持完整帧分析分支用于黑帧判断；不创建不受限的大尺寸中间图。使用 FFmpeg 5.1 已支持的 crop exact 参数，未使用新版 reset_sar |

改名使用 PUT 响应自身的名称版本；catalog 可以同时保留更晚的后台读取。后端提交后会再次读取响应，因此还校验响应目标名称是否仍等于本次提交值；若已被另一写入覆盖，展示最新值和冲突，保留草稿供用户核对，不直接提示保存成功。新增单测复现“写入响应尚在途，更新的读取先进入缓存”：恢复原返回缓存逻辑时失败，返回写入快照后通过。网络结果未知时仅在 GET 确认目标值一致后更新草稿版本，不自动重发；清除覆盖同样使用草稿 CAS。异步读回检查媒体/身份序号，避免旧结果写回新编辑上下文。

预览配方从 1 升为 2。列表/详情、状态、认证读取、领取/续租/发布均按新配方判断；INSERT 与重新入队显式写入 2。已有配方 1 缓存视为 missing，旧 URL 返回 409，新请求按需再生成。没有新增或修改 SQLx 迁移，没有清空用户名称表，也没有修改用户数据库。接口细则见 [MEDIA_LIBRARY_API.md](MEDIA_LIBRARY_API.md)。

主要文件：`MediaRenameDialog.vue`、`media-catalog.store.ts`、`MediaThumbnail.vue`、`library.store.ts`、`LibraryPage.vue`、`crates/media-core/src/preview.rs`、`crates/persistence/src/media_previews.rs`、`apps/server/src/media_titles.rs`。新增浏览器审计回归、几何 fixture、宿主机/Linux 几何验证及前向修复脚本；产品测试支持显式选择独立镜像。

## 2. 红灯到绿灯证据

证据根目录：`C:/Users/ALIENWARE/Desktop/杂项/RainSync-library-player-audit-fix-20260929`。

`logs/<名称>.json` 保存实际命令/参数、起止时间、退出码、是否超时，`.log` 保存标准输出/错误。`acceptance-manifest.json` 列出最终采用结果及日志 SHA256。红灯日志为预期失败，不能当作修复通过。

| 检查 | 修复前/边界失败 | 修复后证据 |
| --- | --- | --- |
| 个人/全站 focus→并发改名→保存，图片同版本 focus/手动恢复 | `audit-ui-red`：4 个桌面测试失败；实际使用 revision 2 而非 1，或无图片重载 | `audit-ui-final`：16 项桌面/手机通过，包含既有冲突/丢响应/清除/持续播放元信息回归 |
| 无关详情刷新不触发图片重试 | `image-retry-bound-red`：2 个测试收到第二次图片请求 | 完整浏览器和 `audit-ui-final` 通过；两次失败间跨过 2 秒轮询周期仍不新增 GET，不为 ready 图片发生成 POST |
| 紧凑待播按钮不被裁切 | `compact-image-red`：桌面/手机按钮底部均越过缩略图边界 | `audit-ui-final`：真实 DOM boundingBox 检查通过，点击仅增加一次图片请求 |
| 写入快照不被更新缓存替换 | `rename-snapshot-red`：恢复原返回缓存语句后，得到 later writer 而非 my draft | `frontend-unit-final`：56/56 通过 |
| 成功响应前已有后续写入 | `superseded-save-red`：个人/全站均错误提示成功，没有展示草稿冲突 | `browser-acceptance`：两作用域、桌面/手机均验证提示、最新值、保留草稿及手动再保存 |
| SAR 几何 | `geometry-red`：真实输出 88×126，预期约 89×89，断言失败 | `geometry-green` 与 `geometry-linux`：真实认证图片中图案比例通过 |
| 配方升级与前向修复 | `forward-fix-red`：旧程序仍将配方 1 封面返回 ready，断言失败 | `forward-fix-green`：真实旧版→新版二进制切换通过，详见下一节 |

几何测试使用四组手算期望值，白色图案像素阈值 >200，边长允许 3px 解码/重采样误差，不只是检查输出尺寸。Windows 与 Linux 输出一致：

| 输入编码尺寸 / SAR / DAR | 期望显示图案 | 实测 |
| --- | --- | --- |
| 720×576 / 64:45 / 16:9 | 约 89×89 | 88×88；原版为 88×126 |
| 720×576 / 16:15 / 4:3 | 约 89×89 | 88×88 |
| 640×360 / 1:1 / 16:9 | 100×100 | 100×100 |
| 360×640 / 1:1 / 9:16 | 约 178×178 | 176×178 |

每张输出还验证认证读取 200、RIFF 长度、解码后的 640×360 RGB 字节数和 256KiB 限额。预览过程不新增 playback_sessions。

## 3. 隔离前向修复实测

`baseline-binaries` 在未修改后端源码时重新构建审计 HEAD，复制 Server/Worker 到本轮 `baseline-bin` 并保存 SHA256。随后使用同一专属 PostgreSQL fixture：

1. 基线 Server 注册合成 local 媒体，保存个人/全站名称，各 revision=1；基线 Worker 生成配方 1 的 88×126 错误封面。
2. 只停止该 fixture 的旧 Server/Worker，切换为本轮修复二进制，继续使用该专属数据库。
3. 原登录会话仍能读取双层名称；名称与 revision 保留，`_sqlx_migrations` 全部版本及 checksum 完全相同。
4. 旧封面 URL 返回 409；详情 cover=missing。请求后新 Worker 按配方 2 生成不同 revision 的 88×88 图片；playback_sessions 仍为 0。

这证明已实施基线 `ae88f9f` 到本修复的前向路径，而非仅重启同一二进制。它不证明早于名称/预览迁移的旧后端能运行新库，也不证明不同配方的 Server/Worker 可混跑。两端应使用相同配方；旧 Server 可能重新入队配方 1，不能将该测试解释为滚动降级兼容承诺。

本轮新建独立镜像 `rainsync-audit-fix-fixture:20260929`，使用现有 `deploy/Dockerfile` 作为输入但未修改/提交它。第一次构建在 Docker Hub 鉴权取 token 时网络失败；仅 build args 不够，补上 Docker 客户端进程内 `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7897` 后成功。容器构建步骤使用 `http://host.docker.internal:7897`。未修改全局代理、Docker Desktop 设置或重启 Docker。

`geometry-linux` 使用新镜像启动专属 Server/Worker，记录容器内 FFmpeg 5.1 版本并通过四组几何测试；`preview-products` 在新镜像下重新验证真实 Jellyfin 10.11.0 与 Emby 4.10.0.40 的扫描、Backdrop 优先和静态视频回退。所有容器、网络、挂载、数据库和端口均为本任务拥有。

## 4. 本轮验证命令与结果

所有命令先执行 `scripts/validation-env.ps1`，ArtifactRoot 使用上述专用目录。为增量构建，显式复用外部 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-library-player-audit-20260929/cargo-target`；旧二进制先复制留存。浏览器使用已有 `C:/Users/ALIENWARE/AppData/Local/ms-playwright`。其余临时输出均在本轮证据目录。没有读取用户 .env 或继承其数据库地址用于 fixture。

以下实际命令均由 `node scripts/run-check.mjs <日志名> <超时秒> ...` 执行，退出码均为 0；完整参数在相应 JSON 中：

| 日志名 | 命令 / 验证内容 | 结果 |
| --- | --- | --- |
| patched-binaries | cargo build --workspace --bins --examples --locked | 通过 |
| rust-format | cargo fmt --all --check | 通过 |
| rust-unit | cargo test --workspace --locked | 57 通过，2 个子进程 fixture 入口 ignored |
| frontend-unit-final | node node_modules/vitest/vitest.mjs run | 56/56 |
| frontend-build-acceptance | cmd.exe /d /c npm.cmd run build | 类型检查与生产构建通过 |
| browser-acceptance | node node_modules/@playwright/test/cli.js test --config playwright.polish.config.ts | 134 通过、2 跳过、0 失败 |
| titles | node tests/media-titles.mjs | 真实双层名称权限、CAS、重扫保留通过 |
| preview-queue | node tests/media-previews.mjs | 真实队列去重/容量、租约/attempt/source、LRU、认证/ETag、重启通过 |
| preview-sources | node tests/media-preview-sources.mjs | local 顺序黑帧/暗/损坏/竖屏、HTTP Range/HLS/拒绝跨源与挂起、真实 NAS relay/恢复/撤销通过；此脚本上游 Jellyfin/Emby 为协议 fixture |
| geometry-green | node tests/media-preview-geometry.mjs | 宿主机真实 Server/Worker 四组内容几何通过 |
| geometry-linux | node tests/media-preview-geometry-linux.mjs | 新 Linux Server/Worker + FFmpeg 5.1 四组内容几何通过 |
| forward-fix-green | node tests/media-preview-forward-fix.mjs | 真实旧→新二进制同库切换通过 |
| patched-linux-image-proxy | docker build -f deploy/Dockerfile -t rainsync-audit-fix-fixture:20260929，使用记录中的代理参数 | 新独立镜像构建通过 |
| preview-products | node tests/media-preview-products.mjs | 新 Linux 镜像与真实 Jellyfin/Emby 产品联调通过 |
| real-player | node tests/library-player-real.mjs | 两真实测试用户改名、同步播放/聊天；跨路由/改名/全屏保持同 video、WS、申请数与 DB session 数 |

额外环境：Linux/产品脚本设置 `RAINSYNC_PREVIEW_IMAGE=rainsync-audit-fix-fixture:20260929`；前向脚本设置 `RAINSYNC_BASELINE_BIN=<本轮证据目录>/baseline-bin`。脚本拒绝缺失的关键参数，fixture 自建随机数据库；不能拿用户服务代替。

保留非失败警告：Vite 外部输出目录不自动清空、主 JS chunk 约 831kB（gzip 272kB），Playwright 的 NO_COLOR/FORCE_COLOR 提示。未借此升级依赖或扩大重构范围。

## 5. 提交、保护范围与回退

代码/测试提交：`fdcfd306bc41872b4723a41c928b8eb75647466b`（`fix: preserve rename drafts and recover proportional media previews`）。成功响应已被后续写入覆盖的额外保护及其回归与报告一起提交；该收尾提交的准确 SHA 由最终回复及 `git log` 提供。所有 Author/Committer 均使用 `Rainfrost <luo005962@gmail.com>`，不修改全局 Git 身份。

先核对项目 AGENTS、分支、HEAD 和未提交改动；cgraphy 不可调用，采用常规检索与范围限定 diff。没有委派子代理或创建新会话。仅逐项暂存任务源码/测试/文档；用户 `deploy/Dockerfile` 和三个原删除不暂存、不恢复、不覆盖。没有 reset --hard、推送、PR、部署、外部消息或效果图。

`ownership-before.json` 与 `ownership-final.json` 对比原容器 ID、8088/5099 监听 PID、Dockerfile SHA256、Git 状态。最终资源核对：原有五个容器 ID 不变，8088 PID 25668/28292、5099 PID 752 不变；无本任务二进制或 5198 Vite 进程，5198 无监听，Docker 仅保留原有网络。Dockerfile SHA256 保持 `C567DB9DD4C6CA56C62D7F4591976FCD838782D512C6E4DE9BBA6B12C45CB5BD`。文档提交后再更新该 JSON 中的最终 HEAD/工作区状态。清理只针对 fixture 保存的子进程、随机容器和网络；保留合成输入、日志、基线二进制、外部构建缓存和独立测试镜像供复查。

本轮没有 SQL 迁移变更。若用户将来决定回退，可按实际 `git log` 逆序 revert 本轮文档提交和修复提交；这会重新引入审计问题，并恢复旧配方。不要盲删名称表/迁移记录，不要使用硬重置。优先保留这些修复并作前向修正；本报告仅描述代码依赖与已测边界，没有执行或授权用户服务上的回退/部署。

## 6. 未验证与保留边界

- 无 Safari/iOS/Android 实机；手机测试为 Chromium 仿真。完整浏览器仍跳过手机标准全屏及全宽抽屉外部点击两项。
- 无长期弱网、大型媒体库负载、HDR、复杂旋转矩阵、极端 SAR/全部编码组合验证；本轮几何覆盖表中四种合成输入。
- 新增改名竞争回归为真实 Vue/Chromium + 可控 API；后端 CAS 与双用户播放另有真实数据库测试，没有将浏览器 fixture 冒充真实并发客户端复现。
- 真实 Jellyfin/Emby 本轮覆盖 Backdrop 优先与无封面静态回退；Primary-only 真实产品分支、依赖上游动态转码才能取得视频的资源仍未验证。
- 没有实测旧于名称/预览迁移的后端回滚，也没有实测新旧配方混跑。T9 缺失项用上述独立前向修复路径补齐。
- 原实施中的独立 Worker 故障注入、全套 relay/取消脚本和旧库迁移 1–22→23/24 测试本轮未全部重跑；本轮重跑范围以第 4 节为准，不复用历史数字冒充本轮结果。
