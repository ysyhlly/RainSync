# 导航滑动回弹与双流光边框实施计划

按用户要求在当前会话内执行，不委派子代理。使用 writing-plans / executing-plans 流程；交付为源码、本地验证和本地提交，不部署。

**目标：** 桌面侧栏和手机底部导航的选中背景连续移动并轻微回弹；桌面选中项具有两段相对的流光，沿同一圈圆角边框持续慢速追逐。

**架构：** 一个 Vue 导航组件承载两种布局，共用基于实际元素位置的弹簧运动。选中背景独立于链接，不接收点击；桌面背景内的 SVG 圆角描边以 dash offset 移动两段流光，边框本体不旋转。动画不等待路由或播放命令。

**技术：** 现有 Vue 3 / TypeScript / Vue Router、requestAnimationFrame、ResizeObserver、CSS 和 SVG；不添加依赖。

**需求依据：** 用户确认手机也滑动回弹；仅桌面流光；同一圈两段相对光带；选中期间持续缓慢循环；桌面始终完整展开，不提供收起；手机保留底部导航。

## 全局约束

- 不停止、重启、重新部署或改动任何已打开的服务。只启动并清理本任务独立测试服务。
- 浅奶油 `#FFF4D5`、浅棕按钮 `#D2B49C`、深棕文字 `#30241F` 保留；选中背景使用现有浅棕语义色。
- reduced-motion 下不滑动、不回弹、不循环流光；静态选中背景和边框仍清晰。
- 不改变唯一 video、WebSocket、播放会话的生命周期；不改认证与后端。
- 保留用户原有 Dockerfile 修改和三个文件删除，不纳入提交。
- 产物位于 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-sidebar-motion-2026-09-28`；测试端口 `5198`，strictPort，禁止复用现有服务；代理指向不可用的本地端口，接口由测试拦截。
- 本地提交使用 `Rainfrost <luo005962@gmail.com>`，分支 `front/rainsync-implementation`；不推送、不部署。

## 任务 1：两端共用的选中背景

文件：新增 `apps/web/src/app/AnimatedNavigation.vue`、`apps/web/src/app/use-navigation-indicator.ts`；修改 `AppShell.vue`、`styles/layout.css`；更新 `tests/browser/sidebar.spec.ts`。

接口：导航组件接受 `variant: "sidebar" | "bottom"` 与 `admin: boolean`；组合函数接受导航元素 Ref 与当前路由对应的导航键 Ref，返回选中矩形和后台暂停状态。

- [x] 更新之前的未提交测试，两端验证实际位置变化、轻微越过目标后归位、连续切换、前进后退、详情路由和管理子页归属。
- [x] 执行测试确认当前版本因缺少滑动背景而失败，保留 red 日志。
- [x] 实现位置测量与有限时长弹簧：每帧更新矩形，达到位置和速度阈值即停止；连续点击从当前位置及速度转向新目标。
- [x] 实现首次显示、布局和尺寸变化、从资料页返回时的直接定位；隐藏导航不运行弹簧。
- [x] 接入两端导航，保留 RouterLink、图标、标签、aria-current、权限和焦点行为。

```ts
// 验证真实 DOM 轨迹，而非仅检查存在动画名称。
expect(samples.some(value => value > target + 0.2)).toBe(true);
expect(Math.abs(finalPosition - target)).toBeLessThan(1);
```

## 任务 2：桌面双流光与动效偏好

文件：`AnimatedNavigation.vue`、`use-navigation-indicator.ts`、`styles/motion.css`、`styles/tokens.css`、`tests/browser/sidebar.spec.ts`。

- [x] SVG 圆角矩形 `pathLength="100"`；描边 `stroke-dasharray="16 34"` 形成相隔半周的两段光带；叠加短而更亮的头部形成尾迹。
- [x] 每 5 秒沿轮廓循环一周；使用暖棕色导航边框语义色，手机不绘制流光。
- [x] 流光不参与布局、不覆盖文字或焦点、不捕获指针；背景移动时边框跟随。
- [x] reduced-motion 下取消弹簧并关闭循环，保留静态轮廓；页面隐藏时暂停，卸载时清理帧和监听。

```css
@keyframes navigation-glow {
  from { stroke-dashoffset: var(--beam-offset, 0); }
  to { stroke-dashoffset: calc(var(--beam-offset, 0) - 100); }
}
```

## 任务 3：验证与交付

- [x] 运行新增导航回归，覆盖两端回弹、双段边框、reduced-motion、布局切换和键盘操作。
- [x] 运行现有完整浏览器套件，验证播放连续性、布局和权限；执行单元测试、类型检查和生产构建。
- [x] 审查变更与产物位置，确认测试服务结束且用户服务保持原状。
- [x] 更新 `docs/FRONTEND_ARCHITECTURE.md` 和本计划状态，记录真实结果及限制。
- [x] 精确暂存本次文件，以 Rainfrost 本地提交，最终给出提交号和文档链接。

验证命令（项目根目录 PowerShell）：

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-sidebar-motion-2026-09-28'
$env:PLAYWRIGHT_BROWSERS_PATH='C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28/browsers'
node scripts/run-check.mjs navigation-browser 180 node node_modules/@playwright/test/cli.js test --config 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-sidebar-motion-2026-09-28/playwright.config.mjs'
node scripts/run-check.mjs navigation-unit 120 node node_modules/vitest/vitest.mjs run
node scripts/run-check.mjs navigation-build 120 cmd.exe /d /c npm.cmd run build
```

## 执行结果与证据

起点 `3a9df09`，分支 `front/rainsync-implementation`。上述功能完成，未添加依赖、修改后端或部署。所有产物均留在上述杂项目录。

| 检查 | 结果 | 日志名 |
| --- | --- | --- |
| 新功能的失败基线 | 桌面/手机均因缺少移动背景而失败，符合预期 | navigation-red |
| 首轮新增用例 | 6 通过、2 失败；失败来自测试写死 216px，而既有窄桌面布局为 184px。已改为检查移开鼠标前后尺寸一致且导航仍完整可见 | navigation-green-first |
| 完整浏览器回归 | 104/104 通过，原有 96 + 新增 8，含真实 DOM 回弹轨迹、两端导航、键盘、尺寸切换、动态 reduced-motion、循环描边及原播放连续性 | navigation-browser |
| CSP 补充回归 | 24/24 通过。发现旧 app.spec.ts 写死 5173，修正为读取 baseURL 后补跑相关文件，独立端口也施加现有 CSP | navigation-csp |
| 前端单元测试 | 47/47 通过 | navigation-unit |
| 类型检查与生产构建 | 通过；既有大 chunk 提示保留，JS 808.85kB / gzip 264.38kB | navigation-build |

每个检查均有 `logs/名称.json` 与 `.log`，记录实际命令、UTC 起止时间、退出码及超时状态。新增浏览器回归模拟接口并在真实 Chromium 中运行，不等同真实账号/数据库或手机实机验证；本次没有重跑后端集成或 Safari/iOS 实机。

功能测试结束后独立 5198 监听已退出；用户原有 5099（PID 752）和 8088（PID 28292/25668）监听进程与开始时一致。本次没有 Docker 构建、容器重启或现有服务配置变更。保留用户已有 deploy/Dockerfile 修改及 oil-pumpjack.html、pelican-bike.svg、pumpjack.html 删除。

回滚本次源码使用本次提交的 `git revert`；不涉及数据库迁移。提交号在交付回复记录，避免文档自引用。
