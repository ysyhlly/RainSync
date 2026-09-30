> 实施状态覆盖：用户已在本次 Goal 明确授权全部实施。历史仅设计或尚未授权记录不再限制实施；执行顺序、产物根和验收门槛以 ../IMPLEMENTATION_PLAN.md 为准。历史图稿留在原设计工作包，不复制为运行证据。

# RainSync 浅色前端重构 Implementation Plan

> **For agentic workers:** 本计划采用 executing-plans 按任务在当前会话执行；只有用户另行授权后才使用子代理。步骤用复选框跟踪。当前仅设计与规划，未获准开始实现。

**Goal:** 全量替换占位前端，交付主色 #E5D1C1、辅色 #9E7867、16:9 横向媒体展示、持续播放与迷你播放器的一套 Vue 应用；加入邀请码注册、不可变登录账号和可修改昵称。

**Architecture:** 保留媒体后端和独立同步算法；重写页面、样式和前端业务组织。账号专项增量扩展 Server、数据库及错误契约，见 ACCOUNT_REGISTRATION_PLAN.md。认证应用外壳持有唯一播放实例和房间连接，路由页面只消费状态及显式操作，观看区与管理区共享组件但权限独立。

**Tech Stack:** 现有 Vue 3、TypeScript、Vite、Pinia、hls.js、Vitest、Playwright；新增 Vue Router，执行前核对兼容版本并锁入 package-lock。视觉动画使用 Vue 内建过渡和 CSS。暂不引入大型 UI/动画框架。

**Spec:** [DESIGN.md](./DESIGN.md)，最新 v3；补充 [账号设计](./ACCOUNT_REGISTRATION_DESIGN.md)、[账号专项计划](./ACCOUNT_REGISTRATION_PLAN.md)、[头像设计与计划](./AVATAR_DESIGN_PLAN.md)。效果图是视觉参考，不是可执行规范。

## Global Constraints

- 只有用户明确索要效果图时才生成或展示；平常只更新设计/Plan，不因新增需求自动调用生图。实施阶段必要的内部验证截图不自动作为效果图发给用户。
- 主色严格为 #E5D1C1，辅色严格为 #9E7867；浅色播放器和浅色迷你播放器。
- 左上角只显示 RainSync 文字，不加图标；没有情绪化标语。
- 媒体库、待播和迷你播放器的图像统一 16:9 横向；卡片文字位于图像外。
- 本轮只实现浅色，集中定义语义 token，暂不做深色开关。
- 头像独立裁剪为512×512静态图；GitHub参考项目不复制源码、不移植或直接接入其裁剪上传组件。Canvas/Pointer Events自主实现，不新增第三方裁剪器依赖。
- 跨观看区、媒体库和管理页持续播放，返回房间不重建播放会话。
- 前端重构本身不改媒体/同步行为；仅账号专项允许增量修改 Server、迁移、身份/聊天显示及错误契约生成物；不改 Worker/Agent，不推送 GitHub、不部署。本轮仍不修改任何项目代码。
- 现有 apps/web/src 的旧视图/样式最终全部替换；核心业务行为迁移后再删除旧承载文件。
- 每个阶段独立本地提交；源代码、文档、最终视觉基线可回滚。
- 临时脚本、截图、测试输出、日志、构建验证产物全部在 C:/Users/ALIENWARE/Desktop/杂项/RainSync-design-2026-09-28 下。不要把 .env、凭据、真实媒体和私有日志加入提交。
- 立项 PLAN初版.md 仅作参考；本次需求 > 当前代码/协议事实 > 历史计划。
- 现有算法与请求超时参数不在本轮顺便改动。UI 控制立即生效，不等动画结束。
- 执行时遵守项目 AGENTS.md：符号检索/读取/上下文/影响/提交前差异优先使用 cgraphy 对应工具替代手工检索，不重复走两条路径。工具不可用时说明后只读回退；不调用 enrich/store_summaries。

