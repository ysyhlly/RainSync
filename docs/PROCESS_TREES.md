# 媒体子进程树回收

编码器和首段验证解码器通过同一进程所有者启动。所有者任务持有操作系统进程及其组/Job 句柄；外部 wait 被取消只取消订阅，不取消实际回收。显式终止、丢弃外部句柄及主进程正常退出都会终止残留后代。只有确认整组退出之后，wait/kill 才完成；编码任务随后才能释放写入预算或继续发布。首段解码的截止和取消也使用该路径。

实现位于 `crates/media-core/src/child_process.rs`，Server 的本地探测、Worker 的远程探测及字幕转换也使用同一所有者。探测标准输出最多 8 MiB，字幕沿用 2 MiB 限制；超过上限、读取错误或 30 秒执行截止都会先终止并回收整棵进程树，再返回错误。标准错误丢弃，不累计任意诊断内容。调用 future 被取消后，独立所有者继续回收，但依赖 Tokio runtime 仍运行；执行截止不限制操作系统回收时间，不能把截止误认为回收保证。

Worker 在编码队列和有界 HTTP 等待结束后调用共享进程登记表的 `shutdown()`，关闭启动入口并终止所有仍登记的进程树。启动与登记、关闭入口使用同一锁，避免关闭检查和新进程登记之间漏记；外部 Child 已 Drop 的所有者也仍保留登记。正常回收完成后移除登记；所有者异常结束或回收错误会被登记为失败，不能报告成功排空。关闭等待者被取消不恢复启动入口。Worker 即使遇到队列/清理错误也先完成这一步，随后才结束 Tokio runtime。

Server 与 Worker 共用 `media_core::process_signal::wait`，普通退出处理 Unix SIGTERM/SIGINT、Windows Ctrl+C/Ctrl+Break 和关闭控制台；信号注册失败也先走已有清理流程，再返回错误。普通信号下 Server 停止接受新连接，最多等待 HTTP 十秒，再关闭媒体进程入口并等待 ffprobe 所有者回收；监听服务报错也会进入回收路径。已有实例锁连接在这段时间仍由监督任务持有，直到进程退出，避免排空期间提前让另一实例接手。房间 WebSocket 最迟随 runtime 结束关闭；此处没有承诺给每个升级连接发送关闭帧。

Server 为媒体所有者配置独立 runtime：子进程、管道 I/O 和回收任务一起登记到该 runtime，不能只移动 wait 任务而把进程驱动留在应用 runtime。实例锁每两秒检查一次，查询最多等待三秒；连接报错或超时都会通知最外层监督器。故障退出跳过 HTTP 排空，先销毁应用 runtime，停止请求、升级套接字和后台任务，再由仍运行的媒体所有者关闭启动入口、终止并回收进程树，最终返回非零退出码。普通排空期间丢锁也会打断排空。Worker 未配置独立 runtime，继续使用其原有的先排空、后结束 runtime 流程。

这使应用任务停止和媒体回收分开，不会为了等待 ffprobe 而继续服务。它不承诺撤回数据库已经接受的语句，也不替代多实例的数据库 fencing；检测间隔、不可中断内核 I/O 和操作系统调度不属于原子退出保证。启动失败也销毁应用 runtime 后执行媒体回收。

