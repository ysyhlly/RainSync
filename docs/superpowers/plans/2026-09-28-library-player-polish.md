# RainSync 媒体库、播放器与公共控件实施计划

> **交接给执行会话：**逐项执行本文，使用 `executing-plans` 的检查点方式；默认在执行会话内完成，不自行新建会话或委派子代理。勾选框表示未来实施工作，本文没有声称任何功能已完成。

**Goal：**实现抽屉点击外部关闭、统一选择控件及配色、媒体封面与双层改名，以及不打断持续播放的沉浸式播放器。

**Architecture：**沿用 Vue 3 / TypeScript / Pinia、Rust Server / Media Worker / NAS Agent、PostgreSQL 和现有媒体处理链。显示名称按查看者解析；缩略图使用独立于房间播放的后台任务；下拉菜单、抽屉和播放器显隐各自集中管理。始终保留现有唯一 video、HLS 实例、房间连接和播放会话。

**Tech Stack：**Vue 3.5、Vue Router、Pinia、TypeScript、Vite、Playwright、Vitest、Rust / Axum / SQLx、PostgreSQL、FFmpeg / libwebp。沿用锁文件，不为本次工作升级框架或接入大型 UI 框架。

**Spec：**本文第 2 节为本次需求规范，第 3—6 节为接口与实现设计，第 7—10 节为执行与验收。交接不依赖原聊天记录。

**编写日期：**2026-09-28—2026-09-29，Asia/Shanghai；文件名保留需求确认日期。

## 1. 执行边界与已核实基线

### 1.1 本文与授权

- 本会话只编写计划，没有修改业务代码、数据库或运行中的服务。
- 用户会把本文交给另一会话执行；执行会话收到用户的实施指令后开始，不重复询问本文已经确认的产品选择。
- 本文中 API 名称、新文件名、默认资源限额和实现方式是供执行的技术方案，不能表述为用户逐项指定或当前已有能力。可以因实际代码证据作等价技术调整，记录原因；改变已确认的产品行为或权限范围时先询问用户。
- 历史 Goal 的账号、头像、审计修复及导航工作已经完成，不重新执行。历史文档中的旧颜色、旧分支、旧提交身份不能覆盖本次最新要求。
- **不得重启、停止、更新、替换用户已打开的任何服务。**当前已知 RainSync 为 `http://127.0.0.1:8088/`，SnowLuma 参考服务为 `http://127.0.0.1:5099/`。本次计划不包含部署授权，也不复用其真实账号执行写入验证。
- 可以启动自己拥有的隔离测试服务；使用独立端口、数据库、目录、容器名和测试媒体，只清理自己创建的资源。Docker 不可用时报告真实阻塞，不能自行启动或重启 Docker Desktop。
- 不推送 GitHub、不创建 PR、不发送外部消息、不生成效果图。用户提供的截图只用于理解需求，不提交到项目。

### 1.2 仓库与未提交内容

项目：`C:/Users/ALIENWARE/Desktop/RainSync`

计划编写时分支：`front/rainsync-implementation`

计划编写时 HEAD：`75c45d82f784ad6f2bf60241c67f65544627faef`

该提交标题：`fix: move gradient borders at constant path speed`

后续本地提交的 Author 和 Committer 均为：`Rainfrost <luo005962@gmail.com>`。不修改全局 Git 配置，不沿用其他邮箱。

计划编写前已有以下用户改动，执行时重新检查并保护，不能暂存、恢复、删除或混入本任务提交：

```text
 M deploy/Dockerfile
 D oil-pumpjack.html
 D pelican-bike.svg
 D pumpjack.html
```

本计划文件是本轮唯一预期新增的正式文件。另一会话开始时 HEAD 或状态可能已经变化，以重新检查的结果为准；禁止硬重置到上述 SHA。

所有日志、截图、测试视频、浏览器 trace、缓存、Cargo target、构建输出放在：

```text
C:/Users/ALIENWARE/Desktop/杂项/RainSync-library-player-polish-<执行日期时间>/
```

正式源码、测试、迁移、计划和报告放在项目中。提交前逐项暂存，禁止 `git add .` 把既有改动带入。

### 1.3 检索与参考

先读项目 `AGENTS.md`。本轮没有可调用的 cgraphy 工具，因此采用常规源码检查；执行会话若可调用，按 AGENTS.md 用 search/read/context/impact/diff_context 替代对应手工操作，不重复查同一内容，不调用 enrich/store_summaries。

相关已有说明：

- `docs/FRONTEND_ARCHITECTURE.md`：持久播放器、认证、导航与前端职责。
- `docs/AUDIT_FIXES.md`：登录 Cookie 竞态、注销、房间重入、聊天幂等修复。
- `docs/AVATAR_PIPE_FIX.md`：部署镜像 FFmpeg 5.1 的 WebP 输出封装经验。
- `docs/superpowers/plans/2026-09-28-navigation-motion.md`：已经完成的导航效果。

截图：

- `C:/Users/ALIENWARE/Desktop/捕获123.PNG`：空播放器“尚未选择影片”区域偏黄。
- `C:/Users/ALIENWARE/Desktop/捕获56.PNG`：播放方式下拉列表展开后，出现灰色选中条、方形菜单和风格不一致的边框。这是本次选择控件整改的明确重点，不能只改收起时的输入框。

## 2. 已确认产品规范

| 编号 | 需求与验收行为 |
| --- | --- |
| R1 | 所有右侧抽屉可通过点击抽屉外部空白/遮罩关闭；保留叉号、Escape 及现有关闭保护。抽屉内部空白不是关闭区域。 |
| R2 | 修复空播放器偏黄，检查页面、卡片、抽屉、表单、菜单及交互状态的非预期色差。主背景保持 `#FFF4D5`，按钮浅暖棕、文字深棕，仅浅色主题。 |
| R3 | 下拉框、单选/复选框、分段切换按钮三类全部统一；特别是下拉框展开菜单也必须统一，不能继续出现截图中的系统灰色选中条。 |
| R4 | 媒体优先展示已有封面；没有封面时跳过开头黑帧，使用最早的有效画面。媒体封面保持 16:9，不拉伸。 |
| R5 | 管理员可修改全站显示名称；用户（包括管理员）可修改仅自己可见的名称。优先级为个人名称 → 管理员名称 → 片源原名。不重命名源文件，重新扫描后保留。 |
| R6 | 普通观看时，片名、房间名、连接/控制状态位于右侧聊天区域上方，文字左对齐。用户已经明确选定此位置。 |
| R7 | 普通桌面观看时，鼠标移入视频才显示进度、音量、倍速等控件，移出显示纯净视频；播放器操作不会打断同步播放。 |
| R8 | 全屏为播放器独占浏览器全屏：不显示页面导航、聊天或队列。鼠标移动时显示播放信息和控件，连续五秒无操作后隐藏信息、控件及鼠标。 |
| R9 | 手机采用触控可用的显隐方式；播放器与所有选择控件、抽屉支持键盘/焦点与减少动态效果。 |
| R10 | 跨路由和进入/退出全屏仍使用同一个 video、HLS 实例、房间 WebSocket、播放 session；不能为改布局重新创建播放运行时。 |

### 2.1 执行采用的交互细则

以下是从需求落实到可测试行为的技术细化，可在用户审阅计划时调整：

