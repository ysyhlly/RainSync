# 资源 owner 验收门槛

## 必跑的原生 HTTP / PostgreSQL 门槛

`.github/workflows/ci.yml` 的 `owner-gates` 是独立必跑 job，不依赖前端或
其他集成测试成功。下列两个步骤各自保留失败状态；前一个行为测试失败不跳过
后面的行为测试。原 `checks` job 的全部门槛保持不变。

1. `npm run test:native-delivery-owner`：真实 loopback HTTP，正常关闭、实际
   有界 body 队列背压、body drop、未返回响应头的 GET/HEAD/Range、原 owner
   的 ACK 异常与 0 行、恢复后的 durable ACK，以及停止 session/关闭 admission
   后拒绝新读取。
2. `npm run test:room-cleanup-native`：生产 lifecycle API，原生 session 不制造
   legacy receipt，真实 preparation/execution 屏障、迟到回执、revision-fenced
   retry、活跃 lease 不被抢占，以及未知 legacy owner 不被超时冒充 disposed。

本地 Linux 验证需要 Rust/Cargo、Node.js 24，以及含 initdb/pg_ctl/postgres/psql
的 PostgreSQL bin 目录。initdb 必须由非 root 用户运行。目录使用本次验证独有的
绝对路径，置于 checkout 外部，不设置现有 `DATABASE_URL`：

```sh
export RAINSYNC_ARTIFACT_DIR=/absolute/owned/batch/artifacts
export RAINSYNC_RUNTIME_ROOT=/absolute/owned/batch/runtime
export CARGO_TARGET_DIR=/absolute/owned/batch/cargo-target
export RAINSYNC_NATIVE_POSTGRES_BIN=/absolute/postgresql/bin
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
mkdir -p "$RAINSYNC_ARTIFACT_DIR" "$RAINSYNC_RUNTIME_ROOT"
npm run test:owner-gate-contracts
node scripts/bind-native-backend.mjs --owner-fixtures > "$RAINSYNC_ARTIFACT_DIR/binding-path.txt"
export W03_BACKEND_BINDING="$(tail -n 1 "$RAINSYNC_ARTIFACT_DIR/binding-path.txt")"
npm run test:native-delivery-owner
npm run test:room-cleanup-native
```

绑定构建先构建 workspace bins/examples，再显式执行 Server 的
`cargo test --no-run --locked --message-format=json-render-diagnostics`。
ignored fixture 的唯一 executable 来自此次 Cargo artifact 消息，并与源码和
内容摘要共同冻结；不扫描 target 目录挑最新文件，不执行未知生产二进制的
`--list`。运行后必须证明恰好执行一个 ignored fixture 和全部具名 case，零匹配
不会被当作通过。源文件、绑定文件与被执行二进制在测试前后重新校验。

安全摘要保存在
`RAINSYNC_ARTIFACT_DIR/owner-gates/<gate>/<run>/report.json`。包括源码和实际
执行二进制摘要、命名行为、HTTP socket 关闭、子进程 close/PID 不存在、Server
监听关闭和 PostgreSQL 正向停机证明。CI 只上传这些摘要及 backend-binding.json；
不会上传数据库、原始日志或含临时认证信息的
request 文件。原生 owner 请求文件在使用后删除。失败与清理完成是独立字段，
强制回收、未确认退出或缺失必要证据都不能产生成功结果。

## 独立的 Linux 静态 HLS 门槛

下列门槛仍然必需，但不因原生 HTTP owner job 通过而获得验收。当前通用 CI
没有声明可用的静态 HLS 验证镜像与离线依赖，因此不虚构 runner/image 或使用
skip/成功退出代替 Linux 验证。需要在已准备好的 Linux Docker 环境单独运行：

| 环境值 | 必要内容 |
| --- | --- |
| `RAINSYNC_OWNER_TEST_IMAGE` | 已在本机的 immutable image ID 或 digest，含 Linux Rust/Clippy、FFmpeg/FFprobe |
| `RAINSYNC_NATIVE_TEST_IMAGE` | pending/native capture 使用的已准备 Linux image ID/digest |
| `RAINSYNC_OWNER_TEST_REGISTRY` | 已填充且与锁文件匹配的离线 Cargo registry 绝对路径 |
| `RAINSYNC_OWNER_TEST_CARGO_CONFIG` | 该 registry 的现有 Cargo 配置绝对路径，仅读取和摘要，不打印内容 |
| `RAINSYNC_SQL_POSTGRES_IMAGE` | 已在本机的 PostgreSQL 17 immutable image ID/digest，使用 SIGINT 清洁停机 |

```sh
npm run test:static-hls-owner-prerequisites
npm run test:static-hls-owner-linux
npm run test:static-hls-pending-prerequisites
npm run test:static-hls-pending-native
```

直接运行对应 `.mjs` 入口也执行同样的前置校验。mutable tag、非 Linux daemon/
image、缺失路径或错误 PostgreSQL major 立即失败；脚本不自动 pull、下载依赖，
也不修改网络/安全配置。后续构建继续使用 `--offline --locked`、只读源码/
registry/config mount，执行固定 image ID。owner 容器保持 `--network none`；
pending driver 只加入本次 owned PostgreSQL 的 namespace。实际 PostgreSQL
启动后再次检查 server major 17。仅前置检查通过不能证明离线 cache 完整或
媒体/owner 行为正确；完整原入口还必须通过。

两项静态门槛尊重外部 `RAINSYNC_ARTIFACT_DIR` / `RAINSYNC_RUNTIME_ROOT`，每次
创建独立 target 目录。报告保留 source/image/config 摘要、pending driver
二进制摘要、PG 版本及各 owned container 清理结果。缺少这些运行结果时，应
记录“未验证”，不能写成 Linux owner、真实设备播放或发布验收完成。
