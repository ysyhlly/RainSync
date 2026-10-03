# 本地媒体探测与版本绑定

## 范围

落实 §7.4 中本地来源的最小新鲜度闭环，不新增未消费的数据库列或迁移。复用现有 metadata 中的 `preview_file_version` 与播放资源/任务 spec 中的 `source_version`。

- 扫描、具体候选预检和新播放准备共用本地探测 helper：先安全解析来源相对路径、打开文件并取得句柄身份，运行真实 ffprobe，再核对持有句柄与重新安全解析/打开的当前路径
- 探测期间替换、修改、消失或路径失效均不能把旧探测标记成新身份；扫描保留条目但不保存失败探测的事实，播放准备返回 `SOURCE_CHANGED`
- 所有新本地播放准备都进行该探测，包括没有 candidate report 的客户端；模式、音轨、时长、回退和容量估算使用这一次探测。未知时长不沿用旧条目时长
- 新本地直放资源和转封装/转码 job 都绑定同一个已捕获版本；具体候选报告也与它比较。最终现有准入、来源策略、房间/媒体代次和本地身份检查仍保留
- Worker 继续使用现有交付、开工、周期及最终身份检查。已持久化且没有版本的旧资源/任务保持原有兼容行为，重放不虚构历史绑定

版本由 stat 身份信息派生，包含设备/文件身份、长度及修改/变更时间。它是常规替换和编辑检测，不是媒体内容哈希、不可变文件快照或跨会话强复用保证。ffprobe 仍通过路径读取，检查之间及最后检查之后存在 TOCTOU 窗口；侧挂字幕也没有获得内容不可变承诺。本次不改变 Agent 或 HTTP 的来源协议，也不关闭真实设备、持续负载或发布门槛。

## 可重复验证

Linux 的独立入口 `tests/local-source-freshness.mjs` 要求现成且源代码一致的构建绑定，不在测试中构建或使用不明二进制：

```sh
export CARGO_TARGET_DIR=/absolute/owned/cargo-target
export RAINSYNC_RUNTIME_ROOT=/absolute/owned/evidence
export RAINSYNC_ARTIFACT_DIR=/absolute/owned/artifacts
# 预先配置已安装的 Rust、Node、FFmpeg 与隔离 PostgreSQL 工具。
node scripts/bind-native-backend.mjs
export RAINSYNC_LOCAL_FRESHNESS_BINDING_FILE=/returned/backend-binding.json
node tests/local-source-freshness.mjs
```

入口使用隔离数据库和自建媒体，通过正常房间 WebSocket `CHANGE_MEDIA` 选择影片。真实 FFmpeg 生成 H.264/AAC 2秒和无音轨 MPEG-4 6秒样本，覆盖：

1. 无具体候选的新直放资源绑定当前探测版本
2. 扫描之后、准备之前替换文件，模式/时长/音轨和 job 版本一起更新，旧音轨选择拒绝
3. 排队后、Worker 启动之前替换，任务失败 `source_changed` 且无发布产物；旧直放交付拒绝替换，重放不改写已记录身份
4. 明确标注的隔离旧记录注入：移除旧资源版本，再重放/交付仍不自动补绑；Rust 单测另验证没有版本的旧 job spec 保持原样
5. 真实 ffprobe 完成后、Server 读取结果前设文件屏障，替换扫描输入，确认旧探测未被盖成新版本
6. 同一确定性屏障替换准备输入，返回 `SOURCE_CHANGED`，没有新增 session/job，也没有更新探测元数据
7. 本地具体候选与本次准备的探测身份一致；旧候选在替换之后拒绝，候选预检期间替换也不保存错误绑定

屏障只包装真实 ffprobe，不伪造输出、不修改生产探测代码、不运行 Agent。报告绑定全部后端输入、二进制与测试协调文件 SHA256，前后复核，并记录真实媒体与工具版本。Server/Worker/PostgreSQL 的关闭事件、PID 消失与监听端口关闭分别验证。超时只能使测试失败，不能作为回收或通过依据。

## 本轮验证状态

2026-10-02（UTC），本分支隔离验证通过：

- `cargo fmt --all --check`、Node 入口语法及 diff 空白检查通过
- `cargo test -p media-core file_version::tests --locked -j 2`：1项
- `cargo test -p rainsync-server playback_plan::tests --locked -j 2`：4项
- `cargo test -p rainsync-server playback_capabilities::tests --locked -j 2`：2项
- `cargo test -p rainsync-media-worker source_version::tests --locked -j 2`：2项，包括旧 job 不补绑
- `cargo clippy -p rainsync-server -p rainsync-media-worker --all-targets --locked -j 2 -- -D warnings` 通过
- `npm test`：690项；`npm run build` 通过，保留既有 bundle 大小提示
- workspace 二进制/示例冻结构建通过；真实本地入口7组全部通过，`09:04:57.597Z` 至 `09:05:03.782Z`。两次 Server 进程、Worker 和 PostgreSQL 均有退出事件、PID 消失与端口关闭证据

证据目录为任务本地 `tooling/artifacts/local-source-freshness-checks`。最终 `report-3.json` SHA256：`d027e8b860f7897673deaa0db80b74da11a3fb0dd7c40cc7090443be0b6235e1`；后端输入摘要：`e2b0d1b04d5820cfd2c4516123a72433570651d1336f1f6580da46c7c57c18ab`；构建绑定摘要：`f369aaba9c7a81a1ec5057640095bb1161e3d36037682237f87cd5a699f9e7c0`。报告和生成媒体、数据库、日志未提交仓库。

保留两次入口问题：首轮在无候选直放绑定通过后因夹具同时保留两份授权而触发默认会话限额，按正常 DELETE 收尾及重排检查后修正，没有放宽生产限额；另一启动在并行 Rust 测试重链接 Server 后被二进制哈希校验拒绝，未进入运行断言。最后在所有 Rust 检查完成后重新冻结并串行运行，前后绑定一致。

这是本地功能回归，未运行含 Agent 场景的广泛候选套件、完整 workspace 测试、浏览器或持续负载。既有 `playback-plan-facts.mjs` 的本地决策原因断言已改为 `local_automatic_direct_authorized_probe`，其混合上游整套本轮未执行。未发布、合并主线或部署。
