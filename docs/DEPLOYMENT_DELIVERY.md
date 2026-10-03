# 可复现交付与隔离升级/恢复

本页对应 NEXT_PLAN §13.1–13.3。代码提供启动拒绝、入口诊断、不可变构建输入校验、分离加密恢复包和可执行预览升级演练；没有真实生产数据库、历史部署或 amd64/arm64 镜像验收记录时，仍保持开发预览，不将合成数据回归改写为正式恢复验收。

## 1. 配置分组与启动顺序

- 控制面：`DATABASE_URL`、`PUBLIC_ORIGIN`、管理员初始化变量、实例锁
- 片源：`MEDIA_ROOT`、`SOURCE_ENCRYPTION_KEY`；恢复清单另记录实际密钥版本
- 媒体入口：`MEDIA_ORIGIN` 默认且必须等于公开 origin；当前浏览器播放采用同源入口，跨域媒体/CORS 未经验收时拒绝分离配置
- Agent：`SERVER_URL`、`AGENT_DATA_ORIGIN`、`AGENT_CREDENTIAL_FILE`；数据入口默认控制 origin
- 转码/缓存：`WORKER_URL`、`CACHE_ROOT`、容量/任务限制、FFmpeg/ffprobe
- 观测：`RUST_LOG`、进程 liveness、依赖 readiness、部署入口诊断

统一解析拒绝带用户密码、路径、query、fragment、通配地址和端口 0 的 origin。Agent 数据为原生客户端连接，保留与控制面协议独立的 HTTP(S) 配置，不把浏览器 mixed-content 限制套在 Agent 上。当前媒体入口必须与 PUBLIC_ORIGIN 相同；Agent 数据入口可独立配置，Worker 生成的实际 Agent 数据 URL 使用 AGENT_DATA_ORIGIN。`CACHE_ROOT` 与 `MEDIA_ROOT` 通过现存路径 canonicalize 比较，拒绝同目录及 symlink 别名；Worker 可在后续创建独立缓存目录。配置的 Server/Worker 媒体根必须存在。Agent 的媒体挂载丢失仍保留既有只回放 drain 回执模式，不因为新增启动检查阻断该恢复路径。

Server/Worker 在连接数据库之前要求 32 字节 source 密钥；数据库现有 sources 及 source_access_policy_snapshots 逐条认证解密，错误密钥或损坏密文以 `source_key_mismatch_or_corrupt_ciphertext` 停止启动。Server 的这个只读探测先于迁移、用户初始化和播放恢复，不把解密失败变为空库，不打印密文、密钥、片源路径或凭据。

不能要求 Server 在绑定监听器之前访问尚未启动的 Worker/代理，否则会产生启动循环。采用两阶段：本地配置先失败即停；服务启动后、开放外部接入前从实际客户端和 Agent 网络位置执行：

```sh
node deploy/diagnose.mjs
```

该命令读取当前环境（不要在终端粘贴密钥）、检查目录及以下精确 JSON 入口，不跟随重定向，5 秒超时，16 KiB 响应上限：

- `PUBLIC_ORIGIN/api/v1/deployment/health` 与 `/api/v1/deployment/ready`
- `MEDIA_ORIGIN/media-delivery/health` 与 `/media-delivery/ready`
- `AGENT_DATA_ORIGIN/agent-data/health`

开发 Caddy 既有路由已覆盖这些路径。返回 SPA/HTML、错误服务标识或 stale readiness 均不通过。HTTP liveness 不等于 WebSocket 认证/真实播放通过；readiness 反映当前 DB/锁/Worker 磁盘、任务领取消费、FFmpeg 等已有探针，不声称任意硬件编码器可用。诊断不会替你打开外部接入或修改网络设置。

### 与现有配置的兼容边界

基于本批预览基线 `6a1f969` 的源码、`.env.example`、Compose 与 OPERATIONS：

