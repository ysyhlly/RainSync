# B / W03 本批交接

功能分支 `codex/b-upstream-v01` 从总控精确基线
`252100dee29cf4d13df00cbda55f0fa4814deb25` 创建；已完整读取
`docs/PARALLEL_CONTRACT_V01.md`。旧分支 `codex/b-upstream` 的
`7a2f55afdf145480b959c99343f081ba52918b0e` 仅保留历史，不用旧基线通过
替代本批验证。没有修改 main、协作分支、协议、任何迁移、共享入口、锁文件、CI
或总台账；没有推送、合并或部署。

## 可直接集成的生产修复

固定真实 Emby `4.10.0.40` 的 `DELETE /Videos/ActiveEncodings` 返回 204。
原 `apps/server/src/upstream.rs` 只接受 200，会将成功的第二步持续记作未确认，
最终耗尽清理预算。本批复用既有 `providers::checkin_confirmed`，接受 200/204；
202、重定向及错误仍不能形成执行完成证明。

预约、SID/DeviceId 绑定、先持久化后发布、Stop 与编码停止的独立收据、迟到结果
不确定性、来源公平性和五次/六十秒预算均保留。受控持久化用例使第一次编码停止
503、第二次 204，验证 Stop 只调用一次、编码停止重试两次且收据落盘；该回归
使用本批实际 Server 二进制，区别于下面尚未接线的适配模块。

## 等总控接线的独立模块

新增 `crates/providers/src/jellyfin.rs`、`emby.rs`、`upstream_common.rs`。
它们复用当前 `SourceConfig`、`PlaybackOptions`、HTTP 客户端与身份头；没有新公共
字段或第二预约账本。Jellyfin `PlaybackInfoDto` 与 Emby `PlaybackInfoRequest`
分别有入口，当前受限 Web 请求模型相同，依据各产品官方契约，不凭扩展名选路线。

模块在发出请求前拒绝非法位置/溢出 ticks、超出 int32 的音轨索引、缺凭据及无运输
选项；PlaybackInfo 完整回包（包括不兼容回包中的 SID）继续交预约执行者先保存。
浏览保留分页与总数校验，增加排序、重复 ID 检测和时长校验；401/403、中断或重复
页不能作为成功空库或部分结果返回。排序及这些检查不等于上游提供原子库快照。

公共 `providers/lib.rs` 没有改。总控的最小接线建议：声明私有
`mod upstream_common`、公开两个产品模块，将既有 `list_items` 的各产品分支分别
调用新模块；`upstream_plan(kind, ...)` 分派到对应模块；保留根 `playback_request`
构造器供私有 helper 复用。签名和原 local/http 分支保留。接线后必须重跑生产 API
与真实产品联合矩阵；现有独立编译测试不能证明新模块已经进入生产路径。

## 新基线验证及证据

本批证据根目录 `/workspace/RainSync-lane-artifacts/b/v01`，均为隔离资源。
Backend binding：
`runtime/w03-viewer-backend/native-2026-09-30T13-38-46-745Z-7d1ce159-81bd-4f08-95dc-242f79e931c2/backend-binding.json`。
133 个后端输入摘要
`1b7e900474fcb70def934c3f18bbfbf1a992709d1f6edeae2a968f75d27b7dfc`，包含迁移 0031。
实际 Server SHA-256
`61da1721a58e881cf56ca53016f4ad931c095864071586b5bb6fc95e90ffff55`。

| 检查 | 本批状态 | 证据 |
| --- | --- | --- |
| providers 独立/既有 Rust 测试 | 12 passed，退出 0 | `providers-tests-final.log` |
| providers Clippy 全目标 `-D warnings` | 通过 | `providers-clippy.log` |
| 锁定原生三组件构建与输入/二进制绑定 | 退出 0 | 上述 binding 与 build.log |
| 上游预约受控 API/真实隔离 PG | 21/21 passed，退出 0，资源清理确认 | `reservations-tests.log`；`runtime/upstream-reservations/63781580-3ba5-4ee1-89f6-9c6e26ff2531/report.json` |
| 实际观测受控 API/真实隔离 PG | 24/24 passed，退出 0，资源清理确认 | `observations-tests.log`；`runtime/upstream-observations/c7544a2e-d4da-495e-8a59-bfd875912fa5/report.json` |
| 固定真实产品短 REST/媒体矩阵 | 退出 1，不能关闭 W03 | `real-contracts.log` 与下述 report |

预约回归新增两产品的同用户、独立 `viewer_id`：A 的 plan_generation 1→2 只停止
A 的旧 SID/DeviceId，B 原授权仍 active/readiness/renew 可用；A 的旧同 key 重试被
拒绝且不再协商。测试只使用总控已发布字段，没有扩展协议或实现 A 的播放逻辑。

## 真实产品：已验证与失败分别保留