- 普通桌面：移入即显示；移出后 150ms 内淡出。鼠标停留画面内时不套用全屏的五秒隐藏。
- 全屏：进入即显示并启动五秒计时；每次指针移动、有效键盘操作、点击/触摸操作重新计时。拖动滑条、菜单展开或键盘焦点位于控件时暂停自动隐藏，结束交互后重新计时。
- 手机：点视频空白唤出/收起控件；显示后闲置五秒收起。控件点击不冒泡成画面点击，不新增“点击画面同步暂停”这一未要求的行为。
- 迷你播放器保留精简的常用控制和返回房间入口，不因房间内控件改为浮层而失去操作能力；无额外常驻的大块播放设置。
- 自动播放被阻止、加载失败等必要提示不被闲置规则永久隐藏；成功恢复后回归正常显隐。字幕属于视频内容，不随播放信息隐藏。
- “独占全屏”指 Fullscreen API 的播放器容器全屏，不承诺网页能控制操作系统独占渲染模式。无法使用标准 API 的设备给出诚实回退，不把 CSS 铺满页面伪称为独占全屏；iOS 原生视频全屏的自定义控件限制单独记录。
- 已生成但未复制的邀请码继续沿用现有确认提示；普通表单点击遮罩遵循与叉号相同的关闭/保留规则，不擅自另加自动提交。
- 管理员改全站名称不会覆盖别人的个人名称。自己保存后立即更新当前界面；其他已打开页面在重新进入、窗口重新获得焦点或其正常资料刷新时获取新名称，不增加含个人别名的房间广播。

### 2.2 必须保持的现有行为

- 桌面侧边栏始终完整展开，手机保留底部导航。
- 桌面和手机选中背景继续滑动回弹。
- 桌面两段相对的渐变流光沿圆角边框**恒定路径速度**运行，每圈五秒，不修改速度曲线、周期或改回固定渐变旋转假象。
- 认证竞态防护、退出登录不受远程播放清理阻断、同房间失败重试、聊天持久幂等均保留。
- 房间控制权限维持现状；音量/静音是本地操作，播放/暂停/拖动/房间倍速沿用现有命令及控制权限。

## 3. 现状与文件边界

### 3.1 已核实问题

1. `AppDialog.vue` 已有 `busy`、`canClose`、原生 dialog、Escape、焦点管理，但没有外部点击关闭。
2. `styles/layout.css` 的 `.video-frame` 和其 video 使用 `--surface-muted: #f0e0b5`，是截图大块偏黄的来源。没有证明所有 muted 色都错误，不能全局无差别替换。
3. 当前倍速/播放方式/音轨/字幕/片源类型/邀请码筛选使用原生 `<select>`；只给 select 外框加 CSS 不能可靠统一操作系统绘制的展开菜单。
4. `MediaThumbnail.vue` 只有图标占位，不接收图片地址；媒体接口没有封面字段。
5. `media.rs::save_scan_batch` 和 `agents.rs` 的 NAS 索引写入均会更新 `media_items.title`，直接把改名写入该列会被下次扫描覆盖。
6. `rooms.rs::playlist` 直接读全局 title；`room-runtime.ts` 的 currentTitle 依赖此前记住的媒体库数据。个人名称需要按查看者解析，直接广播新 title 不可行。
7. `PlaybackHost.vue` 由 `AppShell.vue` 持久挂载在 RouterView 外。现在标题/控制栏/播放选项都占据视频之外的空间；全屏还有 20px 留白和常驻控制栏。
8. Worker 的媒体交付授权依赖 playback_sessions 和 room_snapshots；缩略图不能通过伪造房间或为每张卡片申请 playback session 来读取媒体。

### 3.2 文件责任表

路径均相对项目根目录。“新增”表示未来实现，不是当前已存在。

| 文件/目录 | 操作与职责 |
| --- | --- |
| `migrations/0023_media_display_titles.sql` | 新增全站显示名、个人显示名及并发版本；执行前确认编号未被占用。 |
| `migrations/0024_media_previews.sql` | 新增预览任务、结果缓存及源版本字段；编号以实际最新迁移顺延。 |
| `apps/server/src/media_titles.rs` | 新增名称校验、按查看者查询和改名处理。 |
| `apps/server/src/media_previews.rs` | 新增缩略图请求、状态与认证图片读取接口。 |
| `apps/server/src/media.rs`、`agents.rs` | 列表查询适配；扫描仅更新原名并正确使预览失效。 |
| `apps/server/src/rooms.rs` | 队列按当前用户显示标题；不将个人别名写入房间共享状态。 |
| `apps/server/src/main.rs` | 模块、路由、限额配置。 |
| `crates/providers/src/lib.rs`、新增 `preview.rs` | 采集 Jellyfin/Emby 封面版本信息并解析读取目标。 |
| `crates/persistence/src/media_previews.rs`、`lib.rs` | 新增领取、租约、去重、发布、重试和缓存回收。 |
| `apps/media-worker/src/previews.rs` | 新增预览任务执行器，独立并发预算。 |
| `apps/media-worker/src/preview_input.rs` | 新增仅供预览任务使用的有界、鉴权输入入口。 |
| `apps/media-worker/src/main.rs`、`relay.rs` | 注册执行器/输入路由，复用已有源读取和 NAS relay；保留播放授权边界。 |
| `crates/media-core/src/preview.rs`、`lib.rs` | 新增黑帧判定/图像生成调用与输出验证，复用 child_process 进程所有权。 |
| `crates/protocol/src/errors.rs`、`apps/web/src/errors.ts` | 新增稳定错误码和用户文案，按现有机制生成关联协议产物。 |
| `apps/web/src/shared/api/types.ts` | 媒体名称、预览 DTO。 |
| `apps/web/src/features/library/media.api.ts` | 新增媒体详情、双层改名和批量预览 API。 |
| `apps/web/src/features/library/media-catalog.store.ts` | 新增按身份隔离的媒体详情缓存，集中处理名称/预览更新。 |
| `apps/web/src/features/library/library.store.ts` | 保留搜索分页职责，向 catalog 写入列表响应。 |
| `apps/web/src/features/library/MediaRenameDialog.vue` | 新增个人/全站名称编辑与冲突恢复。 |
| `apps/web/src/features/library/MediaThumbnail.vue`、`LibraryPage.vue` | 图片展示、按需请求、重命名入口。 |
| `apps/web/src/shared/ui/AppDialog.vue` | 外部点击关闭及嵌套菜单的 Escape 协调。 |
| `apps/web/src/shared/ui/AppSelect.vue`、`select.ts`、`use-select-popup.ts` | 新增统一选择器、类型和菜单定位/键盘逻辑。 |
| `apps/web/src/shared/ui/AppSegmented.vue` | 新增分段切换组件；单选/复选沿用原生语义并集中样式。 |
| `apps/web/src/features/admin/SourcesPage.vue`、`RegistrationInvitesPage.vue` | 替换所有原生下拉交互，保持数值/字符串语义。 |
| `apps/web/src/features/playback/PlaybackInformation.vue` | 新增无副作用的信息展示，可用于聊天顶部与全屏浮层。 |
| `apps/web/src/features/playback/PlaybackSettings.vue` | 新增统一设置菜单，容纳播放方式/音轨/字幕和重新加载。 |
| `apps/web/src/features/playback/use-player-chrome.ts` | 新增播放器控件显隐、全屏状态、计时与锁定管理。 |
| `apps/web/src/features/playback/PlaybackHost.vue`、`PlaybackControls.vue` | 视频内浮层与控件事件接入，不移动/重建 video。 |
| `apps/web/src/features/rooms/RoomPage.vue`、`room-runtime.ts` | 聊天上方信息、队列元信息、当前媒体资料刷新。 |
| `apps/web/src/styles/tokens.css`、`base.css`、`layout.css`、`admin.css` | 配色和布局；新增 `selection.css` 管理所有选择控件状态，入口按现有样式引入位置添加。 |
| `tests/browser/fixtures/application.ts` 及各套件的独立 API fixture | 为新增媒体详情/预览路由返回真实形状的测试数据；记录请求计数和身份，不能让默认 `{ok:true}` 冒充新接口。 |
| `tests/browser/app.spec.ts`、`admin.spec.ts` 及相关布局/播放用例 | 将 selectOption 改为实际自绘菜单操作；保留音轨、字幕、倍速、权限等既有业务断言。 |

