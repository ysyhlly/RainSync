# 2026-10-08 测试报告修复与启动优化

## 范围与证据

输入为 `RainSync测试报告.pdf` 的全部 19 页、补充的 `report.md`，以及本次确认的 Bilibili 开播等待问题。PDF 的 5 个 H、10 个 M、17 个 L 编号全部保留；未确认或未测试的功能不伪造为缺陷。报告末尾的账号、房间和清理建议不构成删除授权。

源码基线是当前工作树 `fc985a818f50be654e78d4e50165c320291c7a96`。补充报告的生产基线 `4827cc8ee2e4adf0c074ca3c7c9d62805aa89192` 是另一份发布，不能用工作树索引代替该生产源码。当前修复未部署、未推送，也没有删除报告的正式站点测试数据。

本聊天此前约 9.1 秒的测量是点击至界面等待提示退出，不是精确首帧时间。补充报告的 2 Mbps / 10 Mbps 对照是其单样本隔离实验；下文的实际 SDK / Chromium 回归证明正式适配选段与帧信号成立，不宣称用户线上已获得相同秒数收益。

## 启动、拖动与诊断

1. **WBI 缓存及准备并行**：每次 prepare 仍重建本次凭据的 Client，跨请求复用的只是有界、过期、账户/登录/revision 隔离的签名密钥缓存；不缓存 Cookie、鉴权结论或播放 URL。独立的 view 与签名密钥准备并行，playurl 仍依赖真实结果。
2. **SDK 提前加载**：明确的 Bilibili 原生点播意图和可用 MSE 才预热 DASH。选片/待播的鼠标与键盘意图、已知房间的 SPA 返回、prepare 前三层重叠初始化；共享 Promise，拒绝后可重试。未知媒体、直播、不支持 MSE 与兼容/自适应路线不因这个入口下载 DASH；不提前取媒体授权或签名视频地址。
3. **精确 SegmentBase 选段**：通过 dash.js 的每播放器 `extend` API，仅对校验通过的生成式静态 SegmentBase VOD 生效。包含关系使用半开区间，起点仅容许约 1 ms 的索引舍入；原来的半段容差不再导致 36 秒先读取 30–35 秒视频段。音频和视频使用自己的 SIDX 时间线，不强行使用同一段编号。未修改 SDK/vendor 文件、生产资源或缓冲目标。
4. **真实阶段与计量**：播放器初始化、媒体加载与首帧分别显示；首帧超时仍观察同来源的迟到呈现，且仅清除自己拥有的超时错误。成功后的等待/追赶也有有界失败出口。本地同一个 meter 的诊断保留在播放选项中，区分浏览器帧回调与进度推进估计。
5. **Bilibili 会话指标**：普通非直播、非课程 Bilibili 准备请求协商已有指标协议；支持 v2 的响应可上传同一个 meter 的 preparation/loading/首帧证据。采样从本次 meter 起点对齐每 5 秒，避免构造时的定时器令首包错过 5 秒而延迟到 10 秒；重复绑定同一计划不重置计时。无 grant 或旧响应保持本地诊断；迟到身份、房间、媒体和计划响应不得发送旧包。现有聚合 source 对 native_platform 仍映射 `unknown`，不能宣称新增了 Bilibili 专属直方图。

`preparation_ms` 包括用户意图至实际 source attachment 的前端准备、方案请求与未结束的 SDK 初始化；它不等于纯服务端解析耗时。帧回调表示提交合成器，不是独立测量的屏幕显示时间。

## PDF 编号覆盖

