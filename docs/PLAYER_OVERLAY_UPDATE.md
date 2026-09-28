# 播放器透明浮层与选择控件调整

日期：2026-09-29；分支 `front/rainsync-implementation`。执行依据为用户确认的界面计划：手机保留聊天/待播切换，桌面隐藏无效切换；SVG 下拉箭头；浅暖米色细进度条、透明黑色底部渐变和白色控件。

## 实现

- `layout.css` 用 `.app-segmented.mobile-room-tabs` 修正通用分段组件覆盖桌面隐藏规则的问题。手机切换只隐藏面板，不卸载聊天组件，窗口缩放后保留选择和草稿。
- 公共 `AppSelect` 使用现有 Tabler 下箭头与勾选图标，20px；展开箭头旋转，reduced-motion 关闭过渡。页面继续使用奶油/深棕配色。
- `PlaybackControls` 接收设置组件插槽，把播放设置收进同一行齿轮入口；保持原 settings Popover 在播放器 DOM 内及其 Escape、焦点、菜单锁定机制。
- 设置菜单从齿轮向左展开，横向限制在播放器边界内，避免覆盖聊天区域；长菜单按原规则在视口中滚动。
- `player-overlay.css` 为普通完整播放器和真实全屏提供独立白色/半透明黑色调色板。进度条视觉高度 3px，悬停/聚焦 5px，拖动区域 24px；填充浅暖米色 `#eed9b5`。下方控件 44px，渐变和整套控件同步隐藏。
- 音量通过悬停/焦点展开；窄屏时间可换行，保证 320px 视口的功能按钮仍位于视频内。迷你播放器保持浅色卡片和深色控件。
- 显隐状态机、播放权限、房间命令、同一 video 和 WebSocket 生命周期不变；全屏五秒闲置隐藏鼠标、信息与控件。

## 验证与边界

证据目录：`C:/Users/ALIENWARE/Desktop/杂项/RainSync-player-overlay-20260929`。日志 JSON 保存实际命令、时间、退出码；同名 log 保存输出。

- `overlay-red` 在旧实现上四项失败，证实桌面错误显示切换按钮及大面积浅色播放器底板。
- `overlay-green` 与 `overlay-layout-fixed` 验证面板切换、窄屏、透明紧凑布局、音量/倍速及已有全屏行为。
- `frontend-unit`：56 项单测通过。`frontend-build`：类型检查和生产构建通过，约 832kB JS chunk 提示保留。
- 新增 `player-overlay.spec.ts` 覆盖 320/390/768/1366 宽度、聊天草稿和选中项跨缩放保留、按钮边界、真实 video 音量、实际倍速帧、设置入口。截图含黑色测试视频及人为设置的纯白极端背景；纯白背景仅用于浮层视觉检查，不冒充视频解码验证。
- `browser-acceptance` 全套 140 通过、2 跳过；其后对音量背景选择器及设置菜单横向定位收尾，`player-final` 13 通过、1 跳过。`settings-position-red` 先证实菜单超出播放器，修复后边界断言通过。跳过仍为原手机标准全屏/全宽抽屉场景，未删除或弱化业务断言。
- 最终 `docker-web-release` 镜像构建成功，包含类型检查与生产构建；仅命令进程和构建参数使用已有 7897 代理，不改全局配置。
- 浏览器使用独立 5198 端口和受控 API，不操作用户房间；手机是 Chromium 仿真，未实测 Safari/iOS/Android。

本次仅前端修改。用户原 Dockerfile 修改和三个文件删除保留，不纳入提交。临时产物均在杂项；本地更新仅需替换 web，后端、worker、数据库及 SnowLuma/live-dashboard 无需重启。
