# 后端启动、升级与兼容回退

本记录对应0020/0021增量后端。正式部署仍由维护者操作，本任务没有部署、推送或创建PR。API细节见 [ACCOUNT_REGISTRATION_API.md](ACCOUNT_REGISTRATION_API.md)、[AVATAR_API.md](AVATAR_API.md)，演练证据见 [BACKEND_VALIDATION.md](BACKEND_VALIDATION.md)。

## 启动与配置

既有部署入口不变：安装Docker Compose与Node24，`node scripts/setup.mjs` 创建本机配置后，`docker compose up --build -d`。setup不会覆盖已有配置。首次空库管理员使用 `ADMIN_USERNAME`（原默认）和 `ADMIN_PASSWORD`；新密码须8–1024可打印ASCII字符，空格保留。已有管理员不会因环境变量变化而重置或改名。不要把.env、runtime凭据或用户数据提交。

本机直接启动要求PostgreSQL、Rust、Node24和支持PNG/libwebp的FFmpeg/ffprobe。先设置 `DATABASE_URL`、`SOURCE_ENCRYPTION_KEY`、`PUBLIC_ORIGIN`、`ADMIN_PASSWORD`、`MEDIA_ROOT`、`CACHE_ROOT` 和 `WORKER_URL`，再构建/运行 `rainsync-server`、`rainsync-media-worker`；前端 `npm ci`、`npm run dev`。沿用项目OPERATIONS文档的反代、媒体目录和TLS设置。PUBLIC_ORIGIN须与浏览器Origin完全相同。

新增配置：验证30次/分钟、注册10次/10分钟、Argon2并发2，分别为 `REGISTRATION_VALIDATE_PER_MINUTE`、`REGISTRATION_PER_TEN_MINUTES`、`ACCOUNT_HASH_CONCURRENCY`。`TRUSTED_PROXY_CIDRS` 默认空，只有明确可信peer才解析转发链。填实际反代IP/CIDR，不能信任整个Internet。头像 `AVATAR_PROCESS_CONCURRENCY=2`、`AVATAR_PROCESS_TIMEOUT_MS=5000`、`AVATAR_WRITES_PER_MINUTE=10`；可选 `AVATAR_FFMPEG_BIN` 是可信本地可执行路径。所有默认值在.env.example，Compose传入相同设置。

源码验证产物隔离：

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28'
node scripts/run-check.mjs accounts 300 node --run test:accounts
```

先执行 `cargo build --workspace --bins --examples --locked`。测试总是使用自己的独立容器；不要把生产DATABASE_URL传给测试来代替fixture。`npm ci`可能替换node_modules junction，安装后须检查输出目录；本任务当前junction指向ARTIFACT/node_modules。

## 升级

1. 保存数据库完整备份及匹配的 `SOURCE_ENCRYPTION_KEY`，另行保管媒体、Agent状态及部署配置；保留当前镜像/二进制版本。先在恢复副本演练。
2. 停止旧应用写入，备份完成后部署新Server（Worker/NAS协议本轮未改变）。SQLx启动按序自动应用0020和0021，历史0019及以前文件不能编辑。
3. 确认 `_sqlx_migrations` 最新21且success为true；测试旧账号和已有Cookie、房间邀请、原观看流程。
4. 管理员生成注册邀请码，新客户端注册应普通用户且不加入任何房间；独立检查昵称与头像。管理员生成响应只显示一次原码，丢失后按batch_id确认并撤销不可取回的未使用条目，不自动生成未知批次。
5. 新注册成功自动登录；网络不确定时先查auth/me再用刚创建凭据正常登录。不要自动重发注册。头像失败先读profile确认operation版本，再使用原UUID/内容/预期版本确认或显式重试。

## 应用回退：保留迁移与数据

不能直接运行缺少新迁移的旧SQLx二进制。已验证的兼容版本是**基线业务代码 + 完全相同的0020/0021迁移**。此版本保留新用户、会话、昵称、头像和邀请码表，但不暴露新资料/注册接口；因此前端也须回退到与旧接口匹配的版本。

未来执行回退前在单独分支确保没有未处理用户修改，记录当前交付SHA及要撤销的明确提交列表。按依赖逆序逐个 `git revert --no-commit <明确SHA>`；遇冲突逐项解决并检查。恢复增量迁移原文件，再形成一个兼容回退提交，而不是删除数据库表或历史：

```powershell
# 此处只说明未来维护步骤，不是本任务已执行的revert。
# 先按最终报告的清单逆序revert相关应用提交。
git restore --source 11fe2cb6da2915adf1fe26b1c898544dd1e54b78 -- migrations/0020_registration_accounts.sql migrations/0021_user_avatars.sql
git add migrations/0020_registration_accounts.sql migrations/0021_user_avatars.sql
# 审查完整暂存差异并执行兼容验证后提交，再构建待回退二进制。
```

如果撤销基线验证设施提交会一并删除测试工具，应在回退候选以外保留本次验收工具来验证。不要对交付分支reset --hard，不做force-push。当前分支没有执行以上revert。

独立重复实证：

```powershell
./scripts/prepare-compatibility.ps1 -ArtifactRoot $env:RAINSYNC_ARTIFACT_DIR
./scripts/prepare-legacy-baseline.ps1 -ArtifactRoot $env:RAINSYNC_ARTIFACT_DIR
node scripts/run-check.mjs rollback-data 300 node tests/compatibility-rollback.mjs
node scripts/run-check.mjs migration-upgrade 300 node tests/migration-upgrade.mjs
# 使用manifest里的target运行旧业务观看验证；完成后恢复当前target。
$currentTarget=$env:CARGO_TARGET_DIR
$compat=Get-Content (Join-Path $env:RAINSYNC_ARTIFACT_DIR 'compatibility/latest.json') -Raw | ConvertFrom-Json
try {
  $env:CARGO_TARGET_DIR=$compat.target
  node scripts/run-check.mjs compatibility-watch 1200 node tests/integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Compatibility validation failed' }
} finally { $env:CARGO_TARGET_DIR=$currentTarget }
```

本轮实际兼容构建位置及时间由manifest记录。重新创建manifest会产生新fixture；不要误以为它更改了正式Git分支。继续向前升级时部署完整新代码即可重新读取保留的资料与图片。

## 数据恢复独立于应用回退

不提供删除0020/0021表的down migration。新注册账号、已消费码、头像墓碑及operation历史不得为回退而清空；否则会失去单次消费和迟到上传保护。数据库完整备份要包含SQLx历史及全部新增表，并同SOURCE_ENCRYPTION_KEY配套。

已实测在隔离容器内 `pg_dump -Fc`，新建另一数据库，`pg_restore`，将Server指向恢复库后核对现有Cookie、昵称、头像字节/版本和批次记录。生产恢复需维护者为自己的备份重复演练；不能把这次合成数据库演练称为生产一键回滚。恢复到旧时间点会丢失之后写入，须单独评估数据恢复点，不能与保留当前数据的代码回退混为一谈。
