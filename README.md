# RainSync

自托管同步观影平台，Rust 控制服务 + 独立媒体 Worker + NAS Agent + Vue Web 客户端。

当前为 **v0.1.0-alpha.1 开发预览**，不是完成全部 24 周验收的正式版本。已实现代码与尚未完成的验收见 [实施状态](docs/STATUS.md) 和 [发布说明](CHANGELOG.md)。此版本仅发布源码，不提供已验收的生产镜像。

## 现有部署升级前必读

**当前补强已在 main `399d699` 的独立本地工作树上整合。保留上游 0025/0026 预约/观测迁移，新增为 0027 房主、0028 生命周期、0029 清理，以及本轮 0030 旧 NAS 影响范围。此前 0027–0029 的 131 文件交付包和通过证据保留为历史；含0030的新源码绑定、基础与列明的最终组合复验全部通过；存量对账和真实环境门槛仍未解除，不能据此宣布发布就绪。**

本分支加入房间关闭/重开与真实资源释放回执。**未知旧 NAS 传输仍以 `legacy_agent_drain_unconfirmed` 阻挡其可能关联的房间关闭；0030 只豁免可证明在该传输之后创建的房间，不生成释放回执。0030 前已有的所有房间仍在旧记录的可能范围内，可能长期停在 closing；当前没有受支持的人工对账写入或 force-close 入口，这仍是受影响存量部署的升级/发布阻断。**

房间出生序号和旧传输的不可变范围上限由同一事务计数器排序，判断不依赖墙钟或 created_at。范围外的新房间仍须满足自身所有释放证明；晚到的旧 Worker INSERT 会取得当时的新上限，可能再次涵盖这些房间。停止旧服务、普通 Agent ACK 或记录过期不会清除未知项。升级仍须停止并排空旧组件，使用匹配的 Server/Worker/Agent；任意旧 Worker 在最终关闭检查后继续写入不在保证范围内。

无损诊断顺序：

1. 保全数据库、关联密钥、服务版本和日志，先在隔离恢复库验证；诊断材料不含密钥/令牌
2. 授权读取 `/api/v1/rooms/{id}/lifecycle` 的 epoch、revision、cleanup attempts/last_error/completed，保留准备、执行、Agent transfer 和上游身份等不可变 ID；legacy_agent_drain_unconfirmed 要在授权只读诊断中核对 rooms.cleanup_birth_ordinal 与旧记录 possible_room_cutoff，保留范围证据，不能只按 session 关联查找
3. 将完整 Agent 身份映射到全部主机/容器和服务管理器，禁止旧签发及自动重启并保留冻结的 legacy ID 集合；核对整个进程树的 supervisor 正向退出或可验证主机启动代次，再启配套组件。新心跳、在线状态、租约到期或 PID 不存在都不足以证明旧所有者退出
4. 核对已分发 Agent UUID 回执、上游 stop/操作确认，让仍能报告的当前版所有者完成回执后再观察状态。旧 24 小时清理可能已删除历史行，查不到旧记录也不等于旧资源已释放；当前没有用户生产环境完成上述核验的证明
5. 范围内无法证明的房间保持 closing，等待另行实现、审计和验证的对账方案。不删数据/迁移历史，不改序号/范围、不手填 ACK/reaped 或直接改 closed；当前未提供解除未知旧资源阻断的写入工具

仅输出 transfer ID/Agent ID/范围上限的管理员只读 SQL、验证和完整检查清单见 [第二阶段报告](docs/PHASE2_LIFECYCLE_NEGOTIATION.md) 与 [清理协议](docs/ROOM_CLEANUP.md)。当前候选的浏览器、部署镜像、真实硬件与长期发布门槛仍待验收。上游历史浏览器/镜像和两种各 60 分钟控制拓扑通过保留；NAS 两小时尝试在 103.2 分钟失败，不能写成从未运行或已经通过。原证据见 [计划审计](docs/PLAN_AUDIT.md) 和 [验证记录](docs/VALIDATION.md)。

## 本地启动

需要 Docker Compose 和 Node.js 24。首次构建会下载 Rust、FFmpeg 和前端依赖。

```sh
git clone https://github.com/ysyhlly/RainSync.git
cd RainSync
node scripts/setup.mjs
docker compose up --build -d
```

访问 http://localhost:8088；首次管理员密码保存在 `.runtime/login.txt`，配置保存在 `.env`。脚本不会覆盖已有配置。把影片放在 `media/`，登录后添加本地片源 `/media`，点击检测并扫描。

公网部署时设置 `PUBLIC_ORIGIN=https://你的域名`、`SITE_ADDRESS=你的域名`、`HTTP_PORT=80`、`HTTPS_PORT=443`。PUBLIC_ORIGIN 必须与浏览器地址完全一致，包括端口；登录和 WebSocket 都会校验 Origin。管理员可在“账号与注册”生成一次性注册邀请码，或手动创建普通账号；用户注册成功自动登录，再用独立的房间邀请加入放映室。无需邮箱或手机号。个人资料支持独立保存昵称与裁剪头像，固定登录账号不能修改。

界面已完整替换为浅色米色路由应用。离开观影页前往媒体库、管理或资料页时保持当前播放，底部显示迷你播放器。版本仍为开发预览，实际验证边界见[本次详细修改报告](docs/IMPLEMENTATION_REPORT.md)。

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
npm run test:accounts
npm run test:chat
# 真实浏览器联合验收须先指定外部输出目录。
# PowerShell示例见docs/BACKEND_OPERATIONS.md。
npm run test:browser-real
```

原集成测试创建并删除**独立的随机命名PostgreSQL容器**，占用本机15439、18080–18082端口，不修改已有数据库。`test:accounts`与`test:browser-real`须设置RAINSYNC_ARTIFACT_DIR，使用随机服务端口和独立数据库。浏览器布局/故障回归使用受控API/WebSocket；`test:browser-real`使用真实Server/Worker/数据库及合成视频，独立记录证据。

Windows 本地后端开发需 PostgreSQL、FFmpeg/ffprobe；运行二进制前设置 `.env.example` 中的环境变量和 `DATABASE_URL`。Vite 默认代理控制服务 8080、媒体服务 8081。

## 文档

- [当前：第二阶段生命周期、清理回执与实际媒体协商](docs/PHASE2_LIFECYCLE_NEGOTIATION.md)
- [房间生命周期](docs/ROOM_LIFECYCLE.md) / [关闭清理与旧库边界](docs/ROOM_CLEANUP.md)
- [实际媒体候选与有限回退](docs/PLAYBACK_CAPABILITIES.md) / [NAS 传输与释放回执](docs/AGENT_TRANSFERS.md)
- [第一阶段优先项修复与验证（历史）](docs/PRIORITY_REMEDIATION.md)
- [本次完整修改与验收报告](docs/IMPLEMENTATION_REPORT.md)
- [四项P2审计修复与新一轮回归](docs/AUDIT_FIXES.md)
- [账号接口与注册规则](docs/ACCOUNT_REGISTRATION_API.md) / [头像接口](docs/AVATAR_API.md)
- [升级与兼容回滚](docs/BACKEND_OPERATIONS.md)
- [前端架构](docs/FRONTEND_ARCHITECTURE.md) / [真实浏览器联调](docs/REAL_BROWSER_VALIDATION.md)

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
