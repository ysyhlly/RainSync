# Worker 执行代次

迁移 `0007_media_job_attempt.sql` 为任务增加递增的 `attempt`。领取使用单条带 `FOR UPDATE SKIP LOCKED` 的数据库更新；执行目录为缓存根目录下的 `{job_id}/{attempt}/`，不再复用上次执行的文件。数据库续期和完成均要求 owner、attempt、running 状态、有效租约及有效播放会话。过期后即使尚未被其他 Worker 领取，也不能续期或发布成功。

迁移 `0008_media_job_retry_limit.sql` 增加 max_attempts（默认 3）和 available_at。失联执行在租约过期后先排队，第一次等待 2–3 秒，第二次等待 5–6 秒，随后才能领取下一代次；重复轮询不延后截止。第三次失联写入 failed / media_job_retry_exhausted，不再启动第四次。停止或过期会话优先写入 cancelled，并记录对应会话原因。正常 Worker 退出可立即重领，但仍消耗执行次数，第三次退出后同样终止，避免重启风暴无限编码。

迁移 `0009_media_outputs.sql` 为每次执行建立独立产物记录，保存 job/attempt、owner、相对目录、状态、校验版本、清单 SHA-256、分片数和发布时间。领取与 writing 记录在同一事务内；完成时，任务成功与 published 记录也在同一事务内，校验 owner、attempt、有效租约及会话。缺少校验结果或当前可写产物记录时不能提交成功，任一步不匹配则回滚。重领前旧 writing 记录归为 abandoned，失败保存 failed，正常退出释放时放弃对应 writing 记录。

迁移 0009 引入的版本 1 清单在 HTTP 交付时比对已发布摘要，修改后的清单拒绝读取；清单读取限制 2 MiB。该版本的摘要只覆盖清单。更早的 succeeded 产物单独回填为 legacy、校验版本 0，保留读取但不宣称它们通过了新校验。迁移 0014 后，新领取使用版本 2，逐段持久化长度/SHA-256 和可见清单，详见 [产物发布](OUTPUT_PUBLICATION.md)。停止旧 Worker 后再迁移，不支持新旧 Worker 混跑。

本轮只对租约失联自动恢复增加退避和上限。FFmpeg 返回失败仍保守终止，不能仅凭非零退出码把不支持编码或无权限当成临时网络故障；错误分类、可确认网络故障的重试和对外结构化错误仍需继续完善。

容量预检和运行巡检使用类型化 `CacheCapacityExceeded`，完成更新保留对应原因。完成前还执行最长三秒的只读容量复查，不通过清理文件隐藏刚发生的容量问题；不能仅根据 FFmpeg 退出结果认定成功。媒体读取按白名单映射容量不足、执行失败、取消和重试耗尽，未知内部原因不会直接进入响应。

缓存输出目录创建还区分只读与写权限拒绝；Server 就绪查询和 Worker 媒体读取共用终态原因白名单，提供一致的状态码、错误码和不可重试语义。公开响应不包含原始操作系统文本或路径。其他编码失败和可确认网络故障的细分分类仍待补齐。

除零配额测试外，Linux 故障脚本在独立 8 MiB tmpfs 中注入真实 ENOSPC：暂停 Worker，写满空间，让剩余三十秒样本的 FFmpeg 先退出，再恢复 Worker，覆盖周期巡检尚未来得及执行的空窗。这个容量检查仍不替代完整产物校验；写满后空间在完成前被其他进程释放、清单损坏等情况仍需靠产物发布验证处理。

Worker 在启动 FFmpeg 前再次续期；执行中每五秒检查，数据库续期最多等待三秒。失败或失锁会调用 kill 并等待子进程退出。数据库更新失败不能靠继续执行来掩盖。整机暂停期间无法即时杀进程，但恢复后旧 attempt 的文件仍与新执行隔离。

Worker 接到 Ctrl+C（Unix 另含 SIGTERM）后停止领取。准备阶段可以取消；启动子进程后必须经监督器 kill/wait，再把仍有效且仍属于本代次的任务放回 queued。数据库不可达或租约已失效时不强行释放，由租约过期恢复。主进程等待队列收尾，HTTP 连接最多排空十秒；数据库领取和收尾操作各限制三秒。续租健康检查独立限制三秒，缓存巡检与它并行，慢磁盘扫描不阻塞续租。

