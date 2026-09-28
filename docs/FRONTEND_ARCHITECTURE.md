# 前端迁移与运行时职责

审计后补充：认证Cookie写入由session共享协调，取消并等待前项结束，再核验auth/me与预期账号/CSRF后接受身份；注销不再等待远端播放清理；进房成功清理后才记录激活房间。聊天同编号重试由0022数据库唯一约束保障。新证据见[AUDIT_FIXES.md](AUDIT_FIXES.md)，以下阶段记录保留为历史。

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

语义色集中于styles/tokens.css；当前为浅奶油背景#FFF4D5、浅棕按钮#D2B49C、深棕文字#30241F，原生控件color-scheme:light。layout提供360/390/768/1024/1440/1920布局、mini预留、安全区和visualViewport键盘收起显示（不卸载video）。原生dialog负责模态焦点/阻止背景交互，Esc和关闭回到触发按钮。motion.css对reduced-motion去除位移与缩放，不影响播放指令时机。

## 导航选中动画（2026-09-28）

`app/AnimatedNavigation.vue` 共用桌面侧栏与手机底部导航结构。桌面侧栏始终展开，不提供收起；手机仍用底部导航。独立选中背景根据实际链接位置纵向或横向移动，并轻微回弹。详情房间归属“放映室”，手动创建账号归属“账号与注册”，手机管理子页归属“管理”；个人资料和未知页面不保留错误的导航高亮。

`app/use-navigation-indicator.ts` 管理测量与弹簧：快速切换保留当前位置和速度，达到阈值后停止 requestAnimationFrame；ResizeObserver 与 resize 更新位置，首次显示/重新显示直接定位。路由立即响应，动画不阻塞页面或播放。减少动态效果时即时定位，页面隐藏时暂停装饰动效；卸载取消帧、观察器和事件监听。

桌面选中项使用 SVG 规范化圆角路径，按路径长度匀速推进两段相隔半周的渐变光带，每 5 秒完成一周。每条光带按 96 个细密样本从透明尾部过渡到暖金、暖棕；所有样本的 stroke-dashoffset 使用同一线性周期，长边、短边、圆角处速度一致。路径宽度 2px，边框轮廓固定，文字和图标不移动，装饰元素不捕获指针。手机只保留选中背景回弹，没有流光。reduced-motion 完全关闭循环，保留静态选中背景与轮廓。

执行计划和验证结果见[导航动画计划](superpowers/plans/2026-09-28-navigation-motion.md)。此变更仅本地源码提交，按用户要求未更新运行中的服务。

后续部署（2026-09-28 21:18，Asia/Shanghai）：用户明确要求“同步已运行的服务”后，将 `f437fdd` 的前端构建为 `rainsync-web:navigation-f437fdd`，更新 dev 标签并仅执行 `docker compose up -d --no-deps --no-build web`。实际部署页面资源通过桌面/手机共 8 项导航回归（真实 Chromium，接口由隔离测试模拟），首页/CSS 为 200，匿名账号接口为 401。server/db/worker 容器 ID 及 SnowLuma 5099 的 PID 752 均未变化。证据目录为 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-navigation-deploy-2026-09-28`，包含构建、更新、浏览器检查日志与 `verification.json`。回滚前端时将 `rainsync-web:rollback-navigation-20260928-211228` 标记为 `rainsync-web:dev`，再执行上述仅更新 web 的命令。

渐变边框修正（2026-09-28 22:47，Asia/Shanghai）：用户反馈旋转不可见且需要渐变。旧实现只有三层固定透明度的 SVG 描边，并非连续渐变；旧测试仅验证描边数值变化，不能证明可见旋转，未据此认定所有浏览器中的不可见原因相同。本次改为上述真正的渐变旋转，新增实际渲染像素验证：0ms 与 1250ms 画面不同，0ms 与 2500ms 画面相同，验证两个相对光带的四分之一圈位移和半圈对称。保留自动循环、减少动态效果、两端回弹和焦点验证。

本次证据目录 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-gradient-border-2026-09-28`：`gradient-red` 在旧部署资源上确认无渐变；`gradient-green` 8/8、`gradient-regression` 30/30、镜像构建（含类型检查和生产构建）通过；`gradient-deployed` 在实际新部署资源上 8/8 通过，产物包含三个相位截图。接口均由测试隔离，不操作真实用户数据。仅 web 容器更新，server/db/worker 和 SnowLuma 进程保持不变；首页 200、匿名账号接口 401。新镜像 `rainsync-web:gradient-border`；前端回滚标签 `rainsync-web:rollback-gradient-20260928-224652`，重新标记为 dev 后执行上述仅更新 web 的命令。远程 CI 和 Safari/手机实机未验证。

周长匀速修正（2026-09-28 22:59，Asia/Shanghai）：用户确认需要沿边框匀速而非转角匀速，并保持 5 秒周期。替换上述历史 conic-gradient 版本，采用本节开头的路径渐变采样实现。新增整圈 250ms 间隔检查，每次前进规范化路径的 5%，保留实际画面四分之一圈变化、半圈对称检查。`C:/Users/ALIENWARE/Desktop/杂项/RainSync-uniform-border-2026-09-28` 保存失败基线 `uniform-red`、新增用例 `uniform-green` 8/8、`uniform-regression` 30/30、类型检查/构建 `uniform-image`、部署 `uniform-update`、部署资源回归 `uniform-deployed` 8/8 和 `verification.json`。仅前端容器已更新，其他服务保持原状，首页 200、匿名账号接口 401。修复镜像 `rainsync-web:uniform-border`；前端回滚标签 `rainsync-web:rollback-uniform-20260928-225847`，按上述相同方法回退。

## 已执行的阶段证据

- C1：35单测、类型与原38浏览器案例。
- C2：36单测、类型与原38浏览器案例；快速切轨的2处失败修复后完整重跑。
- C3/C4首批：c3-browser-final的46案例通过（原38 + 新8，桌面/移动）；c3-unit-final的36单测、c3-types-final及c3-build退出0。
- 新浏览器验证真实DOM对象身份、WebSocket和POST播放会话数量、搜索分页、普通权限、精确颜色/16:9/六宽度、reduced-motion和焦点。媒体字节为合成真实MP4，控制/API为mock，不能代替D阶段真实Server/Worker视频连续播放。
- 冷启动图标依赖发现导致最初页面就绪超过断言时间；显式optimizeDeps后全套通过。密码显示按钮最初混入label可访问名称，改为显式label/for后通过，没有放宽定位断言。
- 保留原有大chunk构建提示，未修改警告阈值。原始日志和内部检查截图不入库、不作为产品效果图交付。
