> 实施状态覆盖：用户已在本次 Goal 明确授权全部实施。历史仅设计或尚未授权记录不再限制实施；执行顺序、产物根和验收门槛以 ../IMPLEMENTATION_PLAN.md 为准。历史图稿留在原设计工作包，不复制为运行证据。

# RainSync 邀请码注册与双名称账号实施计划

日期：2026-09-28。仅规划，所有复选框表示未来工作。
依赖：[账号设计](./ACCOUNT_REGISTRATION_DESIGN.md)、[整体前端设计](./DESIGN.md)、[主重构计划](./PLAN.md)。
追加依赖：[头像设计与计划](./AVATAR_DESIGN_PLAN.md)；头像A1–A4接入R3/R4并在R6联合验收。

## 目标与边界

管理员批量生成一次性注册邀请码，默认 7 天、可选 1/7/30 天；用户通过邀请码设置不可变的唯一登录账号、可改昵称和至少 8 位 ASCII 可打印字符密码，自动登录。前端包含登录入口、两步注册、个人资料和管理页。
个人资料追加静态头像上传/取景/512×512保存。外部裁剪上传项目只参考设计思路，不复制/移植/直接接入其代码或组件；独立实现的文件、后端和测试见头像专项。

本专项是原“只替换前端”之外明确新增的后端范围。允许计划改动 Server 账号/资料/聊天显示接口、增量迁移、错误契约及其生成产物；不更改播放协议、同步算法、媒体 Worker、NAS Agent 或房间邀请规则。不会在本轮执行这些改动。

用户确认：登录账号字符集为 [A-Za-z0-9_.-]、不可修改；密码允许英文字符及空格、不允许中文；昵称可选、可重名、中文/Emoji、最多 50 字符、可修改。具体长度计数与旧账号兼容规则以账号设计为准。

## 与主 Plan 的执行顺序

主计划 Task 1（产物边界/基线）→ 本计划 R1–R3（后端与契约）→ 主计划 Task 2–4（认证/API/运行时/外壳）→ R4–R5（注册/资料/管理页面）；R5 与主 Task 6 管理区共用组件。R6 必须在主 Task 8 默认入口切换前通过，最终证据归入主 Task 9。

每步一个或数个独立本地提交，不把架构迁移、注册接口和视觉切换塞进一个提交。不启动子代理，除非用户另行授权。所有临时脚本、日志、测试产物在 C:/Users/ALIENWARE/Desktop/杂项/RainSync-design-2026-09-28，正式实现文件未来才进入 RainSync 分支；不推送 GitHub。

## R1：建立账号规则、迁移与兼容基线

**计划文件：** 新增 apps/server/src/account_rules.rs；新增 migrations/0020_registration_accounts.sql（当前最高 0019，实施时重新确认编号）；修改 tests/integration.mjs 的产物目录，新增 tests/registration.mjs；必要时 server Cargo.toml 中为编码/限流引入最小依赖并锁定。

- [ ] 重查源码基线、现有未提交工作及 cgraphy 可用性；有工具则替代符号/影响检索，不重复查询。
- [ ] 将 integration.mjs 当前 .runtime/integration 临时目录改为 RAINSYNC_ARTIFACT_DIR 子目录，同时设置 CARGO_TARGET_DIR 到杂项，并让测试脚本按该目录定位 Server/Worker 二进制，不能继续硬编码 target/debug；不在用户现有数据库运行测试。
- [ ] 从独立 PostgreSQL fixture 建立注册测试入口，复用已有隔离容器约束；用户名、Cookie、邀请码和明文密码不得写进可提交日志。
- [ ] 字段校验先写边界测试：登录账号允许字符/长度、密码 7/8/1024/1025 位、中文/换行拒绝、空格不被 trim；昵称中文/Emoji、50/51 码点、重复、默认回退。
- [ ] 增量迁移创建 registration_invite_batches、registration_invites、user_profiles、匿名注册限流窗口记录；不改 users/sessions 列顺序，不改旧迁移。
- [ ] 约束覆盖 code_hash 唯一、批次归属、消费/撤销互斥和使用字段成对；邀请码历史使用者按 user_id 关联。
- [ ] 测试旧用户无 profile 行时回退到 username；已有 Session 和房间成员关系不变化。
- [ ] 提交：feat(server): add registration account rules and additive schema。

## R2：实现管理员邀请码生命周期

**计划文件：** 新增 apps/server/src/registration.rs、crates/persistence/src/registration.rs；修改 server/main.rs 路由与 persistence/lib.rs 导出；新增 tests/registration.mjs 的管理员用例；协议错误码加入 crates/protocol/src/errors.rs。

