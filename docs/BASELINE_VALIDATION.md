# 准备阶段与真实基线验证

起始基线：`13262053eb5f949a7e9dea6f2a11d2e1cbe7ce6e`。分支：`codex/rainsync-implementation`。

运行时间：2026-09-27 18:55–19:01 UTC（Asia/Shanghai 为 2026-09-28 02:55–03:01）。原始 JSON 保存开始/结束时间、命令、退出码和超时状态。

## 工作区保护与输出

保留用户开始时的三个删除：`oil-pumpjack.html`、`pelican-bike.svg`、`pumpjack.html`；未恢复、暂存或提交。无项目源码的其他原有修改。直接在新工作分支实施，当前改动与三个无关删除没有交集，不需要额外工作树。

`RAINSYNC_ARTIFACT_DIR` 指向 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28`。Cargo target、Vite/Vitest 缓存、Vite outDir、浏览器下载/报告/trace/截图、集成文件、TEMP/TMP、npm 缓存和 node_modules 实体均在此目录。项目 node_modules 仅为 junction，实际依赖在外部。

npm 11 的 `ci` 会用实体目录替换已有 junction；本次观察到这一行为后已把本任务新装依赖完整移回外部并重建 junction，核验其 workspace 包链接仍指向项目 apps/web。后续安装需再次核查此边界，不能只依赖环境变量。

原集成测试的输出根和 Server/Worker/七个 Rust example 二进制定位均支持外部目录。测试自行生成 PostgreSQL 容器和随机凭据，未连接或写入用户数据库；结束时删除自己的容器。Docker 内的数据库与备份均为随容器销毁的测试数据，不作用户部署。

## 执行结果

以下命令通过 `node scripts/run-check.mjs NAME TIMEOUT_SECONDS ...` 执行。证据路径为 ARTIFACT/logs/NAME.{log,json}。

| NAME | 实际检查 | 结果 |
|---|---|---|
| baseline-install | 现有锁文件 `npm ci --no-audit --no-fund` | 0，84 个包；未升级依赖 |
| baseline-rust | `cargo test --workspace --locked` | 0，50 测试通过；2 个原有子进程 fixture 标记 ignored，由监督测试启动，不当作额外通过 |
| baseline-fmt | `cargo fmt --all --check` | 0 |
| baseline-clippy | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 0 |
| baseline-protocol | `cargo run -p protocol --example export -- --check` | 0，未手改生成物 |
| baseline-binaries | `cargo build --workspace --bins --examples --locked` | 0 |
| baseline-unit | `node node_modules/vitest/vitest.mjs run` | 0，4 文件/31 测试通过 |
| baseline-types | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json` | 0 |
| baseline-build | `node node_modules/vite/bin/vite.js build apps/web` | 0，外部 web-dist；既有大于 500kB 单块提示仍在，不隐藏提示 |
| baseline-browser-install | Playwright `install chromium` | 0，浏览器在外部目录 |
| baseline-browser-fixed | Playwright `test` | 0，桌面/移动 Chromium 共 38 测试通过 |
| baseline-integration-ready | `node tests/integration.mjs` | 0，真实 Server/Worker/PostgreSQL；原有集成断言全部通过 |

集成覆盖：数据库队列公平性/容量/回滚/行锁、缓存租约/配额/发布/清理、原有认证和房间邀请、双客户端广播、控制纪元/幂等/权限/聊天、HTTP Range/HEAD、媒体/音轨/字幕路径、NAS 配对与 10001 条分页索引、撤销及续传清理、进程重启、pg_dump/pg_restore。100 个本地控制连接收到快照用时 194ms，属于本地冒烟，不能推断长期负载能力。Jellyfin/Emby 段是受控上游协议测试，不是外部真实产品联调。

## 初始失败和修复

1. `baseline-integration` 退出 1：Docker 初始未启动，启动后首次获取 postgres:17 遇到 Docker Hub OAuth EOF。独立有界 pull 重试成功，再运行完整集成测试成功。证据保留 `baseline-postgres-pull`，未修改镜像源或用户代理设置。
2. `baseline-browser` 为 36 通过/2 失败：外移 Vite 缓存后 HLS 模拟器仍拦截固定 node_modules 路径，trace 显示实际请求为外部 `/@fs/.../vite-cache/deps/hls__js.js`。修改测试拦截器为依赖文件路径匹配，保留所有加载次数、恢复次数、错误和会话断言，完整重跑 38 通过。这是本次验证设施迁移引入并已修复的问题，非产品功能回归。

未发现需要在此阶段修改业务代码的既有失败。未执行实机 Safari/iOS/Android、长期或弱网验证，未把 Chromium 移动模拟当实机。

## 环境

Windows、Rust/Cargo 1.98.1、Node 24.19.0、npm 11.17.0、Docker daemon 29.8.0；PostgreSQL 测试镜像 postgres:17（本次 digest `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`）；FFmpeg 已检测到 libwebp 编码器。Git 无作者配置，本次提交命令使用 Codex <codex@localhost>，不修改全局配置。

当前文档仅证明准备阶段基线通过，不代表注册、头像或新前端已经实现。
