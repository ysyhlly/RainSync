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
| T1 双层名称 | 待执行 | |
| T2 预览任务 | 待执行 | |
| T3 真实解码 | 待执行 | |
| T4 选择器/抽屉 | 待执行 | |
| T5 配色 | 待执行 | |
| T6 媒体资料 UI | 待执行 | |
| T7 播放器 | 待执行 | |
| T8 综合回归 | 待执行 | |
| T9 报告/提交 | 待执行 | |

每个 logs/NAME.json 记录命令、时间、退出码；同名 .log 保存真实输出。只在实际验证通过后更新检查点。