- [ ] 实现管理员生成、游标列表和撤销；写接口复用 Cookie/CSRF/Origin 检查，普通用户没有绕过。
- [ ] count 1–50，valid_days 只能 1/7/30；note 有界；批次生成在一个事务中完成。
- [ ] 随机邀请码只返回一次，列表只返回末尾和元数据，不返回 hash、原码或可恢复密文。
- [ ] batch_id 与创建者/参数绑定。相同请求已提交返回 REGISTRATION_BATCH_ALREADY_CREATED，前端用已知 batch_id 查询元数据；不同参数/创建者返回冲突，不生成第二批。
- [ ] 撤销与使用共用行锁。撤销重复请求幂等，已用码不被改成撤销状态；列表状态基于服务端时间。
- [ ] 数据库验证批量边界、重复提交、并发撤销、分页筛选和列表脱敏；HTTP 响应 no-store。
- [ ] 提交：feat(server): manage one-time registration invitations。

## R3：实现注册、资料和旧账号兼容

**计划文件：** registration.rs、account_rules.rs、main.rs、rooms.rs；新增 apps/server/src/profile.rs；persistence/registration.rs；crates/protocol/src/errors.rs；正常生成 packages/protocol/index.ts 与 error-response.schema.json；tests/registration.mjs 和 tests/errors.test.ts。

- [ ] 实现匿名邀请码验证与注册；Origin/JSON/body 限制生效，验证不消费，最终提交重新检查。
- [ ] 接入 peer 信息和明确的可信代理配置，测试伪造 X-Forwarded-For 不绕过限流；使用数据库等共享计数，不默认信任任意代理头。
- [ ] 限流发生在 Argon2 前，哈希任务有并发和等待上限；不持事务锁执行哈希。
- [ ] 同一事务写 users、可选 user_profiles、邀请码 used 记录及 sessions；锁定后使用数据库实时钟检查过期；提交后才发送 Cookie。
- [ ] 注册强制 admin=false；已有有效会话不得被 register 换成新身份。账号冲突、资料/会话失败都回滚消费记录。
- [ ] GET /auth/me 扩展 display_name；GET /users/me/profile 区分最终显示与可空的 custom_display_name，PATCH 只接受本人 display_name，拒绝 username/admin/user_id 等额外可写字段。DTO 使用 deny_unknown_fields 或等效白名单。
- [ ] 管理员手动创建和空库初始化使用相同的新账号校验；旧账号登录维持原验证，不给存量账号追加字符或长度门槛。
- [ ] 聊天历史和新 CHAT 消息加入 user_id/display_name，同时保留 username 原含义；新消息查询当前昵称，加载历史用当前资料回退，其他客户端已显示历史不承诺即时改名。
- [ ] 不把 nickname 当权限标识；不为改昵称断开 WS 或轮换会话。
- [ ] 并发数据库用例：两人抢同码至多一人成功；用户名占用不消费；撤销竞态有明确胜者；锁等待跨过有效期必须拒绝；资料/会话写入故障无半成品；密码/账号规则一致。
- [ ] 保留响应丢失后的恢复路径：不实现匿名接口自动重试；用户可通过正常登录找回已创建会话，重复注册不得创建第二账号。
- [ ] 从 Rust 正常生成错误契约，运行 export --check，不手写生成文件；新增 REST/CHAT DTO 由实际契约建模，不假定现有协议生成器会自动导出任意 REST 类型。
- [ ] 提交：feat(server): support invited registration and editable display names。

## R4：注册、登录与个人资料前端

**计划文件：** apps/web/src/features/auth/registration.api.ts、RegisterPage.vue、LoginPage.vue、session.store.ts；features/account/ProfilePage.vue、profile.api.ts；shared/api/types.ts/client.ts/errors.ts；app/router.ts/navigation.ts；tests/browser/registration.spec.ts、profile.spec.ts。

- [ ] ApiClient 增加 PATCH、头像所需PUT/Binary helper；识别匿名注册错误，匿名校验失败不触发全局退出/播放器清理。
- [ ] SessionUser 扩展 display_name；旧响应缺失时显示 username；所有日常显示改用 nickname，登录参数依然 username。
- [ ] /login 使用“登录账号”标签并增加注册链接；/register 两步表单覆盖验证、占用、失效、输入错误、网络不确定结果；禁止昵称登录。
- [ ] 按 v4 图稿实现四字段：登录账号、可选昵称、密码、确认密码。校验前后端一致；密码管理器使用 username/new-password，允许粘贴。
- [ ] 邀请码验证不锁定名额；按钮去重不代替数据库单次消费；超时不自动提交第二次，提供 /auth/me 确认和手动登录路径。
- [ ] 成功从响应恢复身份/CSRF，进入 /rooms，不自动加入房间；不等待成功动画结束。
- [ ] /account/profile 只读展示登录账号，仅昵称可保存；错误保留输入，成功更新侧栏，支持重名和默认回退；无自定义昵称时编辑框为空，不把超过50位的默认登录账号误作为昵称提交。
- [ ] 在同页接入头像A3，头像单独保存，不把昵称草稿打包提交；该项“仅昵称”指profile PATCH可写字段，头像使用独立接口。
- [ ] ChatPanel 与邀请码使用者展示读取 display_name；以稳定 user_id 标识消息作者，不靠重名昵称匹配。
- [ ] 字段 label/helper/error、键盘焦点、360/390px、密码显示、reduced-motion 全覆盖；未登录注册页无播放器，资料页持续迷你播放。
- [ ] 提交：feat(web): add invite registration and personal profile pages。

