# RainSync 全量改造实施报告

交付记录日期：2026-09-28（Asia/Shanghai；验证日志使用2026-09-27 UTC）。本报告按[本次完整要求](IMPLEMENTATION_REQUIREMENTS.md)组织，历史设计中的“仅设计”阶段限制已由本次实施授权替代。

## 1. 总体结果

本次已完成邀请码注册、固定登录账号与可改昵称、独立头像裁剪及持久化、全量米色前端替换、跨路由连续播放、管理区及必要验证。后端先实现、验收并提交，之后才开始前端重构；真实联调先通过，随后原子切换根入口并删除旧UI。

| 项目 | 实际状态 |
|---|---|
| 工作区 | `C:/Users/ALIENWARE/Desktop/RainSync` |
| 实施分支 | `codex/rainsync-implementation` |
| 实际起始基线 | `13262053eb5f949a7e9dea6f2a11d2e1cbe7ce6e` |
| 后端验收节点 | `c6a27127f445cdc079f98ed2440a23154ecdf150`；已在前端实施前向用户报告 |
| 全量前端完成及旧UI删除节点 | `2f24be569b105fcbba3a3ef26d2457e9c2292f37` |
| 最终报告节点 | 本报告与最终文档、CI和测试入口一同提交；该提交SHA由最终聊天提供，避免文件自引用 |
| 正式交付状态 | 产品实现及必要验收完成；全部本任务正式文件纳入本地提交，原有三项用户删除保留 |
| 必须完成但未完成的实现 | 无 |
| 未验证范围 | 实际Safari/iOS/Android、真实软键盘、长期/弱网/生产负载、生产部署及生产备份恢复；具体见第9节 |
| 外部操作 | 没有Git推送、PR、部署、外部消息、第三方演示上传或向用户展示效果图 |

本次完成不等于项目全部历史24周计划或生产级发布验收完成；README原开发预览定位保留。验证只写入自行创建的可丢弃数据库，没有向未知用户部署写入。未新建聊天、未委派子代理。cgraphy工具不可用已说明，按AGENTS.md回退为常规源码检索，未重复graph/grep查询，未调用enrich/store。

证据根目录下文简称 **ARTIFACT**：`C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28`。正式源码、测试设施和文字文档在仓库；运行日志、合成媒体、截图、trace、临时脚本、缓存、构建与依赖实体在ARTIFACT。原始日志不提交，避免混入凭据、原码或大文件。[VERIFICATION_MANIFEST.json](VERIFICATION_MANIFEST.json)保存36个选定通过节点的精确命令、时间、退出码及日志SHA-256，另含最终真实浏览器证据摘要文件的哈希。它不是全部尝试的列表，也不是第三方认证；失败尝试仍在外部logs中。

## 2. 需求完成矩阵

表中路径均相对仓库。测试名称对应正式测试文件；日志对应ARTIFACT/logs。B为后端门槛，F为最终总验收。完整后端逐项细节见[后端验收](BACKEND_VALIDATION.md)，账号/头像交叉证据见[专项联合验收](ACCOUNT_REGISTRATION_VALIDATION.md)。

