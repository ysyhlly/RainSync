# 自有可见时间码样本与独立像素解码

`scripts/generate-timecode-fixture.py` 与 `scripts/acceptance-timecode.mjs` 为 NEXT_PLAN §12.2 提供可执行的**测量链组件**。源帧、数字字形和运动色块全部由仓库代码生成；没有外部媒体、播放器时钟或 RainSync 同步算法参与时间码解码。只支持下述 RST1 布局，**不是通用 OCR**。

此交付不等于真实截图或双设备同步验收。FFmpeg 编码/解码证据、PNG 像素测试和假 page 契约测试均保留 `accepted=false`、`release_ready=false`；浏览器、物理屏幕、实际 RainSync 路径、弱网及 30 分钟×3 次尚需另外执行。本地环境已拒绝浏览器启动，本工作没有重试或绕过。

## 生成与验证

需要已安装 Python 3 + Pillow、FFmpeg（含 libx264）、ffprobe 与 Node；不会下载软件或启动容器、网络、浏览器、Agent/NAS。每个输出目录必须不存在，文件默认私有。失败时保留部分输出，不把缺少 manifest 的目录当成完成。

```sh
python3 scripts/generate-timecode-fixture.py \
  --output=.runtime/visible-timecode-001 --frames=50 --fps=25 --origin-ms=0
node --test tests/acceptance-timecode.test.mjs
# 指定尚不存在的测试证据目录，否则自动创建 .runtime/timecode-test-XXXXXX
RAINSYNC_TIMECODE_EVIDENCE=.runtime/timecode-evidence-001 \
  node --test tests/acceptance-timecode.test.mjs
```

边界：固定 640×360、1–60 的整数 fps、1–1800 帧、非负整数 origin，最后一帧必须小于 100 小时。默认 50 帧/25fps 是 2 秒循环素材；正式长测须由调用者正确处理循环坐标或生成/组合另一个已批准的长素材，不能把 2 秒原片位置回绕当成持续原片时间前进。非整数帧率、旋转、变形、HDR、色调映射、任意尺寸和自适应裁剪均不在此版本范围。

生成器保存：

- `source/000000.png` 等原始程序生成帧，以及每帧 payload、原片毫秒、显示数字、字节数和 SHA-256
- `fixture.mp4`：实际 libx264 CRF 18/yuv420p 编码结果及字节身份
- `decoded/000000.png` 等**从实际 MP4 解码**的 RGB PNG，逐帧 SHA-256
- `ffprobe.json`：编码后逐帧 PTS、流/时基和编码信息；帧数或 PTS 异常即失败
- `manifest.json`：生成/解码完整命令、Python/Pillow/FFmpeg/ffprobe 版本、生成器与解码器源码 SHA-256、样本身份、声明的自生成来源、几何配置和量化误差

精确媒体字节以 manifest 的 SHA-256 为准。相同配方在不同 FFmpeg/Pillow 版本不保证生成相同字节；sample id 绑定生成器/配方，不替代媒体 SHA-256，也不是防伪签名。正式候选绑定仍须遵循 `ACCEPTANCE_RUNNERS.md` 的样本清单和源码冻结要求。

## 接到浏览器测量驱动

生成器的 `manifest.decoder_config` 可直接用于工厂。默认截图为无缩放的 video 元素截图；截图实际尺寸必须正好匹配声明，不能根据测试器时钟或播放器位置补写解码结果。

```js
import { createVisibleTimecodeDecoder } from "./scripts/acceptance-timecode.mjs";
import { createBrowserMeasurementDriver } from "./scripts/acceptance-browser.mjs";

const decodeTimecode = createVisibleTimecodeDecoder(manifest.decoder_config);
const driver = await createBrowserMeasurementDriver({
  clients, // 已授权的真实 page、源 URL 和 manifest.spec.media_origin_ms
  decodeTimecode,
  saveFrame, // 将收到的 PNG 原样保存，返回真实 { path, sha256 }
});
```

实际对象 fit/letterbox/DPR 情形需调用者事先核对截图坐标，显式设置：

- `screenshotWidth`/`screenshotHeight`：PNG 像素尺寸，不是 CSS 像素
- `scale`：仅 1 或 2；指源画面到截图像素的整数比例
- `roi: {x,y,width,height}`：完整源画面的截图区域，必须为 `640*scale × 360*scale`，边界在截图内
- `sampleId`、`mediaOriginMs`、`fps`、`frameCount`：固定来源身份与坐标约束，不能从运行中的被测播放器推导

