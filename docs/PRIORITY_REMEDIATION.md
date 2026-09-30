# 第一阶段优先补强与验证记录（历史）

本文冻结第一阶段的实现范围与当时验证结果。后续生命周期、清理回执和实际媒体候选已在第二阶段继续实现；当前结论见 [第二阶段报告](PHASE2_LIFECYCLE_NEGOTIATION.md)。本文 67/77/17 等数字不代表第二阶段最终验证，也不应将当时未实现的关闭/重开与实际候选写成当前缺失。

日期：2026-09-30，UTC。复核/缺陷复现起点：`7f17ab719576a5bb24ac00055129f2fa92311c0d`。用户合并原 PR 后，本补强分支 `fix/priority-remediation` 对齐主线 `6227469704b301cb9aeccab725104eda79f32f5d`；主线相较复现起点仅删除三个与此补强无关的根目录 artwork 文件，已保留这些删除。

本轮为本地补强工作记录；未推送、合并或部署。已实现代码与实际执行证据分开列出，测试脚本存在不表示已经通过。完整 `NEXT_PLAN.md` 不因这些切片完成而关闭。

## 1. 已有基线纠正

- `13262053` 已实现 migration 0019 的 NAS `source_version`：Server 授权绑定、Agent 句柄属性版本、Worker 返回版本验证和同尺寸/同 mtime 替换/改写场景。`stat-v1` 不是内容哈希或不可变快照。
- [媒体库/播放器报告](LIBRARY_PLAYER_IMPLEMENTATION_REPORT.md) 的 E15 `agent-relay-final` 及正文明确记载真实 Agent 的版本和撤销测试通过。这是历史运行证据；本轮没有依据把它改称“从未运行”，也不拿它替代当前修改后的回归。
- 账号/注册/昵称头像、双层媒体标题与认证封面、持续播放、自动接续/循环和 NAS 手动扫描均已在起点实现。历史记录见 [账号验收](ACCOUNT_REGISTRATION_VALIDATION.md)、[媒体库/播放器](LIBRARY_PLAYER_IMPLEMENTATION_REPORT.md)、[审计补强](LIBRARY_PLAYER_AUDIT_FIX_REPORT.md)、[循环与扫描](PLAYLIST_SCAN_MOTION_REPORT.md)。

## 2. 本轮切片

### W04/W07：响应准备与长流授权撤销

`apps/media-worker/src/playback_access.rs` 为媒体响应准备和正文增加统一授权守卫，准备期间和正文每两秒复查 session/token、到期、停止、媒体代次与成员资格，首部提交前另外重查。单次检查截止三秒，成功授权最大年龄五秒；拒绝或数据库不确定时停止准备/读源。独立正文任务把授权复查与 HTTP 背压解耦；取消生产同时释放其拥有的 local/HTTP/NAS 源。额外队列一块 64KiB，撤销后丢弃未交付字节。

最后的首部前复查仍由准备期监控保护。检查 SQL 使用事务局部的 2500ms `statement_timeout`，取消/出错时关闭本次检查连接，健康完成才归还池；防止取消的锁等待查询继续耗尽 Worker 共享连接池。最终 17 项回归和额外背压连接池复核已通过。

限制：不能召回已经交给网络/浏览器的字节，也不能保证任意内核 blocking I/O 立即退出；五秒应用截止依赖 runtime 可以继续调度，不是进程暂停/系统停机下的实时保证。健康复查使用 BEGIN/SET LOCAL/SELECT/COMMIT，因此 100 条稳定正文流约每秒 50 次检查/200 条 SQL，另有准入/准备检查；这是源码估算，尚未负载实测。现有传输租约、Agent 撤销与缓存租约继续单独生效。`tests/stream-revocation.mjs` 为本轮 local/HTTP 长流、Range、撤销和数据库停滞的隔离验证入口，实际结果列在下一节。

### W07/W10：0019 旧索引升级可诊断

新 Agent HELLO 声明 `source_versions: true`；管理接口显示版本能力、总索引/无版本数和 `empty/ready/rescan_required/upgrade_required`。手动扫描收到旧格式快照不会报为播放恢复成功，仍无版本时返回 `upgrade_required`。旧数据保持可浏览，播放继续拒绝无版本授权。

`tests/nas-upgrade.mjs` 覆盖旧结构和旧索引保留、旧格式 Agent、完整重扫及新版恢复路径；没有在用户真实 NAS 上安装程序。操作步骤由 [OPERATIONS.md](OPERATIONS.md) 维护。

### W02：具体能力报告

`packages/player-core/capabilities.ts` 报告五个有限样本：H.264 High/AAC、H.264 Baseline/AAC、HEVC/AAC、VP9/Opus、AV1/Opus。区分 `canPlayType`、MSE 和 `MediaCapabilities` 的 supported/smooth/power-efficient 信息；可选异步探测最多 500ms，缺失/异常保持未知，超时返回副本避免污染已经提交的请求。协议及生成物保留旧布尔字段兼容。

