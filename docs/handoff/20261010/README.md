# RainSync 重构交接：2026-10-10

本分支保存完整未推送历史及交接材料。代码基线为 `990cf8a75b65c102279539fbce683c52196f4c67`，包含 246 个提交、1574 个已跟踪文件；交接提交仅增加本目录。推送前远端 main 为 `fc985a818f50be654e78d4e50165c320291c7a96`，有 106 个代码历史提交尚未推送。

此前从 Library v19 的完整 Git bundle 恢复到 `7ed7667dbf0a38a531343502ed300f0b47e87c96`，随后完成的 40 个提交见 [提交列表](commits-since-restored-v19.txt)。未从远端 main 重新开始，也未改写既有历史。

## 接收代码和草稿

```bash
git clone --branch codex/rainsync-handoff-20261010 https://github.com/ysyhlly/RainSync.git
cd RainSync
git log --oneline -6
python3 -m zipfile -e docs/handoff/20261010/pending-source-proposals.zip ../rainsync-pending-source
```

原始完整方案见 [REFACTOR_PLAN_20261009.md](REFACTOR_PLAN_20261009.md)。[状态记录](status.json) 和 [最近命令结果](recent-command-receipts.json) 将实际运行与未运行范围分别记录。

`pending-source-proposals.zip` 保留未应用的候选源码、完整输入快照、静态审查及未完成草稿；[逐文件清单](pending-source-index.json) 绑定其字节和来源。这些材料来自已冻结交接包，并不表示生产实现或运行验收通过。每个已冻结目录的原 manifest、候选文件和输入均保留原字节；房间目录草稿及 short-account 独立审查仍未完成。不得把候选整份 `rooms.rs` 覆盖到当前代码而丢失其他已完成的修改。

[room-kick-authority-native.mjs](drafts/room-kick-authority-native.mjs) 保留原未跟踪夹具，SHA-256 为 `232686dbf49ea101288f51cc4df91a8a017d8d05e6d7305bba3fb3bcbe19621e`。它位于交接目录，尚未作为通过验收的常规测试注册。

## 当前已提交成果与验证范围

最近已提交的完整操作边界包括：compute retention/manifest validation/placement/attempt execution、NAS admission/connected session、cluster route-peer-startup、P2P authority 与 quota、应用组装、catalog title/source retirement、identity profile/account retirement/registration invite，以及 room invitation/permissions/ownership。逐项验收范围应结合提交、原方案和各阶段原始证据核对；全计划尚未完成。

最后一次 P22 增量仅修改既有两个测试文件（提交 `990cf8a`），保留九项共享 owner contract，增加 finish CHECK timeout 及同一次执行中的 WARN 1/2/4/8 重试恢复验证。真实 original 九项与 candidate 十一项分开运行；driver 的 12 个 PostgreSQL 连接实际返回同一池并空闲。测试驱动 1 passed / 0 failed / 0 ignored；Server 428 passed / 0 failed / 9 ignored，fmt、严格 Server Clippy、backend contracts 13/0、owner contracts 25/0 和十八项源码/产物绑定检查通过。这些是源码基线阶段的真实运行，没有在发布文档时重新冒充实跑。

该阶段不代表新的 ACK-pending room-close、物理子进程 drain、overflow/saturation、soak 或全 P22/P23/P24 完成。历史 whole-workspace 1659/0/42 绑定较早 233 提交；前端 Vitest 167 文件/2666 项、bundle 4/4、initial JS 405441/409600 与 mock Chromium 153 项/11 seams 绑定较早 222 提交，不能作为当前全量验证结果。

## 明确失败与剩余工作

- kick 原基线夹具在首个 guest 请求收到 HTTP 403 / `FORBIDDEN`，但夹具预期 `GUEST_RESTRICTED`，运行退出 1；完成的检查组数为 0。未进入真实锁案例，后续六项 legacy 测试未运行。生产 kick 候选未应用，断言未修改。
- 上述失败运行的 Server 与临时 PostgreSQL 均正常退出 0，PID 消失、端口关闭，`pg_ctl status` 为 3；原始私有数据库与记录保留在云环境。
- lifecycle、guest-access、short-platform-account 候选以及房间目录草稿仍待完成独立复核与真实 original/candidate 数据库验证。静态通过不代表运行通过。
- 历史两次 2 秒 FFmpeg readiness 失败、一次 metadata 子进程 status=null、以及未解释 NAS 401 仍保留；后续原代码复跑通过不能解释原因。
- P08 已被拒绝两次，P09 依赖 P08，继续排除。Windows 真机、真实 provider 账号、跨主机 TLS、升级兼容、required checks、长时间 soak 与确切离线 Docker 镜像验收仍有未验证范围。P2P Chromium 曾受 SUID/socket 权限限制，未绕过。

用户最新分工为主要执行链完成实现、RainSync 云环境负责测试。后续云环境只测试明确交付的候选；本次用户另行明确授权 Git 推送交接，未授权 merge 或 deploy。请先评估 kick 夹具与既有错误策略的真实差异，再决定如何修正；不要机械迁移 SQL/文件副作用或放宽断言掩盖失败。

## 私有备份与原始证据

公开 Git 分支包含代码历史、原方案、候选源码及静态审查；原始 HTTP/WS/SQL witness、数据库、服务运行记录与 Library 上传记录保留在云环境。三个既有交接 ZIP 的精确大小、SHA-256、Library 身份与最后确认版本见 [备份清单](backup-checksums.json)。完整备份和轻量包均独立恢复验证过；补充交接包不是独立代码恢复包。Library 上传在授权阶段返回 HTTP401，未产生新版本。

现有 `checks` workflow 可能由本次推送自动触发；本交接不声明远端 Actions 或 required checks 通过，也未手动触发发布任务。代码历史与该目录可从本分支重新克隆，私有原始证据仍需使用当前云环境中的保留副本。