最终 report：
`runtime/upstream-real-contracts/19c5e7c8-c02e-4f51-8d44-f69baad55040/report.json`。
Jellyfin 镜像固定为
`jellyfin/jellyfin@sha256:59417f441213e236a9f907d4e71a13472042409d85f9e9310dbdd87ee33d7bd4`；
实际版本 10.11.0。
Emby 镜像固定为
`emby/embyserver@sha256:3aafff933d3f28d23ed0bc201022abe71c0aa80deb17177566c726b9bbc686c6`；
实际版本 4.10.0.40。
镜像 registry manifest digest 与 Docker config ID 分别记录，不能相互比较。

自有合成 60 秒 H264/AAC 与 HEVC/双 AAC/字幕样本记录了完整文件摘要；生成与解码
使用系统 FFmpeg/ffprobe `7.1.5-0+deb13u1`，精确可执行文件 SHA-256 在 report。
没有借用旧 Windows FFmpeg 9.0.2 下载包证明。测试前后复核工具与入口摘要。
Linux restrictive umask 下只放宽合成媒体的读取权限，不放宽产品 config/凭据路径。

两种真实产品均实际通过：版本/镜像固定、两项完整分页及匿名拒绝、H264 直放响应的
真实视频解码。同一专用上游账户的两个 DeviceId/SID 在 Stop A 后，重新取 B 的
后续媒体分片，解码源像素时间从 0→3000ms，同时 B 的进度接口可用。这证明该
短场景的独立媒体访问/进度；没有测量编码进程 PID 连续性或长期运行。

两种产品的随机非零 HLS seek/选轨矩阵失败：目标时间对应的 TS 中未找到可解码
视频，不能把声明的音轨索引当成实际音频切轨验收。失败输出/首次失败及之前各轮
报告都保留，不能把多个版本的成功 case 拼成完整通过。

两种产品在 owned 非 admin 用户 `EnableMediaPlayback=false` 且管理 GET 复核后，
既有授权的 Static 媒体 GET 仍返回 200；该媒体策略撤权 case 失败。这不证明 token
吊销或账号禁用也失效：这两项本批没有执行。RainSync 单登录撤权也没有验收。
没有为通过此检查改变公共契约或代理访问策略。

最终产品容器、网络及所属卷的清理均正向确认；只处理各夹具的 UUID/label 对象。
该入口直接访问隔离真实产品，未接 RainSync Server/Worker/网页播放链，真实产品
API 证明和 RainSync 受控 API 回归必须分别使用。

## 尚需总控/A 的接口与验收

1. 单登录撤权：当前授权属于用户，不能区分同用户登录 A/B。须把可审计
   auth_session 身份绑定到新的请求/授权/预约以及观测准入，并明确旧 NULL 行
   策略、迁移和安全兼容；不能编造旧登录身份或撤销全用户来替代单登录撤权。
2. providers 根拆分接线按上文最小方案总控审查。无稳定 source_version 的上游
   实际候选继续沿用总控/A 的契约，不新增来源版本或公共能力字段。
3. Jellyfin 10.11 动态 HLS 使用整片时间轴：官方 StreamInfo 的 HLS 分支不输出
   `StartTimeTicks`，动态分片拒绝正的 StartTimeTicks。旧真实浏览器入口仍有
   “HLS URL 必有非零 StartTimeTicks”断言，应由 A/总控统一实际计划、seek、
   字幕和源帧验收口径。当前上游 timeline_origin_ms=0 只在模型上相符，未做
   RainSync 播放器联合确认，不能宣称其 seek 已正确。
4. 本批顺手修复既有真实浏览器入口的外部 runtime/target、可选系统 Chromium/
   FFmpeg、按 binding 迁移列表校验等前置；没有执行该完整入口，它仍依赖 Docker
   PostgreSQL 与 A 的上述时间轴约定。不能把本批短 REST 当作浏览器验收。
5. 固定产品联合浏览/直放/转码/三处 seek/切轨/字幕/实际观测/Stop/令牌吊销/
   库权限和恢复仍是下一轮正式兼容门槛；实机、长期运行与发布均未验收。

复现：source `/workspace/.rainsync-cloud/env.sh`，使用本路 CARGO_TARGET_DIR 和外部
RAINSYNC_RUNTIME_ROOT；`cargo test --locked -p providers`；fresh
`node scripts/bind-native-backend.mjs` 后设置 W03_BACKEND_BINDING，使用
`RAINSYNC_NATIVE_POSTGRES_BIN=/workspace/.rainsync-cloud/postgres/usr/lib/postgresql/17/bin`
运行 `tests/upstream-reservations.mjs`、`tests/upstream-observations.mjs`。真实短产品
矩阵另设 `RAINSYNC_FFMPEG_BIN=/usr/bin`，运行
`node tests/upstream-real-contracts.mjs`（也支持 jellyfin/emby 单项）；不会接受现有
个人服务地址或生产数据库。各脚本的隔离测试均使用随机端口与自有资源。