本切片没有把样本支持外推为 codec 家族白名单，没有证明高位深/HDR/4K/多声道支持；完整实际影片候选协商、路线选择、可解释降级和真实设备矩阵仍属于 W02 后续。详细报告字段、兼容门控和测试范围见 [能力报告](PLAYBACK_CAPABILITIES.md)。

### E01：房主转让

新增成员读取与房主转让接口、migration `0025_room_ownership.sql` 审计记录及网页入口。房主/实例管理员只能选择已有成员；预期 revision 和事务锁保护转让，同步 owner/controller、快照和事件，删除旧 control epochs。广播/重连刷新 owner 信息，持久化提交再次校验控制权，避免旧 Actor 状态覆盖转让。转让保留现有时间轴、媒体代次和观看会话，不转移片源所有权。

本切片不包含完整关闭/重开状态机、Moderator/Viewer 矩阵、扩展邀请、账户删除归属或全面事件重放，不能将 E01 标成完成。详细接口、锁顺序、升级/回退限制与剩余门禁见 [房主转让](ROOM_OWNERSHIP.md)。

## 3. 本轮实际验证

最终优先补强套件全部通过：17 项响应撤销/连接池检查、NAS 升级、房主转让和迁移 0025 升级四个脚本。Rust 67 项、前端 77 项、类型/构建、格式、Clippy 与协议检查通过。独立源码复核未发现剩余阻断问题；浏览器运行仍被环境权限阻断，不能据此认定 UI 已验收。

日志根目录为 `/workspace/shared/`；下表仅列本轮实际结果。

| 检查 | 结果与日志 | 范围 |
| --- | --- | --- |
| `npm run test:priority-remediation` | 四脚本全部通过，`rainsync-priority-final.log` | 17 项流/准备/连接池、0019 旧索引升级、房主竞态与 0025 旧库升级 |
| `cargo test --workspace --locked` | 67 通过、2 个有意 ignored 的子进程 fixture，`rainsync-workspace-final-test.log` | 含 Worker 23 与 room-core 8；ignored 不计为通过 |
| 工作区二进制/示例构建、最终 Worker 重建 | 通过，`rainsync-final-build.log` / `rainsync-guard-final-build.log` | 最终守卫包含 SQL 取消清理与首部前连续监控 |
| 全目标 Clippy（`-D warnings`）/ 格式 / 协议导出 `--check` | 通过，`rainsync-clippy-final.log` / `rainsync-fmt-final.log` / `rainsync-export-final.log` | 早期失败已修正后重跑，不当作通过记录 |
| `npm test` / `npm run build` | 77/77；类型与构建通过，`rainsync-npm-final-test.log` / `rainsync-npm-final-build.log` | 保留 841.25kB JS chunk 提示 |
| `npm run test:accounts` / `npm run test:chat` | 全部通过，`rainsync-accounts.log` / `rainsync-chat.log` | 四个账号脚本含系统 FFmpeg 头像处理，不代表部署镜像验收 |
| `node tests/playlist-scan.mjs` | 通过，`rainsync-playlist-scan.log` | 循环/去重及真实 Agent 重扫，旧版/离线/忙/断线反馈 |
| `node tests/integration.mjs` | 最终稳定二进制重跑通过，`rainsync-artifacts/logs/cloud-aggregate-final.log` / `.json`，退出 0 | 含真实隔离 `pg_dump/restore`；100 控制连接快照 173ms 仅本机冒烟 |
| 浏览器套件/真实浏览器入口 | 环境阻断，未执行测试正文 | Chromium 启动报进程 socket `Operation not permitted`，常规/批准重试均失败；无新截图或 UI 通过结论 |

最终完整集成用 `node scripts/run-check.mjs cloud-aggregate-final 420 node tests/integration.mjs` 记录，运行前后三个服务二进制哈希一致。此检查只使用本轮自有 PostgreSQL 和合成媒体，没有连接用户数据库；Docker 镜像、部署镜像头像及实际浏览器仍未验收。

### 撤销与连接池的红绿证据

- 旧 Worker：起点 `7f17ab7` 二进制运行 `local-stop`、`http-stop`，均在十秒源释放截止处失败，日志为 `rainsync-baseline-local.log` / `rainsync-baseline-http.log`。两次使用当前 Server/隔离数据库 fixture，复现精确的旧 Worker 缺陷，不声称重跑整套起点服务。
- 最终守卫：17 项覆盖 local/HTTP 的停止、成员移除、换代、到期、数据库阻塞、消费者断开，另覆盖上游首部/清单/字幕准备撤销和连接池饱和恢复。复核运行中正常/准备期撤销释放源 ≤1.768 秒，单流数据库阻塞 ≤4.251 秒；首部前明确撤销返回 401、数据库不确定返回 503。正文保持暂停时先观察源释放，再恢复消费确认短于声明长度的断流。四种确定失效的后续媒体请求均为 401；数据库暂时阻塞或消费者断开不永久撤销授权。
- 连接池：12 路长流在 14 秒数据库锁期间耗满 Worker 的 12 个共享连接槽，实际观察到 11 个授权查询阻塞。强化背压用例确认暂停消费时所有文件句柄先归零，所有流在 4.831 秒内断开；同一个池上的无关 Agent 查询在锁尚未释放时用 6ms 返回预期 401，证明取消检查不会持续占满连接池。此为定向隔离故障证明，不是 100 在线持续负载测试。