不要因这个表顺手拆分整个 Server/Worker、替换同步引擎或重构账号系统；只提取预览读取真正需要复用的边界。

## 4. 媒体名称契约

### 4.1 持久化与解析

保留 `media_items.title` 作为扫描得到的原名，独立存储覆盖值。迁移核心结构：

```sql
ALTER TABLE media_items
  ADD COLUMN shared_title text,
  ADD COLUMN shared_title_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT media_shared_title_length
    CHECK (shared_title IS NULL OR char_length(shared_title) BETWEEN 1 AND 200),
  ADD CONSTRAINT media_shared_title_revision_nonnegative
    CHECK (shared_title_revision >= 0);

CREATE TABLE media_user_titles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  title text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (user_id, media_id),
  CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200)
);
```

清除个人覆盖值时保留 title=NULL 的版本行，不能删除后让旧请求以 revision=0 重新覆盖新状态。

按查看者查询的核心表达式：

```sql
SELECT m.id,
       COALESCE(u.title, m.shared_title, m.title) AS title,
       m.title AS original_title,
       m.shared_title,
       m.shared_title_revision,
       u.title AS personal_title,
       COALESCE(u.revision, 0) AS personal_title_revision
FROM media_items m
LEFT JOIN media_user_titles u ON u.media_id=m.id AND u.user_id=$1;
```

- 列表、单项详情、队列和当前播放信息都用同一解析规则。
- 搜索按当前用户实际看到的有效 title 搜索，UUID 游标分页保持现有顺序，不因按标题排序引入分页漂移。
- 个人 title 的 user_id 只能来自认证会话，不接受请求中的 user_id。
- title 只用于显示，不用于授权、播放资源定位、room snapshot、命令内容或共享广播。
- 用户输入 trim 后 1—200 个 Unicode 字符；允许中文和 Emoji，不接受空字符串、控制字符、换行。null 表示清除覆盖；使用 text 渲染，不使用 v-html。源码原名的现有长度规则不变。

### 4.2 REST 与前端 DTO

所有路径以下均省略 `/api/v1` 前缀。

| 方法/路径 | 权限/输入 | 输出与行为 |
| --- | --- | --- |
| `GET /media` | 登录；现有 search/after/limit | 保持数组结构，返回扩展后的 Media。 |
| `GET /media/{id}` | 登录 | 单项扩展 Media，供直接进入房间和改名后刷新使用。 |
| `PUT /media/{id}/personal-title` | 登录、Origin、CSRF；`{title: string\|null, expected_revision: string}` | 只更新本人；返回当前用户的 Media。 |
| `PUT /admin/media/{id}/shared-title` | 管理员、Origin、CSRF；`{title: string\|null, expected_revision: string}` | 更新全站覆盖名；返回管理员视角的 Media。 |
| `GET /rooms/{id}/playlist` | 保留房间成员验证 | 既有 id/media_id/title 保留，title 按当前用户解析，新增 cover 信息。 |

```ts
export type Revision = string; // 非负十进制 bigint，避免 JS 精度丢失
export interface MediaCover {
  status: "missing" | "queued" | "running" | "ready" | "unavailable";
  revision: string | null; // 不透明结果版本，不包含路径、源凭据
  url: string | null;     // 仅同源认证图片地址
  retry_after_ms: number | null;
}
export interface Media {
  id: string;
  title: string;
  original_title: string;
  shared_title: string | null;
  shared_title_revision: Revision;
  personal_title: string | null;
  personal_title_revision: Revision;
  duration_ms: number | null;
  kind: string;
  cover: MediaCover;
}
export interface QueueItem {
  id: string;
  media_id: string;
  title: string;
  cover: MediaCover;
}
```

通过事务与 `expected_revision` 比较更新：同版本的两个写入至多一个成功；首次个人写入也必须处理并发 insert 的唯一冲突。409 返回稳定码 `MEDIA_TITLE_CONFLICT`；界面保留草稿、读取最新记录，让用户再次保存，不自动覆盖。

新增 `MEDIA_TITLE_INVALID` 对应 400；非法 revision/多余字段为 400，未登录 401，非管理员写共享名 403，不存在或不可访问的媒体 404。沿用现有错误封装和 request_id，不把数据库错误详情交给浏览器。

响应丢失后 GET 详情核验：若目标 scope 的值与拟保存值一致，可提示已保存；否则保留草稿和不确定状态。不能无限重发或自动提高 expected_revision。无论 PUT 是否成功，播放状态与进度不改变。

标题数据响应使用私有且不跨用户缓存的策略（默认 `Cache-Control: no-store`）。注销/切换账号时取消请求、清空 catalog 和队列资料；旧身份响应即使迟到也不能写回。

## 5. 封面生成与缓存契约

### 5.1 策略与边界

当前项目没有可直接接入的封面 API，必须同时补服务端元数据、后台生成和前端显示。推荐采用**按可见媒体触发的有界后台任务 + 数据库中的小图缓存**，与转码播放队列分离，避免用户未进房就创建 playback session。

- 封面顺序：Jellyfin/Emby 可用的横向 Backdrop，其次 Primary 封面；获取失败或无封面时提取视频画面。本地/HTTP/NAS 当前没有已核实的封面约定，直接使用首个有效画面，不自行扩展外部海报搜索。
- 同一个媒体/源版本/生成规则版本只允许运行一个任务；多用户同时打开不重复解码。
- 固定 640×360、静态 WebP、最大 256KiB。保持比例后中心裁剪为 16:9，不拉伸，不改变视频本身。
- 从开头按时间顺序检查画面，跳过近乎全黑的帧。不要把 seek 到 10% 或随机抽帧当成“最早有效画面”。建议黑帧判定为灰度低于 24 的像素占比达到 99.5%，用合成测试校验阈值，不误把正常低亮度画面全部剔除。
- 整项执行默认最多 30 秒，输入网络/relay 累计预算 256MiB，单进程线程数和并发有界。达到预算仍找不到可用画面时显示“暂无法生成预览”，不冒充已找到首个有效画面；离线、损坏、纯黑素材有明确失败状态。
- 输出复用已修复的 `libwebp + image2pipe` 路径，验证 RIFF 长度、静态图片、尺寸和字节数；不能退回 Bookworm FFmpeg 5.1 的 `-f webp pipe:1` 问题路径。
- 不向浏览器暴露 NAS 文件路径、上游 token、源 HTTP headers 或可读取任意源文件的 URL。

### 5.2 状态接口

| 方法/路径 | 契约 |
| --- | --- |
| `POST /media/previews` | 登录 + Origin/CSRF；`{media_ids: string[]}`，去重后最多 24 项，未知/不可访问媒体不入队；返回 `{items: [{media_id, cover}]}`。ready 命中直接返回；queued/running 返回既有任务。 |
| `GET /media/previews?ids=id1,id2` | 登录；最多 24 项，只查状态，不新建任务；与 POST 相同结果结构。 |
| `GET /media/{id}/cover?revision=opaque` | 登录，重新检查媒体可见/有效及预览版本；ready 才返回 image/webp。旧版本或未 ready 返回稳定错误，不返回别人的数据或上游错误页。支持 ETag，但先认证再处理 304。 |

必须避免 `/media/{id}` 动态路由吞掉 `/media/previews`；新增路由后用真实请求验证匹配。

图片使用 `Cache-Control: private, no-cache`，允许认证后 ETag 重验。浏览器没有公网第三方图片请求。列表/状态响应 no-store。失败码至少区分版本过期、队列已满和暂不可生成；原始 ffmpeg/上游诊断只进脱敏内部日志。

前端只为可见卡片批量请求，最多 2 个批请求同时运行；页面隐藏/离开停止状态轮询。pending 时约 2 秒合并查询一次，最长 60 秒后停止自动等待并显示可重试状态；遵守 retry_after_ms。没有反复用坏图片触发 POST 的 onerror 循环。

