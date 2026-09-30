# W03 上游播放会话下一批

核对基线：`7271c78`，2026-09-30。此页记录实际调用链与待实施闭环，不代表 W03 已完成。W07/W08 的冻结候选 B 不随本页或后续活源码修改而变化。

## 当前代码证据

- `providers::upstream_plan` 在 PlaybackInfo 中为 Jellyfin 固定 `DeviceId=rainsync`，Emby 仅发送 Token；后续媒体资源也只保存 Token。多观看者没有独立且贯穿请求的设备身份。
- `media::prepare_playback` 先调用 PlaybackInfo，再选择流、校验音轨/能力并提交 playback_sessions。上游协商已成功而本地后续失败、请求取消或事务失败时，可能没有可供后台补偿的记录。
- `upstream::report` 从房间快照推算 PositionTicks，而非该观看者视频实际位置。`upstream::maintenance` 每十秒串行遍历会话；一个慢上游可延迟其他会话，停止失败没有次数及总截止限制。
- 前端来自指定分支的 `features/playback/playback-runtime.ts`。后续进度接入在此模块完成，继续保持持久播放器、同会话增长清单恢复和房间时钟语义。

Jellyfin 与 Emby 分别核对契约。Jellyfin v10.11.0 的 [ReportPlaybackStopped 源码](https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Controllers/PlaystateController.cs) 已包含按设备/播放会话停止转码的路径，不能仅因未发 ActiveEncodings DELETE 判定泄漏；仍须验证协商、媒体和报告的设备身份一致。Emby 的 [HLS 接口文档](https://dev.emby.media/doc/restapi/Http-Live-Streaming.html) 给出 ActiveEncodings 的设备级停止方式，独立设备身份也是避免停止其他观看者的前提。

## 实施闭环

1. 新增独立持久化上游会话记录。在发出 PlaybackInfo 前，绑定本地 request/attempt/user/room/generation、加密凭据及不可猜测的独立设备 ID；不依赖最终 playback_sessions 已存在。
2. 协商、资源请求、字幕和播放报告使用相同身份。收到上游 PlaySessionId 后先持久化，再验证/交付本地方案。任何失败、迟到响应、停止或权限失效进入收尾状态；请求被 Drop 与服务重启都由独立执行器补偿。
3. 客户端报告带当前 playback session、generation、递增序号、原片实际位置和 playing/pause/seek/buffering/ended 事件。服务端核对所属用户/房间/代次，位置有限且在范围内；拒绝旧序号、旧会话和迟到恢复。时间轴起点由已提交方案固定，不能取客户端任意偏移。
4. 真实 video playing 触发上游开始；定期进度合并，暂停、seek、停止及时触发。按上游/会话有限并发，单次网络截止独立，重试指数退避并同时限制次数及总截止。清理耗尽保留 cleanup_failed 可观测状态，不能假记 closed。
5. 所有写入/领取/完成具备租约或 fencing，旧执行不能恢复已停止会话。清理不持有房间锁，也不阻塞控制 ACK。只有收到对应服务契约确认后才标记完成。

## 关闭 W03 所需证据

先用受控上游复现 PlaybackInfo 成功后流校验失败、取消、事务失败、迟到响应、断网、长响应、重启和停止重试耗尽；两个独立观看者证明进度不同、停止一人不影响另一人，旧序号/代次不能复活。

随后创建固定镜像摘要的隔离 Jellyfin/Emby 实例，记录实际 `/System/Info` 版本与源码/镜像/样本摘要，验证分页、权限、直放/转码、随机 seek、切轨、真实客户端进度、停止、撤权和恢复。协议夹具结果单独标明，不能作为真实产品兼容验收。部署或最终七十二小时验收仍须使用包含这些闭环的后续候选。