| 确认需求 | 实现位置与行为 | 方法、结果及证据 |
|---|---|---|
| 一码一人、批量、1/7/30天及默认7天 | `registration.rs`、0020；1–50个，管理员批次UUID，默认1个/7天 | 真实Server/Postgres `registration-invites.mjs`、`registration.mjs`；B backend-invites/registration-final、F final-accounts通过 |
| 仅成功注册消耗，验证不预留 | `registration_auth.rs`；锁后复查，账号/资料/消费/会话同事务 | 并发同码只有一人成功、重复validate不消耗、用户名占用不消耗、四处故障全回滚，真实HTTP与数据库断言通过 |
| 撤销/到期/竞争 | `registration.rs`；撤销与注册争同一行锁，数据库实时时钟判定 | 持锁跨有效期、撤销竞争两个顺序、已用/过期/撤销码拒绝；final-accounts通过 |
| 首次原码、复制、列表筛选、丢失响应 | `RegistrationInvitesPage.vue`；一次展示、复制失败选择文本、关闭提醒、UUID查询恢复 | 管理浏览器16例含截断/刷新/同ID重试；c6-browser-full、d-switch-browser-final通过，真实创建见final-real-browser |
| 注册码与房间邀请独立 | 账号邀请码独立表/摘要域；房间仍为`{room_id,token}` | 注册后无成员关系，必须另走房间邀请；真实联合验收数据库与UI断言通过 |
| 登录账号唯一固定、ASCII白名单 | `account_rules.rs`、`profile.rs`、`account-rules.ts`；1–80字符、区分大小写 | 1/80/81边界、非法字符、占用409、PATCH额外字段拒绝；原账号再次登录通过 |
| 可选、重名、中文/Emoji、50码点可改昵称 | `user_profiles`、`ProfilePage.vue`；空白恢复账号显示 | 50/51码点、重名、默认显示、聊天新消息/历史分离身份；真实接口和浏览器通过 |
| 密码≥8、英文符号/空格、禁止中文、不trim | 公共新建规则覆盖注册/手动/首次初始化；8–1024可打印ASCII | 7/8边界、8空格、中文拒绝、含首尾空格登录；final-accounts及真实浏览器通过 |
| 存量账号密码会话兼容 | 登录不套新建规则；users/sessions原结构不改 | 真正0019基线的中文账号/历史短密码、原Cookie/邀请升级后有效；backend-migration-upgrade与rollback-data通过 |
| 普通用户注册、自动登录、无邮箱电话 | RegisterPage两步流程及既有Cookie/CSRF | 真实管理员生成→校验→注册→普通身份→放映室列表；额外admin字段拒绝，final-real-browser通过 |
| 保留手动建号并统一规则 | `CreateUserPage.vue`、POST `/users` | 管理员真实创建结果admin=false；普通用户接口403；规则真实测试通过 |
| 昵称与头像独立保存 | `ProfilePage.vue`、session store的字段级合并及本地修订 | 未保存昵称草稿不被头像写入，昵称保存不变头像版本，迟到auth/me不回退；单测/mock/真实流程通过 |
| JPG/PNG/WebP静态输入，拒绝动态/SVG/GIF | `image-input.ts`、`avatar_image.rs`；签名/尺寸/帧/真实解码 | 坏图/伪格式/APNG/MPF/动画/超限测试，真实FFmpeg校验；final-unit/accounts/browser通过 |
| 长宽图自由取景，先正方形再512输出 | 自主`crop-model.ts`、`AvatarCropDialog.vue`；拖动/键盘/双指、zoom1–8、Canvas | 宽图左右、长图上下四次真实WebP均512×512，像素颜色不同；final-real-browser evidence.avatars |
| 预览、更换、恢复默认、失败旧图、取消不提交 | 裁剪弹窗和条件PUT/DELETE；成功后更新资料 | 浏览器取消零请求、失败保留旧图/草稿；真实并发/删除墓碑、编码失败/进程回收通过 |
| alpha/体积/存储边界、迟到保护 | 0021当前WebP bytea≤256KiB、版本/操作UUID、稳定父行锁 | 透明像素、CRC、尺寸、编码超时、重放和A迟到/B替换/恢复默认竞争、重启/备份通过 |
| Vue/TS/Pinia、一套观看与管理应用 | `app/router.ts`、AppShell及features；独立身份/API/房间/播放运行时 | 类型检查、44单测、角色守卫与真实API；无两套默认入口 |
| 完整替换旧UI，保留核心模块 | `main.ts`原子切换；删除App.vue/style.css/api.ts | 根入口86例及真实联调通过；sync-engine/player-core与基线git diff为空 |
| 主辅色、纯文字品牌、浅色米色播放器 | `styles/tokens.css`、PlaybackHost/Controls、AppShell | 精确颜色/品牌无图标/系统暗色仍浅色断言；c7-browser-final及最终layout回归通过 |
| 媒体16:9、头像1:1、不造元数据 | MediaThumbnail、媒体库/待播/迷你；无封面用明确占位 | 浏览器样式/尺寸断言；真实片源元数据FFprobe；无随机封面/人数/评分 |
| 连续播放、唯一video/HLS/WS/会话 | PlaybackHost位于RouterView/Transition外；CSS全幅/迷你切换 | 真实各管理/资料路径同video，WS1→1、播放POST1→1、全库会话2→2，currentTime连续 |
| 保留同步/控制/取消/幂等/纠偏/HLS/音字幕 | `room-runtime.ts`、`playback-runtime.ts`与原核心 | 原19例×桌面/手机=38全部保留；真实Server/Worker/NAS及双用户视频通过 |
| 登录、房间创建加入、聊天、待播、邀请、连接状态 | Login/Rooms/RoomPage/ChatPanel及运行时 | 加入权限、控制epoch、队列、真实昵称聊天、房间邀请独立；原集成与最终浏览器通过 |
| 片库搜索分页与选择、全部管理页 | Library store；Sources/Agents/RegistrationInvites/CreateUser | 真实游标24+1、扫描后刷新、四类片源字段、NAS创建撤销、批次恢复及手动账号，mock与真实接口交叉通过 |
| 旧异步结果、加载/空态/错误/重试/未知反馈 | API epoch、页面序号、AbortController、use-action及各页 | 旧身份401、截断响应、迟到进房、无CHAT ACK的显式同ID重试均有失败复现/修复/通过记录 |
| 移动、键盘焦点、软键盘、对比及reduced-motion | layout/motion、AppDialog、visualViewport | 360/390/768/1024/1440/1920、Tab/Esc/焦点恢复、触点、视口收缩、对比≥4.5；Chromium模拟通过，实机未验证 |
| 增量迁移、重启、兼容回退与备份 | 0020/0021及compatibility/migration测试 | 未改0019→21，保留迁移旧业务→再升级→pg_dump/restore均通过；不删除用户数据 |
| 全部本地提交、正式报告、用户修改保护 | 分阶段14个实现/验收提交及报告提交 | 第7节清单；最终只保留三个原有删除，不推送/PR/部署 |

## 3. 后端修改明细

### 3.1 模块与前后行为

此前只有管理员建号、登录账号作为主要显示名，没有自助注册及独立头像资料。新增公共规则`apps/server/src/account_rules.rs`、来源/限流/并发设施`account_security.rs`、管理员批次`registration.rs`、匿名注册`registration_auth.rs`、资料`profile.rs`、头像HTTP/CAS持久化`avatars.rs`、实际解码/编码`avatar_image.rs`。`main.rs`接入路由、配置和状态，`rooms.rs`给聊天增加身份/昵称/头像字段，保留username供旧消费者兼容。

新登录账号`[A-Za-z0-9_.-]{1,80}`；昵称trim后最多50个Unicode码点，不是50个UTF-16代码单元，控制字符拒绝。空昵称不保存自定义资料行，显示回退账号。密码8–1024个U+0020–U+007E，空格保留；仅新建应用这些规则，旧登录不因此失效。注册和管理员建号均固定普通用户；首次空库管理员初始化是受配置控制的独立路径。

房间邀请、成员/控制权限、播放API、同步版本、Worker、NAS Agent的业务协议保留。聊天新消息/历史同时包含user_id、username、display_name及头像元数据；授权仍基于UUID/角色。刷新历史读取当前昵称，已显示在另一客户端中的旧历史不全站主动广播刷新。

### 3.2 API契约

统一前缀`/api/v1`，下表省略此前缀。所有已登录写接口沿用Cookie、Origin、CSRF；匿名注册接口允许无会话但要求配置Origin及JSON。错误格式沿用`{error:{code,message,retryable,request_id,retry_after_ms?}}`，必要错误按源正常导出到协议/TypeScript，`export --check`通过。详情见[账号API](ACCOUNT_REGISTRATION_API.md)和[头像API](AVATAR_API.md)。

