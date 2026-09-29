# 后端阶段验收

状态：B1–B5 必需验收通过；本文件与 B5 验收提交共同构成进入前端阶段的门槛。验收时产品后端 HEAD 为 `11fe2cb6da2915adf1fe26b1c898544dd1e54b78`，B5 新增兼容性测试、CI 入口与本文，不含前端视觉或业务重构。B5 提交 SHA 由后续进度及最终报告记录。

## 环境与证据

Windows PowerShell，Rust/Cargo 1.98.1，Node 24.19.0，npm 11.17.0，Docker 29.8.0，PostgreSQL 17 测试容器、18.6 客户端，真实 FFmpeg/libwebp。日志时间为 UTC；以下检查于 2026-09-27 19:39–19:56 UTC 执行（上海时间 2026-09-28 03:39–03:56）。

产物根 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28`，下称 ARTIFACT。每项命令的完整参数、开始/结束时间、超时状态与退出码在 `ARTIFACT/logs/<名称>.json`，原始输出在同名 `.log`。所有下表项退出码为 0 且 timedOut=false。合成素材、密码、Cookie、原码、数据库和构建缓存均不提交。

| 检查名称 | 命令（省略 run-check 包装） | 结果 |
|---|---|---|
| b4-binaries-final | `cargo build --workspace --bins --examples --locked` | Server/Worker/Agent 与测试示例构建通过 |
| b4-rust-final | `cargo test --workspace --locked` | 56 通过；2 个原有被上层测试启动的子进程 fixture ignored，不是跳过产品验收 |
| b4-clippy-final | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| backend-fmt | `cargo fmt --all --check` | 通过 |
| backend-protocol | `cargo run -p protocol --example export -- --check` | 正常生成的 TypeScript/错误 schema 一致 |
| backend-accounts | `node tests/account-rules.mjs` | 新建规则、初始化和存量兼容通过 |
| backend-invites | `node tests/registration-invites.mjs` | 生成、批次、分页、权限、状态与丢失响应恢复通过 |
| backend-registration-final | `node tests/registration.mjs` | 真实并发、事务故障、来源安全和资料通过 |
| backend-avatar-chat | `node tests/avatar-upload.mjs` | 真实图片/进程/版本/聊天/持久性通过 |
| backend-original-integration | `node tests/integration.mjs` | 原 Server/Worker/NAS/观看全量真实集成通过 |
| backend-frontend-unit | `node node_modules/vitest/vitest.mjs run` | 旧前端/核心模块 31 个单测通过 |
| backend-frontend-types | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json` | 通过 |
| backend-frontend-build | `node node_modules/vite/bin/vite.js build apps/web` | 通过；原有大 chunk 提示保留 |
| backend-frontend-browser | `node node_modules/@playwright/test/cli.js test` | 原前端 38 个浏览器案例通过 |
| backend-rollback-data | `node tests/compatibility-rollback.mjs` | 兼容回退→前进→备份恢复保留数据 |
| backend-compatibility-watch | `node tests/integration.mjs`（临时指向兼容构建） | 基线业务 + 保留迁移的完整观看集成通过 |
| backend-migration-upgrade | `node tests/migration-upgrade.mjs` | 真正旧二进制0019→新二进制0020/0021升级通过 |

`tests/fixtures/server.mjs` 总是启动随机命名、随机映射端口和凭据的独立 PostgreSQL 容器，不接受外部数据库 URL。原集成同样创建自己的容器。每次测试只回收自己的进程和容器。CI 已加入 `npm run test:accounts` 及 RUNNER_TEMP 产物路径；本任务没有推送，故未声称远程 CI 已运行。

## 必需验收矩阵