| 编号 | 最终行为                                                                                                                                  | 主要实现与验收                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| H1   | 准备、初始化、媒体与首帧状态分开；超时有明确重试入口，共享播放与本机加载不混称                                                            | `playback-runtime.ts`、`PlaybackHost.vue`、`PlaybackControls.vue`；native runtime 与实际 SDK 回归               |
| H2   | 迟到真实帧清自身首帧超时，其他错误保留；追赶等待有上限及恢复出口                                                                          | `first-frame-deadline.ts`、runtime；late-frame/transport/catch-up 异步回归                                      |
| H3   | 默认分享本站 fragment 邀请链接，公开落地页支持账号及游客，JSON 为高级项                                                                   | `InvitationShare.vue`、`InvitationPage.vue`、`guest-session.ts`；双入口、撤销/过期、迟到与 token 清理浏览器回归 |
| H4   | 原生会话不再错误等待 legacy ACK；真实 HTTP owner 释放后才完成关闭，进度可查询及安全重试；丢失关闭通知时从 HTTP 恢复 lifecycle 和 revision | `room_cleanup.rs`、native owner、`RoomCleanupPanel.vue`；真实 PG/HTTP、原 upstream、浏览器进度及重试回归        |
| H5   | 成员列表包含只读房主，无其他成员时有说明；权限动作迟到响应不污染新身份/房间                                                               | `RoomAccessPanel.vue`；成员/身份 race 单元及 DOM 回归                                                           |
| M1   | 访客错误保持在展开的访客区                                                                                                                | `LoginPage.vue`；撤销/过期浏览器回归                                                                            |
| M2   | 成功消息 5 秒消失，错误不自动消失，上下文和卸载清理计时器                                                                                 | `use-transient-message.ts`、`use-action.ts`；timer/replacement/dispose 回归                                     |
| M3   | 路由等待立即显示页头，数据等待显示媒体骨架                                                                                                | `navigation-progress.ts`、`AppShell.vue`、`LibraryLoading.vue`；延迟真实模块/数据请求 DOM 回归                  |
| M4   | 登录、注册、游客、创建房间使用中文行内校验，空提交无写请求                                                                                | 认证页、`RoomsPage.vue`；local validation、无 POST、保留草稿回归                                                |
| M5   | 560/600/630px 的 50 字符昵称与连接数完整可见，成员卡高度随窄屏内容调整                                                                    | `PresencePanel.vue`、`RoomLayoutCanvas.vue`、room CSS；实际边界、同排及无溢出断言和截图                         |
| M6   | 私库未启用只给用户说明，不显示部署环境变量                                                                                                | `PrivateLibrariesPage.vue`；浏览器用户文案回归                                                                  |
| M7   | 观看者/协管员角色中文一致                                                                                                                 | `RoomPage.vue`、`RoomAccessPanel.vue`                                                                           |
| M8   | Bilibili 未连接与已解除连接按真实身份状态分别显示                                                                                         | `PlatformAccountPanel.vue`；account unit/DOM 回归                                                               |
| M9   | 浅/深主题主按钮与辅助文字达到 AA，切换时前景和背景同步                                                                                    | tokens、共享 CSS；计算及实际 hover/theme DOM 对比                                                               |
| M10  | 未登录未知路由显示公开 404，受保护路由仍守卫                                                                                              | router；匿名 404 与授权回归                                                                                     |
| L1   | 访客入口有展开提示，品牌位置稳定                                                                                                          | `LoginPage.vue`、认证 CSS                                                                                       |
| L2   | 注册采用合理单列，不保留不平衡空栏                                                                                                        | `RegisterPage.vue`、认证 CSS                                                                                    |
| L3   | 数字与中文间距统一                                                                                                                        | 认证、创建房间相关文案与既有断言                                                                                |
| L4   | 浅色/深色/跟随系统主题可切换、保存和跟随变化                                                                                              | `theme.ts`、`ThemeControl.vue`；状态、持久化与浏览器回归                                                        |
| L5   | 选片确认成功即收起抽屉；失败或旧响应不会关闭新抽屉                                                                                        | `RoomMediaPicker.vue`；真实切片确认、焦点及迟到回归                                                             |
| L6   | 长资料页侧栏全高，滚动时保持合理位置                                                                                                      | layout CSS；滚动后 viewport 回归                                                                                |
| L7   | 在线、空房、平台、账号和 NAS 首段精简，完整条件保留在详情                                                                                 | Presence/Room/Account/Compute；仍保留其他成员未知状态和重要许可说明                                             |
| L8   | 平台预览复选框与标签同行                                                                                                                  | 共享 checkbox CSS、`PlatformMediaImport.vue`；实际位置断言                                                      |
| L9   | 默认待播与播放器同宽，成员高度合理；真实 provider 元数据给集数/季数和可用缩略图                                                           | layout model、Media series 投影/label；REST、实际宽度、自定义布局重载及图片解码                                 |
| L10  | 公共/私人库页头标题和副标题上下堆叠                                                                                                       | library CSS；实际位置回归                                                                                       |
| L11  | 总影片数与本页片源/目录/影片数分别说明                                                                                                    | `library-summary.ts`、`LibraryHierarchy.vue`；实际源/目录分页断言                                               |
| L12  | 窄屏使用收起侧栏的导航布局，不横向溢出                                                                                                    | AppShell/layout；560/600/630/880px 实际 DOM 及截图                                                              |
| L13  | 游客访问采用抽屉，与房间管理一致                                                                                                          | `RoomGuestAccess.vue`；实际 drawer/保存/拒绝回归                                                                |
| L14  | 转让先显示加载，父管理层关闭，关闭按钮区分名称                                                                                            | `RoomPage.vue`、`AppDialog.vue`；held members GET、单 dialog/空状态回归                                         |
| L15  | 布局编辑时准备、错误、缓冲、自动播放入口不遮标题                                                                                          | `PlaybackHost.vue`；三种真实 overlay 状态及 inert 回归                                                          |
| L16  | 表情发送有确认反馈，失败不说成功，换片清旧发送锁；面板可折叠                                                                              | `TimelineChatPanel.vue`；success/failure/代次与迟到回归                                                         |
| L17  | Bilibili 单条预览有真实标题、分 P 标题与安全封面，失败给固定原因                                                                          | provider view/受限图片抓取与真实解码、preview DTO；unit、实际 raster DOM 和输入 fence 回归                      |

## 验证范围与运行边界

