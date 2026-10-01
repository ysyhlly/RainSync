# 浏览器媒体能力提示

播放请求继续携带原有 `progressive_h264_aac`、`native_hls`、`mse_h264_aac` 三个独立传输门控。新增可选 `report`，由 Rust 协议导出 TypeScript 与 JSON Schema；旧客户端不发送此字段时保留原有行为。

## 具体探测与边界

`report.schema_version = 1` 包含五个固定、有限的示例：

- MP4 / AVC High Level 4 / AAC-LC，1920×1080、30fps、视频 8Mbps
- MP4 / AVC Baseline Level 3 / AAC-LC，640×360、30fps、视频 1Mbps
- MP4 / HEVC Main Level 4 / AAC-LC，1920×1080、30fps、视频 8Mbps
- WebM / VP9 Profile 0 Level 4 8-bit / Opus，1920×1080、30fps、视频 8Mbps
- WebM / AV1 Main Level 4.0 8-bit / Opus，1920×1080、30fps、视频 8Mbps

音频示例均为双声道、48kHz、128kbps。每项携带完整 container/codec MIME 字符串与用于 `decodingInfo()` 的音视频配置。

- `progressive` 原样区分 `maybe`、`probably`、`unsupported` 与探测异常时的 `unknown`
- `mse_supported` 来自 hls.js 实际选中的 MediaSource 实现；缺失表示 API 不可用或探测失败，`false` 才表示明确不支持
- 可用时分别请求 `file`、`media-source` 的 `decodingInfo()`；仅对 MIME 探测为正的路径调用，最多十次，总等待上限 500ms
- `file_decoding` / `mse_decoding` 的 `supported`、`smooth`、`power_efficient` 仅为对应配置与路径的浏览器估计；拒绝、异常、超时不伪造结果
- 返回后生成独立快照，迟到结果不能修改已提交的幂等请求

这些固定示例仍只是兼容提示，不能证明设备支持全部同族编码、4K、10-bit、HDR、多声道或流畅/硬件解码。不采集设备型号、硬件标识或 DRM 信息，不枚举大量配置。

## 当前协商使用

原有 AVC High Level 4 / AAC MIME 探测仍决定两个 AVC 传输门控。服务端对 v1 report 中该精确 MIME 的结果做一致性约束；原生 HLS 独立判断，不能从 progressive 或 MSE 结果推断原生能力。没有该示例或报告版本未知时沿用旧门控。

一个 1080p 示例的负面 `decodingInfo()` 结果不用于禁止整个编码族，也不能用于保证任意本地输出可播放。其他 codec 的提示不会扩大当前服务端的直放格式白名单。

## 实际媒体候选

新客户端在准备播放前 POST `/api/v1/playback-candidates`，携带房间、媒体代次、音轨和当前位置。服务端返回最多四条有限候选及五分钟有效的加密绑定。绑定限定用户、房间、媒体代次、生命周期 epoch、媒体、源文件版本、音轨和原始候选，不接受客户端自行声明任意 codec 配置。

本地文件在 ffprobe 前后通过持有句柄及重新打开的文件身份验证；NAS 首次使用则建立受生命周期约束的临时 Worker 探测授权，探测后停止授权，并只在 `source_version` 仍匹配时保存 `capability_source_version` 标记。所有预探测先登记不可变准备所有者，取消/超时后正向等待进程树回收，再登记完成回执。可靠单Binary HTTP文件通过版本1显式协商接入本节实际候选：绑定当前身份/来源和可靠ETag或Last-Modified及长度，每次准备先提交独立表示pin再读取。HLS及不可靠身份不冒充支持；显式direct省略HTTP标记，但仍访问通用候选入口以保留本地/Agent兼容。范围及证据见 [HTTP候选绑定](HTTP_FILE_CAPABILITY_BINDING.md)。Jellyfin/Emby保留独立保守协商，不伪造本地文件版本证明。

直放/复制候选只为已经支持的 8-bit AVC 路径生成。RFC6381 AVC profile/compatibility/level 来自实际 avcC/SPS 字节，AAC-LC 来自 AudioSpecificConfig 和 ffprobe 字段；缺失 extradata、尺寸、帧率或码率时不猜。可用的配置按下列顺序协商：

1. 单视频、至多一条音频的原文件 MP4 直放；多轨文件不假定浏览器选中已探测的轨道
2. 零起点、无需旋转/VFR 变换的 AVC/AAC 复制转封装
3. 复制 AVC 视频，仅将音频转为 AAC-LC 双声道 48kHz/128kbps
4. 固定 SDR 1280×720、30fps、AVC High Level 3.1、最大视频码率 4Mbps 的完整转码；有音轨时输出上述 AAC 配置

全转码输出通过显式编码参数约束；画面等比缩放并填边，保留原片时间坐标。非零起点不会谎称 stream-copy 精确定位。HDR 不自动转换。无音轨候选不虚构音频配置。