| 方法/路径 | 权限与主要输入 | 成功结果 | 错误与重试 |
|---|---|---|---|
| POST `/admin/registration-invites` | admin；batch_id UUID，count默认1/最多50，valid_days默认7/可1或30，note≤60码点 | 201 batch_id及每条id/code/尾号/到期；仅首次响应原码 | 同ID同参数409 ALREADY_CREATED；不同参数/创建者BATCH_CONFLICT；未知先按batch_id查询，不换ID自动创建 |
| GET `/admin/registration-invites` | admin；status、UUID cursor、limit1–100默认25、可batch_id | items/next_cursor/server_time，无原码/摘要；使用者id+账号+昵称 | 认证/角色错误；只对读取重试；不捏造总条数 |
| DELETE `/admin/registration-invites/{id}` | admin；目标UUID | 当前元数据；重复撤销幂等 | 已使用409 REGISTRATION_INVITE_ALREADY_USED；过期不能新撤销；未知重新读状态 |
| POST `/auth/registration-invites/validate` | 匿名；code | 尾号、expires_at、server_time；不消费、不建会话 | 不存在/过期/撤销/已用统一REGISTRATION_INVITE_INVALID；429按retry_after_ms等待 |
| POST `/auth/register` | 匿名；code/username/password/display_name?，字段白名单 | 201普通身份、csrf、头像空元数据、HttpOnly/SameSite=Strict Cookie | USERNAME_TAKEN不消费；ALREADY_AUTHENTICATED不换身份；未知先auth/me，再用所填凭据正常登录，不自动重发 |
| POST `/users` | admin；username/password/display_name? | id，普通用户 | 同一新建规则/用户名冲突/来源与哈希并发边界；不接收提权字段 |
| POST `/auth/login` | 原契约username/password及Origin | csrf/Cookie，支持原凭据 | 保持旧登录语义，不以昵称登录 |
| GET `/auth/me` | 有效Cookie | 原id/username/admin/csrf，加display_name/custom_display_name/avatar_url/avatar_version | no-store；身份epoch隔离迟到响应 |
| GET `/users/me/profile` | 本人Cookie | id、只读账号、自定义/有效昵称、头像元数据 | 认证错误；no-store，未知写入后用于确认 |
| PATCH `/users/me/profile` | 本人；仅display_name字符串，空串恢复默认 | 当前资料 | 额外username/admin/user_id/avatar字段拒绝；不改会话/房间/头像 |
| PUT `/users/me/avatar` | 本人；image/png≤2MiB，x-avatar-operation-id UUID，If-Match带引号版本或`"none"` | 200 avatar_url/avatar_version；operation UUID成为版本 | 400坏图/操作头，413超限，415类型，409版本/操作冲突，429，503编码失败/504超时；先读profile确认，再以原UUID/内容/版本显式重试 |
| DELETE `/users/me/avatar` | 本人；同操作/版本头，无正文 | URL=null、新墓碑版本 | 同PUT条件语义；恢复默认后不能重新用none覆盖 |
| GET `/users/{id}/avatar?v=UUID` | 已登录读取当前指定版本 | image/webp，private/no-cache/nosniff，ETag/304 | 先认证，匿名401；旧版本/无头像404，不公开原图 |

表中批次简写对应完整稳定码`REGISTRATION_BATCH_ALREADY_CREATED`、`REGISTRATION_BATCH_CONFLICT`。非法值通常400，Serde字段/类型拒绝通常422，均标准化错误；匿名码错误不泄露管理状态。时间统一Unix毫秒，列表状态优先used > revoked > expired > unused，由数据库时钟决定。

注册没有匿名幂等重放接口，恢复策略是确认登录结果。批次UUID绑定创建者和归一化参数，原码不可重建；元数据确认成功但原响应丢失后，撤销未用条目再明确创建新批次。头像已成功同操作重放返回当前元数据，避免把旧结果重新显示。

### 3.3 数据与并发

`migrations/0020_registration_accounts.sql`为纯增量：

- `user_profiles`：user_id主键/外键，一用户最多一条；display_name非空且1–50数据库字符，不能全空白。可重名。
- `registration_invite_batches`：UUID主键，created_by外键，count1–50、valid_days枚举、note≤60；创建时间/ID倒序索引用于分页。
- `registration_invites`：UUID主键、batch外键、唯一64位十六进制摘要、四位尾号、有效期；使用者/使用时间及撤销者/撤销时间必须成对，不能同时使用与撤销。索引为batch/id及未消费/未撤销有效期。
- `account_rate_limits`：scope/key_hash复合主键、窗口、expires_at、正数次数及清理索引。到期清理；最多10000活动键，满时保守拒绝新键。

20字节随机熵编码为32位Base32并加RS分组前缀，服务接受小写/空白/连字符，只保存独立registration域SHA-256及尾号。批量生成全部成功或回滚。注册先做字段/来源/码粗检，有界Argon2期间不持事务，随后锁码行并以`clock_timestamp()`重查有效性，账号、资料、消费和会话一次提交。撤销争同一锁；任一写失败无半成品。

`0021_user_avatars.sql`新增`user_avatars`和`avatar_operations`。前者每用户当前WebP bytea，1–262144字节及content/content_type成对约束；删除把内容置空但保留版本。后者(user_id,operation_id)主键，保留动作、预期版本、请求摘要和时间，不保存历史图片。处理前检查版本，处理后锁稳定users父行，再检查CAS和操作绑定并原子写入；初始无头像行也有可锁的稳定对象。迟到上传不能覆盖新版本或在删除后复活。

历史迁移未编辑，users/sessions原列形状不变。操作元数据不自动裁剪，防止旧UUID复用/版本回绕；增长边界列入第9节。数据库MVCC/备份中的历史字节按原vacuum/备份策略管理，不承诺物理擦除旧备份。

### 3.4 请求与图像资源边界

Origin/CSRF沿用既有约束。匿名来源默认取TCP peer；只有peer匹配显式`TRUSTED_PROXY_CIDRS`才从右向左剥离可信转发链，无效/过长链退回peer。默认空名单，任意客户端X-Forwarded-For不能改变限流身份。来源摘要窗口持久化，注册10次/10分钟、validate30次/分钟；Argon2默认并发2，满时429、零排队，HTTP取消不会提前释放仍在计算的许可。

头像写入账号级默认10次/分钟；正文在读取前检查身份/来源/头/类型，最多2MiB。PNG签名、块边界、512×512 IHDR、IEND和APNG标记先检查，仅保留像素/色彩所需及有界普通文本。FFmpeg固定PNG解码到恰好512×512×4 RGBA，再由libwebp编码单帧WebP：质量82，超256KiB时在同一总期限内尝试60/40；最终再查真实尺寸、RIFF、单帧与体积，去除非必要元数据并保留alpha。后端不拉伸、不保留原图、不走媒体转码队列。

进程使用固定参数数组和内存管道，无用户shell/URL/路径；并发2、总期限5000ms、线程/stdout有界，FFmpeg单次分配限制16MiB（不是总进程内存承诺）。禁用继承FFREPORT输出；处理取消/超时通过既有process-tree owner kill/reap，进程回收之后才释放许可。真实PID测试确认处理期限内回收，不声称每种HTTP断开都立即被框架感知。

## 4. 前端修改明细

### 4.1 单入口、页面与职责

最终`apps/web/src/main.ts`直接启动`app/bootstrap.ts`，history根路径`/`。开发阶段先在`/preview`验证，完成联合验收后切换；交付不保留双入口。删除旧669行`App.vue`、740行`style.css`及19行过渡`api.ts`，由以下结构承接。`packages/sync-engine`与`packages/player-core`相对基线完全未改，protocol仅正常生成的错误增量。