- 默认同源入口不变；没设置 `MEDIA_ORIGIN` 时取各服务自己的 `PUBLIC_ORIGIN`。Server 和 Worker 使用不同 PUBLIC_ORIGIN 的原生开发拓扑仍可启动，没有跨进程强制相等比较
- Agent 已支持 `SERVER_URL` 与 `AGENT_DATA_ORIGIN` 不同，继续保留，包括 HTTPS 控制 + HTTP 私网数据；Worker 也可显式设置 Agent 数据 origin。应由实际部署提供合适 TLS，不能因通过解析就声称传输安全或所有网络拓扑已验证
- 基线没有读取 `AGENT_PUBLIC_URL` 的代码/模板；本批不新增该变量的语义，也不因为其与 PUBLIC_ORIGIN 不同而拒绝。实际受支持变量仍为 `AGENT_DATA_ORIGIN`
- 新 `MEDIA_ORIGIN` 若与该服务的 PUBLIC_ORIGIN 不同会明确失败。旧代码忽略这个未支持变量不等于分离浏览器媒体已可用；保守拒绝不是新增拓扑支持
- PUBLIC_ORIGIN、SERVER_URL、AGENT_DATA_ORIGIN、WORKER_URL 带用户密码、子路径/query/fragment、通配地址、端口 0 以前可能被忽略、重写或晚期失败；现在启动即失败。只含末尾 `/`、默认端口等合法 origin 会规范化
- Server/Worker 显式 MEDIA_ROOT 不存在、缓存与媒体同目录/别名以前可启动，现在拒绝。Agent 挂载缺失的既有只回执模式继续可运行
- source key 缺失/长度错误以前可能先进行迁移或初始化；现在先拒绝。32 字节但与已有片源不匹配的 key 以前可能表现为操作失败，现在以明确诊断拒绝服务。含伪造明文 config_encrypted 的旧测试需改为真正加密 fixture，不能放宽检查

## 2. 固定运行时与 FFmpeg

开发 `deploy/Dockerfile`/`compose.yaml` 仍允许快速构建。正式候选使用 `deploy/Dockerfile.release`、`deploy/Dockerfile.web.release` 和 `deploy/release.compose.yaml`。无浮动版本默认值；运行时锁必须来自实际获取的镜像与包版本，仓库不放虚构 digest。

操作者在私有 JSON 锁中填写并核实：

- `schema_version: 1`、已冻结候选的 `source_manifest_sha256` 与 `production_manifest_sha256`
- `debian_snapshot`：固定 Debian/安全仓库时间戳，形如 `YYYYMMDDTHHMMSSZ`
- `ffmpeg_version`、`ca_certificates_version`：该快照中的精确 Debian 包版本
- `platforms.amd64` 和 `platforms.arm64` 各包含 `rust`、`debian`、`node`、`caddy`、`postgres` 的真实 `repository@sha256:…` 引用；不能用单架构记录代替另一架构

```sh
node deploy/release-lock.mjs verify-inputs --lock=/private/release-lock.json --arch=amd64
```

本地 Docker inspect 必须实际匹配 digest、Linux 与架构。脚本强制本地 daemon，忽略继承的远程 Docker context，不自动 pull。先按已有流程冻结 candidate 并核验，再进入它的 `source` 目录：

```sh
node deploy/release-lock.mjs build --lock=/private/release-lock.json --arch=amd64 --tag=rainsync-release:preview-1 --output=/private/new-runtime-proof.json
node deploy/release-lock.mjs build --lock=/private/release-lock.json --arch=amd64 --target=web --tag=rainsync-web-release:preview-1 --output=/private/new-web-proof.json
```

对 arm64 在可执行该平台的隔离构建器重复。构建逐文件重算冻结 source manifest 与生产输入子集，同时写入 observer 需要的 `org.rainsync.full-source-manifest` 和 `org.rainsync.source-manifest` 标签；后端还用真实容器采集 FFmpeg Debian 包版本、ffmpeg/ffprobe 构建输出及三个 Rust 二进制 SHA-256，必须与锁相符。实际运行测试与镜像发布获得的 registry digest 仍需留存，不能把本地 image ID 冒充 registry manifest digest。`measure --image=sha256:… --binding=/private/original-runtime-proof.json` 可再次测量同一个已构建后端镜像；它要求原始冻结构建报告，并核对镜像 source 标签、image ID、架构、三个二进制摘要和 FFmpeg 构建摘要，不能给任意已有镜像补填当前候选来源。它不是媒体兼容验收。

release Compose 没有 build 步骤。指定 `RAINSYNC_PROJECT`、`RAINSYNC_BACKEND_IMAGE`、`RAINSYNC_WEB_IMAGE`、`RAINSYNC_POSTGRES_IMAGE` 为已验证平台的 digest 引用后使用；在开放入口前执行上一节 gate。开发、集成和正式项目必须使用不同 project、卷和端口。没有容器构建器或对应平台时只报告阻塞，不能填写假的锁或发布证明。

## 3. 数据库与应用材料分开加密

`deploy/postgres-recovery.mjs` 保留单数据库能力。`deploy/recovery-set.mjs` 在其之上把配置、source key+版本、所有仍有效且已配对的 Agent 凭据及原有 durable receipt 文件合并为独立 AES-256-GCM 材料包，并与数据库备份 ID/密文 digest 绑定。