`cargo test -p rainsync-media-worker` 通过生产监督器启动真实测试子进程，检查退出通知打断挂起的健康检查、健康检查截止、失锁和数据库错误后子进程均已回收。测试在 Windows 执行，使用测试程序作为长运行子进程，不将其称为真实 FFmpeg、Unix SIGTERM 或后代进程组验收。标为 ignored 的 child_fixture 是这些测试显式启动的子进程入口，不是遗漏的普通测试。

媒体入口清单读取当前有效 attempt，其 init/分片 URL 带 attempt。旧 URL 与当前代次不符返回 409；分片缺少 attempt 同样拒绝。文件存在不能绕过失败状态或失效租约。已开始的响应仍可能发送旧字节；它不允许后续请求悄悄混入新代次，客户端需重新获取入口清单。

升级时停止所有旧 Worker，再运行迁移并启动新版；不支持新旧 Worker 混跑。迁移把旧 running 任务转为 queued，让新版从 attempt 1 重新执行。旧 succeeded 产物保留 attempt 0 的旧目录读取能力，重新获取入口清单即可得到带代次的地址。不要直接修改初始迁移。

验证入口：

本地任务完成前执行最多十秒的结构检查：清单须有结束标记、初始化段和连续编号分片；拒绝空/非法时长、越界路径、非普通文件与符号链接；检查 fMP4 顶层 box 长度边界及初始化段的 ftyp/moov、分片的 moof/mdat。清单限制 2 MiB，解析和文件读取有边界。该检查针对当前本地 FFmpeg 输出布局，不处理任意上游 HLS，也不代替逐帧解码或嵌套 box 语义验证。

清单的 ENDLIST 只在当前 attempt 成功提交后经 HTTP 可见。运行中的清单继续交付已生成分片，但去掉结束标记；失败任务拒绝读取。因此磁盘上先出现 ENDLIST 不等于已向客户端宣布完成。版本 1 的兼容读取见 [读取检查](OUTPUT_READINESS.md)；版本 2 读取数据库原子提交的快照，逐次复核分片载荷摘要并复用已检查句柄，见 [产物发布](OUTPUT_PUBLICATION.md)。

```powershell
cargo build --workspace --bins --examples
node tests/integration.mjs
```

集成测试先在隔离 PostgreSQL 中调用生产领取/续期/完成函数，覆盖并发领取、租约到期、同 owner 重领、旧提交拒绝和停止会话；随后通过真实 Worker HTTP 验证清单/初始化段/分片代次绑定及失败文件拒绝。路由测试使用受控产物字节，不冒充真实 FFmpeg 暂停/恢复测试。

真实 Linux FFmpeg 故障验证使用独立构建镜像，不替换已部署服务：

```powershell
docker build -f deploy/Dockerfile -t rainsync-worker-validation:local .
node tests/worker-processes.mjs
```

脚本创建独立网络、数据库和短生命周期 Worker，生成真实 H.264 样本并等待 HLS 清单落盘，之后注入 SIGTERM、数据库暂停，以及旧 Worker 暂停超过租期后恢复。共享缓存场景检查 FFmpeg 实际命令的 attempt 目录、新 Worker 仍运行、旧 FFmpeg 已回收和新 init 内容不变。报告记录镜像 ID、源文件摘要、FFmpeg 版本和故障恢复耗时；所有测试容器最终删除，样本和报告保留在 `.runtime/worker-processes/`。

测试容器使用 init 转发退出信号，暂停针对实际 Worker 子进程，并断言进程处于 T 状态；不能把向容器 PID 1 发送但被忽略的 SIGSTOP 当作成功注入。该测试覆盖 FFmpeg 直接子进程，不代表任意后代进程组或 Windows 系统信号验收。

缓存读取租约、清理互斥与编码前写入预留现已接入，细节和验证范围见 [缓存租约](CACHE_LEASES.md) 和 [写入预算](CACHE_BUDGET.md)。迁移 0015 后新产物为版本 3，首次发布增加受限的首段实际解码，参见 [产物发布](OUTPUT_PUBLICATION.md)。这仍只是 W05 的部分基础。逐段状态接口、细化执行错误分类与可重试网络故障、旧代次独立清理、后代进程组与 Windows 系统退出信号故障注入仍需继续完成。
