# 管理区实现与验证

管理页面在同一应用外壳内，桌面主导航及手机管理次导航均可进入片源、NAS设备和账号管理。全部管理路由由认证/管理员守卫保护，接口仍依赖Server强制权限。PlaybackHost位于路由视图外，管理表单和抽屉不重建播放实例。

## 页面与接口

- `features/admin/SourcesPage.vue`：GET/POST `/sources`、POST `/sources/{id}/test`。本地、HTTP、Jellyfin、Emby按实际配置字段填写；HTTP headers必须为字符串值JSON对象。检测扫描忙碌、失败、count分别归属每一行；NAS来源只显示主动同步说明，不编造扫描按钮/进度或片源编辑删除接口。
- `AgentsPage.vue`：GET/POST `/agents`及DELETE `/agents/{id}`；配对创建返回id与pair_code，没有服务端到期时间，所以10分钟倒计时明确为预计、以服务器校验为准。最后联系记录不被写成实时在线。撤销明确说明凭据和读取影响并确认。
- `CreateUserPage.vue`：POST `/users`创建普通账号，共用注册规则；可选昵称独立于固定登录账号，密码不trim，成功后清空密码。
- `RegistrationInvitesPage.vue`：管理员邀请码创建/列表/状态/游标/单项撤销，时间字段使用Unix毫秒，状态只取服务器结果，并显示查询时的server_time，避免本地时钟决定业务状态。

## 批次和复制语义

一次生成对应一个crypto.randomUUID。未知响应会查询同一batch_id；只允许显式使用同ID及原参数重试，绝不自动换ID生成另一批。成功但原响应丢失只能看元数据，提示撤销丢失的未用代码后重新生成。会话标签页sessionStorage按管理员身份保存未确认操作的ID、数量、天数及备注，以便刷新后准确重试；**从不保存原码**。与设计中的仅保留ID建议相比，额外保留非凭据参数是为了刷新后保持服务端幂等参数一致，记录在此。

原码只在当次创建结果抽屉内，单条/全部复制均等待clipboard成功；失败选中文本供手动复制。未复制完关闭会提醒，可以明确关闭，关闭不会撤销代码。路由离开和页面刷新有未复制提示。历史记录仅尾号，无恢复原码按钮。已用记录同时显示昵称和登录账号。

## 测试证据

`tests/browser/admin.spec.ts`在桌面/手机Chromium模拟下覆盖16例：真实剪贴板拒绝分支、关闭提醒、单条撤销、截断成功响应恢复、刷新后同ID参数重试、游标/筛选、昵称/账号并列、片源JSON及独立扫描、NAS配对和撤销、密码空格、管理导航保持同一video/WS/播放申请计数。

`ARTIFACT/logs/c6-admin-browser-fixed.json`于2026-09-27T20:52:05.657Z完成，16例全部通过；`c6-unit`44单元测试通过，`c6-types-first`类型检查通过。首次浏览器执行失败是精确label定位包含select的option文本，改用实际无障碍combobox角色/名称定位，未减少断言；原始日志保留。全量浏览器及生产构建证据在本阶段进度记录中。以上为可控HTTP/WS mock异常与合成视频验证，不能替代D阶段真实Server/Worker联调。
