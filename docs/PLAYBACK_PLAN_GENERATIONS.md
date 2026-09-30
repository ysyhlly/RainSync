# 播放方案代次：v0.1 下一里程碑

日期：2026-09-30（UTC）。实现基线为 `5ce1c8496bfa6a216be34361df3dd8aae9e4168e`。
本里程碑只补齐 W01/W02/W06 的每观看者播放意图代次，不代表这些工作包、
NEXT_PLAN 全文或 v0.1 发布门槛完成。未部署；远程发布/CI 结果另行核验。

## 实现与兼容

- 请求可同时携带 `viewer_id` UUID 和正整数 `plan_generation`（最大 u32）。
  单独携带、零及非法类型拒绝。viewer 只用于已认证用户/房间内的排序，不授予权限。
- 迁移 0031 新增用户/房间/viewer 的持久高水位；旧会话与请求的新字段保持 NULL。
  更高代次可以跳号；同 key 重试保持代次；相同或更低代次的新 key 返回 409。
  取消、失败、媒体切换、服务重启及 close/reopen 不降低高水位。
- 新方案准入在现有 room→user 锁顺序内撤销同 viewer 的旧授权、取消旧任务并请求上游停止。
  迟到准备、成功/失败回调及旧重放不能发布回旧方案。readiness/续期复核当前代次；
  Worker/播放观测继续通过现有 stopped/epoch/成员授权拒绝旧会话。
- 房间 `media_generation`、个人 `plan_generation`、Worker `attempt` 各有独立含义。
  切音轨、seek 重建、降级不增加房间 revision；能力探测不推进播放方案代次。
- Web 在异步探测前分配意图代次，检查计划及 readiness 回显；元数据、HLS、首帧、
  seek、音轨和迟到 `play()` 成功/拒绝均按当前意图过滤。旧方案的最终播放观测仍先于取消完成。
- 旧客户端不携带两个字段时保留既有行为和幂等摘要。新版 Web 依赖服务端 generation
  回显，对旧服务端响应失败关闭，因此部署时先更新配套后端，或同时更新组件。
- 没有补造进程/Agent/上游释放回执，没有 force-close，也未改变旧 NAS 因果范围门槛。

### 有意保留的容量边界

每个用户在同一房间 ID 的整个存续期内最多创建 **1024 个不同 viewer 身份**。已有 viewer
可以继续推进；新身份超限返回不可盲重试的 429 `PLAYBACK_VIEWER_LIMIT_EXCEEDED`，
事务不留下新请求、高水位或旧会话撤销。其他用户和其他房间独立。

当前每次挂载播放器产生新 UUID，所以长期房间反复刷新/挂载也会消耗名额；不是只计算
同时在线窗口。到达上限时现有播放器可继续，新播放器须使用新房间。不能通过删除高水位
腾出名额，否则旧请求可能复活。可安全压缩的有期限身份机制属于后续设计，当前未实现。

精确冻结接口见 [共享契约](PARALLEL_CONTRACT_V01.md)。

## 本轮验证与证据

只使用云端自建隔离 PostgreSQL 17.11、Rust 1.98.1、Node 24.19.0 和合成媒体。
后端构建前后绑定 129 个输入和三个服务二进制 SHA-256；测试后的独立复核一致。
未读取生产库、真实 NAS 或用户设备。源版本与历史失败不拼接为当前候选成功。
最终后端输入摘要：`d85db1ab36f92b6499fdf47764f75c5d5fc15f76bfe02c475791a36972a6d30c`。

| 检查 | 本轮结果 | 证据文件 |
| --- | --- | --- |
| fmt / Clippy 全目标 `-D warnings` / 协议生成一致性 | 通过 | `rust-final.log` |
| Rust workspace | 104 通过、3 ignored；ignored 不计通过 | `rust-final.log` |
| 前端单元 / vue-tsc / Vite | 122 通过、18 文件；类型与构建通过 | `frontend-final.log` |
| 真实 1–30→31 PostgreSQL 迁移 | 19 项通过，旧行/摘要保留，配对/范围约束与隔离资源清理确认 | `generation-final.log`、migration `report.json` |
| 真实 generation API / Worker / FFmpeg | 14 组通过；含并发、失败重试、迟到发布、旧 URL/观测拒绝、配额回滚、cap、重启与生命周期 | `generation-final.log`、generation `report.json` |
| 完整既有集成、优先项、生命周期、账号、聊天、片单扫描 | 全部通过，六条组合退出0；含13项生命周期脚本与17项撤权场景 | `ci-candidate/status.tsv` |
| 原上游预约、实际观测与崩溃未知矩阵 | 19/19、24/24、1/1 通过，组合退出0；受控 HTTP 不是实际产品验收 | `ci-candidate/upstream-status.tsv` |
| 状态精度 / Worker 健康 | 3组真实DB/WS精度和6组真实PG故障通过，资源清理确认 | `room-state-roundtrip-final.log`、`worker-health-final.log` |
| 当前 Chromium E2E | 启动前 socket EPERM；1 个启动失败、169 未运行，未证明应用回归 | `browser-gate-first.log` |
| Docker 部署镜像 / 真实浏览器播放 / 设备与持续运行 | 本轮未通过；见下列边界 | 环境与现有报告 |

新增 14 组中使用真实本地媒体和 Worker 授权；只有迟到探测时序由受控 HTTP 对端驱动，
没有把这个对端称作真实上游产品。独立审查覆盖准入锁顺序、同 key 重放、晚完成、
最终观测及 cap；发现的持久 viewer 无界增长和旧 `play()` 拒绝已修复并测试。

首次前端失败来自旧测试夹具缺少新 generation 回显，以及新增假播放器缺少 seekable；
保留原失败日志，修正夹具后全量重跑通过，没有删减原生命周期断言。Vite 保留
853.62 kB 主 JS 超过 500 kB 的提示，未借本轮擅自拆包。

复现入口：`npm run test:playback-generations`；CI 已接入。完整命令继续遵守
[贡献指南](../CONTRIBUTING.md) 和 [隔离原生验证说明](CLOUD_LOCAL_VALIDATION.md)。

## 仍开放的范围

- Browser Use 的云浏览器也拒绝访问隔离 loopback（ERR_BLOCKED_BY_CLIENT）；
  没有绕过浏览器/系统限制，不能用单元测试替代本候选真实浏览器执行
- 当前没有 Docker；镜像头像、部署制品、真实 Jellyfin/Emby、iOS/Safari/Android、arm64
  和目标 NAS/NFS/SMB 仍需各自环境和证据
- 新候选两小时 NAS、持续 100 在线/弱网、72 小时、真实旧库升级/回退与灾备未执行
- 计划中的 subtitle_mode、完整 seekable ranges、所有 Provider 的实际文件候选等剩余接口
  与功能未因本次 plan_generation 实现而自动完成
- 生命周期未知旧资源、缺少正向释放证明和受支持对账路径的存量发布阻断继续保留