## 0. 执行与回滚纪律

当前源码基线 main / 13262053eb5f949a7e9dea6f2a11d2e1cbe7ce6e；实施开始时重新检查工作区，不能把他人的新改动混进提交。

批准实现后建立 codex/frontend-cream 分支，并记录当时完整基线 SHA。若需要隔离，先检查当前聊天工作树并通过 Codex 工作树工具创建，不手动删除或替换已有工作树。

建议的提交边界：
1. docs: record approved frontend design and rollout plan
2. test(web): preserve current playback regression contracts
3. refactor(web): isolate typed API and session state
4. refactor(web): isolate persistent room and playback runtimes
5. feat(web): build beige application shell and library
6. feat(web): implement watch room and persistent mini player
7. feat(web): rebuild source agent and account screens
8. feat(web): add responsive motion and accessible interactions
9. refactor(web): switch to new frontend and remove legacy UI
10. test(web): record final visual and functional validation

账号专项 R1–R3 插入基线后、前端账号页面前；R4–R5 接入主 Task 4/6，R6 在 Task 8 切换前通过。该专项有独立提交边界，不能漏掉后端只交付空表单。实施时以 ACCOUNT_REGISTRATION_PLAN.md 的依赖顺序为准。

头像专项 A1–A4 接入账号 R3/R4，A4 和 R6 在默认入口切换前联合验收；读取、上传、裁剪、保存与持久化必须一起完成。头像路由body限制与图像编码属于已明确规划的后端增量，不更改媒体播放队列。

如果一个阶段修复超出原范围，应有独立修复提交和对应回归。分支内部回退优先 git revert，不对共享分支做 reset --hard。未推送前也保留早期提交以便 cherry-pick 或逐步恢复；不 force-push。

旧页面在切换提交前仍是默认入口。新页面可先在测试入口验证；禁止把一堆不可工作的空壳当作已交付。最终切换与旧文件删除同一提交，在它之前完成新路径的完整验收。

## 1. 文件结构与职责

以下路径均相对 RainSync 根目录，表示后续计划创建/替换，不是本轮已修改：

~~~text
apps/web/src/
  main.ts                       新入口，只装配应用/Pinia/Router
  App.vue                       轻量根组件，认证应用外壳
  app/
    router.ts                   路由、登录和管理员守卫
    AppShell.vue                导航、内容网格、常驻播放宿主
    navigation.ts               观看/管理导航定义
  shared/
    api/client.ts               typed request、CSRF、解析错误
    api/types.ts                当前 REST DTO
    api/errors.ts               新旧错误契约兼容
    ui/BaseButton.vue           按钮状态与可访问名称
    ui/FormField.vue            label/helper/error 关联
    ui/AppDrawer.vue            抽屉、焦点、Esc
    ui/InlineNotice.vue         作用域错误/结果
    ui/EmptyState.vue           空/无结果/权限提示
  features/
    auth/session.store.ts       身份加载与失效
    auth/LoginPage.vue
    auth/RegisterPage.vue       邀请码验证、双名称和密码注册
    auth/registration.api.ts
    account/ProfilePage.vue    只读登录账号、昵称和头像分别保存
    account/profile.api.ts
    account/avatar.api.ts
    account/avatar/crop-model.ts
    account/avatar/image-input.ts
    account/avatar/AvatarCropDialog.vue
    account/avatar/AvatarPreview.vue
    rooms/rooms.api.ts
    rooms/room-runtime.ts       唯一 WS、时钟、版本与重连
    rooms/room.store.ts         房间/连接/控制权可观察状态
    rooms/RoomsPage.vue
    rooms/RoomPage.vue          聊天/队列布局，不拥有 video
    rooms/ChatPanel.vue
    rooms/QueuePanel.vue
    rooms/InviteDrawer.vue
    library/library.api.ts
    library/library.store.ts    游标、查询、独立 id 元信息缓存
    library/LibraryPage.vue
    library/MediaCard.vue       16:9 媒体缩略图
    playback/playback-requests.ts 迁移现有幂等/清理/就绪逻辑
    playback/playback-runtime.ts  唯一视频/HLS/方案/续期/恢复
    playback/playback.store.ts   给 UI 的只读播放状态
    playback/PlaybackHost.vue    唯一持久 video 与大/小展示
    playback/PlaybackControls.vue
    playback/PlaybackOptions.vue
    admin/admin.api.ts
    admin/SourcesPage.vue
    admin/SourceForm.vue
    admin/AgentsPage.vue
    admin/CreateUserPage.vue
    admin/RegistrationInvitesPage.vue
    admin/RegistrationInviteDrawer.vue
    admin/RegistrationInviteResult.vue
  styles/tokens.css
  styles/base.css
  styles/layout.css
  styles/motion.css
