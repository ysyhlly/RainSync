# 媒体库与播放器实施进度

执行日期：2026-09-29（Asia/Shanghai）。按 `superpowers/plans/2026-09-28-library-player-polish.md`，当前会话执行，不委派、不推送、不部署。

## T0 起点和资源所有权

- 分支：`front/rainsync-implementation`；初始 HEAD：`75c45d82f784ad6f2bf60241c67f65544627faef`。
- 本地 Git 作者/提交者：Rainfrost `<luo005962@gmail.com>`。不修改全局配置。
- 既有修改：`deploy/Dockerfile`；既有删除：`oil-pumpjack.html`、`pelican-bike.svg`、`pumpjack.html`；既有未跟踪计划文件为本次实施依据。四项用户变更不得暂存。
- Dockerfile 初始 SHA256：`C567DB9DD4C6CA56C62D7F4591976FCD838782D512C6E4DE9BBA6B12C45CB5BD`。
- 唯一新产物根目录：`C:/Users/ALIENWARE/Desktop/杂项/RainSync-library-player-polish-20260929-impl`。日志、缓存、构建、数据库 fixture 和浏览器证据均在其中。
- 只读服务清单：`services-before.txt`、`processes-before.json`；8088 对应 Docker 服务，5099 为 PID 752。不操作这些服务。
- Docker 29.8.0 可用。浏览器使用已有 `C:/Users/ALIENWARE/AppData/Local/ms-playwright` 安装，测试使用临时资料，不连接用户浏览器。
- `playwright.polish.config.ts` 继承桌面/手机项目与外部报告配置，使用经检查空闲的 5198、strictPort、禁止服务复用，API/Worker 漏拦截代理到 127.0.0.1:1。
- 后端使用 `isolatedServer`：随机容器名、独立 PostgreSQL、随机密钥、动态端口、finally 清理；不接受用户 DATABASE_URL。
- cgraphy 工具不可调用，按计划回退到常规源码检查。

## 检查点

| 检查点 | 状态 | 证据/备注 |
| --- | --- | --- |
| T0 基线 | 已核实 | Rust 56 通过/2 忽略；前端 47 通过；类型构建通过；浏览器 103/104，NAS 单例复跑通过（busy/Escape 时序），T4 补就绪等待 |
| T1 双层名称 | 已验证 | titles-red 真实接口 404；titles-green 通过；titles-rust、titles-protocol-check 通过。local 真扫描、Jellyfin/Emby 协议 fixture 扫描、NAS WebSocket 索引与 Server 重启覆盖；真实上游留待 T3 |
| T2 预览任务 | 核心路径通过，扩展审查继续 | previews-red、preview-races-red 暴露路由/容量缺陷；previews-bind-green 验证去重、领取、租约、旧 attempt/source 拒绝、LRU 预算和认证图片；preview-sources-reuse 五类读取路径通过 |
| T3 真实解码 | 部分通过/环境限制 | 合成帧像素、黑/暗/损坏/竖屏、Range/HLS、真实 NAS、上游协议 fixture 通过；previews-container 验证 Bookworm 5.1 编码。preview-image-build 因 Docker Hub 认证超时失败；新 Linux Worker 和真实 Jellyfin/Emby 产品未验证 |
| T4 选择器/抽屉 | 实现/基本回归通过 | selection-red 3 个预期失败；selection-final 25 通过、手机全宽外部点击跳过，字幕文本断言适配后 selection-subtitle-final 2/2；admin 16 项已通过。全屏层级随 T7 验证 |
| T5 配色 | 通过 | cream-layout 桌面/手机六宽度、登录注册/全部管理页/抽屉/媒体库/房间/资料页和真实计算颜色通过；cream-build 通过。硬编码扫描仅剩主题 token、有意遮罩和中性视频留边 |
| T6 媒体资料 UI | 待执行 | |
| T7 播放器 | 待执行 | |
| T8 综合回归 | 待执行 | |
| T9 报告/提交 | 待执行 | |

每个 logs/NAME.json 记录命令、时间、退出码；同名 .log 保存真实输出。只在实际验证通过后更新检查点。


## T6 — 媒体资料与重命名（2026-09-29）

- 实现按身份 epoch 隔离的 catalog、双作用域版本合并、预览请求序号、可见卡片批量请求和 60 秒停止等待/手动重试。
- 卡片提供个人/管理员全站改名，冲突保留草稿，网络失败读回核验；直接进入房间按媒体 ID 读取标题，改名不调用媒体重载。
- `catalog-browser2` 四项桌面/手机测试通过；`catalog-unit-final` 全部单测通过；`catalog-ui-build2` 类型和生产构建通过。
- 后续真实双用户 `library-player-real` 已通过：预览前无播放 session，改名/路由/全屏全过程同 video、同连接、同播放申请数和数据库 session 数。
- 7897 代理通过任务进程环境及 Docker build args 使用；独立镜像构建 `preview-image-proxy` 成功。未修改 Docker Desktop 配置或用户服务。


## T7 — 持久播放器与显隐（2026-09-29）

- 普通片名/房间/控制信息移至右侧聊天顶部；单列/手机放在视频下和分段标签上方。视频 DOM 仍位于原 video-frame，AppShell 仍在 RouterView 外持有运行时。
- 增加纯 UI 状态机：桌面 hover、触摸切换、真实全屏 5000ms、菜单/拖动/键盘独立锁、退出/隐藏/销毁清理。设置内容保持在播放器子树，通过 Popover 解决小屏裁剪和全屏层级。
- `chrome-browser-red` 在未实施时失败；`chrome-final` 17 通过/1 手机全屏跳过；`browser-polish-final2` 完整 118 通过/2 跳过；`frontend-build-final2` 构建通过。
- 五秒边界浏览器测试采用暂停的 Playwright clock，消除 4999ms 检查时真实时间继续前进的测量误差。真实 document.fullscreenElement、计算 opacity/cursor、倍速命令、退出和 DOM 身份均有断言。
- 真实联调 `library-player-real` 成功；最终报告将补列音轨/字幕在真实产品全屏中的验证范围，不把模拟接口等同产品联调。