Linux 启动独立进程组，并设置 subreaper 收养退出主进程留下的后代。使用 `waitid(WNOWAIT)` 观察主进程退出，保留其尚未回收的 PID，先向该组发送 SIGKILL，再 wait 主进程和本组被收养的后代；不在主进程回收后再次用旧 PGID 发终止信号。已完成的数字 PID 可能复用，因此这种顺序用于避免误杀无关组。语义依据：[wait/waitid](https://man7.org/linux/man-pages/man2/wait.2.html)。

Windows 先创建带 KILL_ON_JOB_CLOSE 的 Job，以 CREATE_SUSPENDED 和 CREATE_NO_WINDOW 启动进程，完成 Job 关联后恢复主线程，禁止先运行后关联留下的快速派生空窗。结束时调用 TerminateJobObject，检查 Job 活动进程数，同时等待所捕获成员的进程句柄真正变为已退出状态。只收到一个完成通知，或仅看到主进程结束，都不是整棵树退出的证明。相关 API：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[活动进程计数](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)。

Windows 实现使用 windows Rust 绑定直接调用 API；曾评估的 process-wrap 不在最终依赖中。回归测试要求主进程正常结束后仍要回收故意遗留的叶进程，且持有该叶进程句柄验证退出，而不是仅比较进程名或等待固定时间。

验证入口：`cargo test --workspace --locked` 包含真实原生父子进程的终止、Drop、正常主进程退出、取消 wait 四类检查；两个 ignored 函数是由测试显式启动的子进程夹具。`node tests/worker-processes.mjs` 调用 `tests/process-trees.mjs`，使用真实 FFmpeg 加包装进程和长睡眠后代，覆盖停止会话、SIGTERM 和正常编码完成；容器保持运行并逐一检查 `/proc`，防止把容器退出后的自动清理当作 Worker 回收。

本轮网络下载缓慢，最终测试镜像使用 `cargo vendor --locked --respect-source-config` 生成的本地依赖副本，以 `cargo build --release --frozen --workspace` 构建；基础镜像、运行层和其余步骤沿用 deploy/Dockerfile。临时构建输入保存在 `.runtime/build-inputs/`，不提交 vendor，也不更改部署构建配置。Linux Worker 测试在对应 build 阶段容器内断网执行 `cargo test --release --frozen -p rainsync-media-worker`，真实 FFmpeg 矩阵使用 `WORKER_TEST_IMAGE=rainsync-worker-tree-validation:local` 指定镜像，具体摘要见 VALIDATION.md。

共享模块另有有界输出测试，覆盖正常完成、截止、超限和取消调用；真实 HTTP 场景见 `tests/capture-processes.mjs`，通过隔离 Worker 调用 ffprobe 与字幕 FFmpeg，响应返回后检查包装进程及遗留后代已消失，Worker 保持运行。

新增原生测试验证关闭入口、持有/已 Drop 子进程回收以及取消关闭等待后继续等待。HTTP 测试同时卡住探测与字幕后向 Worker 发送 SIGTERM，要求在各自 30 秒执行截止前退出，并在容器继续运行时检查四个包装/后代 PID 均消失，防止依赖容器退出自动清理。

Server 验证入口 `tests/server-shutdown.mjs` 在独立数据库与容器中覆盖 SIGTERM/SIGINT、终止持锁数据库连接、暂停持锁数据库进程，以及排空期间终止连接；每次都持有已加入房间的 WebSocket，并卡住一次本地扫描探测。检查退出码、探测后代退出、观看连接关闭、正常排空期间实例锁不可取得、Server 退出后实例锁可取得，容器始终保留到检查完成。`--lock-loss-only` 可单独复现连接终止场景。

Windows 原生入口：先 `cargo build --workspace --bins --examples --locked`，再运行 `node tests/windows-shutdown.mjs`（需要 Python 3 与 Docker PostgreSQL）。`windows-console.py` 为每个真实服务创建独立的隐藏控制台，辅助进程只附着到该测试控制台，再发送 Ctrl+C、Ctrl+Break，或对该隐藏控制台发送 WM_CLOSE；不向用户的控制台广播。事件作用范围依据 [GenerateConsoleCtrlEvent](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent)，监听接口依据 [Tokio Windows signals](https://docs.rs/tokio/latest/tokio/signal/windows/index.html)。测试以 `probe_tree_fixture` 替换 ffprobe，保留卡住的探测及后代，发送事件前持有它们的 Windows 进程句柄，随后确认服务正常退出且全部句柄已变为退出状态；不使用 PID 消失或进程名匹配作为唯一证据。测试启动配置只继承必要系统环境变量，创建进程后删除临时启动配置；报告保存服务二进制摘要。

Windows 首个退出事件为关闭控制台时，Server/Worker 跳过普通的十秒 HTTP 等待，立即进入既有清理路径。系统允许的处理时间默认五秒且可配置，依据 [HandlerRoutine](https://learn.microsoft.com/en-us/windows/console/handlerroutine)。锁定版本的 Tokio 在接收关闭事件后保留 OS 回调线程，给异步清理留出时间。测试要求服务正常退出且探测后代句柄已退出，实际用时低于五秒；这不保证磁盘/数据库阻塞时也能赶上系统截止，也不覆盖已经开始普通排空后再次关闭控制台。

Windows 原生夹具另终止 Server 的持锁 PostgreSQL 连接，要求非零退出，并通过事先持有的进程句柄确认探测及后代结束；独立 runtime 单元测试也先销毁应用 runtime，再检查所有者成功回收。具体报告见 VALIDATION.md。

这些机制覆盖留在媒体进程组/Job 中的后代，不是任意第三方插件的隔离沙箱；Unix 主动 setsid 逃离组、强杀进程本体、内核不可中断 I/O、Windows 注销/关机事件仍需单独验收。不能用当前测试宣称所有 Windows 系统退出信号或任意运行时终止路径已覆盖。
