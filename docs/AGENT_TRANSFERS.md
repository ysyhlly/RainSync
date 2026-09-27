# NAS Agent 传输生命周期

Agent 的数据任务绑定到创建它们的控制连接。控制连接结束后，JoinSet 取消并等待全部数据任务退出，再按现有间隔重连；旧授权连接的任务不跨重连继续运行。默认 16 个文件传输名额保持不变；过载拒绝使用另一个最多 4 个任务的预算，避免拒绝流量本身无限创建连接。拒绝预算也满时不再连接该票据，由 Worker 的既有等待期限结束请求。

数据连接握手最多十秒，单次写入最多三十秒，关闭收尾最多一秒。传输同时读取对端：Close/EOF/连接错误能够终止正在等待文件 I/O 或网络背压的业务 future；Ping/Pong 正常处理。路径解析移入 blocking 任务，不在异步执行线程上同步等待文件系统。正常完成与取消都释放文件对象和传输名额。

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

范围仍有缺口：以上不覆盖 Windows 原生文件句柄期限、设备进入内核不可中断 I/O、所有阻塞文件系统及两小时连续观影。Tokio 文件操作底层使用 blocking I/O，丢弃异步 future 不代表能强制中断任意内核文件操作。持久化传输状态机、版本绑定与其余 W07 验收继续；HTTP 请求登记清理见 [Worker 传输说明](WORKER_ATTEMPTS.md)。
