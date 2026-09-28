# 播放循环、片源扫描与交互动效交付报告

日期：2026-09-29（Asia/Shanghai）。分支：`front/rainsync-implementation`。
起点：`50c71fb2a3ce92ca38be94da638fd89b3eeb5477`。

本轮按用户最后确认的规则实施，并已同步本地 RainSync server/web。没有重做历史 Goal 已完成的功能。所有测试写入独立数据库和合成媒体，不使用部署账号或用户媒体。用户 Dockerfile 修改和三个原删除均保留。

## 1. 需求与结果

| 要求 | 实际行为 | 主要实现与验证 |
| --- | --- | --- |
| 视频结束自动接续 | 控制端确认视频真正结束，服务端校验权限、控制租约、revision 和 generation 后选择下一可用影片；末项回首项 | room-core、rooms、playback-runtime；真实 Chromium 自然播放结束及真实 WS 测试 |
| 列表保留、空列表循环当前 | 不消费或删除已播条目；列表为空重播当前影片；历史重复条目不会让自动接续卡住 | playlist-scan / playlist-real；重复条目修复有红绿证据 |
| 片尾按播放不再闪停 | 已到已知片尾或 ended 状态时 PLAY 从零开始，并增加 generation，使所有客户端重建当前媒体播放 | Rust 片尾重播红绿单测；真实 WS 重播 |
| 媒体库播放与加号 | 播放立即开始，服务端在状态提交事务中去重入列；加号保留，也去重；普通观看者原有控制权限不变 | persistence、rooms；并发添加五次返回同一个条目，真实 UI 选片后直接播放 |
| 扫描所有片源含 NAS | 管理员在媒体库和片源管理可发起；最多三路并发，逐源列结果；单行扫描相互独立 | source-scans.store、ScanAllSources；真实 Agent 和浏览器/单测 |
| NAS 手动扫描 | 复用控制连接，单扫描任务，匹配本次快照最终提交 ACK 后才报告成功；离线、旧版、忙、断线、失败、超时分别反馈 | agents、nas-agent；真实新增/删除文件扫描和旧版/断线协议测试 |
| 侧边栏关闭动效 | 右侧抽屉退出滑动/淡出，遮罩淡出；退出完成后才关闭 modal 和恢复焦点；减少动效时立即关闭 | AppDialog、motion.css；桌面/手机关闭和焦点回归 |
| 播放器与小窗进度 | 3px 细轨道，悬停/焦点 5px；进度平滑，拖拽期间取消平滑；小窗暖棕细线，手机也可拖动；全屏空闲 2 秒隐藏控件和鼠标 | PlaybackControls、player-overlay、player-chrome；浏览器、定时器单测、截图复核 |
| 导航悬停提示 | 未选中项悬停/键盘焦点显示较浅色块，不加流光；选中项原双渐变流光继续 5 秒线性匀速循环 | layout / motion；既有滑动回弹、双流光、减少动效回归通过 |

同时为自定义选择菜单和播放器设置面板加入出现动效、滑轨高度/滑块透明度过渡。页面切换、播放器控件显隐、导航弹性位移等已有动效保留。没有为后台操作增加虚构进度或延迟播放命令。

## 2. 播放协议与一致性

新增 v1 action：`END_MEDIA`，payload `{ position_ms: number }`。沿用 `command_id`、`expected_revision`、`media_generation`、`control_epoch`。

- 服务端拒绝过早、非有限数、暂停中、旧 revision/generation 或无控制权限的结束命令。已知时长允许 1.5 秒的容器/播放尾部差异；还检查房间时钟位置。
- 成功后 revision 和 generation 各增加一次，位置归零、状态 playing；下一影片的时长从数据库读取。普通用户不能借此取得控制权限。
- 同 command_id 重放返回原结果；同代的另一个结束命令不能再次推进。客户端在网络或租约更新后可重试，间隔至少两秒。
- 按房间列表的稳定顺序选择可见且 available 的影片；跳过不可用或被撤销 NAS 的媒体。旧重复条目按首次出现的位置参与自动循环，原行不被自动删除。
- 原 `CHANGE_MEDIA` 现在直接 playing，并在同一持久化事务中唯一入列；加号接口在房间/snapshot 锁内复用已有条目。
- 前端每次换代刷新待播显示。视频元素和房间 WebSocket 跨路由保留，换片必需的媒体播放 session 会按原机制取消/创建。
- 生成中的 HLS 前缀结束时，先读取 readiness；不完整则等待原 session 的生成范围，不能误当影片完成。既有 HLS 恢复、取消、字幕和时钟验证保持通过。

自动接续遵守现有房间控制权：需要具有控制权限的客户端在线并实际播放到结束；不是无人在线时由后台定时切片。浏览器禁止自动播放时仍显示既有“点击加入播放”。

协议 TypeScript 和 JSON Schema 由 Rust export 正常生成。无 SQL 迁移、表清空或依赖升级。

## 3. 扫描接口与 Agent 升级