| 路由 | 页面/行为 |
|---|---|
| `/login` | 登录、密码可见切换、旧凭据兼容、错误和恢复 |
| `/register` | 邀请码校验→设置固定账号/昵称/密码及确认，两步焦点、限流、未知结果确认 |
| `/rooms` | 放映室列表、创建、独立房间邀请JSON或字段加入 |
| `/rooms/:id` | 观影入口、连接状态、聊天、待播、邀请生成/复制/撤销、控制权限 |
| `/library` | 服务端搜索/游标分页、选片/加入待播、加载/空态/重试 |
| `/account/profile` | 只读账号、独立昵称保存、头像选择/裁剪/更换/默认 |
| `/admin/sources` | 本地/HTTP/Jellyfin/Emby按实际字段新增、按行检测扫描 |
| `/admin/agents` | 最后联系、预计配对有效时间、创建/复制/撤销NAS设备 |
| `/admin/registration-invites` | 首次批次结果、复制/关闭提醒、历史筛选/游标/撤销、未知结果恢复 |
| `/admin/users` | 普通账号手动创建、可选昵称、统一新建规则 |

`shared/api/client.ts`与`types.ts`集中同源Cookie/CSRF、结构化错误、JSON/二进制、响应类型与身份epoch。`features/auth/session.store.ts`拥有认证恢复/用户和资料修订；只有当前身份的401能使会话失效，迟到解析不能污染新身份。同用户资料刷新不更换身份，不触发播放器重建。路由守卫保护登录/管理页，真实后端继续强制权限。

`room-runtime.ts`拥有WS、连接/房间序号、时钟采样/重连/状态timer、控制epoch、聊天确认/去重、队列和播放标题缓存；`playback-runtime.ts`拥有video/HLS、加载序号、PlaybackPlan、生成等待取消、纠偏/续期和媒体事件。页面负责展示与显式动作，不独立建立另一套运行时。

### 4.2 播放生命周期及原有能力

AppShell的唯一PlaybackHost位于RouterView和页面Transition之外，CSS切换全幅/底部迷你；不Teleport、不换key、不移动DOM父节点。同房enter幂等；普通路由切换保持连接/播放会话，明确换房/身份变化/权限失效才清理。共享播放、跳转、倍速使用房间命令；音量、静音、字幕和全屏仅本机。

保留原clock_epoch/revision/media_generation/control_epoch、同步纠偏、播放取消编号/幂等key、65秒单次/335秒总准备/180秒就绪等待、HLS失效入口恢复/生成区间等待/seek重建、音轨快速切换、按index字幕、500ms纠偏和10分钟续期。未因新视觉发明新播放协议。真实视频验证导航后进度推进且实例计数不变，具体第5节。

页面卸载和路由序号阻止迟到查房在后台进入；聊天10秒无ACK转为“不确定”并允许同client_message_id显式重试，不自动重复发。退出/断连/ACK清理timer。媒体库请求25项显示24项，用额外一项判断下一页；250ms搜索防抖/回车立即查，查询序号及AbortController防旧结果覆盖，进入片库时保留页码/查询刷新，当前播放标题按media_id独立缓存。

### 4.3 账号、裁剪与管理员交互

注册的code/password只在组件内存，不放URL或持久化存储；成功进入房间列表，失效码回第一步，账号占用保留其他草稿并聚焦，未知请求先确认身份。昵称与头像各有保存状态；字段级合并和本地修订防止互相覆盖。

自主裁剪使用`features/account/avatar/{image-input.ts,crop-model.ts,AvatarCropDialog.vue}`。源图≤10MiB、≤4000万像素、单边≤16384，签名/尺寸及动画检查后用ImageBitmap真实解码，`from-image`处理方向并二次检查尺寸。取景正方形边长min(W,H)/zoom、zoom1–8，中心夹紧；平移按原像素换算，缩放保持指针锚点，支持鼠标/单指/双指/方向键/Shift/滑块/重置。Canvas从正方形source rect绘制到512×512，PNG中间图≤2MiB，无圆形擦除或填背景，透明度保留。原图不上传，bitmap关闭/换图释放。未发请求的取消零写入；已发未知请求需要确认结果，不能伪称关闭弹窗撤回了服务端写入。

片源按接口能力实现，不提供不存在的编辑删除或虚构扫描进度；HTTP headers要求字符串值JSON对象。NAS `last_seen`仅称最后联系，不冒充在线；接口不返回精确到期，10分钟倒计时明确为预计，以服务端为准。管理员原码复制等待clipboard确认，失败选中文本；未复制关闭会提醒，明确关闭不自动撤销。批次未知保存同UUID及数量/天数/备注到按管理员区分的tab sessionStorage，确保刷新后仍可同参数重试，从不存原码。此处比设计“仅保留ID”多保存非凭据参数，是解决服务端参数绑定的必要调整，已记录在[管理区文档](ADMIN_FRONTEND.md)。

### 4.4 视觉、响应与可访问性

`styles/tokens.css`集中主色#E5D1C1、辅色#9E7867及语义颜色；本次仅light，保留未来主题结构，不实现深色。品牌只有RainSync文字，其余图标统一Tabler。播放器/控制栏/迷你均米色。媒体库、待播、迷你横图16:9，头像1:1存储/裁剪，UI可圆形；无封面时使用明确占位，无随机海报或虚构信息。

`layout.css`覆盖360/390/768/1024/1440/1920宽度、手机底部导航/管理次导航、安全区和迷你预留；visualViewport收缩时隐藏会遮挡输入的迷你画面/底栏，仍保留video，弹窗最大高度随可视区域变化。AppDialog用原生模态dialog、Tab首尾循环、Esc及返回触发按钮焦点；跳到内容链接可用。`motion.css`支持reduced-motion，动画不延迟播放命令。

测得次级文字在深米色背景原对比4.258，改#65493D后4.763；控件边框#866250在相关表面均>3，正文/次级/按钮/错误文字相关组合≥4.5。不是宣称全站WCAG认证。上述尺寸、焦点、视觉视口和触点是Chromium测试，实际手机键盘与Safari见未验证项。

## 5. 验证证据

### 5.1 环境、代码状态与输出隔离

Windows PowerShell；Rust/Cargo 1.98.1、Node24.19.0、npm11.17.0、Docker29.8.0、PostgreSQL17测试容器/18.6客户端、FFmpeg/ffprobe及libwebp、Chromium桌面与Pixel7配置。没有用户私人媒体；图像和180秒H264/AAC素材现场合成。Playwright模拟配置不等于设备硬件。

