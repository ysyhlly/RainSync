# 前端迁移与运行时职责

根入口现为完整路由应用。真实联调通过后，已删除旧App.vue、style.css及api.ts适配层，不再保留并行UI。注册/资料/头像/全部管理页面以及真实视频联合验收详见ACCOUNT_FRONTEND、ADMIN_FRONTEND、REAL_BROWSER_VALIDATION，最终验收以IMPLEMENTATION_REPORT为准。

## 依赖与边界

沿用Vue3、TypeScript、Pinia、hls.js。2026-09-28上海时间查证npm registry后加入精确锁定的 `vue-router@4.6.4`（peer Vue ^3.5.0）和 `@tabler/icons-vue@3.48.0`（peer Vue >=3.0.1）。不升级现有Vue/Pinia/Vite主版本，不引入大型UI或动画框架。统一图标为Tabler包，品牌仅文字。

workspace定向npm安装会替换Windows junction且不带根测试依赖，故已改用ARTIFACT内复制的package manifests执行完整npm ci，移回ARTIFACT/node_modules，再恢复仓库junction及@rainsync/web工作区链接。所有缓存/构建/截图仍在ARTIFACT。npm脚本不通过run-check的无shell spawn直接调用Windows npm.cmd；可调用node及npm-cli.js，或测试脚本本身。

## 身份与API

`features/auth/session.store.ts`管理用户、恢复阶段与身份epoch。`shared/api/client.ts`发送同源Cookie/CSRF，支持JSON及Blob，保留结构化错误和不确定成功响应。解析后核对epoch，旧响应不能污染新身份。同一用户的资料刷新不改变epoch。旧api.ts已删除，必要REST响应使用shared/api/types.ts。

`app/router.ts`使用history、匿名/登录/管理员守卫和站内redirect；初始连接失败显示重试，认证加载期间不闪现登录表单。管理员权限仍由Server执行。`AppShell.vue`持有唯一PlaybackHost，位于RouterView/页面Transition之外。

## 房间运行时

`features/rooms/room-runtime.ts`是Pinia单例，页面只发显式操作。它拥有socket、connectionSerial、roomSerial、重连timer、时钟采样timer和八次采样的一次性timer、CLIENT_STATUS timer、control_epoch、聊天确认/去重、房间队列和按media_id保留的标题元数据。

同房enter直接返回；换房先取消旧准备、关闭旧连接，异步历史/队列按序号隔离。认证身份变化、成员资格失效和销毁清理；普通路由导航不清理。控制命令沿用clock_epoch/revision/media_generation/control_epoch，不自动重放权限失败的旧命令。资料昵称不会作为权限标识。

页面卸载递增入口序号，迟到房间查询不能在其他页面后台进入旧房。聊天等待确认10秒后展示显式重试，保留同一client_message_id，不自动重复发送；确认、断连、离开及销毁清理计时器。

## 播放运行时

`features/playback/playback-runtime.ts`独立拥有唯一video引用、HLS实例、PlaybackPlan、loadSerial、生成等待AbortController、500ms纠偏timer、10分钟续期timer、媒体onerror/onloadedmetadata与HLS错误处理。Pinia的scope销毁清理计时器；AppShell销毁释放运行时。attach相同元素幂等，换元素要求显式停止。

保留原PlaybackRequests、65s单次/335s总准备/180s就绪等待、sessionStorage取消编号、HLS失效入口恢复/生成区间等待/seek重建、音轨竞争和按index字幕。profile/管理员页面不请求新播放会话。音轨重载期间保留选项，只有真正离开房间才清空，避免快速二次切轨丢入口。

`PlaybackHost.vue`通过CSS full-player/mini-player切布局，不Teleport、不换key、不移动DOM父节点。共享播放、seek、倍速走房间命令；音量、静音、字幕和全屏只影响本机。

## 页面与状态

RoomsPage支持创建抽屉、JSON房间邀请解析和分别输入；RoomPage负责入口权限/邀请生成复制撤销与队列，ChatPanel按滚动位置决定自动跟随。没有成员人数接口，因此不捏造人数。

Library store请求25项，展示24项，用额外一项判断下一页；新搜索重置游标，250ms防抖/回车立即搜索，AbortController与序号共同阻止迟到覆盖。无封面显示明确16:9占位，不伪造海报/评分/年份。当前片名缓存不会被搜索结果清除。

返回媒体库保留当前搜索/页码并重新查询，片源扫描后的新记录不被永久缓存空列表遮蔽。刷新不会重建房间或播放会话。

语义色集中于styles/tokens.css，确切#E5D1C1/#9E7867及深色按钮字；原生控件color-scheme:light。layout提供360/390/768/1024/1440/1920布局、mini预留、安全区和visualViewport键盘收起显示（不卸载video）。原生dialog负责模态焦点/阻止背景交互，Esc和关闭回到触发按钮。motion.css对reduced-motion去除位移与缩放，不影响播放指令时机。

## 已执行的阶段证据

- C1：35单测、类型与原38浏览器案例。
- C2：36单测、类型与原38浏览器案例；快速切轨的2处失败修复后完整重跑。
- C3/C4首批：c3-browser-final的46案例通过（原38 + 新8，桌面/移动）；c3-unit-final的36单测、c3-types-final及c3-build退出0。
- 新浏览器验证真实DOM对象身份、WebSocket和POST播放会话数量、搜索分页、普通权限、精确颜色/16:9/六宽度、reduced-motion和焦点。媒体字节为合成真实MP4，控制/API为mock，不能代替D阶段真实Server/Worker视频连续播放。
- 冷启动图标依赖发现导致最初页面就绪超过断言时间；显式optimizeDeps后全套通过。密码显示按钮最初混入label可访问名称，改为显式label/for后通过，没有放宽定位断言。
- 保留原有大chunk构建提示，未修改警告阈值。原始日志和内部检查截图不入库、不作为产品效果图交付。
