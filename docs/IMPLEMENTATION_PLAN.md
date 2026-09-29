# RainSync 全部已确认改造实施计划

> 当前会话按 executing-plans 执行；不委派子代理。用户已明确授权实施。使用复选框跟踪，原设计中的仅设计阶段声明失效。

**Goal:** 完成账号、注册邀请码、昵称、头像及米色前端全量替换，保留所有现有播放行为，真实验证并分阶段本地提交。

**Architecture:** Server 增量扩展注册、资料和头像，PostgreSQL 事务维护身份与邀请码消费；头像独立有版本记录。前端先提取认证/API/房间/播放运行时，再构建常驻唯一播放器的 Vue 路由应用，完整验收后原子替换旧 UI。

**Tech Stack:** Rust/Axum/SQLx/PostgreSQL、现有 FFmpeg，Vue 3/TypeScript/Pinia/Vite/hls.js/Vitest/Playwright，新增 Vue Router 和一致图标库时核实并锁定版本。

**Spec:** [完整用户要求](IMPLEMENTATION_REQUIREMENTS.md)、[主设计](design/DESIGN.md)、[账号设计](design/ACCOUNT_REGISTRATION_DESIGN.md)、[头像设计](design/AVATAR_DESIGN_PLAN.md)。原计划完整保留在 design 中；本文件替换其交错执行顺序，不删减验收项。

## 全局约束

- 主色 #E5D1C1、辅色 #9E7867；仅浅色，播放器和迷你播放器同色系。品牌只有 RainSync 文字。
- 媒体图像 16:9；头像独立为真实静态 512×512。头像裁剪/导出逻辑自主实现，无外部裁剪组件或素材复用。
- 登录账号固定且唯一；昵称可选、重名、最多 50 Unicode 码点。新密码 8–1024 可打印 ASCII 字符，保留空格。旧账号凭据兼容。
- 邀请码一码一人、批量 1–50、默认 7 天并支持 1/30 天；注册成功才消费。注册仅普通用户，自动登录但不自动加房间。
- 唯一 video/HLS/WS/播放会话；普通导航不重建。保留同步版本、纠偏、取消/幂等、HLS 恢复、音字幕、Worker/Agent 和房间权限。
- 所有临时产物位于 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28`，简称 ARTIFACT。正式文件在当前项目 docs/源码。测试独立数据库，无未知部署写入。
- 不 push、不建 PR、不部署、不发消息、不自动展示效果图。只用明确路径暂存本任务内容，保留三个原有删除。
- 每个阶段执行真实验证并记录退出码；失败不能转述为通过。代码回滚用 revert，数据库保留迁移历史和数据。

## A：准备与基线（原主 Task 1，账号 R1 的验证设施）

**文件：** `scripts/validation-env.ps1`、`scripts/run-check.mjs`、Playwright/Vite/Vitest 配置、`tests/integration.mjs`、`docs/IMPLEMENTATION_PROGRESS.md`、本计划及 design/。

- [x] 实际基线 `13262053eb5f949a7e9dea6f2a11d2e1cbe7ce6e`；分支 `codex/rainsync-implementation`。
- [x] 完整阅读 AGENTS.md 和七份设计文档；cgraphy 不可调用，源码使用常规检索，不 enrich/store。
- [x] 记录原有 `oil-pumpjack.html`、`pelican-bike.svg`、`pumpjack.html` 删除，不纳入提交。
- [x] 配置全部产物和二进制查找，安装既有锁定依赖，检查真实 DB/FFmpeg/浏览器可用性。
- [x] 运行 Rust 测试/协议一致性、前端单测/类型/构建/浏览器及真实集成基线；记录已有失败和合理修复。
- [x] 准备提交；不重写前端页面或删除旧 UI。结果见 BASELINE_VALIDATION.md。

验证入口（后续命令均先设置环境）：

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28'
node scripts/run-check.mjs baseline-rust 1200 cargo test --workspace --locked
node scripts/run-check.mjs baseline-protocol 300 cargo run -p protocol --example export -- --check
node scripts/run-check.mjs baseline-unit 180 node node_modules/vitest/vitest.mjs run
node scripts/run-check.mjs baseline-types 180 node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json
node scripts/run-check.mjs baseline-build 180 node node_modules/vite/bin/vite.js build apps/web
node scripts/run-check.mjs baseline-browser 600 node node_modules/@playwright/test/cli.js test
node scripts/run-check.mjs baseline-integration 1200 node tests/integration.mjs
```

## B：后端全量完成并验收（账号 R1–R3、头像 A1）

**文件：** `apps/server/src/{account_rules,registration,profile,avatars}.rs`、`main.rs`、`rooms.rs`、必要 persistence 模块、`migrations/0020_registration_accounts.sql`、`0021_user_avatars.sql`、协议错误源和正常生成物、`tests/{registration,avatar-upload}.mjs`、隔离 fixture、`.env.example`、后端/兼容回滚文档。

**接口：** 现有 API 前缀下邀请码 admin 生成/列表/撤销、匿名 validate/register、me/profile 读取和白名单 PATCH、avatar 条件 PUT/DELETE 及认证 GET。具体字段与错误见两个专项设计。

