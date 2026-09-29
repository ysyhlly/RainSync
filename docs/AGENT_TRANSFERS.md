# NAS Agent 传输生命周期

## 源文件版本绑定

迁移 `0019_agent_source_versions.sql` 为索引增加可空 `source_version`。新 Agent 在完整索引中报告 `stat-v1:` 版本；文件版本变化会清空旧探测元数据和时长。Server 将版本固定到探测授权和最终播放会话，探测结果只在索引仍为同一版本时保存。Worker 的一次性传输请求携带该版本，并核对 Agent 成功响应中的版本；缺失或不一致的版本不能用于播放。

版本来自已打开文件的身份、大小与修改/变更时间：Linux 使用设备/inode/mtime/ctime，Windows 使用卷/文件 ID 及文件时间。Agent 在同一已打开句柄上读取，每个块读取前后检查版本；不会校验路径后重新打开另一个文件。替换后旧授权返回 `SOURCE_CHANGED`，原地改写或缩短导致已开始的响应中断，不追加第二份错误首部。相同大小且恢复 mtime 的替换和原地改写有实际回归。

`stat-v1` 是文件系统变化检测，不是内容哈希、不可变快照或跨会话缓存复用证明。不能保证任意不可靠远程文件系统都会报告变化，也不能撤回已经交付的字节。获取新版索引后需重新发起播放；旧方案不会自动改绑新版文件。

自动播放探测保留 Worker 确认的 `SOURCE_CHANGED` / `SOURCE_VERSION_REQUIRED`（409，不可盲重试），未知上游错误仍脱敏为探测失败。转码任务保存同样的固定失败原因，只执行一次，不发布旧源产物，且释放写入预留；后续读取任务清单仍返回明确的 409。

升级时停止旧 Worker，由新 Server 执行迁移，再启动新 Agent 和 Worker。旧索引的 NULL 版本不会自动回填为可信版本；Agent 重新连接并完成索引后才能播放。旧 Agent 的无版本成功响应会被拒绝并提示升级，旧播放授权需重新创建。该规则补充下文迁移 0018 的生命周期升级顺序。

## 自动索引与快照失败隔离

`AGENT_INDEX_INTERVAL_SECS` 默认六十秒，可配置为五至 86400 秒。控制连接保持独立处理心跳和传输；后台扫描按 ACK 推进，每次连接只保留一个扫描，共享扫描名额防止重连时重叠。每页最多 128 条且受字节上限约束。

单个可识别视频无法打开或无法取得可信版本时，索引记录 `available:false`、`source_version:null`；其余视频继续更新。恢复可读后的完整扫描重新恢复可用状态。目录无法枚举等全局扫描失败发送 `INDEX_ABORT`，Server 撤销暂存快照并确认，不把不完整结果发布为片库删除，也不关闭仍有效的控制连接。断线同样回滚暂存快照；只有完整提交才标记真正消失的文件。

验证入口 `node tests/agent-index-refresh.mjs` 使用真实 Server/Agent/PostgreSQL、权限故障及透明控制代理，覆盖延迟 ACK、扫描期间读取、恢复、目录失败、删除和断线回滚。文件系统仍须提供可靠身份/变化时间；网络文件系统的专门验收继续。

## 持久化状态与一次性授权

迁移 `0018_agent_transfer_runs.sql` 增加独立的生命周期记录，保留 `offered → connected → streaming → completed/failed/cancelled`。短期 `agent_transfers` 仍只负责分发一次性票据；Worker 在同一数据库事务内消费票据并进入 `connected`，第二个连接不能再次使用。有效元数据接受后写入 `streaming`；HEAD 和空正文也经过该状态，再进入终态。

记录包含 Agent、授权资源描述的 SHA-256、方法、Range、时间、交给 HTTP 响应体的字节数和固定内部原因，不存数据通道 URL、令牌或明文源路径。这里的资源摘要用于关联授权描述，**不是文件内容版本或内容校验**；独立的 `source_version` 绑定见上文。

领取、续租、阶段推进及终态写入先锁定对应行，再用独立语句的 `clock_timestamp()` 检查有效期；不会沿用事务开始时或等锁前的时间判断。失效租约不能被旧所有者延长，也不能把过期任务补写为成功。

转码读取遇到传输失租时，记录为可恢复输入故障，沿用媒体任务最多三次的执行上限；不会因为本次 relay 的租约失败而立即记为不可重试的编码失败。

HTTP 处理及正文持有同一生命周期登记。正常的完整正文、HEAD 或空正文标记 `completed`；已确认的错误首部、上游错误状态、断流等标记 `failed`；提前丢弃请求/正文为 `cancelled`。第一个确定的终态保留，迟到的连接关闭或清理不得覆盖。`completed` 表示所需字节已交给 HTTP 层，不证明客户端收到全部字节、解码完成或用户观看完成。活跃字节计数随续租采样，正常结束再记录最终计数；失租或崩溃时只保留最后确认值，不能当作客户端实际收取字节的精确统计。

独立所有者先原子写入票据和状态，再通知请求继续；即使 HTTP 在 INSERT 期间取消，也在插入结束后原子提交终态并清理票据。活跃租约为三十秒，每十秒续期，续租及终态收尾各最多等待三秒；续期失败/超时或租约已失效会停止通道和 HTTP 流，不继续使用不确定的所有权。长传输不会因最初票据的三十秒有效期结束而中止。Server 的每分钟清理将无终态且租约到期的记录标为 `failed/transfer_owner_lost`；数据库恢复后也可处理崩溃遗留。终态保留二十四小时后清理，不保留无限历史。