工厂复制 ROI 数值，调用后修改配置对象不会改变已固定几何。返回函数只接收 PNG Buffer；驱动传入的额外 client_id 不参与位置解码。未知比例/尺寸、letterbox 未配置、不能证明布局的情况都应拒绝，不能自动搜索或猜测。

返回：`{original_position_ms, method:"rainsync-rst1-pixels-v1", sample_id, frame_index, human_readable, frame_duration_ms, timestamp_rounding_bound_ms, frame_sha256}`。位置先从可见像素解出，再用固定配置和帧号校验关系；绝不读取 currentTime、系统时间、rVFC 或目标时钟来生成该位置。rVFC 是驱动中**被该像素结果核对**的另一条测量路径。

驱动先保存截图再调用解码，失败抛错并附 `error.frame_artifact`，包含失败原图的路径/哈希/客户端；调用者仍须收集该私有目录。成功检查保留 `decoder_evidence` 的帧号、样本、显示数字和量化字段，不修改已有 100ms 对照容差。PNG 保存成功不代表解码成功。普通断言失败时原图也已保存，但不保证每类错误都带该附加属性。

## RST1 像素格式

640×360 RGB 源画面：

- 标记从 `(32,32)` 开始，36 列×12 行，每模块 8×8 像素
- 最外围一圈纯白；内圈顶部按列奇偶黑/白交替，底部取反；侧边左白右黑
- 中间 32 列×8 行承载 256 位，按行、每字节高位优先；黑为 1，白为 0
- 数字从 `(32,160)` 开始，12 个 `HH:MM:SS.mmm` 字符；原创 5×7 位图，每点 4×4，字符间一列白点
- 解码器独立识别全部数字字形，并与 payload 的时间比较；数字不是仅供装饰

32 字节网络序 payload：

| 偏移 | 字节数 | 含义                             |
| ---- | -----: | -------------------------------- |
| 0    |      4 | ASCII `RST1`，版本固定           |
| 4    |      8 | 配方与生成器摘要派生的 sample id |
| 12   |      4 | 从 0 开始的帧号                  |
| 16   |      8 | 原片位置毫秒，无符号整数         |
| 24   |      2 | 整数 fps                         |
| 26   |      2 | 保留位，必须为 0                 |
| 28   |      4 | 前 28 字节 CRC32/IEEE            |

原片坐标为 `origin_ms + round(frame_index*1000/fps)`；Python 编码与 JS 解码分别实现，正数 .5 向上取整。标记 CRC32 和 PNG chunk CRC32 分别检查；它们是意外损坏检测，不提供恶意修改认证。

## 拒绝条件与精度边界

PNG 阅读器有 16 MiB 输入、4096×2304 尺寸和精确解压输出上限；仅接受 8-bit、非交错 RGB/RGBA，支持五种 PNG 行过滤器。拒绝 APNG、tRNS 透明色、调色板、灰度、16-bit、未知关键 chunk、错误长度/CRC、截断、超界或超量解压。

读取每个模块/字形点中央一半区域，避开有损编码边缘。每个采样像素必须不透明且亮度 ≤65 或 ≥190，同一个点的采样不能混合。检查所有布局/静区模块、完整 payload/CRC、版本/保留位、样本身份、fps、帧号/时间界限、全部数字及字符间空白。局部中间采样能容忍轻微编码边缘，不承诺任何模糊、抗锯齿或缩放一定可读；拒绝比猜测更重要。

`frame_duration_ms` 描述素材帧间隔；30fps 的整数毫秒字段有最多 0.5ms 舍入，25fps 为 0ms。ffprobe 的 PTS 残差另留原始记录。上述数值**不是**截图获取延迟、显示扫描、客户端时钟映射或跨设备误差的不确定度；它们不能被用来缩减驱动的截图前后包围区间或既有容差。固定帧率像素时间只标识可见帧起点，画面持续一帧的区间仍需测量设计处理。

测试覆盖实际 MP4 编码后全部 PNG、25/30fps、非零 origin、小时进位、RGBA/全部 PNG 过滤器、明确 2 倍和 padding ROI，以及校验和/布局/数字/透明度/低对比度/错误 ROI/未知比例/错误样本/帧界限/PNG 破坏的拒绝；所有负例 PNG 也保存。假 page 测试仅验证传参和失败证据保存，不能算浏览器或双客户端实测。