- [x] B1/R1：先写账号边界失败测试，再实现规则和增量 schema；旧 users/sessions 列形状不变。独立提交。
- [x] B2/R2：管理员批次 UUID 幂等、原码仅首次、状态/游标/撤销、no-store；真实数据库测试批量/权限/重复批次。独立提交。
- [x] B3/R3：匿名 Origin/JSON、可信 peer/代理与共享限流、有界 Argon2；注册事务写用户/资料/消费/会话；昵称及聊天兼容。真实 HTTP 并发、故障事务与旧会话测试。独立提交。
- [x] B4/A1：静态 PNG 512×512 真实有界解码/重编码 WebP，≤256KiB，alpha 与资源回收；独立头像表、操作 UUID、预期版本与删除墓碑。真实上传故障/并发/重启测试。独立提交。
- [x] B5：Rust 测试、构建、clippy/fmt、协议 export --check、隔离 Server 集成全部必要项通过；兼容回滚构建在增量迁移 DB 上验证旧登录/观看与数据留存。
- [x] 写入 `docs/BACKEND_VALIDATION.md`，与B5一同提交；实际提交后在聊天报告后端门槛和SHA，再继续C。

后端必须实测：同码并发、撤销竞争、锁等待过期、用户名占用不消费、重名、用户/资料/消费/会话失败全回滚、普通权限/白名单/规则边界、旧凭据/会话、Origin/CSRF/IP/限流、未知注册/批次恢复、坏图/动态/超限/编码异常、头像上传删除竞态、迁移与重启。单元/mock 不替代真实 Server 和数据库。

## C：前端完整迁移（原主 Tasks 2–7、账号 R4–R5、头像 A2–A3）

详细文件结构、接口、任务用例沿用 `design/PLAN.md` Tasks 2–7 和专项 R4/R5/A2/A3；执行顺序改为 B 完成后的连续前端阶段。

- [x] C1：typed API、错误/身份隔离；测试旧身份401与截断响应，旧入口兼容；35单测、类型、38浏览器通过，阶段提交。
- [x] C2：房间/播放运行时和store；同房enter、迟到结果、销毁，以及既有幂等/取消/就绪/纠偏及恢复回归通过。36单测、类型与38浏览器通过；跨路由唯一节点验收在C4/D。
- [x] C3：语义色、路由/守卫、AppShell、登录/放映室/媒体库、搜索/分页/缓存；新入口/preview验证但暂不删旧入口，与C4首批一同提交。
- [x] C4：观影、聊天/队列/邀请、状态/权限、常驻PlaybackHost、完整/迷你布局；DOM节点和mock请求计数断言通过，与C3一同提交。D阶段仍需真实后端视频跨所有页面验收。
- [x] C5/R4/A2/A3：两步注册、不确定结果、个人资料、独立裁剪模型/格式检查/手势/键盘/导出、头像与昵称分别保存。44单测、56浏览器、类型与构建通过，阶段提交；D真实联调仍待完成。
- [x] C6/R5：片源/NAS/邀请码/手动创建，按真实API契约实现批次恢复、复制失败、撤销、状态和抽屉焦点；72浏览器、44单测、类型和构建通过，阶段提交。真实Server联调在D。
- [x] C7：360/390/768/1024/1440/1920、软键盘模拟、reduced-motion、对比、焦点；修复次级文字对比与Tab循环，80浏览器、类型与构建通过。实机不在此模拟证据内。

## D：真实联调、原子切换、最终交付（R6、A4、原主 Tasks 8–9）

- [x] D1：真实管理员生成→注册→自动登录→昵称→头像→房间观看联调；宽/长图四次不同取景及实际WebP/重启持久性通过。
- [x] D2：真实视频多人同步/权限/聊天/队列，观影→片库→全部管理/资料→原房间无新增video/WS/会话且时间连续通过；根入口切换及最后修复后final-real-browser重跑通过。
- [x] D3：真实联调通过后切换根入口并删除旧App/style/api；保留全部核心业务，迁移原38播放回归，新总86浏览器通过，独立提交。
- [x] D4：最终Rust56通过/2原有子进程fixture忽略，fmt/clippy/协议、四套真实账号与原Server/Worker/NAS集成通过；44前端单测、类型、构建、86浏览器及根入口真实视频重跑全部通过。修复与精确时间见IMPLEMENTATION_REPORT第5节。
- [x] D5：`FRONTEND_VALIDATION.md`随2f24be5提交；`ACCOUNT_REGISTRATION_VALIDATION.md`、完整`IMPLEMENTATION_REPORT.md`、验证哈希清单及进度随最终报告提交。启动/升级/回退及实机/弱网/长时边界均明确记录。
- [x] D6：全部本任务正式文件纳入本地提交，保留并排除三项用户删除；完整SHA、依赖和明确逆序revert见报告第7/8节。最终报告提交SHA及提交后status核对由最终回复提供；只有核对成功才完成Goal。

## 恢复与证据

每次阶段完成更新 `IMPLEMENTATION_PROGRESS.md`，记录提交、命令、结果、证据和剩余工作。命令日志与 JSON 退出码在 ARTIFACT/logs；敏感运行数据不进入 Git。上下文压缩后先读进度和本计划，从未完成项续跑，不重新开始。