### 5.3 数据与任务状态机

给 `media_items` 增加 `preview_generation bigint NOT NULL DEFAULT 1`。新增 `media_previews` 表，至少包含：

```text
media_id                 uuid PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE
source_generation        bigint NOT NULL
recipe_version           integer NOT NULL DEFAULT 1
result_revision          uuid NOT NULL
status                   text CHECK IN ('queued','running','ready','unavailable')
attempt                  integer NOT NULL DEFAULT 0
attempt_id               uuid NULL
owner_id                 uuid NULL
lease_until              timestamptz NULL
next_attempt_at          timestamptz NOT NULL
requested_at             timestamptz NOT NULL
accessed_at              timestamptz NOT NULL
generated_at             timestamptz NULL
image                    bytea NULL CHECK (image IS NULL OR octet_length(image) <= 262144)
image_sha256             text NULL
error_code               text NULL
```

迁移应落实非负值、合法状态和 ready 必须有 image/sha 的约束，以及领取索引 `(status,next_attempt_at,requested_at)`。这张表只服务预览任务，不修改既有 media_jobs/playback_sessions 的状态含义。

```text
无记录/旧源版本/缓存被回收 --认证 POST--> queued
queued --SKIP LOCKED 领取，签发 attempt_id--> running
running --验证输出 + 租约/attempt/源版本仍匹配--> ready
running --暂时网络失败，未超 3 次--> queued（2s、5s 退避）
running --永久失败/重试耗尽--> unavailable（默认 60s 后允许重试）
running --租约失效--> 回收后重新排队或终止
任何状态 --源版本变化--> 旧结果不可再发布/提供，新请求生成新版本
```

租约默认 15 秒，执行中每 5 秒续租；取消、Worker 退出或续租失败时停止 FFmpeg、关闭 relay、回收子进程，不能留下仍可读源文件的授权。一次 attempt 的失败发布不能覆盖后一次 attempt。

缓存默认图像总预算 128MiB，按最近读取时间淘汰 ready 图像；队列默认最多 128 个待执行项，Worker 预览并发默认 1。通过事务锁协调多个 Worker 的发布与容量核算，淘汰不删除媒体记录或名称。最后访问时间可以合并/节流更新，避免每个图片请求写数据库。

设置名建议：`MEDIA_PREVIEW_CONCURRENCY`、`MEDIA_PREVIEW_TIMEOUT_SECONDS`、`MEDIA_PREVIEW_CACHE_BYTES`、`MEDIA_PREVIEW_QUEUE_LIMIT`、`MEDIA_PREVIEW_INPUT_BYTES`。启动时检查正数与合理上限；新增配置写入样例/说明，不编辑用户真实 `.env`。

### 5.4 源版本和读取入口

| 片源 | 输入与版本策略 |
| --- | --- |
| local | 复用 safe_path，使用 file_version 的句柄属性版本；采集前后核验。扫描检测文件替换后递增 preview_generation。 |
| agent/NAS | 使用已上报 source_version，复用 Worker relay 的 range、取消及版本验证；不要求公开挂载 NAS。索引版本变化时递增 generation。 |
| HTTP | 复用受控 HTTP/Range/HLS 读取，保留认证 headers 及同源重定向限制。有 ETag/Last-Modified 时绑定验证；缺少可靠版本时每次成功重新扫描使预览失效，并对缓存设置最多 24 小时再验证周期。 |
| Jellyfin/Emby | providers 保存 ImageTags/BackdropImageTags 等版本信息；封面用同源图片 API，视频回退使用现有上游播放解析。封面 tag/媒体版本变化使缓存失效，无可靠版本时按 HTTP 的保守规则处理。 |

源配置改变也必须使缓存失效。禁止将个人改名当作内容变化反复重提取封面。local 的宿主机/容器属性版本可能不同，应以实际读取侧核验并记录，不把属性版本说成内容哈希。

Worker 为 FFmpeg 提供单独的预览输入授权（建议 `/preview-input/{attempt_id}`），绑定用途、媒体、源版本、owner、attempt、有效期及输入字节预算。只在该任务运行期间有效，不经过房间 playback session。

可以提取已有源读取辅助函数供播放与预览调用，但两个授权检查入口保持独立。HLS 的子列表/分片同样必须绑定该预览授权和原始同源约束；不能让 FFmpeg 绕过代理直接带凭据访问任意 URL。Range/HEAD 继续工作，预算按整个 attempt 累计，不因多次 Range 请求重置。

持久化缓存中的图片由 Server 认证读取，因此不新增公开 Worker 图片端口，也不要求新增数据库之外的共享卷。这会增加数据库小图容量，必须实现上述预算/淘汰，不能无限保存。

## 6. 前端组件与播放器契约

### 6.1 统一 AppSelect

采用真正由应用绘制的菜单，不靠原生 `<option>` 配色，不保留一套不可见 select 来掩盖界面测试。接口：

```ts
export type SelectValue = string | number | null;
export interface SelectOption {
  value: SelectValue;
  label: string;
  disabled?: boolean;
}
// AppSelect props
// modelValue: SelectValue; options: SelectOption[]; label: string;
// disabled?: boolean; invalid?: boolean; describedBy?: string;
// placeholder?: string; compact?: boolean;
// emits:
// update:modelValue(value: SelectValue)
// change(value: SelectValue) 仅用户选择了不同值时发出
// open-change(open: boolean) 供播放器锁定显隐
```

- 关闭字幕在组件层用 null，接入运行时适配为原有 undefined；音轨索引、有效期和倍速保持 number，不能因 DOM 值变成字符串。
- 触发器有 combobox、aria-expanded、aria-controls、正确标签；菜单 listbox，选项 option/aria-selected，选中项有勾号。保持真实焦点和 aria-activedescendant 一致。
- 支持 Enter/Space 展开，方向键移动，Home/End，输入首字定位，Enter 选择，Escape 仅关闭当前菜单，Tab 关闭后继续正常焦点顺序。禁用选项跳过。
- 菜单展开不改变页面布局；按可用空间向上或向下展开，长列表内部滚动，限制宽高，跟随 resize/scroll/visualViewport 更新位置。
- 菜单留在所属 dialog 或 fullscreen 元素的 DOM 子树内。优先使用可用的 Popover API 进入顶层；兼容回退的定位容器也必须属于当前 dialog/fullscreen。禁止无条件 Teleport 到 body，导致弹窗焦点陷阱之外或全屏不可见。
- 第一次 Escape 关闭菜单，第二次才关闭抽屉/退出相应上层；不要冒泡误触发 dialog cancel。在抽屉内点击选项不关闭抽屉。
- pointerdown/outside 监听在卸载时清理；控制菜单同时只打开一个。
- options 暂为空或当前值不在 options 内时显示明确占位/不可用状态，不自动选择首项或触发 change，避免字幕、音轨或片源在加载途中意外切换。

视觉基准：背景 `#FFF8E5`、文字 `#30241F`、悬停 `#EED9B5`、选中浅暖棕，圆角 11px、细边框；普通触发器/选项最小触控高度 44px。紧凑播放器布局也保持足够点击面积。焦点环要清楚，但避免截图中叠加的重边框。

单选/复选框保留原生 input 的键盘/表单语义，统一 accent、外框和 focus-visible；审查现有样式 `input:not([type="range"]):not([type="checkbox"])`，避免新增 radio 被错误应用文本输入框布局。当前没有确认的现有 checkbox/radio 页面，不为“统一”新增无意义功能。

分段按钮统一使用 AppSegmented；手机聊天/待播使用 tablist/tab/tabpanel 对应关系和方向键；管理员路由标签保持链接语义，不强行当作同页 tabs。

### 6.2 抽屉外部点击

