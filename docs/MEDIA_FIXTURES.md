# 可复现媒体样本

## 真实浏览器 HLS 起播与 seek

先运行 `tests/seek-fixtures.mjs`，再把它输出的报告路径传入：

```powershell
node tests/seek-browser.mjs .runtime/fixtures/seek-<uuid>/report.json
```

脚本启动独立 Vite 服务并加载实际 App.vue，沿用部署 CSP；API/房间快照受控，媒体请求使用真实 HLS 清单、初始化文件和分片。它对每条 seek 产物分别运行原生 HLS 和 hls.js/MSE：MSE 分支仅在测试中覆盖 `canPlayType` 的 HLS 能力声明，使实际 App 选择 hls.js；MediaSource、解码器、播放时钟均为真实浏览器实现，并断言 video 使用 blob URL。原生分支不做能力覆盖，不能把原生成功冒充 MSE 成功。

每条路径要求 readyState >= 2、正确视频尺寸、起播时间接近零、时长匹配剩余片长；播放推进超过 0.6 秒且解码帧数增加，再发送房间 SEEK 快照，确认原片 `origin+1.5s` 映射到播放器 `1.5s` 并暂停。报告写入同目录 `browser-report.json`，记录浏览器版本、App/依赖锁摘要及实际交付清单/分片哈希。

当前 Chromium 153.0.8010.12 上 CFR、VFR 各十条产物 × 两种传输通过。此处覆盖真实 App 与浏览器媒体链路，但不使用真实 Server/Worker HTTP 服务，不能替代授权、队列、弱网、端到端重建或长期运行测试；Safari、移动实机和长片仍需验收。

## 本地 HLS seek 起点

```powershell
cargo build -p media-core --example hls_fixture_args
node tests/seek-fixtures.mjs
node tests/seek-fixtures.mjs --vfr
```

生成 12 秒、24 fps、10 秒 GOP 的 H.264/AAC 样本，测试 0、1.25、5.25、5.267、8.125 秒请求，每个位置覆盖请求 remux/transcode。参考帧通过从原片头开始独立解码、按原片帧时间筛选获得，不使用生产输入 seek。输出首帧须与参考帧 PSNR > 30 dB，非零起点还须比旧关键帧高至少 10 dB；首个视频 PTS 与零相差小于 1 ms，清单时长与原片剩余时长差小于 50 ms，并严格解码全部音视频。

实测原来的 stream-copy 在 5.25 秒请求仍输出完整 12 秒，不能支持声明的 origin。现在非零起点的本地 HLS 使用精确解码/丢弃 preroll，即使请求 remux 也返回实际 transcode 模式；Worker 共用构造器对已入队旧参数采用同一策略。零点仍可转封装。转码关闭 B 帧重排，所有本地 HLS 关闭自动负 DTS 整体移位，防止首帧被挪到约 83 ms。音频编码延迟允许存在于包时间戳中，不能通过平移整个视频时间轴掩盖。

VFR 版本在 3 秒后每两帧保留一帧，并根据实际解码时间戳确认约 42/83 ms 两种帧间隔，不能仅凭文件标签称为 VFR。真实探测元数据传入生产参数导出器；该样本的两种请求模式实际都选择 CFR 转码。

另外比较输出 1.5 秒处的画面：参考限定为原片 origin+1.5 秒两侧紧邻的源帧（恰好落在源帧时刻时只有一帧），要求 PSNR > 30 dB，报告记录匹配帧时间及有符号误差。CFR 重采样可能选择前后邻帧，不能以总时长正确代替画面验证，也不能声称连续时间上的无限精度。首帧仍要求第一张不早于请求位置的源帧。

这是以增加解码/编码成本换取可验证起点的策略。当前证据包括短 CFR/VFR 样本的本地转换与 Chromium 原生/MSE 播放；长片、远程上游起点与 discontinuity 仍有后续验收要求。

## 字幕时间轴验收

```powershell
cargo build -p media-core --example shift_subtitles
node tests/subtitle-fixtures.mjs
cargo test -p media-core
```