所有检查先执行：

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28'
```

脚本设置RAINSYNC_ARTIFACT_DIR、CARGO_TARGET_DIR、npm缓存、PLAYWRIGHT_BROWSERS_PATH、TEMP/TMP；Vite/Vitest/Playwright和集成脚本使用此外部根。`node_modules`为指向ARTIFACT/node_modules的junction，workspace链接仍指向本项目；npm ci可能替换junction，安装后必须重新检查。单个检查由`node scripts/run-check.mjs NAME TIMEOUT_SECONDS COMMAND ARGS...`有界运行并保存退出码。Windows npm.cmd不能直接用于该shell:false包装，可用`node --run`或npm-cli.js。

后端门槛针对`11fe2cb6…`产品代码及随后`c6a2712…`验收设施执行；前端写入从`52e816c…`开始，顺序由Git历史证明。最终总验收期间HEAD仍是`c06ae03…`，根入口切换和最后修复在工作树完成；同一批产品变更随后提交为`2f24be5…`。后端代码在这些前端末次修复期间没有改变；最后片库刷新修复之后完整重跑浏览器、类型、单元、构建和真实视频。因此最终evidence.json的head记录c06ae03，不应伪改为测试时尚不存在的2f24be5。收尾提交仅补文档、CI的FFmpeg/真实浏览器步骤及已经执行的package测试脚本入口，没有再改产品代码。

### 5.2 最终实际命令及结果

以下均退出0、timedOut=false；完整开始/结束时间和原参数在manifest及对应JSON。表中时间为**2026-09-27 UTC完成时间**，上海时间为**2026-09-28加8小时**。

| 日志NAME | 实际命令（包装内部） | 完成UTC | 结果 |
|---|---|---|---|
| final-rust | `cargo test --workspace --locked` | 21:13:07.102 | 56通过，2个原有受上层监督测试启动的子进程fixture ignored，0失败 |
| final-fmt | `cargo fmt --all --check` | 21:13:07.637 | 通过 |
| final-clippy | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 21:13:08.546 | 通过 |
| final-protocol | `cargo run -p protocol --example export -- --check` | 21:13:09.949 | 生成一致 |
| final-accounts | `node --run test:accounts` | 21:13:41.041 | 四套真实Server/Postgres规则、邀请、注册、头像测试通过 |
| final-original-integration | `node tests/integration.mjs` | 21:15:10.151 | 原Server/Worker/NAS全套真实集成通过 |
| d-switch-browser-final | `node node_modules/@playwright/test/cli.js test --workers=2` | 21:18:03.722 | 86浏览器案例通过 |
| final-types | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json` | 21:19:13.989 | 通过 |
| final-unit | `node node_modules/vitest/vitest.mjs run` | 21:19:14.881 | 8文件/44测试通过 |
| final-build | `node node_modules/vite/bin/vite.js build apps/web` | 21:19:21.522 | 生产构建通过，保留chunk警告 |
| final-real-browser | `node --run test:browser-real` | 21:19:39.503 | 根入口、两个真实用户、Server/Worker/Postgres、实际视频全链路通过 |

Rust各crate/目标合计56，不把两个ignored fixture计为额外通过。浏览器86=原播放/恢复38+账户10+管理16+新应用14+布局8。原app.spec/recovery.spec的19例在桌面/移动各跑一次，全部保留业务断言；没有删测试来制造通过。

构建JS804.99kB（gzip262.77kB）、CSS25.97kB（gzip5.92kB）。HLS相关>500kB单块提示仍在，未抬高阈值掩盖。外部outDir不会自动清空的提示也保留；产物目录并非运行时发布目录。

### 5.3 真实后端、迁移与回退证据

四套账号测试各创建独立随机名PostgreSQL/随机凭据/随机端口，实际启动Server。并发和失败注入包括数据库锁、触发器、真实HTTP、WebSocket及专用编码故障子进程；单测/mock不能替代这些证据。`final-accounts`重复全部四套，最终通过。

| 独立检查 | 实际命令 | 完成UTC 2026-09-27 | 证明范围 |
|---|---|---|---|
| backend-rollback-data | `node tests/compatibility-rollback.mjs` | 19:48:32.581 | 基线业务+保留迁移回退、再前进、pg_dump/pg_restore后账号/会话/资料/头像/批次保留 |
| backend-compatibility-watch | `node tests/integration.mjs`，CARGO_TARGET_DIR指向兼容构建 | 19:51:36.207 | 旧Server/Worker业务在保留新迁移数据库上完整观看集成 |
| backend-migration-upgrade | `node tests/migration-upgrade.mjs` | 19:53:53.015 | 完全未改0019二进制创建数据后，新应用升级20/21且旧凭据/会话/邀请有效 |
| backend-registration-final | `node tests/registration.mjs` | 19:56:12.266 | 真锁等待跨过有效期、竞争/事务/权限/来源边界 |
| backend-avatar-chat | `node tests/avatar-upload.mjs` | 19:51:03.528 | 真解码/编码、版本、alpha、进程回收、聊天身份与持久性 |

兼容构建来自外部git archive，并未reset/revert交付分支。定位文件ARTIFACT/compatibility/latest.json。原集成包括缓存/租约/队列、控制幂等、HTTP Range/HEAD、媒体/字幕/音轨、NAS配对/10001条分页索引、撤销/续传及进程/备份恢复。Jellyfin/Emby使用受控上游契约fixture，不能称真实外部产品部署测试；本地100连接冒烟也不能推出生产负载能力。

### 5.4 真实浏览器与视频结果

最终独立证据：`ARTIFACT/browser-real/f9ecebb8-3b8a-4db0-9e2e-c561e7f268ab/evidence.json`；对应`logs/final-real-browser.{json,log}`。`tests/browser-real.mjs`没有HTTP/WS拦截，没有替换HTMLMediaElement方法；两个隔离Cookie上下文、实际Server/Worker、真实解码并推进的180秒视频。

- 实际扫描两部文件；管理员生成2码，一个码完成校验/普通注册/自动登录且只消费一次，不自动加房间。
- 宽图左右/长图上下四次真实保存均512×512 WebP，分别552/554字节；中心像素分别为红/蓝，证明取景不同。昵称草稿与头像分别保存，固定登录账号和带空格密码仍登录成功。
- 创建/房间邀请加入、待播添加/删除、管理员播放/暂停/跳转、观众同步且无控制权限、昵称聊天均成功。
- 观影→媒体库→片源→NAS→账号与注册→资料→原房间，video对象相同；观察到20.570→20.965→21.376→21.790→22.205秒连续推进。该管理员浏览器WS1→1、播放POST1→1；数据库两位用户合计playback_sessions2→2。该次两用户偏差约0.002704秒，仅为受控本机观察，不作固定延迟或漂移保证。
- 普通用户管理路由被拒绝且真实管理API403；手动建号只能普通用户，真实NAS创建/撤销通过。
- Server重启后同Cookie、账号/昵称、头像版本/像素和邀请码消费保持。故意重启引发的ECONNRESET/ECONNREFUSED代理日志保留，是预期断连观察。