只在 `drawer=true` 的 AppDialog 默认开启外部关闭，普通危险操作确认弹窗保持现有规则。所有关闭路径调用已有 close()，不能旁路 busy/canClose。

关键判定：同一 primary pointer 的按下与抬起都命中外部遮罩，且没有 pointercancel，才关闭。原生 dialog 的 backdrop 事件 target 可能是 dialog 本身，所以还需坐标与矩形判断；内部 padding 点击不得被 `.self` 误判。

```ts
function outsideBox(event: PointerEvent, element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right ||
    event.clientY < rect.top || event.clientY > rect.bottom;
}
// 只在 event.target === dialog 且 outsideBox 为真时记录 backdrop 按下。
// 抬起再次检查 pointerId、target、矩形和关闭保护；取消时清除记录。
// 下拉菜单 option/触发器属于抽屉内容，不属于 backdrop。
```

验收所有 drawer 调用点：添加 NAS、添加片源、创建房间、通过邀请加入、房间邀请、生成注册邀请码，以及新增的重命名抽屉（若采用 drawer）。

### 6.3 媒体资料缓存与改名 UI

`media-catalog.store.ts` 接口设计：

```ts
// records: Record<string, Media>
// remember(items: Media[]): void
// ensure(id: string, force?: boolean): Promise<Media>
// renamePersonal(id: string, title: string | null, revision: Revision): Promise<Media>
// renameShared(id: string, title: string | null, revision: Revision): Promise<Media>
// requestPreviews(ids: string[]): Promise<void>
// refreshPreviewStatuses(ids: string[]): Promise<void>
// reset(): void
```

catalog 依赖 session/API，不反向依赖 room-runtime，避免现有 library → runtime 的循环扩张。library、room-runtime、信息组件和缩略图统一消费 catalog。

除了身份 epoch，还要有每媒体的请求/写入序号：改名后迟到的旧列表/队列/详情响应不能覆盖刚保存的新名称。成功保存后按字段版本或写入序号合并，再重新计算有效标题；不能仅按“最后收到的响应”覆盖整条记录。队列标题优先读取当前身份的 catalog，队列接口 title 作为尚未加载详情时的回退；旧队列响应同样受序号约束。

媒体卡片新增“重命名”入口。编辑器包含“仅我看到的名称”，管理员额外看到“所有人的默认名称”，分别保存、分别恢复；标明原名及个人名称优先级。显示保存中、成功、失败和冲突；失败不丢草稿。普通用户看不到全站编辑入口，直接 API 请求也必须被拒绝。

`MediaThumbnail` 接收 `cover` 和描述性 `alt`，使用 lazy 图片、固定 16:9 容器避免布局跳动；图片失败保留真实失败/占位状态。队列与迷你播放器的缩略区域共享相同数据，视频本体不替换成缩略图。

直接打开房间或收到新的 state.media_id 时，按身份请求媒体详情，不要求用户先进入媒体库才有片名。按 media_id 去重请求，身份 epoch/room serial 拦截迟到数据；metadata 刷新绝不调用 loadMedia、enter 或重新建 socket。

### 6.4 播放器显隐状态机

把计时/锁定封装为 `use-player-chrome.ts`，它只管理 UI，不发送播放命令。对外至少提供：

```ts
// visible: Readonly<Ref<boolean>>
// hideCursor: Readonly<Ref<boolean>>
// fullscreen: Readonly<Ref<boolean>>
// pointerEnter(): void; pointerLeave(): void; activity(): void;
// toggleFromSurface(): void;
// setMenuOpen(value: boolean): void;
// setDragging(value: boolean): void;
// setKeyboardFocus(value: boolean): void;
// toggleFullscreen(): Promise<void>;
// dispose(): void;
```

| 当前模式 | 触发 | 行为 |
| --- | --- | --- |
| 普通桌面 | 移入画面 | 显示，鼠标可见 |
| 普通桌面 | 移出且没有交互锁 | 淡出，页面光标保持正常 |
| 全屏 | 进入/移动/操作 | 显示并重新计算 5000ms 截止时间 |
| 全屏 | 到期且无菜单/拖动/键盘焦点 | 隐藏信息、控件和仅播放器区域内的光标 |
| 触屏 | 点视频空白 | 显隐切换，显示时计时 |
| 任一模式 | 菜单打开/拖动/键盘焦点进入 | 显示并锁定；结束后按模式重新计时 |
| 任一模式 | 页面隐藏/组件销毁/退出全屏 | 清理过期计时与监听，避免恢复后旧计时错误隐藏 |

使用单个 timeout 或明确的截止时间，不用永久 RAF；普通鼠标点击造成的 focus 不应让光标永不隐藏，区分键盘焦点和 pointer focus。隐藏后控件不能有透明但拦截鼠标的层；键盘 Tab 到控件时必须先唤出再可见操作。

播放器结构目标（同一个 video 保留在原父级）：

```text
PlaybackHost（AppShell 持久挂载；全屏目标）
  video-frame
    video（现有 DOM，持续使用）
    必要错误/自动播放/缓冲提示
    全屏 PlaybackInformation（左上，随 chrome 显隐）
    底部 PlaybackControls + PlaybackSettings（浮层）
  迷你模式专用精简资料/返回入口

RoomPage（可随路由挂卸）
  右侧区域
    PlaybackInformation（左对齐）
    ChatPanel
  队列/房间操作
```

普通观看移除视频下方常驻大标题/控件/播放选项块。右侧 `.room-chat` 当前有 86px padding-top，改布局时重新对齐，不叠加旧补偿值。手机信息区放视频下方、聊天/待播切换区域上方，切换待播时仍能看见播放信息。

全屏去掉宿主的 20px padding、边框和圆角，视频 `object-fit: contain`，保留比例。空播放器保持奶油主题；真实视频比例不足产生的留边采用独立视频底色（建议中性黑），不在视频上叠加暖色滤镜。控制浮层用具有足够不透明度的奶油面板和深棕文字，显示时保证在亮/暗视频画面上的可读性；隐藏后完全纯净。

## 7. 按检查点执行

顺序：T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9。后端 T1—T3 完成真实验证后再接入前端数据功能。每个任务先增加能暴露缺陷的有效测试，确认失败原因，再实现并通过；纯配色/文档变更不为凑数量编写镜像实现的测试。

上述为正常执行顺序。若真实后端验证因环境受阻，可以先完成不依赖它的 T4/T5 和 T7 的纯 UI/状态机部分；记录未完成的检查点并返回补验，不把 mock 接口接入或独立 UI 完成当成后端通过。

### T0：记录起点并隔离验证环境

**文件：**新增 `docs/LIBRARY_PLAYER_PROGRESS.md`；按需新增 `tests/fixtures/media-stack.mjs` 和 `playwright.polish.config.ts`，不得修改用户真实环境文件。

