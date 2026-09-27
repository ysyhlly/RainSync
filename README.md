# RainSync

自托管同步观影平台，Rust 控制服务 + 独立媒体 Worker + NAS Agent + Vue Web 客户端。

当前为 **v0.1.0-alpha.1 开发预览**，不是完成全部 24 周验收的正式版本。已实现代码与尚未完成的验收见 [实施状态](docs/STATUS.md) 和 [发布说明](CHANGELOG.md)。此版本仅发布源码，不提供已验收的生产镜像。

## 本地启动

需要 Docker Compose 和 Node.js 24。首次构建会下载 Rust、FFmpeg 和前端依赖。

```sh
git clone https://github.com/ysyhlly/RainSync.git
cd RainSync
node scripts/setup.mjs
docker compose up --build -d
```

访问 http://localhost:8088；首次管理员密码保存在 `.runtime/login.txt`，配置保存在 `.env`。脚本不会覆盖已有配置。把影片放在 `media/`，登录后添加本地片源 `/media`，点击检测并扫描。

公网部署时设置 `PUBLIC_ORIGIN=https://你的域名`、`SITE_ADDRESS=你的域名`、`HTTP_PORT=80`、`HTTPS_PORT=443`。PUBLIC_ORIGIN 必须与浏览器地址完全一致，包括端口；登录和 WebSocket 都会校验 Origin。默认未开放公开注册，由管理员创建观看账户，再通过房间邀请加入。

## NAS Agent

1. 管理界面创建 Agent，取得 10 分钟有效的一次性配对码。
2. 在 NAS 配置 `SERVER_URL`、`PAIR_CODE`、`MEDIA_PATH` 和 `RAINSYNC_IMAGE`。
3. 运行 `docker compose -f deploy/agent.compose.yaml up -d`。
4. Agent 凭据保存在 `/state/credentials.json`，重启复用；管理员可撤销设备。

Agent 与 Server 应同时升级到分页索引协议：每页确认后继续发送，完整批次提交才更新片库；扫描/发送失败自动重连。完整重扫中消失的文件会从可用片库移除，历史会话引用保留。

Agent 仅主动建立连接。支持经 Worker 中继直放、探测、转封装和基础转码。NAS 的上行和中继出口仍需要容纳视频流量。

## 开发与验证

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo run -p protocol --example export
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:e2e
cargo build --workspace --bins --examples
node tests/integration.mjs
```

集成测试会创建并删除**独立的随机命名 PostgreSQL 容器**，占用本机 15439、18080–18082 端口，不使用或修改已有数据库。浏览器布局测试使用受控 API/WebSocket 样本，与真实后端集成测试分开报告。

Windows 本地后端开发需 PostgreSQL、FFmpeg/ffprobe；运行二进制前设置 `.env.example` 中的环境变量和 `DATABASE_URL`。Vite 默认代理控制服务 8080、媒体服务 8081。

## 文档

- [架构与工程约定](docs/ARCHITECTURE.md)
- [实施状态与后续里程碑](docs/STATUS.md)
- [部署、备份与验证](docs/OPERATIONS.md)
- [本轮验证记录](docs/VALIDATION.md)
- [完整计划验收台账](docs/ACCEPTANCE.md)
- [后续详细计划](docs/NEXT_PLAN.md) / [全计划实施进度](docs/PROGRESS.md)
- [错误契约与客户端升级](docs/API_ERRORS.md)
- [播放请求幂等与恢复](docs/PLAYBACK_REQUESTS.md)
- [开发贡献指南](CONTRIBUTING.md)

媒体源凭据采用 AES-256-GCM 加密。**数据库备份必须与 SOURCE_ENCRYPTION_KEY 一起保存**，否则无法恢复已配置的片源凭据。原始媒体和缓存不进入数据库。

## 许可证

源码使用 [GNU AGPL-3.0-only](LICENSE)。第三方依赖遵循各自许可证。