直接真实视频本次为H264/AAC progressive。HLS恢复/生成等待/媒体错误由受控浏览器和真实Worker集成覆盖；模拟native HLS不等于真实Safari。更多细节见[真实浏览器验收](REAL_BROWSER_VALIDATION.md)。

### 5.5 失败、修复及非通过范围

失败日志仍保留，不把最初失败隐去；每次修复后重跑相关完整范围。主要记录：

| 发现 | 处置与最后证据 |
|---|---|
| 初始Docker未启动、Docker Hub OAuth EOF | 启动已有Docker Desktop，有界pull重试后基线完整集成通过；未改镜像源/代理 |
| 外移Vite缓存后2个HLS mock固定路径不匹配 | 修复依赖路径拦截匹配，38例重新通过；属于验证设施迁移问题 |
| 后端合成旧密码helper盐值生命周期编译错、跨期限测试未准确持锁 | 修复helper；在持锁事务内设置期限后释放，真正证明锁后复查；b3-binaries-fixed及backend-registration-final通过 |
| C2提取后快速切音轨列表过早清空 | 只在真正离房清空，原快速二次切轨断言捕获后38例重跑通过 |
| 冷启动依赖/表单label/步骤焦点/隐藏文件input撑宽 | optimizeDeps、明确label/for、就绪聚焦、sr-only尺寸优先级修复；保留真实触点/像素/宽度检查 |
| 次级文字对比4.258、弹窗Tab进入浏览器chrome | 改文字/边框色及首尾焦点循环；c7-browser-final80及最终86通过 |
| 迟到房间查询在已离开页面后台进房 | d-runtime-edge-red复现；卸载和序号联合隔离，最终浏览器通过 |
| 聊天无ACK一直busy | 10秒转未知，显式同ID重试并清理timer；没有自动重复发送 |
| 扫描后返回片库仍显示缓存空态 | d-library-refresh-red复现；进入时保留查询/页码重新读取，最终真实联调重跑通过 |
| 切换UI后的原测试定位/过渡竞争 | combobox实际名称、h1级别、移动tab等待、错误流定位、native HLS先等src、搜索回车及页码等待；完整86通过，不删权限/幂等/恢复断言 |

未发现必须在准备阶段修改业务代码的原有失败。保留的原有chunk提示、未验证真实设备/网络/长期边界见第9节；没有将其写成已通过。远程CI配置已更新，但因未推送没有实际运行结果。

收尾文档检查`final-report-audit-verified`于2026-09-27T21:37:00.566Z退出0：九节结构、14个实际提交及标题、45个本地文档链接、36份记录/日志哈希与原始命令/时间、最终真实证据及计数均匹配，产品目录相对2f24be5无漂移。首次清单生成时PowerShell日期序列化省略了毫秒尾零（.910→.91），严格原文比较捕获后已改为保留源JSON时间字符串；进度文件多余EOF空行也已修复，`git diff --check`通过。原失败日志保留，此修复不改变任何测试结果。

## 6. 依赖、配置与实现来源

| 变更 | 原因及范围 |
|---|---|
| 新`vue-router@4.6.4`、`@tabler/icons-vue@3.48.0` | 精确锁定路由/统一图标，Vue3/TypeScript/Pinia/hls.js沿用；对应package-lock更新 |
| Rust新增直接`ipnet = "2"` | 可信代理CIDR解析；锁文件已有2.12.2，没有引入另一个版本 |
| 其他依赖 | 未升级既有顶层运行/测试依赖主版本；prettier原已存在，无外部裁剪库、图床、UI框架或动画框架 |
| 新测试入口 | `test:accounts`四套真实接口；`test:browser-real`实际浏览器/服务；CI显式安装FFmpeg并运行，未执行远程CI |
| 兼容性配置 | 测试二进制定位支持外部CARGO_TARGET_DIR，Vite代理可用RAINSYNC_SERVER_PROXY_URL/RAINSYNC_WORKER_PROXY_URL指定随机测试端口，默认8080/8081不变 |

新增生产配置默认：

| 名称 | 默认/允许范围 |
|---|---|
| REGISTRATION_VALIDATE_PER_MINUTE | 30，1–10000 |
| REGISTRATION_PER_TEN_MINUTES | 10，1–10000 |
| ACCOUNT_HASH_CONCURRENCY | 2，1–32，满即拒绝 |
| TRUSTED_PROXY_CIDRS | 空，只信socket peer；逗号分隔明确可信IP/CIDR |
| AVATAR_PROCESS_CONCURRENCY | 2，1–8 |
| AVATAR_PROCESS_TIMEOUT_MS | 5000，100–30000 |
| AVATAR_WRITES_PER_MINUTE | 10 |
| AVATAR_FFMPEG_BIN | 未设置时PATH的ffmpeg；可选可信本地路径 |

`.env.example`和Compose同步新配置。需要PostgreSQL、支持PNG解码/libwebp编码的FFmpeg；沿用现有容器媒体设施，没有新增图床/卷或改变Worker转码架构。PUBLIC_ORIGIN须匹配页面Origin；反代CIDR为空时同代理用户共享保守来源窗口，生产运维应按实际受控代理配置。

裁剪的数学、文件检测、拖动/双指/键盘交互、Canvas导出和上传状态均在本项目独立编写。参考项目仅用于理解交互思路，未复制/移植Cropper.js、Vue Advanced Cropper、Uppy源码、组件、主题或素材。基础Vue与浏览器标准API继续使用；此处说明实际实现来源，不作未审计的法律保证。新增Tabler图标由明确依赖提供，不冒充自绘资产。

## 7. Git提交清单与最终范围

全部实现按下表顺序依赖；阶段标题是实际Git提交标题。Git作者未配置，提交使用命令级`-c user.name=Codex -c user.email=codex@localhost`，未修改全局配置或冒用用户身份。