- 最终全前端 Vitest **141 个文件、2139 项通过**；Vue 类型检查、Web 生产构建、ESLint、`cargo fmt --all -- --check` 与 `git diff --check` 均通过。SDK 大块资源的既有构建提示仍存在，提前加载没有消除文件体积。
- PDF 对应的 Auth/shared 15 个、Room 新增/既有 28 个、Library desktop/mobile 8 个浏览器用例通过；长昵称三宽和自定义布局分别加严断言后通过。房间用例额外阻止所有 closed WebSocket/列表更新：HTTP 确认关闭后必须更新本机 lifecycle 与 revision；第二次读取 503 时继续轮询，恢复后重新打开携带新 revision 9，不能继续用旧 revision 8。组件卸载后的迟到重试回执不得启动新轮询。使用本机 Chromium 和受控 API，不等于真实手机/线上服务验收。
- DASH 对照使用当前锁定 SDK、45 秒本地 AVC/AAC SIDX、真实 206 byte-range 和 `requestVideoFrameCallback`。原始 36 秒会读取前段及目标段；正式适配的 35/36/38/40 秒、播放中跳转、连续跳转和销毁后的迟到 MPD 已验证。
- 原生指标另有 2 项实际 Chromium 回归：使用真实 runtime、SDK、HTTP 准备响应、帧回调及 5 秒采样。v2 grant 用例首包为 5002 ms，上传一次并收到匹配回执；无 grant 用例在同一时点保留本地证据而不上传。准备/加载/未观察阶段之和与确认首帧时间一致；这里没有验证真实生产 Rust 入库和 CDN。
- 后端通过 Bilibili family 80 项及新增 owner/cover/cache/series 单元、生产 Server 构建；真实独立 PG + loopback HTTP 验证原生关闭、真实 I/O 释放、HEAD/Range 等待取消、背压、ACK 异常/0 行、恢复与拒绝授权。现有 upstream 释放与真实 episode REST fixture 同时核验。
- 全 Server 单元在 Windows 有 5 个 Linux 专属门控失败和 2 个忽略；一个并发时序失败单独重跑通过。这里不宣称 Linux 全套通过、Worker 全套通过或发布就绪。
- 所有临时数据库/HTTP 测试资源由各自 owned fixture 回收；报告中的正式账号、关闭中的房间、评论和邀请未删除。

## GitNexus 与复核限制

MCP 注册的是 `C:\rainsync` 的旧 `39ab4d7` 索引，与本次工作树不符。本次用已有安装的 CLI 和独立任务存储建立、刷新索引；最后索引路径为 `C:\Users\ysyhly\.codex\worktrees\7a1f\rainsync`，提交为 `fc985a818f50be654e78d4e50165c320291c7a96`，更新时间为 `2026-10-08T04:36:23.369Z`。仓库 `AGENTS.md` 已采用当前 GitNexus 导航要求。

Windows 的 FTS 扩展无法加载，因此任务索引禁用 FTS；精确 symbol context/impact 可用，缺少源码或 Vue SFC 解析不完整时按要求做局部源码及行为复核。`lower-bound` 的调用/影响结果不能证明没有其他调用者。提交前的 staged changes 分析覆盖 129 个文件、480 个符号、50 个流程，风险为 critical，符号和流程展示被截断；受影响源码由相关单元和实际行为回归另行覆盖。这不是通过判据，也未把旧 MCP 索引作为本工作树证据。

## 可复核的本次证据

任务证据根目录：`C:\Users\ysyhly\.codex\visualizations\2026\10\08\01a11938-39f1-7da3-a567-5296915aa4fb`。

- `dash-segment-browser\playwright-results\dash-segment-base-real-das-1e6fc--the-previous-video-segment-desktop\dash-seek-evidence.json`：真实选段 byte-range、独立音视频时间线及呈现帧证据。
- `native-metrics-browser\playwright-results\native-platform-metrics-re-f6231-s-its-presented-frame-meter-desktop\native-metrics-evidence.json`：v2 grant 的同 meter 本地/上传/回执字段。
- `native-metrics-browser\playwright-results\native-platform-metrics-re-ac1f3-al-evidence-without-posting-desktop\native-metrics-evidence.json`：无 grant 的同 meter 本地记录与零上传。
- `pdf-report\terminal-lifecycle-baseline.json`：修复前丢失关闭通知后只刷新标题、仍停在旧 lifecycle/revision 的重现。
- `backend-fixtures\native-delivery-owner\285c696e-3df3-4b64-a40f-241b48127cc5\native-delivery-request.json`：最终真实 native owner fixture 的请求证据；8 项断言的通过结果另见本任务执行回执。

## 部署前提

修复源码与当前正式站点分开；正式站点尚未采用这些变更。原生 HTTP owner ledger 是后端资源契约变化，部署需要协调停止并排空所有旧版 Server 的原生读取，确认旧 I/O 已退出后再启动同版 Server。未经验证，不允许新旧 Server 混合读取同一数据库后把“没有 execution 行”解释成旧读者已释放，也不声称滚动升级兼容。使用既有镜像/数据库备份和回退流程；不要用直接改 closed、删除 cleanup 行或超时替代真实释放确认。