本地 FFmpeg 输出完整 WebVTT 后，统一调用 `media_core::subtitles::shift_webvtt`；远程 WebVTT 也调用同一实现。按播放方案 origin 减去起点，跨零点 cue 起始裁为零，结束不晚于 origin 的 cue 丢弃，行内 karaoke 时间标记同步偏移。保留 cue ID、设置、文本、NOTE/STYLE/REGION；接受 UTF-8 BOM/CRLF，拒绝无效 UTF-8、倒置或损坏时间戳及超过 2 MiB 的数据。时间戳结构和行内标记约束参考 [W3C WebVTT](https://www.w3.org/TR/webvtt1/)。不支持的 X-TIMESTAMP-MAP 明确拒绝，不静默套用错误偏移。

本地外挂文件和 FFmpeg 输出各有 2 MiB 上限，转换保留 30 秒截止及子进程取消。HEAD 返回空正文。本机没有原生 FFmpeg，因此本轮通过固定 Docker 镜像进行真实 SRT 转换，再交给生产 Rust 处理器，最后用 ffprobe 读取生成的 VTT 包时间戳；没有将这个组合冒充原生 Worker 本地子进程端到端验收。

中文 UTF-8/BOM SRT 的 1–5 秒长 cue，在 origin=3 秒时保留为 0–2 秒；0–1 秒 cue 丢弃；5–7 秒 cue 变为 2–4 秒。`tests/subtitle-delivery.mjs` 随隔离数据库集成，使用真实 Worker 访问受控 Jellyfin/Emby 字幕端点，检查凭据代理、BOM、偏移、HEAD、损坏/超大响应；为隔离 Worker 行为，在测试授权记录中注入已知 origin，不声称验证了上游实际播放起点。

原始负 WebVTT 时间戳属于无效输入，不能与“减去 origin 后跨零点”混为一谈。分段时间映射、ASS 样式、图形字幕、真实上游与播放计划实际 origin 仍有独立验收要求。

W01 的短样本目录位于 `tests/fixtures/media-cases.json`。生成器把本地镜像标签解析为不可变 image ID，随后以禁网、2 CPU、512 MiB 限额运行 FFmpeg。默认镜像为 `rainsync-server:dev`，可通过 `FIXTURE_IMAGE` 指定其他已安装镜像。

```powershell
node scripts/media-fixtures.mjs
cargo build -p media-core --example verify_fixtures
node tests/fixture-manifest.mjs
```

产物保存在 `.runtime/fixtures`，不提交二进制媒体。`manifest.json` 记录镜像 ID、FFmpeg 版本、每个文件的字节数、SHA-256、探测元数据与边界检查结果。每段约三秒；重新生成会覆盖这些测试文件。

| 样本 | 必须验证的性质 | 当前保守路线 |
|---|---|---|
| h264-high-aac | H.264/AAC 基础样本 | direct |
| h264-no-audio | 没有音轨 | direct |
| h264-ac3 | MKV + AC3 | remux，音频转 AAC |
| mpeg4-aac | 非 H.264 视频 | transcode |
| h264-high10 | 10-bit H.264 | transcode |
| pq-tagged-video | PQ 元数据 | 拒绝 HDR；不是 HDR 画质样本 |
| h264-multi-audio | 440/880 Hz 两条独立音轨，eng/jpn 标签 | 默认 direct；选择音轨时 remux |
| h264-rotated | MP4 display matrix 为 90° | direct |
| h264-anamorphic | sample aspect ratio 为 4:3 | direct |
| h264-vfr | 时间戳严格递增，实际帧间隔约 42/83 ms | direct |

生成时解析实际探测结果并断言音轨数量、语言、旋转、像素宽高比以及逐帧时间间隔。随后显式映射视频和全部音轨进行 FFmpeg 解码，`-xerror` 使解码错误立即失败。可变帧率不能仅由平均帧率判断；必须确认封装后仍有不同帧间隔。

Rust 验证器使用源码中的目录作为期望，检查完整性、重复项、配置漂移以及磁盘文件哈希，再把真实探测元数据传入生产路线选择函数。负向测试验证缺项、重复项、错误哈希和修改期望均被拒绝。该清单是本地测试证据，不是防恶意篡改的签名证明。

这些测试不证明浏览器正确显示旋转/像素比例、不证明真实切音轨或 VFR 同步，也不替代长片 seek、字幕矩阵、NAS 两小时、移动实机和持续运行验收；后续 W02/W06/W07/W09 应复用这些样本完成各自范围。

## 本地 HLS 转换验收

```powershell
cargo build -p media-core --example hls_fixture_args
node tests/hls-fixtures.mjs
```

该脚本调用生产 FFmpeg 参数构造器和本地 HLS 视频转换判定，在生成样本时记录的同一镜像内转换，随后检查输出编码、显示宽高比（容差 1%）、总时长（相对源文件差异小于 150 ms）、视频/音频解码及 ENDLIST。每轮使用独立输出目录，证据写入 `.runtime/fixtures/hls-<uuid>/report.json`，包含请求模式与实际选择模式，不能将升级后的转码冒充 stream-copy 验证。

当前十类样本中 PQ 被路线选择拒绝，其余九类共十六条转换路径通过。H.264 High10 和 MPEG-4 只测试转码；其他样本覆盖请求 remux 和 transcode。测试发现并修复两项问题：

- MP4 90° display matrix 在 stream-copy HLS 中丢失，导致显示比例变化。本地 HLS 遇到非零旋转时升级为视频转码，由 FFmpeg 将旋转应用到像素。
- VFR 样本直接复制到 HLS 后清单时长为 2 秒，与约 3 秒源文件不一致。名义与平均帧率相差超过 1% 时保守升级为转码，明确采用 CFR 输出；该样本输出时长为约 2.958 秒。

帧率差异是保守判据，不是完整的 VFR 检测器：元数据缺失或两种帧率恰好一致的输入不能凭此断言为 CFR。直放继续交付源文件，不因这些本地转换规则强制转码。上游自行生成的 HLS 不经过本地转换规则，其兼容性仍需 W03 独立验证。此矩阵中的多音轨转换检查默认选轨输出；第二轨的声音验证见下节。

## 显式音轨的声音验证

```powershell
cargo build -p media-core --example hls_fixture_args
node tests/audio-fixtures.mjs
```

使用多音轨样本的绝对流编号分别请求第一、第二音轨，在 remux/transcode 两条路径生成 HLS，再将唯一输出音轨解码为 8 kHz 单声道 float PCM。取中间一秒检查非静音，并比较 440/880 Hz 的频率能量：选中频率的能量须超过另一轨频率的 100 倍。四条路径均验证实际声音，不能仅凭返回的语言标签或 FFmpeg 参数判定选轨成功。不存在的流编号须让 FFmpeg 失败，不能退回默认音轨。证据保存在独立 `.runtime/fixtures/audio-<uuid>/report.json`。

Worker 与样本验证共同使用 `hls_args` 的显式绝对流编号参数，不再各自替换参数字符串。服务端先验证编号确实属于音频流；本地/HTTP/Agent 明确选轨时即使请求 direct，也须生成带选轨的 HLS。设备不能播放 HLS 时返回不兼容错误，不忽略用户选择。播放起点继续传入任务，选轨不修改房间权威时间轴。上游原生选轨仍由各自适配器协商。

`tests/audio-routing.mjs` 随隔离集成检查 HTTP 方案与任务参数；上述 FFmpeg 测试验证输出内容。两者仍不替代网页实际切换、网络 seek、上游多音轨与实机听播验收。


## Browser subtitle fixture

`tests/fixtures/browser-video.base64` contains a synthetic three-second, 32x32 black H.264 Baseline MP4 with no audio. Playwright decodes the Base64 for an HTTP media response so CI needs no Docker or local generated fixtures. It was generated using image `sha256:601d17a36464b22699564fc37ffcf7c402e37d288d447c25295125eff2a8d7f8` and this FFmpeg recipe:

```text
ffmpeg -v error -nostdin -y -f lavfi -i color=c=black:s=32x32:r=10 -t 3 -c:v libx264 -pix_fmt yuv420p -profile:v baseline -an -threads 1 -movflags +faststart browser-subtitles.mp4
```

The subtitle lifecycle test supplies a valid WebVTT cue through a controlled route and verifies the browser's actual TextTrack state and parsed cues. It does not substitute for Worker subtitle conversion, upstream authorization, visual subtitle layout, or device-specific playback validation.