| 完整SHA | 实际标题 | 目的及验证范围 |
|---|---|---|
| `891b7bd86573502443849ca2036145ccd602c47d` | test: establish isolated validation baseline and approved rollout plan | 基线、外部输出、要求/计划归档；50 Rust、31单测、38浏览器、原完整集成 |
| `48ad16a48236121ea946e712fa0205036b80b41f` | feat(server): add account rules and additive registration schema | B1规则/0020；新建边界真实红→绿、构建/Rust/协议/clippy |
| `e62bc32c882086aab7cbc87c3b684af9665f6e32` | feat(server): manage one-time registration invitation batches | B2批次/状态/权限/响应丢失；真实邀请码及Rust/协议/clippy |
| `a99e247eec6a1cdbba5bc3d7fd2ec82b68f341ab` | feat(server): support atomic invited registration and editable profiles | B3匿名注册/事务/昵称/安全/聊天；并发/兼容/真实原集成 |
| `11fe2cb6da2915adf1fe26b1c898544dd1e54b78` | feat(server): store versioned avatars with bounded image processing | B4头像/0021/真实编码/并发/进程；56 Rust及真实头像 |
| `c6a27127f445cdc079f98ed2440a23154ecdf150` | test(server): accept account backend and verify migration-safe rollback | **后端完成门槛**；真实四套/原集成/迁移/兼容回退/备份，旧前端仍完整 |
| `52e816ca55b626db55a44f114870b2ead62cb033` | refactor(web): isolate typed requests and identity-safe session state | C1 typed API/身份epoch；35单测、38浏览器/类型 |
| `d5e25f41fd5d003e3b90fd9ce93eecf0aeb9d2ff` | refactor(web): extract persistent room and playback runtimes | C2运行时；36单测、38原回归及类型 |
| `b114345809910b50041a6bb8c84f83a87118b032` | feat(web): add beige routed shell with persistent viewing and library | C3/C4外壳/房间/片库/常驻播放器；46浏览器/36单测/构建 |
| `8c3494b1f36a8662b949665928c94ce6069070f3` | feat(web): implement invited signup and independent profile avatar cropping | C5账号/独立裁剪；44单测、56浏览器/类型/构建 |
| `1baaccb56691d9fd0e4777b58a99e878a61e4846` | feat(web): complete administration and recover invitation batches safely | C6管理区/批次恢复；72浏览器/44单测/类型/构建 |
| `e0a2704c650526e9199ae08f23797b73ba9042d3` | fix(web): verify responsive pages and improve contrast and dialog focus | C7六宽度/对比/焦点/动效；80浏览器/类型/构建 |
| `c06ae0394323517851b64ae5f66558f332c8925e` | test: validate new UI with real accounts avatars and synchronized video | D1/D2；删除旧UI前真实注册/头像/多用户视频/重启全链路 |
| `2f24be569b105fcbba3a3ef26d2457e9c2292f37` | feat(web): switch to complete routed UI and retire legacy views | **前端完成/原子切换**；修复迟到房间/无ACK/片库刷新，根入口86例及第5节全部最终验收 |
| 本报告提交，SHA由最终回复补充 | docs: record complete implementation validation and rollback | 最终报告/专项验收/36节点哈希清单/进度、README/头像文档、CI与已验证测试入口；文档链接、哈希、范围、Git检查 |

最终范围核对：正式变更全部本地提交；保护并保留如下原有工作区删除，它们不属于本任务，也未被暂存/提交/恢复：

```text
 D oil-pumpjack.html
 D pelican-bike.svg
 D pumpjack.html
```

不会为追求空git status而修改这些用户工作。交付前以明确路径暂存，检查提交退出码、HEAD、提交内容及status；报告自身SHA在最终回复给出。没有reset --hard、force-push、推送、PR或部署。所有代码/迁移/生成物/测试及文档提交都在当前分支，临时证据不进入Git。

## 8. 启动、升级与回滚

### 8.1 安装与首次使用

完整运维入口见[BACKEND_OPERATIONS.md](BACKEND_OPERATIONS.md)及既有[OPERATIONS.md](OPERATIONS.md)。本报告提供维护命令，不表示本次已执行生产部署。

已有源码检出目录，安装Docker Compose与Node24后：

```powershell
node scripts/setup.mjs
docker compose up --build -d
```

setup不覆盖既有配置；首次凭据只保存在本地`.runtime/login.txt`/`.env`，不要提交。默认浏览器`http://localhost:8088`；影片放media/，管理员新增本地片源`/media`后检测扫描。管理员在账号与注册生成一次性注册码，用户注册普通账号后进入房间列表，再用独立房间邀请加入。登录后的个人资料分别保存昵称及裁剪头像。

生产配置名称包括POSTGRES_PASSWORD、ADMIN_PASSWORD、SOURCE_ENCRYPTION_KEY、MEDIA_PATH、PUBLIC_ORIGIN、SITE_ADDRESS、HTTP_PORT/HTTPS_PORT，及第6节新增变量；必须用自己的随机值，不使用示例占位值。PUBLIC_ORIGIN精确匹配浏览器协议/主机/端口，公网TLS和媒体挂载沿用既有文档。初始管理员用户名由ADMIN_USERNAME控制；已有账号不会因环境变量变化被重置。

源码开发需安装Rust、Node24、PostgreSQL及FFmpeg/ffprobe，执行`npm ci`、`cargo build --workspace --bins --examples --locked`、`npm run dev`。直接Server/Worker还需DATABASE_URL、SOURCE_ENCRYPTION_KEY、PUBLIC_ORIGIN、ADMIN_PASSWORD、MEDIA_ROOT、CACHE_ROOT、WORKER_URL等既有运行环境。验证先加载validation-env；不要为测试传入生产DATABASE_URL，fixture只使用自己的容器。真实浏览器复核命令为`node scripts/run-check.mjs verify-real 360 node --run test:browser-real`。

### 8.2 增量升级

1. 备份整个数据库及SQLx历史，匹配保管SOURCE_ENCRYPTION_KEY、媒体/Agent状态/配置、当前应用版本；先在恢复副本演练。
2. 停止旧应用写入，启动新Server时SQLx自动按序0019→0020→0021；历史迁移和checksum不能改。Worker/NAS业务协议本轮不变。
3. 检查`_sqlx_migrations`最新21且成功；检查旧凭据/现有Cookie/房间邀请/观看。
4. 检查注册仅普通用户且不加房间、资料/头像分别保存、重启持久性；批次未知按同UUID查询，丢失原码按元数据撤销再明确创建。
5. 运行恢复副本上的必要验证再由维护者决定上线；本任务没有代替生产演练或执行部署。

### 8.3 应用回退顺序

