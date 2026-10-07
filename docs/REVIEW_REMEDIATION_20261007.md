# RainSync 审查修复记录（2026-10-07）

本记录对应用户提供的 31 项合并清单及三份审查报告。修复在两个代码版本中按实际存在的路径适配，保留旧 HLS 工作树和新分支的私有库、直播、计算及集群功能。

## 修复完成时的源码归属（发布前快照）

- 当前目录：`C:/rainsync`，`codex/handoff-0044-validation`，HEAD `39ab4d705f78d2c8eb5c70a74b3e8c7181d98603`；原有未提交 HLS 改动保留。
- 最新独立修复目录：`C:/Users/ysyhly/.codex/worktrees/review-remediation/rainsync`；从审查的 `5b3ca788a4febcf1369a00e8a8008680fbd6fab9` 创建。
- 当前最新工作树分支为 `codex/rainsync`，HEAD 为本地提交 `feca83c4b766d40b10290c7b6d3bfe96a3b6a0a2`，其后还有待提交修复。该提交在本轮期间出现，执行者来源未知，已保留；主代理及子代理未执行 Git 提交、推送或部署。
- 原审查工作树 `review-modular-room-20261007` 未覆盖。公开静态 HLS/新能力开关未因此开启。

## 逐项处理

| 项 | 状态 | 处理及边界 |
| --- | --- | --- |
| 1 | 两版修复 | 失败计数使用可信调用来源；随机用户名不会创建全局槽位；满表不会拒绝新的合法来源。 |
| 2 | 当前修复，最新版已有防护 | 哈希生成与验密共用 Argon2 semaphore；blocking worker 完成前持有 permit，HTTP 取消不会提前释放。 |
| 3 | 两版修复 | 成功登录不计失败额度；未知账户执行同预算的虚拟哈希验证；不能按用户名锁住另一来源的账户。 |
| 4 | 两版修复 | 管理员、原始会话和 CSRF 在片源锁之前进入事务；提交前复查实际角色、账户状态及自然到期。最新版同时覆盖删除。 |
| 5 | 最新版修复 | 按调用者、库、授权、片源、媒体的锁序固定权限；事务内生成响应；提交前分别检查登录和浏览/管理权限，避免提交后再查询导致 404。 |
| 6 | 当前修复，最新版已有防护 | 聊天插入及重放接收确切 session_hash，锁定原始登录，并在提交前检查实际到期。 |
| 7 | 当前修复，最新版已有防护 | 取得锁后以 clock_timestamp 检查邀请有效期；最终成员准入仍检查邀请码。 |
| 8 | 两版修复 | 扫描绑定源配置及策略代次；每页 I/O 及保存复查；策略更新使旧扫描代次失效。 |
| 9 | 两版修复 | 批准根、已打开文件及目录的最终 OS 路径均验证 MEDIA_ROOT；扫描保留目录句柄，读取/子进程保留文件句柄。 |
| 10 | 两版补强，条件风险 | 遮蔽静态 HLS 路径授权段；绝对/相对 URL 及 Error 负例通过。未证明存在真实令牌泄漏。 |
| 11 | 两版属性对齐 | 退出 Secure 与签发一致，HTTP/HTTPS 响应头回归通过。未把原先缺 Secure 等同于浏览器不能删除 Cookie。 |
| 12 | 两版修复 | 预览 renew 和 finish 先取行锁，再以新 DB 时钟检查 owner、attempt、lease 和来源新鲜度；不复活旧 owner。 |
| 13 | 两版修复 | 续租作为受限、可取消的监督 future，与 produce、停止、截止时间持续并行轮询。 |
| 14 | 两版修复 | 后台回收明确未接纳且已持久化拒绝的条目，或正向 Disposed 的已结束条目；保留未知责任及有界原始控制。 |
| 15 | 两版修复，真实回归通过 | 仅 COMMIT 或之后的错误标为结果不确定；明确提交前失败回到可发布状态；协调器重新发布同一 owner，不替换捕获。 |
| 16 | 语义核实，无需改变行为 | TRANSFER_DRAINED 表示无剩余资源，不表示传输成功；未开始的请求可以提供 NeverStarted 释放回执。文档已明确区别。 |
| 17 | 两版修复 | EXTINF 接受可选标题；TARGETDURATION 使用最近整数。仍保持有限、封闭清单的其它安全约束。 |
| 18 | 两版修复 | 直接 HTTP 通过受控 Worker 的短 Range/MIME/清单嗅探确定 transport，避免强制 FFprobe；auto 路径保留完整探测。 |
| 19 | 两版修复 | 有限的负剩余时间转换为零，进入明确过期路径；NaN/无穷等真正未知值继续拒绝 I/O。 |
| 20 | 两版修复 | 换片/无媒体先暂停、解绑旧 plan/session/source，再等待时钟；tick 拒绝过时代次。 |
| 21 | 两版修复 | requested 后退回 missing 仍有界轮询和重试；取消的旧请求不会污染新状态。 |
| 22 | 两版修复/补齐 | 队列事件触发刷新；重连、聚焦、唤醒及返回同房间刷新；room/request serial 防旧响应覆盖。最新版保留原有集群传播。 |
| 23 | 两版修复 | 身份切换清 running；epoch 防止旧结果和旧 finally 覆盖新身份的任务。 |
| 24 | 两版修复 | 正常 PlaybackCancelled 不作为播放失败；仅当前时钟/目标的真实失败写入错误，恢复清理旧状态。 |
| 25 | 两版修复 | END_MEDIA 在房间/snapshot 事务锁内重新读取队列、选片并记录诊断。当前项被删除后返回 NO_MEDIA，要求重新选片，不跳到首项。 |
| 26 | 两版修复 | 同 revision 不重复应用 seek 等副作用；仍接收控制凭据、时钟及关闭状态更新。 |
| 27 | 两版修复 | 未知游标明确返回 400 CHAT_CURSOR_NOT_FOUND；客户端加载最近历史且防分页循环。最新版保留消息删除检查。 |
| 28 | 当前修复，最新版已有正确断言 | 覆盖 CompletedUnmarked、带 custody 完成及非法状态；不把旧断言冲突改称原生完成错误。 |
| 29 | 两版修复 | 默认演练允许 local/agent，继续排除 HTTP/provider 来源；脚本及运维契约检查通过，未进行完整升级/回退。 |
| 30 | 最新版修复 | guest_rate_limit 定位已修正；6/6 Node 契约通过，并加入 npm script/CI。当前旧分支不存在该文件。 |
| 31 | 最新版修复 | 移动管理入口断言 /admin/settings 与管理员设置；已有 settings fixture 保留；mobile/desktop 各 4/4。 |