两把独立 32 字节二进制备份密钥分别通过 `RAINSYNC_BACKUP_KEY_FILE`、`RAINSYNC_MATERIAL_KEY_FILE` 提供；不能是同文件或同字节，Unix 上文件不能向 group/world 开放。数据包和材料包输出到互不嵌套的新目录，文件 0600、目录 0700。还须由管理员把它们及密钥放到真正分离的存储/访问控制域；单机路径分开本身不是独立保管证明。

私有 `RAINSYNC_RECOVERY_INPUT_FILE` 指向 JSON，内容为：

- `schema_version: 1`
- `configuration`：部署环境字符串映射，source key/Agent token 不放这里
- `source_key`：现有 base64 32 字节 key；`source_key_version`：该 key 的实际版本
- `agents`：所有必要已配对设备，每项是 `id`、现有 `credential` JSON、现有 `drained_receipts` 数组；明确无设备时为 `[]`
- `original_media_policy`：原始媒体备份/恢复位置或管理员明确的未备份策略；缓存可重建

不要把这个文件、密钥、备份、恢复配置或凭据作为公开工单附件。脚本不自动发现/导出现有设备凭据，须在授权范围内收集。已有 drain receipt 只原样保存，UUID、管理员声明、心跳或新进程退出不证明任何历史进程释放；撤销凭据不允许复活。

停止写入并完成当前进程排空后，连接独立 loopback PostgreSQL：

```sh
node deploy/recovery-set.mjs backup --database=/private/new-db-backup --materials=/separate-private/new-material-backup
```

备份前会认证解密现有所有片源、比对 Agent token 哈希及 revoked 状态，拒绝漏凭据、错误凭据和 revoked 凭据。继承的 `DATABASE_URL` 不打印到报告或命令行。备份先检查 pg_dump 可读，再加密，临时明文即使失败也删除。

恢复只接受 loopback 的 `/postgres` 或 `/template1` 维护库。必须指定全新输出目录：

```sh
node deploy/recovery-set.mjs restore --database=/private/db-backup --materials=/separate-private/material-backup --output=/private/new-recovery
```

先认证材料与备份绑定；数据库恢复为随机命名全新 DB，没有 `DROP`、`--clean` 或 down migration。随后核对迁移基线、source key 解密与 Agent 凭据，生成全新配置文件、source-key 文件、Agent 状态目录和空缓存。失败的新 DB 保留供诊断，原 DB 不改写；已存在输出目录拒绝覆盖。CLI 报告不含连接串/密钥/凭据，`production_recovery_accepted` 始终为 false，应用验证清单仍待执行。

## 4. 可执行预览升级与回滚

无可靠旧发布标签时，先固定一个真实预览基线。`deploy/preview-transition.mjs` 只接受两个不同、已通过 `scripts/bind-native-backend.mjs` 的冻结 source/build 集合，逐项核对 source 和三个实际二进制；两个目录里的二进制不得被后续 Cargo build 覆盖。禁止用同源/同二进制 smoke 冒充升级。

```sh
node deploy/preview-transition.mjs --baseline-binding=/private/baseline/backend-binding.json --baseline-source=/private/baseline/source --candidate-binding=/private/candidate/backend-binding.json --candidate-source=/private/candidate/source
```

设定 `RAINSYNC_NATIVE_POSTGRES_BIN` 和 `RAINSYNC_ARTIFACT_DIR`；脚本在**自己新建**的数据库/随机端口/目录中执行：

1. 基线运行真实 Server/Worker/Agent、生成自有两秒测试媒体、API 初始化片源和房间并登录/直放
2. 迁移 checksum 预检；停止接入与任务（给本次自己启动的进程发 SIGTERM），有限时间等待真实 close 事件；超时阻断回滚，不伪造回执
3. 创建与读取分离加密数据库/配置/密钥/设备材料，验证 candidate 错误密钥启动明确失败
4. 启动候选 Server/Worker，再重连候选 Agent；验证登录、既有片源、房间、直放、转码片段、seek、停止、实际入口 readiness
5. 若旧版迁移集合与当前 DB 完全匹配，回退真实二进制再验证；不匹配则从备份恢复到**另一新 DB**后启动基线，明确备份点之后数据不在恢复库内
6. 不论是否能原库退镜像，再做全新数据库+空缓存的应用恢复、凭据重连及转码缓存重建

恢复后逐项应用并验证已保存的配置。原生演练没有浏览器反代，只有 Worker 的 PUBLIC_ORIGIN/MEDIA_ORIGIN 显式覆盖为自有组件监听地址以直接访问；报告中的入口检查仅证明原生组件可达，不代表浏览器或反代拓扑验收。生成媒体存放在独立媒体子目录，Agent 不索引数据库、密钥或备份目录。

