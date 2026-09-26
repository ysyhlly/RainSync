# 本轮验证记录

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
