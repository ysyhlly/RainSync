# 其他平台直播范围

当前封闭适配器覆盖 YouTube、抖音、TikTok 的授权直播解析与明确支持的 HLS 媒体，
与 [Bilibili 直播](BILIBILI_LIVE.md) 和 [平台合集导入](PLATFORM_COLLECTION_IMPORT.md)
分开处理。资源身份、媒体 origin/path、清晰度/编码和短期授权均有边界。
维护来源与限制见 [Provider 边界](../crates/providers/src/platform/other_live/BOUNDARY.md)。

YouTube 需要已配置且受约束的 extractor；抖音/TikTok 不进行任意接口发现、
签名/指纹或 JS challenge 生成、自动登录、DRM 绕过或 feed 抓取。
需要用户交接、权限不足、未验证编码、受保护媒体或未允许的 URL 明确失败，
不把失败转换为任意远程 URL 播放。原始 URL、Cookie 和 headers 留在 Server，
不进入浏览器、日志或导出报告。

当前只支持代码明确接纳的直播输出和滚动窗口，不提供完整 DVR 或共享直播时间轴。
纯 fixture 仅验证解析、身份、许可和窗口处理；真实平台访问、extractor 执行、
凭据、真实媒体、浏览器播放和固定候选长时验收应另行记录，本文不宣称已完成。