SIGINT/SIGTERM 转入有界取消/清理链；错误密钥探针也必须等到自己创建的子进程 close。超时会停止自己的进程并等待回收，强制清理或信号终止不能算成功 drain；被取消报告为 interrupted，不能恢复接入或报告成功。正常切换必须观察本次各服务 exit 0 且无终止信号。

脚本绝不接受已有数据库 URL、生产项目、外部 PID、人工 drain 声明或历史 Agent 释放证明。它验证“这两个预览构建在这个自有样本/机器上的流程”，不是线上升级器，也不是所有历史版本/真 NAS、真实库或硬件平台验收。现网变更仍按 OPERATIONS 的历史 Agent 生命周期门槛、发布组合与授权执行；不能照搬测试报告解除历史释放门槛。

## 5. 验证与目标

```sh
cargo test -p media-core deployment_config --locked
node --test tests/deployment-operations.test.mjs tests/postgres-recovery.test.mjs tests/preview-interruption.test.mjs
```

无 `RAINSYNC_NATIVE_POSTGRES_BIN` 时 Node 套件明确 skip 真 PostgreSQL 项，不报全链通过。预览两构建演练必须另行执行并保留报告。默认建议每日 DB 备份、目标 RPO≤24 小时；要求更小窗口再做 WAL/PITR。RTO≤60 分钟是需在实际硬件测量的演练目标，本实现不作未经演练保证。


### 0041 后的最低授权语义

数据库迁移兼容不等于登录授权语义兼容。任一构建含0041时，预览工具在任何服务/数据库创建之前对候选和回退 Server 执行离线 `media-login-binding-v1` 契约预检；每个实际切换入口还会重新核对目标二进制。旧→新→旧这类组合提前拒绝，不能借恢复旧备份绕过最低契约。旧→新的真实迁移由独立 `tests/media-login-upgrade.mjs` 验证；需要回退演练时必须提供不同且兼容的已验证构建。此前的旧版回退报告仅适用于 B 之前的候选。

发布 Dockerfile 默认入口与 release compose 的 Server 入口强制调用 `backend-entrypoint.sh`：先在空目录和清理过的环境里进行有界离线契约检查，通过后才执行服务；缺少该入口的旧镜像直接启动失败。

该 gate 不阻止操作者绕开工具手动运行任意旧二进制；这样的启动不属于支持的切换路径。Docker/架构实际验收仍需受控环境，不能仅凭契约字符串认定完整运行验证。

当前入口比较的是精确 `media-login-binding-v1` 契约（包括声明 JSON），并非“迁移号≥41”或任意更高版本自动兼容。后续服务若保留相同语义，应保留此探针；若变更契约或编码，需同步更新预检、切换入口及固定构建 A/B、旧授权升级、恢复回归后再支持新版本。未知契约仍提前拒绝。


### Controlled-media redirect reader compatibility

The login contract is not proof of redirect-reader compatibility. Redirected generic HTTP pins add optional `final_target_sha256` inside the existing private identity JSON. Default no-follow identities omit that field completely; old direct identity shapes stay unchanged. A workload using the new identity needs matching Server and Worker `controlled-media-redirects-v1` / `final-target-sha256-v1` readers. A migration number cannot certify this binary capability.

`node scripts/source-access-preflight.mjs SERVER WORKER` probes both exact executables in empty working directories with application settings removed, records their hashes and rejects wrong/missing roles. Unknown workload state also requires the pair: absence of evidence is not evidence that no new identity exists. Successful declarations must still be linked to exact-build public API and representation tests.

The current release entrypoint has the same conservative unknown-state policy and verifies both co-delivered binaries before startup. Server and Worker currently use the same `RAINSYNC_BACKEND_IMAGE`; this proves only that co-delivered pair, not compatibility with an arbitrary separately deployed remote Worker. The release image/compose path is renamed to `rainsync-source-access-entrypoint`, so an older image cannot silently reuse only the login-era wrapper. Direct manual execution or an old compose file is outside this supported path. Docker behavior remains pending actual image validation; owned native pair tests do not stand in for it.

The default preview rehearsal is a distinct proved scope: a fresh owned database, only hardcoded local/NAS fixtures, no existing deployment, no HTTP/provider source or redirect identity. It records and checks that exemption instead of guessing about live encrypted source configurations. Passing `--require-source-access` explicitly requires both candidate and rollback pairs before any fixture/database starts and rechecks them at launches. This flag proves reader compatibility only; the separate public-API redirect fixture proves actual redirect behavior.

The earlier41→42 recovery report used no redirect identity and remains valid only for that frozen batch. It is not evidence that pre-redirect readers can safely process newly opted-in sources or grants.