新增 `POST /api/v1/agents/{id}/scan`，管理员、已认证、Origin/CSRF 保护。返回：

```json
{ "status": "complete", "count": 12 }
```

其他业务状态：`offline`、`unsupported`、`busy`、`disconnected`、`failed`、`timeout`。这些是扫描结果，不假装发生了成功扫描；界面对应明确中文说明。无效/撤销设备返回 HTTP 404，认证权限沿用现有错误契约。

新 Agent 连接后发送 `HELLO { manual_scan: true }`；服务器下发带 UUID snapshot 的 `SCAN`。Agent 扫描忙时回复 `SCAN_BUSY`，否则重置分块序号并启动一次有界索引扫描。服务端仅接受本次 snapshot 的最终入库 ACK 为完成；初始同步不能冒充手动扫描完成。旧 Agent 可以继续原连接同步/传输，但手动扫描提示升级。

扫描 HTTP 等待上限 120 秒；前端 125 秒请求超时。超时表示结果未确认，已经开始的 Agent 扫描可能继续，不能据此自动重发。连接断开时结束本连接待确认请求，部分索引事务按原机制回滚。连接登记在单 Server 进程内，适用当前单实例部署；不承诺跨多个 Server 的扫描路由。

本轮已构建新 Agent，并验证真实 Windows 原生 Agent 扫描。当前部署 Linux 镜像内含 release Agent；另导出：

`C:/Users/ALIENWARE/Desktop/杂项/RainSync-playlist-scan-motion-20260929/nas-agent-linux-amd64/rainsync-nas-agent`

SHA256：`A7BC6F2D58EC0314D5F4D43DA62166E7CFCE2B13CD9C6BCB2E5D5C694043707B`。

该文件为 Debian Bookworm Linux amd64 构建，不适用于 ARM 或 Windows。实际 NAS 架构、安装路径及进程管理方式尚未提供，因此没有替换外部 NAS 上的程序。升级时保留原 `SERVER_URL`、`MEDIA_ROOT`、`AGENT_CREDENTIAL_FILE`（或 `AGENT_TOKEN`）及原凭据；不需重新配对。NAS 如为其他架构，应在对应环境运行 `cargo build --release --locked -p rainsync-nas-agent`，或使用相应架构镜像。不要把本地测试凭据复制到设备。

## 4. 实际验证

证据根目录：`C:/Users/ALIENWARE/Desktop/杂项/RainSync-playlist-scan-motion-20260929`。
`logs/<name>.json` 记录实际命令、时间、退出码及超时状态；`.log` 是原始输出。最终采用结果与 SHA256 见 `acceptance-manifest.json`。

产物先由 `scripts/validation-env.ps1` 重定向到该目录。为增量构建复用外部 `RainSync-library-player-audit-20260929/cargo-target`。浏览器用已安装 Chromium；测试数据库、Server、Worker、Vite、Agent 均由 fixture 单独拥有并关闭。未读取部署数据库进行验证写入。

| 日志 | 实际检查 | 结果 |
| --- | --- | --- |
| backend-build-acceptance | cargo build --workspace --bins --examples --locked | 通过 |
| rust-acceptance | cargo test --workspace --locked | 58 通过，2 个上层启动的子进程 fixture ignored |
| clippy-acceptance | cargo clippy --workspace --all-targets --locked -- -D warnings | 通过 |
| protocol-check | cargo run -p protocol --example export --locked -- --check | 通过 |
| frontend-acceptance | Vitest | 58/58 |
| frontend-build-fixed / docker-web-acceptance | vue-tsc 与 Vite 生产构建；最终镜像再次执行构建 | 通过 |
| browser-acceptance | playwright.polish.config.ts 全套桌面/手机 Chromium 仿真 | 150 通过、2 跳过、0 失败 |
| legacy-queue-green | tests/playlist-scan.mjs | 真实 DB/WS 循环、去重、重复/过早结束；真实 Agent 新增/删除、离线；协议模拟旧版/忙/断线通过 |
| playlist-real-green | tests/playlist-real.mjs | 真实视频自然播放结束 → 下一条 → 首条；空列表在小窗重播；同 video、单房间 WS |
| player-continuity | tests/library-player-real.mjs | 两真实用户、双层名称、聊天/同步、跨路由/全屏保持播放通过 |
| integration | tests/integration.mjs | 完整真实接口/数据库/Worker/NAS、控制租约、幂等、队列、HLS、恢复与备份还原通过 |
| browser-real-final | tests/browser-real.mjs | 真实注册/资料/头像、双用户控制、跨路由和重启持久性通过 |
| docker-server-acceptance / docker-web-acceptance | 实际部署 Dockerfile 构建 Linux release 镜像 | 通过 |
| local-update | 更新 server/web 后读取首页、匿名账号接口和静态 JS | 200 / 401；实际 JS 包含 END_MEDIA 与扫描按钮 |