HLS 语法依据 [RFC 8216 EXTINF](https://datatracker.ietf.org/doc/html/rfc8216#section-4.3.2.1) 与 [TARGETDURATION](https://datatracker.ietf.org/doc/html/rfc8216#section-4.3.3.1)。

## 已有新验证证据

- 当前 Vue/Vitest：40 个文件、784 项通过；生产构建通过。
- 最新 Vue/Vitest：123 个文件、1971 项通过；最终独立生产构建退出 0。一次已产出资源的 Node/libuv 退出崩溃保留，独立重跑通过。
- 当前 Windows Rust `--workspace --lib --bins`：587 项通过、10 项忽略。后续 Server 重跑有一次已有 deadline 测试受调度影响失败，单项串行重跑通过。
- 最新 Windows `cargo check --workspace --all-targets --locked --offline` 通过；persistence/protocol/room-core lib 分别 93/49/20 项通过；登录预算与取消单元 6/6。
- 最新媒体针对性单元：Windows junction 1、EXTINF/目标时长 1、Registry/发布结果 2、预览监督 1，通过。
- 两版路径脱敏测试各 5/5；最新后端契约 6/6；最新 Chrome 导航 mobile/desktop 各 4/4。
- 当前真实 Server/独立 PostgreSQL：登录容量、代理信任、排队聊天撤权、插入等待到期、邀请锁等待到期、片源策略撤权/到期、Cookie 属性回归通过。
- 最新真实 Server/独立 PostgreSQL：登录容量/代理信任/Cookie 回归通过；F1/F2 12/12 并发场景通过。
- 两版真实队列/聊天各 4 组通过；两版实际 Rust 预览 renew/finish 锁等待跨期通过。上述 HTTP/SQL 夹具均确认进程、端口及自有 PostgreSQL 清理。
- 两版真实 Server/Worker HTTP 识别各 4 项通过：无扩展名、大写后缀、fragment HLS 使用 octet-stream 上游仍识别 hls，MP4 保持 progressive 且字节一致。Worker PATH 为空，media_jobs 为 0；自有 Worker/Server/PostgreSQL/上游均完成清理。
- Linux 文件/目录句柄隔离 2 项及 EXTINF/目标时长 1 项通过；固定镜像及冻结源码 hash 已核对，自建测试容器退出 0 后移除。

下列绝对路径是本机验证证据，GitHub 读者可使用文末回归入口复现。最新 F1/F2 报告：[source-mutation-authority.json](C:/rainsync/.runtime/review-remediation-20261007/authority-latest/source-mutation-authority.json)。全部集中日志位于 `C:/rainsync/.runtime/review-remediation-20261007/`。

## 验证限制与保留现场

Linux 私有 Worker 原生全链完成编译、严格 Clippy及真实 Rust 测试：58 项断言、10 个准备场景全部通过，包含正常准备、实际 P0001 提交前 SQL 失败后同一 owner 的第二次发布、原 ID/deadline、一次捕获及一次授权。12 个 capture 均取得正向 disposed 证明，reservation 与原生连接均为 0。

本次 `55982c2c` 原始 Node 包装器运行在 Rust 全部通过后，因新增场景的旧计数 9 而退出 1。两版计数已修成 10；原失败报告不重写。独立完成核验验证冻结源码、原生二进制、58/10、实际重试及释放证据，并确认唯一包装器差异为 cases.length 9→10。该运行的原 driver 和 PostgreSQL 已正常关闭并移除。

完成核验：[completion-verification.json](C:/rainsync/.runtime/0044-worker-operation/55982c2c-238f-453f-865b-cc23eec56ef2/completion-verification.json)；重试正向证明：[native-precommit-retry-positive.json](C:/rainsync/.runtime/review-remediation-20261007/native-precommit-retry-positive.json)。当前 Rust 原生来源已验证，最新版同路径适配完成及 Windows 全目标检查通过；没有将这些事实称为最新版完整 Linux/浏览器正式发布验收。

保留原生失败报告：`C:/rainsync/.runtime/0044-worker-operation/928763fd-d031-4800-871d-23841c573bb1/report.json`。更早容量断言失败现场 `c4f90d79-e585-4eec-a1d8-84f29892e6ad` 及锁夹具错误现场也保留；没有用本次新成功替代历史原 owner 未闭合的责任。容量用例已验证持久拒绝/墓碑/不重捕获的明确合同。

未做正式部署、真实媒体平台账号/公网 TLS、真实媒体浏览器播放、双客户端长稳、完整升级回退或 72 小时验收。Windows 的正常检查包含平台既有 warning；不宣称全平台发布验收。

GitNexus 用于当前仓库的符号及影响分析，存在 Rust/接收者调用遗漏，API 路由映射未给出 Rust 路由。最新工作树不在 MCP 允许索引范围内，因此使用直接源码分析，并未扩大 allowlist。

## 回归入口

- 当前：`npm run test:review-regressions`，先构建 Server 与 `verify_preview_recovery`，设置独立 `RAINSYNC_ARTIFACT_DIR`。
- 最新：`npm run test:backend-contracts`、`npm run test:review-regressions`；前者和真实并发回归均加入 CI。
- Linux HLS 原生：`node tests/static-hls-worker-operation.mjs`，以每次报告的 source/binary/image 绑定和资源证明为准。

31 项已逐项处理，16 为语义核实；当前工作包含代码修复、针对性回归及上述明确验收边界，尚未正式部署。最终源码文件哈希清单位于 `C:/rainsync/.runtime/review-remediation-20261007/source-inventory.json`。

## 发布范围

2026-10-07 用户授权推送：将上述修复的最新功能分支提交并推送到 `origin/codex/rainsync`。旧 `C:/rainsync` HLS 开发工作树保持本地状态；本次没有正式部署。实际推送提交以 Git 历史为准。