- [ ] 读 AGENTS、本文、相关架构；核实分支/HEAD/工作区和 Git 作者。若发现新改动，先明确归属，不覆写。
- [ ] 记录启动中的服务身份、端口和验证所有权，采用只读检查，不输出环境中的凭据。
- [ ] 设置外部产物根目录后再启动任何会写缓存的命令。
- [ ] 执行一次必要基线：Rust 单测、前端单测、类型/构建、现有浏览器核心用例；失败区分原有或环境原因。
- [ ] 隔离 fixture 必须自己创建 PostgreSQL、Server、Worker、可选 NAS Agent、合成媒体及随机密钥，注册其进程/容器所有权并 finally 清理。已有 `tests/fixtures/server.mjs::isolatedServer` 可复用，不能接受用户 DATABASE_URL。

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git config --local user.name
git config --local user.email
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-library-player-polish-20260928-run1'
```

若作者不符，仅设置仓库本地配置为 Rainfrost / luo005962@gmail.com；提交后还要检查 Author 与 Committer。日期目录可以换成实际执行时间，禁止清空以前的证据目录。

Playwright 新配置必须继承现有 desktop/mobile 项目、产物目录和报告设置，同时使用经检查空闲的独立端口，例如 5198，`reuseExistingServer: false`，Vite `--strictPort`。mock 套件代理指向不可用测试目标（如 127.0.0.1:1），避免漏拦截请求落到真实 8080 服务。真实联调则设置为 fixture 的临时 Server/Worker 地址。

**完成检查点：**进度文件列出基线结果、环境限制、既有用户改动和唯一产物目录。只提交本任务准备文件，建议提交标题 `docs: record library and player implementation baseline`。

### T1：实现双层名称与按用户读取

**文件：**第 3 节的 0023、media_titles.rs、Server 路由、media.rs、agents.rs、rooms.rs、错误契约；新增 `tests/media-titles.mjs`。

- [ ] 先写真实隔离 Server 回归：管理员全站名、两普通用户不同个人名、禁止越权、清除回退、重扫保留、并发版本冲突、重启持久化。
- [ ] 增量迁移后，列表/详情/队列共用有效标题查询；确保两条扫描路径都不覆盖新字段。
- [ ] 实现两个 PUT 路由的字段白名单、校验、Origin/CSRF、CAS 及丢响应恢复契约。
- [ ] 增加稳定错误码并通过既有生成器更新相关协议，不手工编辑生成文件冒充生成。
- [ ] 检查搜索、游标分页、不可用媒体和原有房间成员权限。

新测试文件的起点可直接使用已有 fixture；以下为必须通过的最小真实 API 路径：

```js
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";

await isolatedServer("media-titles", async (f) => {
  const admin = f.client();
  await admin.login();
  const source = await admin.request("/sources", "POST", {
    name: "title-fixture", kind: "local", config: { root: f.root },
  });
  const id = randomUUID();
  f.sql(`INSERT INTO media_items(id,source_id,title,resource)
    VALUES('${id}','${source.id}','原始名称','fixture.mp4')`);
  for (const username of ["alice", "bob"]) {
    await admin.request("/users", "POST", {
      username, password: "Fixture-pass-123",
    });
  }
  const alice = f.client(), bob = f.client();
  await alice.login("alice", "Fixture-pass-123");
  await bob.login("bob", "Fixture-pass-123");
  await admin.request(`/admin/media/${id}/shared-title`, "PUT", {
    title: "全站名称", expected_revision: "0",
  });
  await alice.request(`/media/${id}/personal-title`, "PUT", {
    title: "我的名称", expected_revision: "0",
  });
  assert.equal((await alice.request(`/media/${id}`)).title, "我的名称");
  assert.equal((await bob.request(`/media/${id}`)).title, "全站名称");
  await bob.request(`/admin/media/${id}/shared-title`, "PUT", {
    title: "越权名称", expected_revision: "1",
  }, 403);
  await alice.request(`/media/${id}/personal-title`, "PUT", {
    title: null, expected_revision: "1",
  });
  assert.equal((await alice.request(`/media/${id}`)).title, "全站名称");
  await alice.request(`/media/${id}/personal-title`, "PUT", {
    title: "迟到旧写入", expected_revision: "0",
  }, 409);
});
```

扩展上述测试时必须真的执行 local/Jellyfin/Emby 扫描及 NAS 索引提交，不能用手工 UPDATE 原名冒充扫描兼容验证；这些素材由 fixture 自己生成。

**验证：**`node scripts/run-check.mjs titles 300 node tests/media-titles.mjs`，相关 Rust 单测/编译与迁移测试。通过后提交 `feat: support shared and personal media titles`。

### T2：实现预览任务与输入授权

**文件：**0024、persistence/media_previews、Server media_previews、Worker previews/preview_input、providers/preview、media-core/preview；新增 `tests/media-previews.mjs`。

- [ ] 先补独立队列真实测试：相同媒体并发请求去重、租约回收、旧 attempt 不可发布、源更新不可发布旧结果、容量限制。
- [ ] 落实第 5 节状态机、数据库约束、预算和清理；Server 的请求/状态接口不执行解码。
- [ ] 接入 Worker 独立执行器与短期输入授权，复用 child_process 的进程所有权，确保失败/取消等待子进程回收。
- [ ] local/HTTP/NAS/Jellyfin/Emby 分别完成版本绑定和凭据隔离；HTTP HLS 子资源不能绕开授权。不要修改或放宽既有播放会话校验。
- [ ] 实现认证图片返回、正确 MIME/ETag、版本核验与 no-store 状态响应。
- [ ] 每次 POST 返回实际状态，不生成假进度百分比。

关键发布逻辑必须包含等价的条件写入：

```sql
UPDATE media_previews p
SET status='ready', image=$1, image_sha256=$2, generated_at=clock_timestamp(),
    owner_id=NULL, lease_until=NULL, error_code=NULL
FROM media_items m
WHERE p.media_id=$3 AND m.id=p.media_id AND m.available
  AND p.source_generation=m.preview_generation
  AND p.attempt_id=$4 AND p.owner_id=$5
  AND p.status='running' AND p.lease_until>clock_timestamp();