另实际执行 `cargo fmt --all --check`、`git diff --check`。构建保留既有约 835kB 主 JS chunk 提示；Playwright 有 NO_COLOR/FORCE_COLOR 环境提示。真实浏览器重启 Server 测试中短暂 ECONNRESET/ECONNREFUSED 是重启期间输出，测试最终通过。

红绿与发现：

- `replay-red`：原 PLAY 保留片尾位置导致新增单测失败；修复后 Rust 全套通过。
- `legacy-queue-red`：旧重复条目导致下一条仍是当前影片；增加循环候选去重后 `legacy-queue-green` 通过。
- 浏览器全套先发现单行扫描误禁用其他行，随后发现手机新增轨道使小窗遮住分页；分别修复按钮禁用范围和底部留白。最后完整 150/2/0。
- 第一次构建出现 Vue 内联 if 表达式错误，已改为具名动画回调；初版部分新测试也修正了接口数组结构、NAS 文件名不含扩展名、Vite HMR 不算房间 WS 等测试假设。失败日志保留，未当作通过。
- 严格 Clippy 暴露旧代码三处常量 chunks_exact 和一处复杂类型告警：在 preview.rs 做等价 as_chunks 迭代，在 preview_input.rs 提取 HttpValidators 类型别名；不改变预览配方/像素或传输协议，Rust 全套重新通过。

## 5. 本地同步与回退

更新服务：仅 `server web`，使用 `docker compose up -d --no-deps --no-build server web`。数据库、Worker、live-dashboard 容器 ID 保持原值，5099 监听仍为 PID 752。Worker 的本轮类型/迭代源码调整等价，不需要中断现有媒体传输重建 Worker。

新运行容器：server `f5548d991f2e`，web `dc1a3136e309`。
服务器镜像：`sha256:c95a29360ae86def9e4137da6257a12ffc0576db1d0ba0189edd99be1f24160f`。
前端镜像：`sha256:061b448b4919d77d253f2dc2240b0277c056f2a4a68efd14f26331d3ba061930`。
页面：`http://localhost:8088/`。因部署 Origin 配置，请使用 localhost。

更新前镜像保留为 `rainsync-server:rollback-playlist-20260929` 与 `rainsync-web:rollback-playlist-20260929`。仅在需要回退时执行：

```powershell
docker tag rainsync-server:rollback-playlist-20260929 rainsync-server:dev
docker tag rainsync-web:rollback-playlist-20260929 rainsync-web:dev
docker compose up -d --no-deps --no-build server web
```

本轮无迁移或配方变化；回退会移除自动循环/扫描等新能力，需前后端一起回退并刷新页面，不要让新前端反复向旧 Server 发送 END_MEDIA。未执行生产回退演练，不承诺已验证其所有播放中边界。镜像新版本还保留为 `rainsync-server:playlist-scan-20260929` 和 `rainsync-web:playlist-scan-20260929`。

构建代理仅在本轮进程/构建参数中配置：宿主 7897，容器使用 host.docker.internal:7897；无全局代理或 Docker Desktop 设置变更。保留用户修改的 Dockerfile 作为构建输入，不将其加入 Git。

## 6. 提交及保护范围

全部 Author/Committer：Rainfrost <luo005962@gmail.com>。

1. `0f47e7584720171743a69655e58a029b31253040`：后端循环、原子入列、NAS 手动扫描及接口集成验证；前端前的后端验收节点。
2. `ed59ecfc4371e1c2c619cf9386901a0d03e157a3`：前端接续、扫描、动效、旧重复队列保护、针对性/真实浏览器回归及 CI 接入。
3. 本报告及完成进度索引提交：准确 SHA 由最终回复/git log 提供，避免自引用。

源码回退按以上逆序 `git revert <报告提交> ed59ecf 0f47e75`；数据库不删表、不删迁移、不恢复旧快照。没有推送、PR、外部消息或新会话/代理委派。cgraphy 不可调用，采用普通源码/Git 范围检查，无 enrich/store。

保留的原工作区修改仅：`deploy/Dockerfile` 修改，以及 `oil-pumpjack.html`、`pelican-bike.svg`、`pumpjack.html` 删除。Dockerfile SHA256 始终为 `C567DB9DD4C6CA56C62D7F4591976FCD838782D512C6E4DE9BBA6B12C45CB5BD`。

## 7. 验证边界

- 手机为 Chromium 仿真；没有 Safari/iOS/Android 实机。本轮既有跳过为手机标准全屏和全宽抽屉外部点击。
- 未实测外部 NAS 安装/升级、ARM 镜像、超大型网络目录长期扫描或多 Server 实例。外部设备仍需换用新 Agent 才能使用手动扫描。
- 生成前缀结束防误跳为可控浏览器协议回归；自然结束联调用真实 progressive 视频。既有真实 HLS/relay 集成另通过，但未声称本轮实测所有长片编码的自然结尾。
- 生产侧只验证服务就绪和实际静态资产，不读取账号或替用户操作私人媒体；没有将隔离联调冒充用户数据库测试。
- 远程 CI 未运行；新增的 CI 测试步骤已本地按对应命令验证。