最终 17 项 JSON：`rainsync-artifacts/stream-revocation/6aed930c-fb4b-4668-9f2c-20713e11a050/stream-revocation.json`；强化池用例 JSON：`rainsync-artifacts/stream-revocation/ec0324b1-b64a-4777-b1da-8213c72a597f/stream-revocation.json`。源释放时间以 `source_released_ms` 为准；池用例 4.831 秒为全部断流完成的上界，源释放发生在恢复消费之前。

审查中先后补齐响应准备期保护、首部前最后复查的连续监控，以及 SQL 取消后的连接回收。早期 12/16 项通过属于修正过程，最终结论采用上述 17 项与强化池证据。两秒复查/三秒检查/五秒授权年龄是应用边界，不是停机、不可调度 runtime 或任意内核 I/O 的绝对期限。

### 升级与所有权证据

NAS 测试应用真实 0018 旧结构后升级，确认迁移校验和、设备/媒体 ID 保留，未知版本保持 NULL 且不能播放；旧格式协议对端、能力声明与不完整快照均不能绕过版本要求。真实新版 Agent 重扫补版本、失效旧探测、完整/Range/HEAD 读取，以及修改后拒绝旧授权、重扫后新授权恢复通过。旧格式分支不是历史旧二进制运行，外部真实 NAS 未安装/升级。

房主测试覆盖成员/管理员权限、目标删除与并发转让、旧命令提交/重放、多设备重连、播放保留和审计重启；另以原始 1–24 迁移和旧房间/成员/邀请升级到 25，数据保留通过。原旧二进制回退未验证；网页新增用例已编写，当前环境未运行测试正文。

## 4. 复现与隔离数据库

统一入口为 `npm run test:priority-remediation`，按顺序执行长流撤销、NAS 升级、房主转让和房主迁移四个脚本。CI 已增加该入口；本轮只记录本地运行，远程 CI 未执行。共享 fixture 和环境边界另见 [云端本地验证](CLOUD_LOCAL_VALIDATION.md)。

先执行 `npm ci`、`cargo build --workspace --bins --examples --locked`，设置仓库外的 `RAINSYNC_ARTIFACT_DIR`；若设置 `CARGO_TARGET_DIR`，构建和测试必须使用同一目录。默认 fixture 新建随机命名的 `postgres:17` 容器，需可用的 Docker。Windows 可用 `scripts/validation-env.ps1` 统一设置产物路径。

无 Docker 时可显式设置 `RAINSYNC_NATIVE_POSTGRES_BIN` 为可信本地 PostgreSQL 17 的 bin 目录。共享 [PostgreSQL fixture](../tests/fixtures/postgres.mjs) 会用该目录的 `initdb/postgres/psql` 创建专用新集群，随机端口仅监听 `127.0.0.1`，采用随机密码和 SCRAM，结束时关闭自有进程；不会连接现有用户数据库。使用能运行 `initdb` 的普通用户，产物目录须可写；不要传入生产 `DATABASE_URL` 或把现有数据库目录用作产物根。真实备份/恢复类脚本还需要同目录的 `pg_dump/createdb/pg_restore`。

示例仅设置本次 shell 的环境，不安装软件、不更改数据库服务配置：

```sh
export RAINSYNC_ARTIFACT_DIR=/absolute/path/outside-checkout/rainsync-validation
export CARGO_TARGET_DIR="$RAINSYNC_ARTIFACT_DIR/cargo-target"
# 仅无 Docker 且已有可信 PostgreSQL 工具时启用：
export RAINSYNC_NATIVE_POSTGRES_BIN=/absolute/path/to/postgresql/bin
cargo build --workspace --bins --examples --locked
npm run test:priority-remediation
```

## 5. 尚未关闭的验收

- 真实 NAS 两小时连续观影及分阶段 RSS/句柄/连接趋势
- 最终候选镜像 72 小时稳定性、持续 100 在线和弱网矩阵；本机 100 连接冒烟不等价
- Safari、iOS/Android 真机及 arm64；Chromium 手机尺寸/触摸模拟不等价
- 真实库备份恢复、完整升级/回退矩阵；历史隔离数据库恢复通过不等价
- W02 全媒体/设备能力决策和有限失败降级、W03 完整真实上游矩阵，以及 E01 完整生命周期和后续扩展包

本轮只新增 0025 增量迁移，不改写 0019 或其他历史迁移。原旧二进制内嵌的 SQLx migrator 不认识版本 25；保留数据/表本身不等于可直接启动原旧二进制，需要保留完整迁移历史的兼容构建并另行验证。回退/发布前仍需在隔离库验证，不删除用户数据、表或迁移记录来绕过兼容性错误。未运行 Docker 镜像构建或 `test:avatar-container`；系统 FFmpeg 的头像通过结果不能替代部署镜像验收。
