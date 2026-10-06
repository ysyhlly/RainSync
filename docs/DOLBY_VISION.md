# Dolby Vision 播放

Dolby Vision 已纳入实现范围，覆盖单层 HEVC Profile 5、8.1 和 8.4。该功能使用现有本地、HTTP 文件和 NAS 播放资格检查，不适用于带 DRM 的媒体或平台网页登录。

| 路线 | 当前支持与条件 |
| --- | --- |
| 原生输出 | 合格的原始 MP4 文件直接传输，保留 HEVC、Dolby 配置和动态 RPU；沿用原片容器、轨道、变换及版本检查。 |
| 转 SDR | 使用 libplacebo 读取实际解码的 RPU，进行 Dolby 重塑和色调映射，输出现有最高 720p H.264 / BT.709 方案；保留现有音轨、跳转和字幕流程。 |
| 自动选择 | 默认自动模式先检测原生能力。不支持或原生路线解码失败时，新建当前观众自己的 SDR 请求，不更改房间时间或其他观众的路线。 |
| 未覆盖 | 双层 Profile 7 / FEL、其他 Dolby 编码及不符合现有容器、轨道、几何资格条件的源。此处不能据此宣称完整 Dolby Vision 认证或全 profile 支持。 |

原生能力同时要求实际文件的 MIME 支持、带 HDR 元数据参数的 MediaCapabilities 解码结果、相应 Dolby codec 支持和 HDR 显示能力提示。普通 HEVC 支持不能代替 Dolby Vision 支持；缺少检测接口时使用 SDR。浏览器提示和数据传输验证不等于设备已经实际呈现 Dolby Vision。

Profile 5 不作为普通 PQ/BT.2020 图像解释。其未指定的 VUI 色彩字段由 Dolby 元数据处理；兼容 Apple 开发样本中的有限范围标记。Profile 8.1 必须有一致的 HDR10 基础层标签，8.4 必须有一致的 HLG 基础层标签。转换前在保留的文件描述符上检查实际解码的 RPU 和 Dolby 元数据；只有容器标记而没有实际 RPU 的输入会被拒绝。

运行镜像包含 FFmpeg、libplacebo 和 Mesa Vulkan 驱动，可以在没有主机 GPU 的环境中使用 CPU Vulkan。CPU Vulkan 使用两条执行线程；Dolby 转换采用软件 H.264 编码，尚未声称验证 GPU 之间的设备互通或 4K 实时转换性能。现有普通 HDR 和其他硬件编码路线保持各自资格检查。

## 验证

常规检查包括 Rust 测试、协议生成检查、前端测试及构建。真实样本测试显式执行，测试自身不下载媒体，也不连接生产数据库：

```sh
RAINSYNC_DOLBY_FIXTURE_ROOT=/owned/fixtures \
  cargo test -p media-core --test dolby_vision_output -- --ignored --nocapture
```

夹具目录至少需要 `dv84.mp4`，还可包含 `dv5.mp4` 和 `dv81.mp4`。需要提供支持 Dolby 元数据的 FFmpeg/libplacebo/Vulkan 运行环境。测试检查实际 RPU、原生候选资格、普通 SDR 工作器拒绝 Dolby 原片、转换及跳转后的实际 SDR 输出和源文件完整性。`RAINSYNC_DOLBY_OUTPUT_REPORT` 可保存检查结果。

开发样本来自 [FFmpeg FATE](https://fate-suite.ffmpeg.org/hevc/dv84.mov) 和 [Apple 的 Dolby Vision 开发示例](https://developer.apple.com/streaming/examples/advanced-stream-dv-atmos.html)。FATE MOV 样本在夹具准备阶段仅重封装为 MP4、去除旋转标记；Apple 片段在夹具准备阶段仅重封装并恢复原有 `dvh1` 样本入口。媒体包和 RPU 不重新编码，准备过程应记录 URL、散列和包数据保持证据。样本不随仓库发布。

尚无用户设备做原生显示验收。数据保持、软件转换和浏览器 SDR 播放的证据应与原生显示、GPU/HDR、手机及长时间稳定性验收分开记录。