升级时先停止 Worker，备份数据库，再由新 Server 执行迁移，最后启动对应版本 Worker。迁移会删除没有生命周期所有者的旧短期票据；正在等待它们的请求需重试。迁移 0018 单独实施时没有改变 Agent 消息格式；迁移 0019 的版本要求见上文。回滚应用版本前应停止活跃传输，生命周期审计不视为跨版本持续会话恢复。

Agent 的数据任务绑定到创建它们的控制连接。控制连接结束后，JoinSet 取消并等待全部数据任务退出，再按现有间隔重连；旧授权连接的任务不跨重连继续运行。默认 16 个文件传输名额保持不变；过载拒绝使用另一个最多 4 个任务的预算，避免拒绝流量本身无限创建连接。拒绝预算也满时不再连接该票据，由 Worker 的既有等待期限结束请求。

数据连接握手最多十秒，元数据写入及正文无进展最多三十秒，关闭收尾最多一秒。有效传输租约下，Worker 在等待本地消费者队列时每五秒发送精确 `rainsync-backpressure-v1` Ping；Agent 保留同一次正文写入 future，并用这类健康信号延长其无进展期限。普通 Ping/Pong 不延长期限；Worker 的真实字节读取期限也不被健康信号重置。停止、消费者关闭或失租会停止健康信号并取消通道。

传输同时读取对端：Close/EOF/连接错误能够终止正在等待文件 I/O 或网络背压的业务 future。路径解析移入 blocking 任务，不在异步执行线程上同步等待文件系统。正常完成与取消都释放文件对象和传输名额。

按初始文件长度发送精确字节数。源文件在传输中缩短会返回内部错误并结束连接；响应元数据一旦开始发送，之后的错误只关闭连接，不再追加 404 元数据。开始发送前的路径/文件错误仍使用原有 404，Range 无效为 416。

验证入口：

```powershell
$env:WORKER_TEST_IMAGE='rainsync-agent-lifecycle-validation:local'
node tests/agent-lifecycle.mjs
```

该脚本运行真实 Linux Agent 与独立稀疏文件卷，使用受控控制端和数据消费者制造背压。检查 16 路文件描述符、第 17 路拒绝、Close/TCP 关闭混合取消、五秒内名额复用、控制断开后的文件/数据连接退出、重连 Range/HEAD、握手期限以及文件缩短。报告记录镜像与几个负载阶段的 RSS；它不是两小时内存趋势或总内存上限证明。

端到端传输验证入口：

```powershell
$env:WORKER_TEST_IMAGE='rainsync-worker-validation:local'
node tests/input-retries.mjs --agent-relay
```

该入口启动真实 Server、Worker、Agent 与隔离 PostgreSQL，使用有授权的播放会话夹具读取独立稀疏文件。八路 HTTP 消费者制造背压，检查 HTTP 取消经 Worker 到 Agent 的文件关闭、Agent 重启后旧响应截断与新 Range 成功，以及管理员 DELETE 撤销经 Server 控制连接关闭到 Agent 文件释放、Worker 旧 HTTP 流中断和新请求拒绝。会话夹具直接入库，故不将它称为登录/配对/播放准备到浏览器解码的完整观影验收。

状态及恢复验证入口：`node tests/input-retries.mjs --relay-cancel`。它使用真实 Worker、Server 和 PostgreSQL，加受控 WebSocket 数据端，检查延迟 INSERT 的取消、各阶段取消、正常 HEAD/正文、并发领取、错误首部/状态/断流、超过票据期限的续租、失租断流、强杀 Worker 后的实际租约过期收尾和终态保留清理。保留清理测试主动回拨一条终态记录的时间，不声称实际等待二十四小时。

自动探测和错误传播的隔离回归入口：

```powershell
docker build -f deploy/Dockerfile -t rainsync-source-errors-validation:local .
$env:WORKER_TEST_IMAGE='rainsync-source-errors-validation:local'
node tests/input-retries.mjs --source-version-playback
node tests/input-retries.mjs --nas
node tests/input-retries.mjs --agent-relay
```

使用真实 Server/Worker/PostgreSQL 和 FFprobe，自动探测的 Agent 数据端为受控夹具；同时检查失败准备授权撤销和同请求编号重放不创建新探测。`--nas` 增加源变化、缺版本、版本不匹配和未知错误脱敏的转码任务场景。必须使用当前源码构建的镜像，既有同名本地镜像不保证包含本轮变更。

Windows 原生入口：`node tests/agent-native.mjs`，入口自动执行 `cargo build -p rainsync-nas-agent --locked`。使用真实 exe、独立本地媒体文件和受控控制/数据端，通过逐文件独占打开检查句柄持有及释放，并保存阶段内存样本。具体完成场景和环境见 [验证记录](VALIDATION.md)。

范围仍有缺口：真实设备进入内核不可中断 I/O、所有阻塞/远程文件系统及两小时连续观影与内存趋势。Tokio 文件操作底层使用 blocking I/O，丢弃异步 future 不代表能强制中断任意内核文件操作。Windows 原生夹具不替代完整 Server/Worker/Agent 的 Windows 链路，也不证明总内存上限；HTTP 请求登记清理见 [Worker 传输说明](WORKER_ATTEMPTS.md)。
