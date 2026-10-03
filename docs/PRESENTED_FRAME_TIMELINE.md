# 首帧截止与时间轴安全边界

2026-10-02；本地实现检查，未发布或部署。对应 `NEXT_PLAN.md` §8.3、§11.2 的有界增量，不能据此关闭整个 W02/W06。

## 首帧截止

- 每条已就绪路线有独立的 20 秒呈现等待预算。开始点在准备/队列完成并挂载资源后；每个具体候选的解码降级仍使用原来的最多三路线、候选绑定和代次限制。
- `loadedmetadata`、`loadeddata`、`canplay`、`readyState >= 2`、`playing` 或 `play()` 成功均不能单独结束此预算。
- 有 `requestVideoFrameCallback` 时，使用本资源挂载后、同一单调时钟范围内的 `presentationTime`，证据名称是 `video_frame_callback`。它表示提交给合成器，不证明屏幕像素已被用户看到。
- 没有该 API 时，只接受实际 `playing` 事件后的时间前进，并同时要求未暂停、未 seek 和 `readyState >= 2`；seek/seeked 重置比较基线。证据明确标为 `playing_time_advance` 近似值。存在但注册失败的 RVFC 不伪造近似成功，原截止仍有效。
- 显式房间暂停、后台、实际自动播放权限拒绝、生成区间等待不消耗剩余预算；挂起的 `play()`、普通缓冲和有数据但无呈现仍消耗预算。现有准备超时、生成等待超时和“媒体数据加载超时”保留为不同边界。
- native → MSE、同方案重载保留剩余预算；旧源回调先失效再替换。取消、换房间/媒体/账号、销毁以及方案代次变化均令旧计时和回调失效。成功或超时后该初始预算不反复重启。
- 超时只显示“尚未确认画面呈现”，不能推断解码失败、自动新建转码授权或覆盖已有认证/媒体错误。安全截止独立于可选指标 grant、指标构造、上报或观测失败。

## 时间轴拒绝边界

- 客户端在准备结果进入 readiness 算术、挂载、seek、字幕和观测之前验证有限且非负的 origin/duration。非零标量 origin 仅允许既有 `rebuild_on_seek + HLS + transcode` 精确解码裁切契约；直放/转封装不能带一个请求起点冒充实际映射。
- 服务端保留 legacy remux 非零起点升级为精确解码的旧流程；对于已经绑定到 stream-copy 候选的 remux，非零起点明确拒绝，避免 FFmpeg 内部悄悄转码却仍宣称原候选/codec 证据成立。
- Worker 在主播放清单签发任何子 URI 前拒绝 `EXT-X-DISCONTINUITY`、非零/重复/无效 `EXT-X-DISCONTINUITY-SEQUENCE`、重复/无效 `EXT-X-MEDIA-SEQUENCE`、`EXT-X-SKIP`。`MEDIA-SEQUENCE` 是分片编号，不是时间偏移；完整静态 `PLAYLIST-TYPE:VOD + ENDLIST` 允许从7等非零编号开始，原编号、时长和坐标均不改写。缺少此完整静态声明的非零窗口仍保守拒绝。每一层清单均检查，因此子媒体清单不能借 master 绕过。返回 HTTP 422、`UNSUPPORTED_TIMELINE`，不可按暂时失败重试。
- 该校验是主播放限制；通用清单解析和预览输入仍可保留标签。完整的原时间轴 VOD/从零开始的 EVENT 及 master 路线不因请求的 `StartTimeTicks` 而改变 origin。参数名称或用户请求位置本身不是输出时间轴证据。
- 零起点 `audio_transcode` 保留原视频、只转换音频，与零起点remux同样允许；非零起点仍须精确视频解码策略，不能把分片编号或音频转换当成视频映射证据。
- 新拒绝会使此前被不安全代理的 discontinuity/滑动清单失败；它没有新增 piecewise mapping。通过解码输入网关触发此拒绝的任务仍可能沿现有持久任务分类显示 `MEDIA_INPUT_INVALID`；本轮没有新增持久任务错误迁移。

## 仍未关闭

通用 HTTP/HLS 的实际首 PTS/原片坐标映射、非标准上游裁切输出、分段映射、无显式不连续标签但时间戳跳变的输入，以及更多媒体/长片随机 seek 样本仍未建立全覆盖证据。现有本地精确裁切和已验证的上游完整清单契约保留；没有根据请求 seek、扩展名或缺失字段生成映射。§11.2 仍是部分实现。

## 本轮验证

- `npm test`：36 文件、690 项通过，包含新的假时钟/事件首帧边界及实际运行时调用链测试
- `npm run build`：类型检查和生产构建通过；保留既有 >500 kB chunk 警告
- `cargo test -p protocol --locked`：32 项通过
- `cargo test -p rainsync-media-worker --locked`：162 项通过，10 项需隔离数据库的测试跳过
- `cargo test -p rainsync-server --locked playback_plan::tests`：4项通过
- `cargo clippy -p rainsync-server -p rainsync-media-worker --all-targets --locked -- -D warnings`：通过
- 52 项 Chromium desktop/mobile 配置的受影响 Playwright 回归已尝试两次；第二次经审核运行，但环境仍在浏览器启动时禁止 `socket()`。全部未进入应用断言，因此不算 52 项应用回归失败或通过，仍需可运行浏览器环境复验

后续审查修正两项误拒绝：完整静态VOD非零分片编号、零起点audio_transcode。`cargo test -p rainsync-media-worker --locked hls_manifest::tests` 8项、`http_media::timeline_tests` 2项以及server的 `playback_plan::tests` 4项通过；server/Worker all-target严格Clippy、格式和diff检查通过。新增正向检查只证明清单/路线契约与时长、编号保留，不冒充新媒体PTS解码或端到端prepare验证。

没有新真实上游、移动实机、媒体解码像素、长测或远端 CI 通过声明。共享 TS/Schema 由集中集成端统一导出后核对。