```

发布前的缓存预算锁/淘汰与此更新处于同一事务；受影响行数不是 1 就丢弃结果，不强行补写。处理编码到发布之间源变化、源被撤销、lease 丢失的竞态。

上述 SQL 是版本/租约发布条件，不代替源权限复核。NAS 发布事务中还需锁定并检查对应 agent 未被撤销，认证图片读取也需检查当前源仍被允许使用；禁止只在任务开始时检查一次。

**验证：**`node scripts/run-check.mjs previews 600 node tests/media-previews.mjs`；相关 Rust 测试。通过后提交 `feat: generate authenticated media previews outside playback sessions`。

### T3：验证真实解码与部署版本兼容

**文件：**新增 `tests/media-preview-container.mjs`、合成媒体 fixture 支持；更新必要配置说明；新增后端验收段落到进度文档。

- [ ] 生成：从首帧有图、黑两秒后出现图、较暗但有效的图、全黑、竖屏/旋转、损坏视频、高细节画面、超大/挂起输入。
- [ ] 用帧颜色/标记验证输出来自最早有效画面，不能只断言 HTTP 200 或文件非空。
- [ ] 验证 WebP RIFF 长度、640×360、静态、256KiB 上限和读取权限。
- [ ] 在实际部署 Dockerfile 所使用的 Bookworm FFmpeg 路径验证；使用独立测试镜像标签及随机 fixture 容器，不覆盖 `rainsync-*:dev` 等现有服务标签。Dockerfile 已有用户改动只作为实际构建输入记录，不暂存它。
- [ ] 真实 NAS Agent 测试离线/恢复、版本变化、撤销、取消后的 transfer 清理；HTTP 测试 Range/HLS、跨源重定向、慢流/无 Content-Length；Jellyfin/Emby 测试上游封面与无封面回退。
- [ ] 对比预览前后 playback_sessions、房间连接和转码任务计数：预览不能新增播放会话或房间。

**通过门槛：**名称权限/扫描保留与五种片源预览均有真实 Server/Worker/隔离数据库证据。上游 HTTP fixture 可模拟 Jellyfin/Emby 的确定性错误，但至少补现有隔离 Jellyfin/Emby 启动设施的真实 API 路径；不能将 mock 协议测试写成真实上游联调。无条件时保留明确未验证项，继续可独立验证的工作，但不宣称后端验收完成。

**验证：**`node scripts/run-check.mjs previews-container 900 node tests/media-preview-container.mjs`；必要的既有 relay/worker 回归。提交 `test: verify media previews with deployment ffmpeg and source variants`。

### T4：实现统一选择器与抽屉关闭

**文件：**AppDialog、AppSelect/select/use-select-popup、AppSegmented、选择样式；新增 `tests/browser/selection-controls.spec.ts`、`tests/browser/drawers.spec.ts`。

- [ ] 先写截图问题对应浏览器用例：播放方式点击后出现自绘 listbox，选中项有标记，背景属于统一 tokens；原实现应因没有 listbox 而失败。
- [ ] 实现第 6.1 节完整键盘、定位、点击外部、禁用和数值类型契约。
- [ ] 在原生 modal dialog 内和真实 fullscreen 容器内验证菜单可见、可操作、没有被裁剪，不在 body 的无效层级显示。
- [ ] AppDialog 添加同 pointer 的 backdrop 判定，所有关闭入口仍经过 busy/canClose。
- [ ] 验证内部空白、拖出、pointercancel 不关，外部点击可关，Escape 优先关闭菜单，关闭后焦点返回触发器。
- [ ] 替换所有既有 select；同步修改旧浏览器用例的 selectOption 为真实点击/键盘操作，不删除其业务断言。统一 radio/checkbox 的样式与分段切换。

典型浏览器测试（使用已有 appFixture）：

```ts
import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("片源类型菜单在抽屉中可操作且不会误关闭抽屉", async ({ page }) => {
  await appFixture(page);
  await page.goto("/admin/sources");
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "添加片源" });
  const select = drawer.getByRole("combobox", { name: "类型", exact: true });
  await select.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "HTTP MP4 / HLS", exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(select).toContainText("HTTP MP4 / HLS");
  await select.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(drawer).toBeVisible();
});
```

测试标签以保留的实际页面文字为准；不为迎合此例改掉已有片源名称。为窄屏没有可点击外部区域的全宽抽屉保留明显关闭按钮，不能把内部边距改成关闭区。

**验证：**独立端口 Playwright desktop/mobile；键盘和 reduced-motion；相关已有 admin/account 用例。提交 `feat: unify selection menus and drawer backdrop dismissal`。

### T5：完成配色审查与修复

**文件：**tokens/base/layout/admin/account/selection 样式以及使用到的 Vue 类名；扩展 `tests/browser/layout.spec.ts` 的必要可见状态检查。

- [ ] 将无媒体时播放器大块底色调整为 `--surface-panel` 或明确的同色空态 token；页面主背景 `#FFF4D5` 不变。
- [ ] 建立页面/状态检查表：登录注册、房间列表、空/有视频房间、媒体库、个人资料、所有管理页、抽屉、下拉展开、焦点、选中、禁用、错误、只读、加载。
- [ ] 扫描硬编码颜色及浏览器默认背景，修复有证据的不一致；错误/成功语义色和有意的层次色保留，不把全部界面刷成一种颜色。
- [ ] 检查字号/对比度，尤其浅棕按钮上的深棕文字、菜单选中项、只读邀请码及视频上的浮层。
- [ ] 媒体缩略图、空态与视频 letterbox 分开命名，不用更改视频内容颜色来“消除色差”。

**验证：**真实浏览器查看上述状态并记录截图到杂项；必要颜色断言验证计算后的样式，不能只断言 token 字符串。生产构建。提交 `fix: align empty states and controls with the cream theme`。

### T6：接入媒体资料、封面和重命名

**文件：**types、media.api、media-catalog.store、library.store、MediaRenameDialog、MediaThumbnail、LibraryPage、room-runtime/RoomPage；新增 `tests/media-catalog.test.ts`、`tests/browser/media-library.spec.ts`。

- [ ] 按第 4—6 节实现 API/DTO/catalog，按用户隔离，防止重命名和预览旧响应回写新身份。
- [ ] 列表保持现有搜索/分页语义；可见卡片批量请求预览，轮询合并和取消。
- [ ] 改名分别保存个人/全站作用域；CAS 冲突保留输入；响应丢失后读回核验；清除后正确回退。
- [ ] 改名后更新卡片、当前播放资料和队列显示，但不重载媒体。
- [ ] 直接进入房间也加载当前媒体详情；媒体切换只刷新新 id 的元信息。
- [ ] 队列和迷你播放器中需要的封面复用同一缓存；后台页面停止轮询，回到页面从真实状态恢复。

**关键测试：**Alice/Bob 对同一影片显示不同名称；切账号后不会短暂出现旧别名；新用户可见的标题和网络响应均不含他人私有名称；25 项分页只有可见项请求；旧封面响应不能覆盖新 source generation；连续播放期间改名不新增 session。

**验证：**catalog 单测、浏览器媒体库用例、真实 Server 名称/封面 API 联调。提交 `feat: add media covers and personal or shared rename controls`。

### T7：实现播放信息布局与显隐状态

**文件：**PlaybackInformation、use-player-chrome、PlaybackHost、PlaybackControls、PlaybackSettings、RoomPage/layout；新增 `tests/player-chrome.test.ts`、`tests/browser/player-chrome.spec.ts`。

- [ ] 先测试状态机：普通 hover、5000ms 边界、活动重置、菜单/拖动/键盘锁、触控切换、清理旧 timeout。
- [ ] 信息放到桌面聊天上方及手机视频下方；信息组件纯展示，不拥有/挂卸媒体。
- [ ] 把进度、音量、倍速及设置放进视频内浮层；使用统一 AppSelect，展开菜单锁定显隐。
- [ ] 控制操作沿用现有 r.send/r.seek/本地音量、模式 reload 与字幕逻辑；mode 改变是否生效继续保持原有“重新加载”语义并清晰呈现，不顺手改自动重建策略。
- [ ] 保留滑条 pointercancel/blur 收尾，拖动离开视频也能完成，其他观众仍不能发送控制者命令。
- [ ] 处理全屏切换成功/拒绝、fullscreenchange、Escape 和手机能力差异。退出全屏时清除 cursor:none，恢复当前布局。
- [ ] 处理 hidden 控件的命中区域与键盘可达性；操作菜单/聊天输入不会触发全局播放快捷键。

**浏览器五秒边界断言思路：**用 Playwright clock 控制 UI 计时；通过真实点击进入全屏后核验 document.fullscreenElement。在第 4999ms 控件仍显示，第 5000ms 起进入隐藏并在动画时长内 opacity=0、播放器 cursor=none；再移动鼠标恢复。不能只检查某个 CSS class 存在。

**验证：**状态机单测；桌面真实 Fullscreen API 的显示/隐藏和菜单；手机模拟触控；键盘、reduced-motion；迷你播放器、路由持久播放回归。提交 `feat: add clean video controls and idle fullscreen behavior`。

### T8：真实联调、回归与性能边界

**文件：**扩展 `tests/browser-real.mjs` 或新增 `tests/library-player-real.mjs`，复用隔离 fixture；需要新增脚本时在 package.json 注册明确命令。

- [ ] 两真实测试用户进入同一房间，各自改名/查看同一视频，确认各自标题、同步播放和聊天都正常。
- [ ] 先在媒体库请求封面再进房：没有封面播放 session；实际播放只产生正常所需会话。
- [ ] 播放 → 媒体库 → 改名 → 管理/资料 → 返回原房间 → 全屏 → 退出：逐段检查同一 DOM video、同一连接、进度连续、无多余播放申请。
- [ ] 在全屏内操作倍速、字幕、音轨和设置菜单，验证命令/当前媒体结果，不能只截图菜单。
- [ ] 运行本次改动涉及的 Rust、前端单测、类型/构建、完整浏览器套件；涉及输入授权/进程管理时重跑既有 relay/worker/取消/版本回归。
- [ ] 数据库迁移在有旧媒体数据的隔离库升级；重启自己创建的 Server/Worker 检查名称、封面和任务恢复。
- [ ] 记录大库滚动时请求/并发数、有无持续空转 RAF/timeout、缓存上限、失败后进程数和连接数。

**完成检查点：**需求矩阵每项有实际证据；未完成和未验证单独列出。不能用已有历史测试数字替代本轮验证。Safari/iOS/Android 实机若不可用，明确写未验证。