客户端仅探测服务端提供的有限配置，500ms 内收集结果并冻结快照，通过 `candidate_report` 回传同一绑定。实际 passthrough 需要对应 `decodingInfo.supported`；API 不可用时只有固定保守转码输出可以使用 MIME 提示。`supported=false` 绝不当成未知。播放准备及最终发布再次验证来源、房间和生命周期；源变化返回 `SOURCE_CHANGED`，失效绑定返回 `STALE_CAPABILITY_REPORT`。计划包含 `decision_reason`、`selected_candidate_id` 和选中音轨。

自动模式排除失败候选，每条路线一次、最多三条路线。所有经过验证的schema 1、非空绑定及有限候选集合（本地、Agent和已协商HTTP）在同一播放意图内保留不可变的原始候选、设备报告与累计排除集合；五分钟从第一次发现开始计算，准备前检查本地单调时间，服务端仍独立决定绑定和当前授权是否有效。具体报告失败、来源变化或过期不能静默重新探测，只能由新的明确意图重新开始。HTML媒体code 3可触发解码路线回退；code 4本身也可能是早期装载失败，不创建新授权，包括旧HTTP单次续接。hls.js明确的fatal mediaError保留既有有限路线回退，原生HLS仍可在同一授权下单次native→MSE。空候选及旧Server 404保留初始兼容协商。此处复用既有本地/Agent版本契约，不把stat-v1升级为内容哈希。完整范围与受控证据见 [候选恢复身份](CONCRETE_CANDIDATE_RECOVERY.md)。网络、鉴权错误和初始媒体数据装载超时不会触发额外转码。每个已挂接方案都有20秒可实际装载的累计预算，包括没有具体候选ID的HTTP/Jellyfin/Emby方案；排队准备在挂接前处理，已知生成等待、明确隐藏的页面和被自动播放政策阻挡的手势等待单独处理，不消耗此预算。普通网络停滞及尚未完成的play()仍计时。native→MSE或同计划重新挂接保留剩余预算，Stop、离房、身份/媒体换代和销毁使旧回调失效。

`loadeddata`或`readyState >= 2`只表示有可用媒体数据，不是已呈现首帧证明，也不会写入首帧遥测。截止后显示明确装载错误，保留已有媒体/鉴权错误和加入播放按钮；稍后收到本方案有效数据可清除该超时提示。呈现测量仍使用独立的视频帧回调/时间前进契约。

同方案更换来源或生成恢复暂停前，先使旧play()动作失效；load()/pause()造成的旧AbortError、迟到成功或权限拒绝不能改变新来源的手势状态。只有当前NotAllowedError建立自动播放阻挡；当前源的其他失败停止周期性重试而不暂停装载预算，当前AbortError给出可恢复中断提示。用户手势开始时立即解除原手势等待并恢复剩余预算，不等待play()解析成功才重新计时。

能力探测等待之后重新核验加载序号、身份 epoch、video 元素、房间和媒体代次，防止离开/重载后的旧探测创建会话。原生 HLS 的实际解码失败仍保留同一授权计划下的单次 native→MSE 降级。

## 实际播放观察与恢复

候选协商与 observation v1 并存：能力探测只验证配置，不产生「已经播放」记录。正式计划保留 `observation_version` / `observation_seq`，幂等重放与 readiness 返回当前已确认序号。观察位置始终来自媒体元素，而非房间时钟。

自动路线回退先捕获旧元素的最后实际样本，等待 Stop 提交，再取消旧幂等键和准备新计划；native→MSE 沿用同一计划与观察绑定。关闭房间后不发送新观察、续期或恢复播放，但已拥有会话的最终 Stop 仍清理资源，即使其旧 epoch 样本被拒绝。同一生成任务的 EVENT 前缀增长只恢复加载，不重建 Hls、MediaSource 或清空已有缓冲；真正的旧 attempt 409 仍走独立恢复路径。

## 验证

- `tests/capabilities.test.ts`：精确 MIME 区分、异常/缺失、有限配置、file/MSE 分离、超时与迟到不可变性
- `tests/playback-capabilities-runtime.test.ts`：实际 POST 包含报告、hls.js MSE 门控、native→MSE、reset/身份变化期间不发旧请求、最终 Stop 顺序及保留 MSE 缓冲
- `cargo test -p protocol --locked`：旧请求兼容、报告门控与原生独立性、未知报告版本回退
- `cargo run -p protocol --example export -- --check`：生成契约一致性
- `cargo test -p media-core capabilities --locked`：实际 codec 字节、缺失参数、HDR、非零定位
- `node tests/playback-candidates.mjs`：独立 PostgreSQL 与真实 FFmpeg，实际路线/输出参数、绑定篡改、源变化/旧代次拒绝、NAS 首次探测及授权回收、观察序号重放及旧 epoch 最终清理

浏览器估计测试使用受控 API；后端/编码参数另有真实 PG/FFmpeg 验证。二者均不能替代 Safari、移动端或各硬件的真实媒体播放验收。

语义参考：[Media Capabilities](https://www.w3.org/TR/media-capabilities/)、[MSE isTypeSupported](https://www.w3.org/TR/media-source-2/#dom-mediasource-istypesupported)。