回退保留当前数据，使用新的revert提交。先保留交付版本的只读验证检出/外部测试设施，在独立维护分支处理，不将用户的三个删除或其他未提交工作带入回退。以下是**未来维护流程**，本任务没有在交付分支执行revert。最终报告/验证记录可保留，不必为回退应用而删除它们；有冲突应逐项解决，不直接照抄为“一键回滚”。

只回退前端到后端完成节点：依次撤销以下8个提交，后端/数据库保持新版本：

```powershell
git revert --no-commit 2f24be569b105fcbba3a3ef26d2457e9c2292f37
git revert --no-commit c06ae0394323517851b64ae5f66558f332c8925e
git revert --no-commit e0a2704c650526e9199ae08f23797b73ba9042d3
git revert --no-commit 1baaccb56691d9fd0e4777b58a99e878a61e4846
git revert --no-commit 8c3494b1f36a8662b949665928c94ce6069070f3
git revert --no-commit b114345809910b50041a6bb8c84f83a87118b032
git revert --no-commit d5e25f41fd5d003e3b90fd9ce93eecf0aeb9d2ff
git revert --no-commit 52e816ca55b626db55a44f114870b2ead62cb033
```

每步检查退出码及冲突，失败立即停止；不要无检查批量执行。该候选应恢复原默认UI，校验旧38浏览器、类型/构建、后端现有接口再形成回退提交。旧前端与新增后端的兼容性已在B5检查，但每个实际未来revert候选仍需复核。

如还要回退到基线业务代码，接着按以下明确顺序撤销后端阶段：

```powershell
git revert --no-commit c6a27127f445cdc079f98ed2440a23154ecdf150
git revert --no-commit 11fe2cb6da2915adf1fe26b1c898544dd1e54b78
git revert --no-commit a99e247eec6a1cdbba5bc3d7fd2ec82b68f341ab
git revert --no-commit e62bc32c882086aab7cbc87c3b684af9665f6e32
git revert --no-commit 48ad16a48236121ea946e712fa0205036b80b41f
# 保留完全相同的增量迁移，不能将缺少它们的旧SQLx二进制直接上线。
git restore --source 11fe2cb6da2915adf1fe26b1c898544dd1e54b78 -- migrations/0020_registration_accounts.sql migrations/0021_user_avatars.sql
git add migrations/0020_registration_accounts.sql migrations/0021_user_avatars.sql
```

准备提交891b7bd包含验证隔离设施，可保留；它不是产品业务变更。收尾提交中的CI/package入口应与回退后的可用测试文件核对（如test:browser-real已被撤销则不能保留失效调用）。从交付版本保留测试设施，因为撤销c6a2712会删除兼容测试本身。审查暂存范围，构建候选并用保留的外部工具验证后，才提交并部署回退候选；没有未经验证的自动冲突解决承诺。

已经实测的兼容目标是**基线业务代码+完全相同0020/0021迁移**：旧业务可以登录新账号/已有会话并观看，新资料/头像/邀请码数据保留但旧界面不显示其新接口。任意缺少迁移文件的旧SQLx二进制不等于此目标。前后端版本必须匹配；继续升级时部署完整新版本即可读取保留的资料。

独立演练入口（在交付检出执行，不改正式分支）：

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28'
./scripts/prepare-compatibility.ps1 -ArtifactRoot $env:RAINSYNC_ARTIFACT_DIR
./scripts/prepare-legacy-baseline.ps1 -ArtifactRoot $env:RAINSYNC_ARTIFACT_DIR
node scripts/run-check.mjs rollback-data 300 node tests/compatibility-rollback.mjs
node scripts/run-check.mjs migration-upgrade 300 node tests/migration-upgrade.mjs
```

各命令分别检查退出码；兼容观看测试按BACKEND_OPERATIONS所示临时指向manifest中的CARGO_TARGET_DIR并在finally恢复。以上演练验证业务/数据兼容，不意味着已在用户部署执行revert。

### 8.4 数据恢复与迁移历史

不提供删除0020/0021的down migration，不清空新注册用户、会话、昵称、当前头像、墓碑、操作记录、消费或批次历史。否则邀请码单次使用和迟到上传保护都会受损。代码回退不应改变数据库当前数据。

完整备份须包括所有新增表、SQLx历史，并与SOURCE_ENCRYPTION_KEY配套。已实测隔离库`pg_dump -Fc`→另一数据库`pg_restore`→Server核对Cookie/昵称/头像字节版本/批次，再升级仍一致。生产备份恢复由维护者对自己的数据演练；恢复到旧时间点会丢失之后写入，需要独立评估恢复点，与保留现有数据的应用回退不同。

## 9. 剩余事项与风险

本次确认且可实施的功能/必要验收没有未完成项。以下是证据边界和实际运行限制，不作为已通过项目：

- Safari/iOS/Android实机、真实软键盘及真实手机EXIF照片库未测试；当前有Chromium桌面/手机模拟、触点与visualViewport模拟、格式解析/方向处理实现。设备特有解码/键盘行为需在相应硬件确认。
- 没有长期连续播放、持续生产负载或真实弱网测试。本地同步偏差、100连接冒烟不能外推所有网络和部署。
- 真实浏览器联调视频为progressive H264/AAC；HLS异常/恢复为受控浏览器加真实Worker集成，未验证Safari原生HLS设备行为。Jellyfin/Emby为受控上游契约fixture，未连接真实外部产品部署。
- 原有及当前HLS相关单JS块804.99kB构建提示保留，影响冷启动下载/解析成本；没有隐藏警告或承诺已做包体优化。
- 注册码原文只有创建响应，已确认成功但丢失原文无法恢复，这是只存摘要的设计；管理页支持元数据确认、撤销未用条目并重新生成。不能用“重试”恢复已丢原码。
- 头像操作元数据持续保留以维持幂等与墓碑安全，未自动清理；长期高频头像更新会增加元数据行，不能未经另行设计直接按时间删除。
- 当前资料变化不会主动广播刷新另一客户端已显示的全部历史昵称/头像；新消息/重读会取当前资料，权限始终不依赖昵称。
- 远程CI未运行，没有发布镜像、推送/PR、部署或生产数据备份恢复。维护者后续自行推送/部署，按第8节配置Origin、可信代理和凭据，并对生产副本演练。
- 外部日志/缓存/合成证据仍在ARTIFACT供复核，未把它们作为正式源码交付，也未自动删除可能需要保留的本地证据。三项用户原有删除仍在工作区。

后续维护从本报告、[实施计划](IMPLEMENTATION_PLAN.md)、[最终进度](IMPLEMENTATION_PROGRESS.md)及[验证清单](VERIFICATION_MANIFEST.json)继续，不需要重新实施已完成的C/D阶段。
