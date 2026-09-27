# 媒体子进程树回收

编码器和首段验证解码器通过同一进程所有者启动。所有者任务持有操作系统进程及其组/Job 句柄；外部 wait 被取消只取消订阅，不取消实际回收。显式终止、丢弃外部句柄及主进程正常退出都会终止残留后代。只有确认整组退出之后，wait/kill 才完成；编码任务随后才能释放写入预算或继续发布。首段解码的截止和取消也使用该路径。

实现位于 `crates/media-core/src/child_process.rs`，Server 的本地探测、Worker 的远程探测及字幕转换也使用同一所有者。探测标准输出最多 8 MiB，字幕沿用 2 MiB 限制；超过上限、读取错误或 30 秒执行截止都会先终止并回收整棵进程树，再返回错误。标准错误丢弃，不累计任意诊断内容。调用 future 被取消后，独立所有者继续回收，但依赖 Tokio runtime 仍运行；执行截止不限制操作系统回收时间，不能把截止误认为回收保证。

Worker 在编码队列和有界 HTTP 等待结束后调用共享进程登记表的 `shutdown()`，关闭启动入口并终止所有仍登记的进程树。启动与登记、关闭入口使用同一锁，避免关闭检查和新进程登记之间漏记；外部 Child 已 Drop 的所有者也仍保留登记。正常回收完成后移除登记；所有者异常结束或回收错误会被登记为失败，不能报告成功排空。关闭等待者被取消不恢复启动入口。Worker 即使遇到队列/清理错误也先完成这一步，随后才结束 Tokio runtime。

Server 的普通退出路径也处理 Unix SIGTERM/SIGINT，Windows 沿用 Ctrl+C。收到信号后停止接受新连接，最多等待 HTTP 十秒，再关闭媒体进程入口并等待 ffprobe 所有者回收；监听服务报错也会进入回收路径。已有实例锁连接在这段时间仍由监督任务持有，直到进程退出，避免排空期间提前让另一实例接手。房间 WebSocket 最迟随 runtime 结束关闭；此处没有承诺给每个升级连接发送关闭帧。

Linux 启动独立进程组，并设置 subreaper 收养退出主进程留下的后代。使用 `waitid(WNOWAIT)` 观察主进程退出，保留其尚未回收的 PID，先向该组发送 SIGKILL，再 wait 主进程和本组被收养的后代；不在主进程回收后再次用旧 PGID 发终止信号。已完成的数字 PID 可能复用，因此这种顺序用于避免误杀无关组。语义依据：[wait/waitid](https://man7.org/linux/man-pages/man2/wait.2.html)。

Windows 先创建带 KILL_ON_JOB_CLOSE 的 Job，以 CREATE_SUSPENDED 和 CREATE_NO_WINDOW 启动进程，完成 Job 关联后恢复主线程，禁止先运行后关联留下的快速派生空窗。结束时调用 TerminateJobObject，检查 Job 活动进程数，同时等待所捕获成员的进程句柄真正变为已退出状态。只收到一个完成通知，或仅看到主进程结束，都不是整棵树退出的证明。相关 API：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[活动进程计数](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)。

Windows 实现使用 windows Rust 绑定直接调用 API；曾评估的 process-wrap 不在最终依赖中。回归测试要求主进程正常结束后仍要回收故意遗留的叶进程，且持有该叶进程句柄验证退出，而不是仅比较进程名或等待固定时间。

验证入口：`cargo test --workspace --locked` 包含真实原生父子进程的终止、Drop、正常主进程退出、取消 wait 四类检查；两个 ignored 函数是由测试显式启动的子进程夹具。`node tests/worker-processes.mjs` 调用 `tests/process-trees.mjs`，使用真实 FFmpeg 加包装进程和长睡眠后代，覆盖停止会话、SIGTERM 和正常编码完成；容器保持运行并逐一检查 `/proc`，防止把容器退出后的自动清理当作 Worker 回收。

本轮网络下载缓慢，最终测试镜像使用 `cargo vendor --locked --respect-source-config` 生成的本地依赖副本，以 `cargo build --release --frozen --workspace` 构建；基础镜像、运行层和其余步骤沿用 deploy/Dockerfile。临时构建输入保存在 `.runtime/build-inputs/`，不提交 vendor，也不更改部署构建配置。Linux Worker 测试在对应 build 阶段容器内断网执行 `cargo test --release --frozen -p rainsync-media-worker`，真实 FFmpeg 矩阵使用 `WORKER_TEST_IMAGE=rainsync-worker-tree-validation:local` 指定镜像，具体摘要见 VALIDATION.md。

共享模块另有有界输出测试，覆盖正常完成、截止、超限和取消调用；真实 HTTP 场景见 `tests/capture-processes.mjs`，通过隔离 Worker 调用 ffprobe 与字幕 FFmpeg，响应返回后检查包装进程及遗留后代已消失，Worker 保持运行。

新增原生测试验证关闭入口、持有/已 Drop 子进程回收以及取消关闭等待后继续等待。HTTP 测试同时卡住探测与字幕后向 Worker 发送 SIGTERM，要求在各自 30 秒执行截止前退出，并在容器继续运行时检查四个包装/后代 PID 均消失，防止依赖容器退出自动清理。

Server 验证入口 `tests/server-shutdown.mjs` 在独立数据库与容器中分别发送 SIGTERM/SIGINT；每次都持有已加入房间的 WebSocket，并卡住一次本地扫描探测。检查探测后代退出、观看连接关闭、排空期间实例锁不可取得、Server 退出后实例锁可取得，容器始终保留到检查完成。

这些机制覆盖留在媒体进程组/Job 中的后代，不是任意第三方插件的隔离沙箱；Unix 主动 setsid 逃离组、强杀进程本体、内核不可中断 I/O、Windows 控制台退出事件仍需单独验收。Server 实例锁连接出错时原有立即 `process::exit(1)` 路径仍保持失败即停止，尚未接入安全的全请求取消与子进程排空；不能把普通信号测试算作这条故障路径的证据。不能用当前测试宣称所有 Windows 系统退出信号或任意运行时终止路径已覆盖。