### T9：本地提交、交接报告与回滚说明

**文件：**新增 `docs/LIBRARY_PLAYER_IMPLEMENTATION_REPORT.md`，完成进度文档，按真实变更更新 `docs/FRONTEND_ARCHITECTURE.md` 和接口/配置说明。

- [ ] 报告包含需求矩阵、改动前后、接口/迁移/配置、实际命令/退出码/证据目录、提交 SHA、兼容与限制。
- [ ] 本任务源码、迁移、正式测试和报告本地提交，所有提交身份为 Rainfrost `<luo005962@gmail.com>`；既有四项用户改动保持原状。
- [ ] 提交前审查只包含任务范围；有 cgraphy 则用 diff_context，缺失时常规 diff。不得将真实照片、视频、Cookie、密钥或截图加入提交。
- [ ] 记录依赖顺序与 `git revert` 回滚顺序，不 reset --hard，不改写已完成历史。SQLx 新迁移加入后不要直接运行不认识新迁移历史的旧二进制并承诺兼容；在隔离库实测兼容构建或前向修复路径。
- [ ] 回退 UI 可保留新增名称/缩略图表；停止预览新任务需要 Worker/Server 版本兼容。删除缓存可以再生成，但个人/全站名称是用户数据，不能随回滚删除。
- [ ] 清理仅本任务拥有的测试进程/容器，保留证据。报告不包含执行部署命令；用户已运行服务仍由用户后续决定是否同步。

最终回复提供：完成摘要、关键验证结果、报告绝对路径、分支和提交、未验证项；不发送效果图。

## 8. 验证命令与设施要求

以下命令是供执行会话运行的计划，本轮没有执行。`run-check.mjs` 第二个参数单位是秒。

```powershell
node scripts/run-check.mjs rust-format 120 cargo fmt --all --check
node scripts/run-check.mjs rust-unit 1200 cargo test --workspace --locked
node scripts/run-check.mjs rust-build 1200 cargo build --workspace --bins --examples --locked
node scripts/run-check.mjs protocol-check 300 cargo run -p protocol --example export --locked -- --check
node scripts/run-check.mjs frontend-unit 300 node node_modules/vitest/vitest.mjs run
node scripts/run-check.mjs frontend-build 300 cmd.exe /d /c npm.cmd run build
node scripts/run-check.mjs titles 300 node tests/media-titles.mjs
node scripts/run-check.mjs previews 600 node tests/media-previews.mjs
node scripts/run-check.mjs previews-container 900 node tests/media-preview-container.mjs
node scripts/run-check.mjs browser-polish 900 node node_modules/@playwright/test/cli.js test --config playwright.polish.config.ts
node scripts/run-check.mjs library-player-real 1200 node tests/library-player-real.mjs
```

若 T8 选择扩展现有 browser-real.mjs，就把最后一条和报告同步改为该真实脚本，不留下不存在的命令。已核实协议生成器为 `crates/protocol/examples/export.rs`，输出到 `packages/protocol`，`--check` 为只读内容核对；实现中修改错误契约后，用 `cargo run -p protocol --example export --locked` 正常生成，再运行上面的 protocol-check。执行时仍需确认 crate 名称和接口没有随其他提交改变。

新增 `tests/fixtures/media-stack.mjs` 的接口需要统一，避免各测试自行启动不受控服务：

```js
// export async function isolatedMediaStack(name, run, options = {})
// run 接收扩展的 isolatedServer fixture：
// f.client(), f.sql(), f.root, f.origin, f.target 继续存在；
// f.workerOrigin: string
// f.startWorker(): Promise<void>
// f.stopWorker(): Promise<void>
// f.startAgent(): Promise<{ agentId: string }>
// f.stopAgent(): Promise<void>
// f.makeClip(name, { blackSeconds, pictureSeconds, width, height, rotate }): Promise<string>
// f.waitForPreview(mediaId, expectedStatus): Promise<void>
// 所有进程/端口/临时数据的所有权由 fixture 记录并 finally 回收。
```

这些是要新增的接口，不可当成仓库已存在的函数。makeClip 必须使用合成画面且有超时；新测试在支持真实数据路径后再引用，不能写只有名称的空 fixture。

测试启动前检查浏览器安装路径。可以使用已存在的有效安装目录；不能悄悄连接用户当前浏览器资料做测试。Docker 镜像构建/拉取若受网络限制，先记录具体错误；此前 7897 代理是历史操作背景，不擅自修改全局代理。

## 9. 需求—验收矩阵

| 需求 | 最低验收证据 |
| --- | --- |
| R1 抽屉 | 全部 drawer 外部点击可关；内部点击/拖出不关；busy/canClose 生效；未复制邀请码仍提示；焦点恢复；嵌套下拉 Escape 正确。 |
| R2 配色 | 截图对应空态已修；逐页状态表和实际计算样式/内部截图；对比度；没有系统灰色菜单；没有改动视频色彩。 |
| R3 选择控件 | 七处原生 select 全覆盖（播放方式、音轨、字幕、倍速、片源类型、邀请码状态、有效期）；键盘/移动/禁用/空列表/滚动；数值类型；全屏/dialog 层级；radio/checkbox 样式与分段按钮。 |
| R4 封面 | 五种片源；真实提取最早非黑帧；已有上游封面优先；图像格式/尺寸/大小；去重/失效/预算；无额外播放 session；权限与凭据隔离。 |
| R5 改名 | admin + Alice + Bob；双层回退；无个人泄漏；搜索/分页/队列/当前播放一致；重扫和重启保留；CAS、CSRF、越权、丢响应。 |
| R6 信息位置 | 桌面聊天顶部左对齐；手机视频下方；长标题不挤坏聊天；直接进房能读取片名。 |
| R7 普通播放器 | hover 显隐、拖动和菜单锁定、纯净画面、音量本地/倍速房间权限、手机点按、迷你播放器。 |
| R8 全屏 | document.fullscreenElement 为播放器；无页面区域；比例正确、无旧 padding；4999/5000ms 和动画终点；恢复鼠标；退出全屏无残留 cursor:none。 |
| R9 可访问性 | Enter/Space/箭头/Home/End/Escape/Tab；焦点可见；触控面积；reduced-motion；不支持 API 的诚实回退。 |
| R10 持续播放 | 同一 video 对象、连接数、播放请求数及数据库会话数；路由/改名/菜单/全屏全过程进度连续。 |
| 现有功能保护 | 导航匀速流光/回弹，认证竞态、注销、同房间重入、聊天幂等，头像/管理/播放核心回归。 |

## 10. 给执行会话的可直接复制指令

```text
请执行 C:/Users/ALIENWARE/Desktop/RainSync/docs/superpowers/plans/2026-09-28-library-player-polish.md。
先完整阅读该计划及项目 AGENTS.md，重新核实实际 HEAD、分支和未提交改动，然后按 T0—T9 完成实现、隔离验证、本地提交及详细报告。
已确认的产品需求不要重复询问；出现本文未覆盖的重大产品分歧时先问，同时继续独立工作。
分支使用 front/rainsync-implementation；所有本地提交的作者和提交者均使用 Rainfrost <luo005962@gmail.com>。
不要覆盖用户原有 deploy/Dockerfile 修改和三个删除，不使用 reset --hard，不把无关改动提交。
不要操作任何已运行的用户服务，包括 RainSync 8088 和 SnowLuma 5099；只启动和清理本任务自己的隔离测试资源。
所有临时产物放在 Desktop/杂项 的专用目录，不连接用户数据库写入；不推送、不创建 PR、不部署、不发外部消息、不生成效果图。
默认在当前执行会话内完成，不自行新建会话或委派子代理。保留进度记录，实际验证后再声称完成，最后提供报告链接、提交 SHA、验证结果和未验证项。
```