## R5：管理端邀请码页面与结果状态

**计划文件：** features/admin/RegistrationInvitesPage.vue、RegistrationInviteDrawer.vue、RegistrationInviteResult.vue、CreateUserPage.vue、admin.api.ts；app/navigation.ts/router.ts；tests/browser/registration-admin.spec.ts。

- [ ] “账号与注册”导航下有邀请码页和手动创建标签；前者成为默认入口，后者保持可访问。
- [ ] 实现真实筛选/游标列表、空态、失败、刷新、生成数量/有效期/备注、撤销确认；不显示接口未提供的总量。
- [ ] 首次生成结果单条/批量复制，复制失败有手动选中文本方式；未复制关闭提示一次，关闭不自动撤销。
- [ ] 未知结果按 batch_id 查询；已生成但响应丢失不伪造原码，提供已知条目的撤销和新生成流程。
- [ ] 历史列表无完整码复制按钮，状态更新以服务端为准，已用码显示昵称及登录账号。
- [ ] 手动创建改为登录账号、可选昵称和密码；8 字符/字符集一致，不保留旧 12 字符帮助文字。
- [ ] 在有播放会话时打开/关闭抽屉、生成和撤销均不更换 video/WS/播放会话；移动可收起画面但保留播放。
- [ ] 提交：feat(web): add registration invitation management。

## R6：联合验收与回滚演练

**计划文件：** tests/registration.mjs、tests/browser/registration*.spec.ts、profile.spec.ts、errors.test.ts；docs/ACCOUNT_REGISTRATION_VALIDATION.md（未来正式交接文档）。

- [ ] 真后端完成管理员生成 → 用户验证 → 注册 → 自动登录 → 昵称显示 → 修改昵称 → 重新登录仍用原账号；同时验证房间邀请仍单独工作。
- [ ] 恶意 username 修改、昵称重名/HTML 文本、密码中文、失效代码、越权管理、匿名 Origin、并发和超时恢复均有证据。
- [ ] 既有账号含不符合新字符规则的历史用户名或密码仍可登录；没有 profile 行仍正常工作；普通用户不获得管理员权限。
- [ ] 前端截图核对确切配色、四个注册字段、个人资料只读账号、管理状态和播放连续性；生成图不作为运行通过证据。
- [ ] 联合完成头像A4：宽/长图取景、512×512实际文件、恢复默认、失败保留旧图、持久化和无外部组件代码复用。
- [ ] 运行有针对性的 Rust/集成/浏览器测试，再在主计划切换入口时进行规定的全量检查；不因纯样式修改堆叠实现镜像测试。
- [ ] 记录证据类型与未验证设备，提交验收摘要，不把真实密码/Cookie/邀请码放入版本记录。

未来可执行的命令（本轮未运行）：

~~~powershell
$env:RAINSYNC_ARTIFACT_DIR = 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-design-2026-09-28/validation'
$env:CARGO_TARGET_DIR = "$env:RAINSYNC_ARTIFACT_DIR/cargo-target"
cargo test -p rainsync-server -p protocol
cargo run -p protocol --example export -- --check
node tests/integration.mjs
npx playwright test tests/browser/registration.spec.ts tests/browser/registration-admin.spec.ts tests/browser/profile.spec.ts
npm test
npm run build -w apps/web -- --outDir "$env:RAINSYNC_ARTIFACT_DIR/build"
~~~

先完成 integration.mjs/Playwright 的产物目录改造后才能用上述命令。集成脚本必须验证连接的是自己创建的临时数据库。未具备隔离数据库/浏览器环境时如实记录，不对未知部署进行写操作。

回滚优先撤回页面入口和新增业务 handler，保留增量迁移与已注册账号/资料/使用记录，不通过删除数据“恢复邀请码”。现有 sqlx::migrate! 会检查迁移历史；不可盲目启动完全不含新迁移的旧二进制。准备保留新迁移文件但回退业务代码的兼容构建并演练，确认旧登录和播放仍可用。只做本地提交，不 push、PR 或部署。

## 当前交付状态

本轮只新增/修订“杂项”中的设计文档、计划及图稿；RainSync 主仓库仍保持原基线。没有实现注册接口，没有建表，没有创建真实账号，没有运行上述测试。
