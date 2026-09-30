# W03 上游播放会话闭环

核对基线：`036ac19` 后的第一批上游预约及公平清理改动，2026-09-30。最终八源与 Windows 实测二进制绑定见 `.runtime/w03-backend/fairness/backend-binding.json`（源摘要 `894a1463…`，Server `3d512f80…`）；较早绑定及源码归档仍保留。最终十九场景、完整原生集成及四十六个旧授权的五十项升级检查均通过，仍不代表 W03 全部完成。冻结候选 D 保持原源码与镜像，未包含本批改动；其 NAS 两小时门槛失败另见验证记录。

## 第一批已实现

- 新迁移 `0025_upstream_reservations.sql` 在 PlaybackInfo 前保存独立预约，绑定请求、尝试、用户、房间、媒体代次和加密凭据。每次尝试使用 `rainsync-<session UUID>`，协商、媒体/字幕请求和播放报告沿用同一设备身份；旧尝试的清理记录不依赖可重试的请求记录或最终播放授权。
- 协商由独立执行者持有，真实网络期限三十秒。响应及 SID 先加密持久化，再选择流、校验 URL/音轨及提交播放方案。取消、迟到返回、后续校验或提交失败、媒体换代和停止进入收尾，不能重新激活已关闭的尝试。
- 独立清理预算与按来源的有限并发避免慢请求阻塞其他会话。一次清理的网络总期限三秒，最多五次并受总截止六十秒约束；失败保留 `cleanup_failed`，不将耗尽或未知 SID 写作成功关闭。
- Start/Progress/Stop 通过本地领取租约串行。该租约不能阻止已提交请求在上游迟到执行，因此未知网络结果保留 `io_uncertain`；即使补偿 Stop 收到成功，也不会抹去迟到 Start 的不确定性。
- 服务重启将失去执行者且尚无 SID 的协商保留为 `unknown / cleanup_failed`；已完成且仍授权的其他会话继续 ready/renew，不重新协商。升级前的旧会话保留原身份，不能为旧 Emby 编造设备 ID。

Jellyfin 与 Emby 分别核对契约。Jellyfin v10.11.0 的 [ReportPlaybackStopped 源码](https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Controllers/PlaystateController.cs) 已包含按设备/播放会话停止转码的路径，本批按已知 SID 与一致设备的 Stopped 200/204 确认。Emby 的 [HLS 接口文档](https://dev.emby.media/doc/restapi/Http-Live-Streaming.html) 给出 ActiveEncodings 的设备级停止方式，本批要求 Stopped 200/204 和相同 SID/DeviceId 的 ActiveEncodings DELETE 200；分步确认持久保存，重试只补尚未成功的步骤。这是受控契约回归，真实固定版本验证继续。

## 已取得的验证及边界

`tests/upstream-reservations.mjs` 的十八场景主回归与独立 `--crash-unknown-only` 补测已通过。使用真实 Windows Server、隔离 PostgreSQL 和受控 Jellyfin/Emby HTTP，覆盖独立观看者、加密检查点、幂等、流/音轨/URL 校验失败、取消与迟到响应、事务失败、真实房间换代、已知/未知 SID 重启、慢清理并行、实际三十秒协商超时、五次重试耗尽、Emby 分步恢复及 Stop 后迟到 Start。旧未知尝试与新同 key 尝试相互隔离，成功与失败路径的真实容器/卷均检查清理。

`tests/upstream-reservations-upgrade.mjs` 另用旧 Server 创建六个真实 API 授权，数据库真实 1–24→25。仍有效的 Jellyfin/Emby 授权 ready/renew 保留原加密 scope/SID，不增加协商；停止一个已知 Jellyfin 使用原 `rainsync` 身份且不影响其他观看者。未知 SID 五次本地领取但零次 HTTP Stop；无可恢复设备身份的旧 Emby 虽收到五次 Stopped 204，远端编码仍活跃，不能标记 closed，也不发送猜测设备的 DELETE。原期限及超过十秒的稳定观察窗确认没有第六次领取。详见 [验证记录](VALIDATION.md)。

本批保留原先准备方案时发送 Start、从房间快照推算进度的行为；上述测试不声明网页实际进度或真实产品的解码/转码兼容。前端继续来自指定分支 `front/rainsync-implementation`，没有换回旧播放器。

## 下一批实施

提交前审查发现的旧会话 `ORDER BY id LIMIT 32` 饥饿已修复：清理与进度分别查询及有界调度，进度按最近上报时间轮转。密集旧库实跑已证明四十四个低 UUID 活跃授权不阻挡高 UUID 停止，四十二个存活授权继续 Progress，失败仍严格五次/六十秒且无第六次；原六授权证据仅代表早期版本。具体报告见验证记录。

1. 客户端报告带当前 playback session、媒体/方案代次、递增序号、原片实际位置和 playing/pause/seek/buffering/ended 事件。服务端核对所属用户/房间/代次，位置有限且在范围内；拒绝旧序号、旧会话和迟到恢复。时间轴起点由已提交方案固定，不能取客户端任意偏移。
2. 真实 video playing 触发上游 Start；合并定期进度，暂停、seek、停止及时触发。保留已实现的独立预算、清理和未知网络结果处理。继续保持持久播放器、同会话增长清单恢复与房间时钟语义。
3. 真实双观看者证明各自进度不同、停止一人不影响另一人，旧序号/代次不能复活。补齐撤权、来源删除和断网恢复。

## 关闭 W03 所需证据

创建固定镜像摘要的隔离 Jellyfin/Emby 实例，记录实际 `/System/Info` 版本与源码/镜像/样本摘要，验证分页、权限、直放/转码、随机 seek、切轨、真实客户端进度、停止、撤权和恢复。受控 HTTP 结果不能作为真实产品兼容验收。部署或最终七十二小时验收仍须使用包含这些闭环的后续候选。