~~~

组件私有样式 colocate 在 .vue。主题色只出现在 tokens.css。packages/protocol、packages/sync-engine、packages/player-core 不属于旧占位 UI，不整体删除。

## 2. 模块接口约定

DTO 来自本次实际读取的接口；实施时确认 playlist/chat/room DTO 的完整响应再补全，不允许用 any 贯穿页面。

~~~ts
type SessionUser = { id: string; username: string; display_name: string; avatar_url: string | null; avatar_version: string | null; admin: boolean; csrf: string };
type MediaSummary = { id: string; title: string; kind: string; duration_ms: number | null };
type SourceSummary = { id: string; name: string; kind: string };
type AgentSummary = { id: string; name: string; revoked: boolean; last_seen: string | null };
type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "stopped";
type PlaybackDisplay = "room" | "mini";
type PlaybackPhase = "idle" | "preparing" | "waiting" | "ready" | "blocked" | "failed";

interface ApiClient {
  request<T>(path: string, options?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T>;
}

interface RoomRuntime {
  enter(roomId: string): Promise<void>;
  dispatch(action: import("@protocol").Action): void;
  sendChat(body: string, clientMessageId: string): void;
  dispose(): Promise<void>;
}

interface PlaybackRuntime {
  attach(video: HTMLVideoElement): void;
  setDisplay(display: PlaybackDisplay): void;
  reload(): Promise<void>;
  chooseAudio(index: number): Promise<void>;
  chooseSubtitle(index: number | undefined): void;
  setVolume(value: number): void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
~~~

@protocol 别名在 tsconfig 与 Vite 同时指向仓库 packages/protocol/index.ts，配置属于 Task 2。createApiClient(getIdentity: () => SessionUser | null, onFailure: (identity: SessionUser | null, failure: RequestFailure) => void): ApiClient。RoomRuntime 的 room.store 暴露 RoomState|null、connectionStatus、canControl、控制错误；PlaybackRuntime 的 store 暴露 phase、sessionId、positionSeconds、durationSeconds、tracks、display。状态更新不通过重新构造 runtime 完成。

username 固定表示登录账号，不改名为昵称含义；display_name 用于日常展示，旧响应缺失时回退到 username。新增匿名注册请求不能用“所有401都注销”的逻辑处理；PATCH 资料只允许修改 display_name。

头像字段缺失时回退null和默认占位；上传使用独立Binary helper，共享Cookie/CSRF/错误解析，不能将Blob按JSON编码。头像PUT和昵称PATCH相互独立，细节见头像专项。

display 仅决定布局。主播放/暂停、进度、倍速仍调用 RoomRuntime.dispatch，不把本机 video.pause 当成共享暂停。音量/字幕等本机操作不发送房间指令。

## Task 1: 建立回归基线和产物输出边界

**Files:** 修改 playwright.config.ts、apps/web/vite.config.ts、tests/browser/app.spec.ts 的输出路径；必要时 vitest.config.ts。新增 tests/browser/fixtures/rainsync.ts，用现有样本提取共用 fixtures。正式基线记录进 docs，原始输出到杂项。

**Consumes:** 当前测试、当前 API/WS 协议。
**Produces:** 可复用的受控场景 fixture 和 RAINSYNC_ARTIFACT_DIR 产物根。

- [ ] 检查 Git 状态并记录基线，建立重构分支。
- [ ] 将截图、trace、report、Vite cache 和本地验证 outDir 指向 RAINSYNC_ARTIFACT_DIR；Docker 正式构建保持默认 outDir。
- [ ] 保留现有测试断言的业务含义，提取 fixture 时不放宽断言、不通过删测试消除失败。
- [ ] 运行单测、类型检查和浏览器基线；失败先注明“重构前已存在”并定位，不能标绿。

~~~powershell
$env:RAINSYNC_ARTIFACT_DIR = 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-design-2026-09-28/validation'
npm test
npm run build -w apps/web -- --outDir "$env:RAINSYNC_ARTIFACT_DIR/build"
npm run test:e2e
~~~

- [ ] 提交测试/输出配置及可重复的结果摘要，不提交运行日志、账号或签名媒体 URL。

## Task 2: 隔离认证、错误与有类型的 API

**Files:** 创建 shared/api/client.ts、types.ts、errors.ts、features/auth/session.store.ts；迁移 apps/web/src/api.ts 和 errors.ts；修改 apps/web/tsconfig.json、apps/web/vite.config.ts 的 @protocol 别名；调整 tests/errors.test.ts，新增 tests/session.test.ts。

**Consumes:** SessionUser、ApiClient；Cookie/CSRF 契约。
**Produces:** createApiClient、useSessionStore，后续页面统一使用。

- [ ] 为两个真实竞态写单测：旧身份请求的 401 不清除新身份；HTTP 200 但 JSON 截断抛出不确定结果错误。
- [ ] 将现有 RequestFailure 兼容行为搬到新模块，保留 request_id、retryable、retry_after_ms。
- [ ] 身份状态明确分 loading/authenticated/anonymous；登录页不出现加载闪烁。
- [ ] 普通请求有明确返回类型；unknown 的响应在边界校验关键字段。注销清理与网络失败分别处理。
- [ ] 旧 UI 暂时通过新模块适配继续工作；调整 imports 后执行 errors/session 单测和 vue-tsc。
- [ ] 独立提交。

示例核心断言：
~~~ts
// fixture 让身份 A 的请求挂起，切到身份 B，再返回 A 的 SESSION_EXPIRED。
expect(session.user?.id).toBe("user-b");
// 成功状态但残缺 JSON，不能被当成 null 成功方案。
await expect(truncatedRequest).rejects.toBeInstanceOf(TypeError);
~~~

## Task 3: 独立房间与播放运行时

**Files:** features/rooms/room-runtime.ts、room.store.ts；features/playback/playback-runtime.ts、playback.store.ts、playback-requests.ts。迁移 App.vue 现有 WS/播放器业务；tests/playback-request.test.ts 改 import，新增 tests/runtime.test.ts。

**Consumes:** ApiClient、RoomState、Action、PlaybackPlan、Clock、Corrector。
**Produces:** RoomRuntime、PlaybackRuntime；实例由登录后的 AppShell 创建一次。

- [ ] 列出 App.vue 内每个连接序号、加载序号、AbortController、timer 与媒体事件监听的归属。
- [ ] 先加入运行时测试：重复 enter 同房间不多开 WS；A 房间迟到回复不能改 B；dispose 后没有重连与续期。
- [ ] 迁移 control_epoch、revision、media_generation 和时钟纪元逻辑，不简化为仅比较 roomId。
- [ ] 迁移 HLS 入口恢复、生成区间轮询、seek 重建、音轨竞态、字幕身份。
- [ ] 保留 sessionStorage 取消编号直到服务器确认；取消失败不能继续消耗新播放配额。
- [ ] 单例 attach 后 display 切换不执行 prepare/stop/attach；让 repeated attach 同元素幂等，不同元素需要显式停止和重新绑定。
- [ ] 完整执行同步、能力、错误、播放请求单测，相关 browser 恢复场景；提交。

示例核心断言：
~~~ts
runtime.attach(video);
runtime.setDisplay("mini");
runtime.setDisplay("room");
expect(prepareSpy).toHaveBeenCalledTimes(1);
expect(revokeSpy).not.toHaveBeenCalled();
~~~

此断言应放在已完成初次准备的 fixture 中，并同时检查 timer 与视频对象身份，不能只检查调用次数。

## Task 4: 主题、应用外壳、登录和媒体库

**Files:** app/router.ts、AppShell.vue、navigation.ts；styles/*.css；shared/ui/*；features/auth/LoginPage.vue；features/library/*；apps/web/package.json、package-lock.json；测试 tests/browser/navigation.spec.ts、library.spec.ts。

**Consumes:** ApiClient、session store、运行时只读状态。
**Produces:** 新应用页面和主题；尚未删除旧入口。

- [ ] 安装并锁定与当前 Vue 匹配的 Vue Router，核对官方文档；不盲目用历史示例版本。
- [ ] 按 DESIGN token 定义浅色，color-scheme: light；不把系统深色偏好映射到未实现主题。
- [ ] 所有缩略图使用统一 MediaThumbnail 容器样式 aspect-ratio:16/9；封面不存在时显示明确通用封面或标题布局。
- [ ] 实现 /login、/rooms、/library 的路由和身份守卫；管理员路由使用 meta.requiresAdmin。守卫实现参考 [Vue Router](https://router.vuejs.org/guide/advanced/meta.html)。
- [ ] 按账号专项 R4 接入 /register、/account/profile；登录页增加注册入口，账号和昵称分别展示；注册成功自动恢复身份，资料页不打断播放。
- [ ] 实现 250ms 搜索防抖、AbortSignal/序号隔离、游标分页；id 元信息缓存独立于当前列表。
- [ ] 删除品牌图标与情绪标语，页面名称及空态使用功能性中文。
- [ ] 验证普通用户不能进入 /admin，登录后返回安全的站内路径，搜索/分页不丢当前片名。
- [ ] 对浅色视觉用实际截图检查；布局/样式微调不写镜像实现的单元测试。提交。

## Task 5: 观影页、聊天、队列与迷你播放器

**Files:** PlaybackHost.vue、PlaybackControls.vue、PlaybackOptions.vue；RoomsPage.vue、RoomPage.vue、ChatPanel.vue、QueuePanel.vue、InviteDrawer.vue；tests/browser/player-lifecycle.spec.ts、rooms.spec.ts。

**Consumes:** RoomRuntime、PlaybackRuntime、library 元信息缓存。
**Produces:** 完整观看流程；唯一持久 video 位于 AppShell 的稳定 DOM 子树。

- [ ] PlaybackHost 不放在 RouterView 或带 route key 的 Transition 中；CSS 布局切换 room/mini，不把 video 在父节点间重新挂载。
- [ ] 实现共享控制与本机控制分离；观看者进度只读、音量和字幕可用。
- [ ] 实现房间选择/创建/邀请/加入、聊天确认与去重、队列增删与播放；按 room 操作序号隔离所有晚到结果。
- [ ] 实现桌面底部迷你栏与“返回房间”；内容区留出高度，抽屉按钮不会被覆盖。
- [ ] 写跨路由浏览器回归，观察真正的 DOM 身份、WS 数量、POST 会话次数和播放进度，而不只观察迷你栏是否显示。
- [ ] 检查生成中的 HLS、原生 HLS 恢复、无声/自动播放受阻、切轨中路由变化等状态。
- [ ] 提交。

关键浏览器断言示例：
~~~ts
await page.goto("/rooms/room-a");
// fixture 先完成进入与准备；记录 video 引用和请求计数
await page.evaluate(() => {
  (window as any).__originalVideo = document.querySelector("video");
});
const before = fixture.playbackRequests.length;
await page.getByRole("link", { name: "媒体库", exact: true }).click();
await expect(page.getByRole("button", { name: "返回房间" })).toBeVisible();
await page.getByRole("button", { name: "返回房间" }).click();
expect(await page.evaluate(() =>
  (window as any).__originalVideo === document.querySelector("video")
)).toBe(true);
expect(fixture.playbackRequests.length).toBe(before);
expect(fixture.activeSockets()).toBe(1);
~~~

fixture.playbackRequests 与 activeSockets 是 Task 1 共用 fixture 必须实现的观测接口；计数仅记录实际 mock 请求/连接，不通过应用埋点虚构。

## Task 6: 管理区完整替换

**Files:** admin.api.ts、SourcesPage.vue、SourceForm.vue、AgentsPage.vue、CreateUserPage.vue；按专项 R5 增加 RegistrationInvitesPage/Drawer/Result；tests/browser/admin.spec.ts、registration-admin.spec.ts。

**Consumes:** typed ApiClient、现有 source/agent API 与专项 R1–R3 实现的注册/资料/账号 API。
**Produces:** 独立管理页面和就地操作状态；后端新增能力由账号专项承担。

- [ ] 源列表只显示已提供字段；添加表单按类型显示；JSON 请求头解析错误定位到字段。
- [ ] 扫描忙碌只影响该行；并发扫描不覆盖其他行的结果；成功 count 明确属于本次扫描。
- [ ] NAS 配对、复制、过期展示、撤销确认；revoked/last_seen 不冒充实时在线状态。
- [ ] 手动创建含登录账号、可选昵称、密码，采用至少8个ASCII可打印字符及不可变登录账号规则；成功清空密码，不显示缺失的禁用/密码重置能力。
- [ ] 接入邀请码批量生成、首次复制、真实状态/游标、撤销和响应丢失恢复；按 R5 单独验收。
- [ ] 所有表单有 label、helper、错误关联；打开/关闭抽屉处理焦点。
- [ ] 浏览器覆盖普通用户直达拒绝、添加失败保留非敏感输入、不同扫描结果隔离、撤销失败可重试。
- [ ] 在管理页保持迷你播放器同一实例。提交。

## Task 7: 响应式、动效与可访问性

**Files:** styles/layout.css、motion.css，各页面必要的 scoped styles；tests/browser/responsive.spec.ts、accessibility.spec.ts。

**Consumes:** 完整页面和 DESIGN 动效表。
**Produces:** 360/390/768/1024/1440/1920 宽度可用界面，动效有减少动态效果分支。

- [ ] 移动底部导航上方放迷你播放器；聊天键盘打开时输入与发送不被遮挡。
- [ ] 媒体库横图移动 2 列；聊天与待播在手机上切换，图像仍16:9。
- [ ] 实现 120–160ms 按钮反馈、220ms 页面、280ms 抽屉、240ms 外围播放器展示过渡。
- [ ] 不延迟发送 PLAY/PAUSE/SEEK；不动画 video 生命周期；不为每帧动画写入 Pinia。
- [ ] 检查键盘导航、焦点还原、禁用理由、输入标签、颜色对比与 reduced-motion。
- [ ] 用真实浏览器截图和交互验收，不把生图当视觉测试基线；提交。

比例与减少动画的关键检查：
~~~ts
for (const box of await page.locator("[data-media-thumbnail]").all()) {
  const rect = await box.boundingBox();
  expect(Math.abs(rect!.width / rect!.height - 16 / 9)).toBeLessThan(0.02);
}
await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
// 本轮强制浅色，即便系统偏好 dark，画布仍是 #E5D1C1。
await expect(page.locator("body")).toHaveCSS("background-color", "rgb(229, 209, 193)");
~~~

## Task 8: 原子切换与删除旧占位前端

**Files:** 替换 apps/web/src/main.ts、App.vue；删除旧 style.css、api.ts、errors.ts、playback-request.ts（确认已迁移且无旧 imports）；更新 app.spec.ts、recovery.spec.ts 的页面入口和角色定位。

**Consumes:** 前述完整新应用，所有业务回归。
**Produces:** 默认入口只有新前端；仓库没有第二套遗留界面。

- [ ] 先通过新入口的全流程测试，再切换默认 main/App。
- [ ] 删除全部旧 UI 模板、全局样式、过渡适配导出和测试入口；不删除 packages/protocol/sync-engine/player-core。
- [ ] 现有测试按新路由和可访问名称定位，但不弱化播放幂等、取消、恢复等断言。
- [ ] 检查无旧颜色、品牌图标、营销标语、竖海报规则和死 imports。
- [ ] 完整 npm test、生产 build、Playwright；CI 生成协议一致性保持原有检查。
- [ ] 用单个“切换并删除旧 UI”提交形成明确回滚点。若失败修复，不把残缺新旧混合状态提交为完成。

## Task 9: 最终验收与交接

**Files:** docs 内正式 FRONTEND_VALIDATION.md、ACCOUNT_REGISTRATION_VALIDATION.md 与使用说明；最终视觉基线图片。数据库增量变更与兼容回滚在账号专项单独记录，不在验收阶段顺手改部署。

- [ ] 核实下方验收矩阵每项有证据，区分受控 API 测试、真实视频、真实后端与真实设备。
- [ ] 真实 MP4 样本确认播放中进度持续增加，跨路由只出现同一 video 和同一播放方案。
- [ ] 有独立测试环境才执行真实 Server/Worker/Agent 观看冒烟；不运行会写入未知部署数据的脚本。
- [ ] 记录未验证的 Safari/iOS/Android 实机、实际长时观看、弱网，不能由 Chromium 移动模拟替代。
- [ ] 更新本地提交清单、基线 SHA 和 revert 顺序；不 push，交由用户提交 GitHub。

## 最终验收矩阵

| 领域 | 必须通过 |
|---|---|
| 视觉 | 指定主辅色、品牌纯文字、无情绪标语、所有媒体图像16:9 |
| 主题 | 全站浅色含播放器；系统 dark 不触发未实现配色；颜色集中 |
| 连续播放 | 观影→媒体库→管理→原房间，无新video/WS/会话，进度连续 |
| 权限 | 管理导航和深链守卫；观看者不发送房间控制，仍可聊天/本机偏好 |
| 搜索 | 防抖、游标复位、旧响应隔离、当前片名不随列表丢失 |
| 房间竞态 | 快速A→B、迟到聊天/队列/播放结果不能污染新房间 |
| 播放契约 | 同key重试、取消持久化、就绪等待、旧DELETE不取消新方案 |
| HLS | 原生/MSE、失效入口恢复、增长产物等待、范围外seek重建 |
| 音字幕 | 快速切音轨保留最新，字幕按index，切片复位，本机选择不发共享命令 |
| 登录 | 失效清理并停重连；旧请求失败不能注销新用户 |
| 注册与资料 | 一次性邀请码/自动登录；登录账号唯一不可改；昵称可重名可修改；密码8位且禁止中文；旧账号兼容 |
| 头像 | 静态图片可调整取景；真实512×512；上传失败保留旧图；头像与昵称独立；参考项目无代码/组件复用 |
| 动效 | 播放操作不等动画；reduced-motion；没有永久循环干扰 |
| 移动 | 360px起无横溢出，底栏/迷你/键盘互不遮挡 |
| 管理 | 真接口范围、字段错误、扫描隔离、配对撤销、手动创建、邀请码生成/复制/撤销 |
| 回滚 | 有明确基线、分阶段提交、删除旧UI可单独revert、无GitHub推送 |

## 本轮未执行

没有安装 Router，没有创建前端实现文件，没有删除旧 UI，没有运行构建或浏览器测试。本计划中的命令、文件清单、代码片段是未来实施说明，不能当作已完成工作。