| 要求 | 实际验证 |
|---|---|
| 同码两人至多一成功、validate不消费 | registration 测试并发真实 HTTP，校验唯一账号/消费记录；invites 重复 validate 后仍 unused |
| 撤销和注册竞争、锁后有效期 | 两个顺序都实际占用数据库行锁验证；在持锁事务内改近期限再让注册等待，释放后拒绝过期码，避免把哈希耗时误当锁等待证据 |
| 用户名占用不消费、昵称重名 | 真实冲突后原码仍可用；不同登录账号使用相同中文/Emoji昵称 |
| 四处事务失败无半成品 | 用户、资料、消费、会话分别注入数据库故障；检查用户/资料/会话/邀请码均整体回滚 |
| 始终普通用户与管理员权限 | 额外admin/user_id字段拒绝；普通用户生成/列表/撤销管理员资源被拒绝 |
| 白名单、只读账号、新建规则 | 1/80/81账号、非法字符、7/8密码、中文拒绝、8个空格不trim、50/51码点昵称；PATCH不能改username |
| 历史兼容 | 真正0019二进制创建中文用户/会话/房间邀请，合成历史短密码；升级后原凭据、会话、成员与邀请有效，初始化不改名/重置密码 |
| Origin/CSRF/限流/代理 | 缺失及错误Origin/JSON/CSRF、实际socket来源、不可信转发头、可信代理链、持久窗口及并发哈希上限 |
| 响应丢失 | 批次UUID查询恢复仅元数据；真实提交注册后丢弃响应体及客户端Cookie，从新客户端正常登录确认单一账号 |
| 头像验证和处理故障 | 假格式/坏CRC/动态APNG/非512/超体积；真实FFmpeg解码、WebP尺寸和alpha；故障编码器输出/超时/断开后PID回收 |
| 头像并发与删除墓碑 | 同版本竞争、重放、事务失败；初始none的A卡住→B成功→恢复默认→A完成冲突；迟到请求不能重新激活 |
| 持久性及聊天 | 重启后昵称/头像字节和版本相同；真实WebSocket CHAT与历史均区分user_id/username/display_name及头像元数据 |

账号测试与头像测试均为真实 Server/SQLx/PostgreSQL，只有特定失败路径使用测试专用编码器或数据库触发器注入故障。浏览器基线使用 mock，仅证明旧前端兼容；本文件不把它当作前端全新流程或真实视频导航验收。

## 接口、迁移与实现

完整方法、路径、权限、字段、错误及重试契约见 [ACCOUNT_REGISTRATION_API.md](ACCOUNT_REGISTRATION_API.md) 与 [AVATAR_API.md](AVATAR_API.md)。新增注册邀请码admin生成/列表/撤销、匿名验证/注册、本人资料、条件头像写入与认证图片读取。既有登录、管理员手动创建及聊天做兼容增量。房间邀请码仍为独立实体，不自动授予注册者成员资格。

迁移0020新增资料、邀请码批次/摘要及限流表；0021新增当前头像及操作记录。历史迁移checksum不变，users/sessions旧四列不变。注册在锁后用数据库实时时钟复查，然后原子写入用户/昵称/消费/会话。头像锁稳定users父行，独立UUID版本/CAS/操作幂等，删除留墓碑。原图不存储，单帧WebP≤256KiB，编码许可在子进程树回收后释放。

运行时新增直接依赖仅ipnet（使用锁文件已有2.12.2），没有引入图床、头像裁剪库或媒体架构替换。新配置默认值和可信代理策略见 API 文档与 `.env.example`。

## 升级与兼容回退实证

`scripts/prepare-compatibility.ps1` 从基线 `13262053eb5f949a7e9dea6f2a11d2e1cbe7ce6e` 创建外部归档，仅加入完全相同的0020/0021，构建旧业务代码；`prepare-legacy-baseline.ps1` 另建完全未改的0019基线。没有reset/revert当前交付分支。定位清单位于 `ARTIFACT/compatibility/latest.json`。

实际测试分别证明：未改基线升级成功；保留迁移的旧业务接受新账号及现有Cookie且保留资料/头像/邀请码；旧Server/Worker完整观看测试通过；再次升级后字节不变；pg_dump/pg_restore到另一个独立数据库后会话及上述记录仍在。不能推论缺少0020/0021的任意旧二进制可直接读取SQLx新历史。具体运维与安全回退步骤见 [BACKEND_OPERATIONS.md](BACKEND_OPERATIONS.md)。

## 修复与边界

- 注册跨有效期测试改为持锁事务内设置期限，稳定测到锁后复查，保留原失败日志。
- 基线HLS浏览器mock路径适配外部Vite cache；全部既有断言保留，38项已完整重跑。
- 未验收远程CI、真实Safari/iOS/Android、长时间弱网、生产负载、用户私有媒体或生产备份恢复；这些不能冒充本后端阶段已覆盖。
- 前端注册/裁剪/路由/迷你播放器仍待后续C/D实施与实测；本阶段门槛不代表整个Goal完成。
