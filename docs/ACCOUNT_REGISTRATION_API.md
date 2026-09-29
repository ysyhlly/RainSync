# 账号、邀请码与资料接口

本文件描述本分支已实现的账号接口。统一前缀 `/api/v1`，错误为既有 `{error:{code,message,retryable,request_id,retry_after_ms?}}`。头像二进制接口及条件版本、处理边界见 [AVATAR_API.md](AVATAR_API.md)。

## 新建与存量规则

- 新登录账号精确区分大小写，`[A-Za-z0-9_.-]{1,80}`；所有本人资料写入仅允许昵称，登录账号不可经 API 修改。
- 新密码为 8–1024 个 U+0020–U+007E 字符，包含空格且不 trim。管理员手动创建、空库管理员初始化、自助注册规则相同。
- 登录端不添加新字符集/最短长度验证。真实回归使用合成的历史中文账号及包含中文/换行的短密码验证原凭据登录和会话恢复。
- 昵称 trim 后为空则无自定义资料行；非空最多 50 个 Unicode 码点。控制字符不作为可显示昵称接受；中文、Emoji、重名和普通符号允许。默认显示登录账号，允许其长于 50，`custom_display_name` 为 null。
- 新账号均为普通用户；前端和权限不得以昵称判定身份，使用 UUID `id`/`user_id`。

## 端点

| 方法和路径 | 授权/输入 | 返回与重试语义 |
|---|---|---|
| POST `/admin/registration-invites` | 管理员 Cookie、Origin、CSRF；`batch_id:UUID,count?:1..50,valid_days?:1/7/30,note?:string` | 201 `{batch_id,items:[{id,code,code_suffix,expires_at}]}`；默认 1 个/7 天，备注最多 60 码点。原码只在此创建响应中返回 |
| GET `/admin/registration-invites` | 管理员；`status=all/unused/used/expired/revoked`、`cursor=UUID`、`limit=1..100` 默认25、可选 `batch_id` | `{items,next_cursor,server_time}`；只含元数据，无原码/摘要。创建时间及 UUID 降序游标分页，不返回假总量 |
| DELETE `/admin/registration-invites/{id}` | 管理员 Cookie、Origin、CSRF | 当前元数据；重复撤销幂等，已使用 409 `REGISTRATION_INVITE_ALREADY_USED`，已过期不能新撤销 |
| POST `/auth/registration-invites/validate` | 匿名允许；严格配置 Origin、JSON；`{code}` | `{code_suffix,expires_at,server_time}`，不锁定/预留/消费，不建立会话 |
| POST `/auth/register` | 匿名允许；严格 Origin、JSON；`{code,username,password,display_name?}` | 201 `{id,username,display_name,admin:false,csrf,avatar_url:null,avatar_version:null}`，现有 HttpOnly/SameSite=Strict Cookie；无自动房间成员关系 |
| POST `/users` | 管理员 Cookie、Origin、CSRF；`{username,password,display_name?}` | `{id}`，复用新建规则，用户和昵称在同一事务中创建 |
| POST `/auth/login` | 原有 Origin 和用户名/密码契约 | 保持 `{csrf}` 和 Cookie，仍用登录账号；不会把昵称映射为账号 |
| GET `/auth/me` | 现有有效 Cookie | 保留 id/username/admin/csrf，增加 display_name/custom_display_name 和可空头像元数据；no-store |
| GET `/users/me/profile` | 本人有效 Cookie | `{id,username,display_name,custom_display_name,avatar_url,avatar_version}`；no-store |
| PATCH `/users/me/profile` | 本人 Cookie、Origin、CSRF；仅 `{display_name:string}` | 更新资料。空串恢复默认；缺字段、username/admin/user_id/avatar_url 等额外字段拒绝。无新会话，无 WS 重连 |

所有时间字段为 Unix 毫秒，前端用 `new Date(value)` 显示；邀请码状态由数据库时钟决定。列表使用者包含 `used_by` UUID、`used_by_username` 登录账号和 `used_by_display_name` 昵称。状态优先级为 used > revoked > expired > unused。

参数值非法通常 400；Serde 字段/类型拒绝通常 422，均标准化为 `INVALID_REQUEST` 或明确错误码。登录账号占用是 409 `USERNAME_TAKEN`。匿名所有不存在/过期/撤销/已用码统一 400 `REGISTRATION_INVITE_INVALID`。有效会话调用注册返回 409 `ALREADY_AUTHENTICATED`，不切换身份。

