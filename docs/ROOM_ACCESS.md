# 房间邀请与委派权限

房主及站点管理员可指定 Moderator 的九项独立权限：邀请、移除成员、关闭房间、播放、暂停、跳转、倍速、换片及待播管理。换片权限同时涵盖自动下一部；待播权限涵盖平台媒体导入。Moderator 不能再委派权限，也不能创建授予 Moderator 的邀请。观看者仍可观看和聊天。

房间页面的「房间邀请」可配置有效期（1 分钟至 30 天）、使用次数（1 至 10000 或不限）、指定受邀账户 ID、授予角色及动作。Moderator 权限可设置独立有效期（1 分钟至 365 天或不限），从邀请创建时开始计时。邀请明文仅在创建时返回；历史列表可查看次数及撤销邀请。`revoked_at` 记录实际撤销时间（毫秒），重复撤销保留首次时间；升级前已经撤销的历史邀请保持 null，不虚构时间。撤销邀请不删除已加入成员或撤销其现有权限；「成员与权限」分别提供撤销权限和移出成员。

房主或管理员在「成员与权限」中修改权限时，会使该成员所有旧控制凭据失效。前端会重新连接取得新凭据；服务端每次执行仍重新检查账户、登录、成员、角色、明确动作和有效期。已过期或撤销的委派不会因旧设备重连恢复。所有权转移会撤销该房间的委派和 Moderator 邀请；普通观看者邀请仍按原策略有效。关闭或归档的房间也可转移所有权；正在关闭（`closing`）、尚未完成资源清理的房间暂不允许转移，返回 `409 ROOM_NOT_ACTIVE`，待进入 `closed` 后可重试。

每次成功接纳一个账户消费一次使用次数；同一会员身份的重试不重复消费，也不恢复后来撤销的权限。房间与邀请行在数据库事务中锁定，单次邀请的并发消费只允许一个账户成功。移出后再次加入属于新的会员身份；需要邀请仍有效且有剩余次数。

这些权限仅用于房间。授权播放控制、加入房间、获得 Moderator 角色不会授予私人库的浏览、选片或播放权；私人库共享仍遵循其独立策略。

旧客户端可以继续不带请求体创建邀请，保留 24 小时、可重复使用、观看者角色的原有行为。新界面默认生成单次观看者邀请。

HTTP API（均需当前登录，写操作需 CSRF）：

- `POST /api/v1/rooms/{id}/invites`：`expires_in_seconds`、`max_uses`（null 表示不限）、`invited_user_id`、`role`、`permissions`、`grant_expires_in_seconds`。
- `GET /api/v1/rooms/{id}/invites`：列出策略、使用状态和可空毫秒字段 `revoked_at`，不返回明文令牌。
- `DELETE /api/v1/rooms/{id}/invites/{token_or_id}`：按明文令牌或列表 ID 撤销。
- `GET /api/v1/rooms/{id}/permissions`：当前账户有效权限和房间成员的授权状态。
- `PUT /api/v1/rooms/{id}/permissions/{user}`：`role`（viewer/moderator）、`permissions`、`expires_in_seconds`（null 表示不限）。
- `DELETE /api/v1/rooms/{id}/permissions/{user}`：撤销委派。
- `DELETE /api/v1/rooms/{id}/members/{user}`：移出成员；不能移出当前房主、控制者或自己。

动作值：`invite`、`kick`、`close`、`play`、`pause`、`seek`、`set_rate`、`change_media`、`queue`。

离线房间诊断现在采用 `room-diagnostics/3`，记录实际通过的动作权限而不把 Moderator 标为管理员，继续读取版本 1/2 历史。版本 3 同时支持关闭/归档房间的所有权转移。此诊断是已提交状态的复演材料，不是授权凭据。
