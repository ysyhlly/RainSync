# RainSync

自托管同步观影平台：Rust Server、独立媒体 Worker、主动出站 NAS Agent 和 Vue Web 客户端。
这是源码开发预览；源码、离线检查或短期测试不代表生产发布已完成验收。

## 本地开发

需要 Rust stable、Node.js 24、Docker Compose 和 FFmpeg/ffprobe。
首次本地开发可运行：

```sh
node scripts/setup.mjs
docker compose up --build -d
```

访问 http://localhost:8088。开发脚本在本机生成 `.env` 和 `.runtime/login.txt`，不覆盖已有配置；这些文件不要提交或公开。
把测试媒体放在 `media/`，登录后添加本地片源 `/media` 并扫描。生产安装应使用下面的交互式首个管理员初始化，不使用开发脚本生成的管理员密码。

配置数据库密码、`SOURCE_ENCRYPTION_KEY`、媒体目录和与浏览器地址一致的 `PUBLIC_ORIGIN`。
数据库备份必须与加密密钥安全保存，否则已配置的片源凭据无法恢复。升级已有安装前备份并检查迁移与旧组件兼容性，不混用不同版本的 Server、Worker、Agent。

片源管理支持确认删除本地、HTTP、Jellyfin 和 Emby 共享片源。删除会移除配置及媒体库入口，
保留房间历史和播放列表引用，不删除原始媒体文件。正在播放或准备播放的片源须先停止相关播放。
NAS 片源通过 NAS 设备页面撤销；所属媒体库中的片源继续受该媒体库权限管理。

## 已导入运行镜像接口

运行镜像工作流输出压缩镜像包、`manifest.json` 和 `SHA256SUMS`。令 `EXPECTED_SOURCE_SHA` 为选择的精确 40 位 Git 提交 SHA，`ARTIFACT_DIRECTORY` 为该包所在目录：

```sh
python3 deploy/runtime-images.py verify --source "$EXPECTED_SOURCE_SHA" --directory "$ARTIFACT_DIRECTORY"
```

校验成功后再由安装负责人加载镜像；追加 `--daemon` 可只读核对已加载的本地镜像和离线程序契约。校验命令不会拉取、加载或启动服务。
将经核对的本地镜像 `sha256:` ID 设置为 `RAINSYNC_BACKEND_IMAGE`、`RAINSYNC_WEB_IMAGE`、`RAINSYNC_POSTGRES_IMAGE`。
设置 `RAINSYNC_DATABASE_PATH`、`RAINSYNC_CACHE_PATH`、`MEDIA_PATH` 为预先准备、符合辅助工具约束的绑定目录；自动创建宿主目录已禁用，Server 和 Worker 必须共享同一缓存目录。

使用相同的项目名、环境文件和 Compose 文件顺序执行配置检查、数据库启动、管理员初始化及普通服务启动：
`compose.yaml`、`deploy/imported-images.override.yaml`、`deploy/loopback.override.yaml`。
导入配置禁止自动构建和拉取镜像。`RAINSYNC_LOOPBACK_PORT` 控制本机回环端口；公网代理与 TLS 需单独配置。

使用 Nginx 作为公网代理时，在转发 RainSync 的 `location` 中包含
`deploy/nginx-playback.inc.conf`（使用发布目录的绝对路径）。该配置关闭继承的代理缓存，
并保留 `Range`、`If-Range` 请求头。Nginx 启用代理缓存时默认移除这些请求头，
即使上游返回 `Cache-Control: no-store`，DASH 索引请求也可能收到整个视频并导致黑屏。
上线时应通过公网入口验证非零字节范围返回 `206`、正确的 `Content-Range` 和对应长度的响应体。
参见 [Nginx 请求头转发说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。

启动该项目的数据库后，在安装负责人自己的交互式终端中运行同一组 Compose 选择器的
`run --rm --no-deps server rainsync-server init-admin --username NAME`，再启动 Server、Worker、Web。
负责人亲自输入并提交两次密码；不要把密码放入环境变量、命令、管道或日志。
详见 [首个管理员初始化](docs/INTERACTIVE_ADMIN_BOOTSTRAP.md)。此命令拒绝重定向输入及已有账号的安装，不重置已有账号。

## NAS Agent

在管理界面创建 Agent，取得一次性配对码；配置 `SERVER_URL`、`PAIR_CODE`、`MEDIA_PATH` 和 `RAINSYNC_IMAGE`，然后运行 `docker compose -f deploy/agent.compose.yaml up -d`。
Agent 凭据保存在其状态目录，重启复用；管理员可撤销设备。Server 和 Agent 应使用匹配版本。

## 开发检查

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm ci
npm test
npm run build
python3 tests/runtime-images.test.py
```

集成或部署测试只用于独立测试实例；按各脚本要求配置测试资源及外部输出目录，不使用已有生产数据库。
`npm run test:source-deletion` 在隔离 PostgreSQL、Server 和真实 Vue/Chromium 中检查删除、取消、
播放中提示、权限、事务回滚和延迟扫描；需先构建 Server，设置 `CARGO_TARGET_DIR` 和
`RAINSYNC_ARTIFACT_DIR`，并准备 FFmpeg 和 Chromium（可用 `RAINSYNC_CHROMIUM_EXECUTABLE` 指定路径）。
四个可选 Static HLS Docker 测试入口需要显式设置本地镜像、Cargo 注册表及配置路径；两个固定镜像校验入口还要求 `RAINSYNC_NATIVE_TEST_IMAGE_ID`、`RAINSYNC_SQL_POSTGRES_IMAGE_ID`。缺少或格式不正确的配置会在执行外部命令前失败。

## 文档与许可证

- [错误契约](docs/API_ERRORS.md)
- [Bilibili 直播](docs/BILIBILI_LIVE.md) 与 [直播间控制](docs/BILIBILI_LIVE_ROOM_CONTROLS.md)
- [媒体库扫描](docs/LIBRARY_SCANNING.md)
- [平台合集导入](docs/PLATFORM_COLLECTION_IMPORT.md)
- [传输指标契约](docs/TRANSPORT_METRICS_CONTRACT.md)

本源码分发保留产品使用与契约文档。部分契约引用的独立验证或审计材料未包含在此分发中。
源码使用 [GNU AGPL-3.0-only](LICENSE)；第三方依赖遵循各自许可证。
