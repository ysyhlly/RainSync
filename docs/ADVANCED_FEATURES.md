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
{ "enabled": true, "slots": 1, "output_budget_bytes": 268435456 }
```

所有 API 请求经本人登录会话与常规 Origin 检查；不要在终端日志粘贴 Cookie。
通过房间播放器发起实际任务，核对输出验证、停止/取消、租约失效、设备撤销和容量耗尽。
房间内“NAS 本地计算”提供以下固定配方；默认仍为 480p，不改变全局播放画质：

| 选项                    | 配方 ID             | 输出尺寸上限                     |
| ----------------------- | ------------------- | -------------------------------- |
| 480p H.264（默认）      | `h264_480p_hls_v1`  | 高度 480，宽度随原片比例         |
| 720p H.264              | `h264_720p_hls_v1`  | 1280 × 720                       |
| 1080p H.264             | `h264_1080p_hls_v1` | 1920 × 1080                      |
| 4K H.264（2160p / UHD） | `h264_2160p_hls_v1` | 3840 × 2160                      |
| HLS 转封装              | `remux_hls_v1`      | 合格 H.264/AAC，最高 1920 × 1080 |

这些尺寸是上限，转码保留原片比例，不强制放大低分辨率原片；4K 指 UHD，
不包括 4096 宽的 DCI 4K。转封装仍不接收 4K。选中配方后先生成完整产物，
通过独立校验后再由用户选择用于房间主播放器；音轨、原片时间轴和房间控制不变。

配方出现在菜单中不等于任意节点都能执行。节点必须通过该配方的实际编码、探测与
解码检查并上报能力；调度还要求原片或合格副本位于有授权且健康的计算节点。
旧节点仅上报已有配方时，不会被当作支持 720p、1080p 或 4K。管理员页面会显示
当前节点实际上报的配方、任务槽与产物预算；缺少能力时先检查匹配组件和 FFmpeg。

默认授权仍是一个任务槽、64 MiB 产物上限；菜单选择和授权按钮不会提高配额。
上面的 256 MiB 示例也是管理员单独设置的限额，并不保证任何时长的 4K 都能完成。
高清尤其是较长的 4K 产物可能超预算，必须在存储容量允许时单独配置，
仍受节点产物限额、服务端总存储限额和任务预算检查约束，不会静默越限或改用低清配方。
源时长最多 30 分钟、伴随进程一个执行槽；更高分辨率也不会放宽执行超时、
输入大小、输出校验或取消/租约约束。服务器未配置计算时保持关闭。
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

### NAS 固定清晰度配方与容量

受支持的精确配方 ID 为 `remux_hls_v1`、`h264_480p_hls_v1`、
`h264_720p_hls_v1`、`h264_1080p_hls_v1` 和 `h264_2160p_hls_v1`（4K UHD）。
必须部署相同候选的 Server 与 compute companion；旧节点只声明旧配方时不能领取 HD
任务。新增清晰度不会自动启用 FFmpeg 计算；目录读取许可、设备配对和计算授权保持独立。
新增迁移 0082 仅扩充固定白名单，保留已有授权、节点声明和历史迁移校验和。

默认策略仍为禁用、1 槽、64 MiB；已有用户策略不会被升级过程修改。管理员可显式设置
1–4 槽及 1 MiB–1 GiB 单任务产物配额，companion 当前仍只有一个执行槽。
每个产物文件及上传请求仍最多 8 MiB，服务端总存储默认 1 GiB（可显式配置
`RAINSYNC_COMPUTE_TOTAL_BYTES`），输入最多 16 GiB、源时长最多 30 分钟，
节点单次受监管操作最多 30 分钟，任务从创建起 30 分钟到期。HD 配方使用 2 秒关键帧对齐分片及固定码率/VBV；
不能用任意 FFmpeg 参数绕过这些限制。分辨率上限不代表升采样保证或性能保证。

新 HD 配方在已有与当前片源版本一致的探测时长时，排队前按视频最大码率、所选音频码率、
一个 VBV 缓冲、20% 封装余量和 64 KiB 清单余量计算保守容量需求。
这是容量预留估算，实际输出可能更小；不满足任何已授权同源/等价副本节点当前配额时，
请求以 `COMPUTE_OUTPUT_BUDGET_INSUFFICIENT` 拒绝。可选择较低清晰度、较短片源，
或让管理员明确调整配额，不会自动扩大配额。未知时长以及原有 480p/remux 配方
仍由完整节点探测、执行期限、实时字节检查、上传检查和服务端独立验证限制。
排队后缩小策略配额也会阻止不满足当前估算的节点领取任务，但不阻塞该节点领取后续可执行任务。
源时长探测完成后，节点在编码前再次核对新 HD 配方容量需求；容量/时长失败仅返回固定
诊断码，保留独立的进程与文件回收义务，不公开 FFmpeg 输出、宿主路径或凭据。
`COMPUTE_RECIPE_UNAVAILABLE` 表示同源或等价副本没有声明该配方的已授权节点，
应先更新、启动并授权匹配 companion；已注册的离线节点允许排队，领取仍须有效心跳。
