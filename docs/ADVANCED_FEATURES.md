# 高级功能启用与回退

先部署 [同一候选的匹配组件](COMPATIBILITY.md)，完成基础登录/播放/停止与备份。
下面的模板需要管理员显式选择；仅复制模板不会修改正在运行的实例。
所有宿主目录先准备，禁止自动创建；为镜像中的 UID 10001 提供必要的写入权限，
媒体和现有 Agent 凭据仅只读挂载。先执行同一项目/环境文件/Compose 文件顺序的
`config`，再在独立测试实例验证启用和故障回退，最后才安排实际实例变更。

## NAS 本地计算

Server 选择 `deploy/advanced.override.yaml`，设置独立的
`RAINSYNC_COMPUTE_STORAGE_PATH`；与原媒体、共享 Worker 缓存分开。
`RAINSYNC_COMPUTE_TOTAL_BYTES` 限制服务端计算产物总量。已经配对的 Agent 使用
`deploy/compute-agent.compose.yaml`，提供相同候选的 `RAINSYNC_IMAGE`、
HTTPS 或 loopback `SERVER_URL`、已有 `RAINSYNC_AGENT_STATE_VOLUME`、
`MEDIA_PATH` 和独立 `COMPUTE_OUTPUT_PATH`，设置 `RAINSYNC_NAS_COMPUTE_ENABLED=1`。
外部 volume 必须是该设备已配对的状态卷，不把凭据复制进源码或镜像。

进程开启不等于获得计算许可。管理员登录后查看 `/api/v1/agents/compute`，
对目标设备 `POST /api/v1/agents/{id}/compute-policy`：

```json
{"enabled":true,"slots":1,"output_budget_bytes":268435456}
```

所有 API 请求经本人登录会话与常规 Origin 检查；不要在终端日志粘贴 Cookie。
通过房间播放器发起实际任务，核对输出验证、停止/取消、租约失效、设备撤销和容量耗尽。
当前仅两种配方、源时长最多 30 分钟、伴随进程一个执行槽。
回退先将设备 policy 的 `enabled` 设为 false，取消/停止房间任务，等待执行和上传回收，
停止 companion；移除 Server 输出配置前确认任务已收敛。保留设备状态卷和恢复材料。

## P2P

在上述 Server overlay 中设置 `RAINSYNC_P2P_ENABLED=1`，浏览器经 HTTPS 访问。
当前仅覆盖 NAS 计算产物；DataChannel 分片经哈希校验，失败回退 HTTP。
浏览器 ICE 服务仍为空，模板不虚构 STUN/TURN 接入。公网跨 NAT 的可达性和收益
需要实际对照，不能由局域网连接成功推断。禁用时设为 `0`，重建对应 Server，
刷新测试浏览器并验证 HTTP 播放/seek 继续可用。

## 控制节点

媒体权威 Server 在 overlay 中设置 `RAINSYNC_CONTROL_CLUSTER=1`、
`RAINSYNC_CONTROL_ROLE=media`、自己的非零 UUID、`RAINSYNC_CONTROL_NODES`
（UUID 到节点 HTTPS origin 的 JSON）和单独保存的 32–256 字节 peer token。
新增 control 节点使用 `deploy/control-node.compose.yaml`，角色固定 `control`；
所有节点共享数据库、相同候选、节点 allowlist/token、浏览器公共 Origin 和媒体路由。
每个节点的 origin 需通过专属 TLS 代理可达，模板本机端口只绑定 loopback。
peer token 不写入普通恢复材料、报告或浏览器配置，按独立密钥保管政策保存。

上线前验证 room lease/fencing、旧主恢复、代理 WebSocket、网络分区和暂停/恢复。
当前房间上限 10 人，热点广播扩容、大房间管理及无感迁移尚未交付。
回退必须先暂停相关房间、排空控制连接、停用额外节点，再把单一媒体权威配置改回
`RAINSYNC_CONTROL_CLUSTER=0`；所有节点一致切换，不能在仍持有旧租约时并行接管。
回退后验证房间快照、控制权限、播放与聊天，保留故障证据。

## 其他开关

Static HLS 的 `STATIC_HLS_PARENT_PREPARE_ENABLED`（Server）和
`STATIC_HLS_CHILD_EXECUTION_ENABLED`（Worker）应按同一候选成对验收。
GPU 需设备映射和实测驱动/编码器，设置 `RAINSYNC_VIDEO_ENCODER` 前验证实际输出；
模板不自动映射宿主 GPU。插件当前只提供两个内置声明式元数据扩展，
没有第三方进程宿主可供管理员开启。媒体边缘、S3 ArtifactStore、通用 Worker P2P
与 WebTransport 也不在这些模板的支持范围中。