## 并发与未知结果

批次 ID 绑定创建者与归一化参数。相同 ID/创建者/参数返回 409 `REGISTRATION_BATCH_ALREADY_CREATED`；参数或创建者不同返回 `REGISTRATION_BATCH_CONFLICT`。生成事务全部成功或全部回滚。响应丢失后查询已知 batch_id；原码不可重建，管理员可撤销丢失的未使用条目再创建新批次。不得偷偷换新 ID 自动重发。

注册先做来源限流、字段和邀请码粗检，再在有界阻塞线程中 Argon2。哈希期间不持数据库事务。随后锁邀请码行，在锁后单独使用 `clock_timestamp()` 复查有效性，再一次事务提交用户、可选昵称、消费和会话，最后才返回 Cookie。任何中间失败整体回滚；并发撤销和注册争同一行锁。

注册没有匿名幂等重发接口。响应丢失时先 GET `/auth/me` 确认本次登录账号，其他身份不能当成功；仍未知则使用刚设置的登录账号和密码正常登录。测试实际丢弃已提交注册的响应体和客户端 Cookie，再从新客户端登录确认单一账号；不宣称该用例模拟了所有 TCP 故障时点。

## 限流和可信代理

`REGISTRATION_VALIDATE_PER_MINUTE=30`、`REGISTRATION_PER_TEN_MINUTES=10`。独立 `account_rate_limits` 表持久保存 scope/来源摘要/窗口/次数；到期清理，最多10000个活动键，容量已满时拒绝新键。设置均必须在1–10000范围。

`ACCOUNT_HASH_CONCURRENCY=2`（1–32）限制新建账号 Argon2 任务；满时立即429，等待队列长度为零。许可归阻塞任务所有，HTTP 请求取消不会提早释放仍在计算的许可。429 具有 Retry-After 和毫秒级 `retry_after_ms`，前端不应盲目循环重试注册。

默认 `TRUSTED_PROXY_CIDRS` 为空，只使用 TCP peer，任意 X-Forwarded-For 无效。部署在 Caddy 等反代之后时，应显式填写实际代理 IP 或受控网络 CIDR，以逗号分隔。服务仅在 peer 可信时由右向左剥离可信链，遇第一个非可信地址即停止；无效/过长链回退 peer。不要使用 `0.0.0.0/0` 或 `::/0`。不自动推断任意私网地址可信。配置缺失时所有同一代理后的注册共享其来源窗口，这是保守默认。

## 存储与兼容

`0020_registration_accounts.sql` 新建 user_profiles、registration_invite_batches、registration_invites、account_rate_limits；不改 users/sessions 的既有四列形状，不修改历史迁移。码为20字节随机熵的32位 Base32，RS 分组前缀，接受小写/空白/连字符；只存带 registration 域的 SHA-256 和尾四位，与房间邀请无关。

聊天历史和新 CHAT 保留 username，并增加 user_id/display_name/头像元数据。加载历史及新消息使用当前昵称，已经显示在其他客户端中的历史不额外广播更新。历史响应增加 created_at 毫秒字段，原有分页排序和权限不变。

审计修复后，0022为CHAT增加持久幂等：同room_id/user_id/client_message_id及相同正文返回原消息ID，不重复写入或广播；同键换正文返回INVALID_REQUEST。缺少编号的旧客户端仍兼容。真实并发/重启及迁移回退证据见[AUDIT_FIXES.md](AUDIT_FIXES.md)。

代码回退必须保留新迁移文件及数据库历史；直接运行缺少新迁移的旧 SQLx 二进制不保证启动。已执行的兼容构建、升级、数据保留和备份恢复证据见 BACKEND_VALIDATION.md，具体步骤见 BACKEND_OPERATIONS.md。

## 证据入口

`tests/account-rules.mjs`、`tests/registration-invites.mjs`、`tests/registration.mjs` 均启动独立 PostgreSQL 和真实 Server。完整命令及阶段门槛汇总见 `BACKEND_VALIDATION.md`，逐项执行结果记录于 `IMPLEMENTATION_PROGRESS.md` 和外部 logs。
