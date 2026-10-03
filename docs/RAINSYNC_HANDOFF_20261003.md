# RainSync 开发交接 — 2026-10-03

## 当前交付结论

本轮已停止新增功能，交付可复核的本地集成、未合入的源码快照和剩余工作。原计划19项没有全部完成；代码实现、纯测试、短时真实试验、正式验收分别记录。交付分支的最终 commit/tree 以同包 manifest 为准，不能把本地提交或 bundle 当成已推送、部署或发布。

已完成的主集成代码检查点为 `d44f5fbc3e7b6f5f0c5a77b1336773a045e3caa0`，后续 `cc10505fbe5187b94d6f045393bf40f000c3e152` 只补 pending HLS 授权检查的统一750ms预算。最终收束的操作合同分片已合为 `0c9eac810c54f9a47643342c1cf88c68cecdb289`，代码 tree `07ee39672a14ce3ba9afe6ab099fc7431f58321d`；后续交接文档提交只改变文档。

主集成工作树：`RainSync-partial-plan`，开发分支 `feat/partial-plan-batch`。基准代码树为 `e37a18dd32ad338e2ff14ef08a57399af90913bf`，本地 `6a1f969` 与此前已发布的 `af3fad7` 源码等价。旧本地 `integration/v0.1-next` 指针停在浅历史边界，不能误当最新交付分支。

## 已落地的主要行为

- 本地媒体 probe、元数据、版本和实际 job 绑定；Worker 拒绝不匹配。文件 stat 版本只能检测普通变化，不等于字节不可变快照
- 当前 v0.1 房间、邀请、播放请求和排队控制的权限复核；单登录媒体授权绑定及批准的旧票据策略 B
- 四条具体候选路线及输出事实解释、严格 HEVC/AVC sample-entry/config 判断、缺事实拒绝；新增 local/reliable-HTTP 最终 job 门禁，避免分析正片却按旧 Worker map 转封面/错音轨
- 有界、逐跳重验的媒体 GET/HEAD redirect；最终 URL digest/representation 绑定；API/POST 默认不继承跟随策略
- 首次呈现计时及 fallback 代次预算；timeout 不自动产生 decode-failure 授权
- v2 播放指标与真实 Worker 首次输出入口 cohort、queue 累计、原 grant 首帧归因和 exact-login 接收门禁
- 房间/媒体/lifecycle/restart 的 v2 事件重放与冻结 v1 语义
- 配置/启动诊断、版本锁定、切换/备份恢复工具；证据、时间码、同步、soak 调度和自有故障测试工具
- 有限静态 HLS 的 capture/scanner/sealed owner 前提、严格纯合同和 pending-only0044存储。公开 parent/child fallback、生产激活仍关闭

## 原19项的逐项状态

“已补代码”不代表所有环境验收完成；表中的缺口是交接时保留的真实边界。

| 计划项 | 当前实现 | 仍需完成或验收 |
|---|---|---|
| §7.4 数据模型/迁移 | 实际 source/version/receipt/cache 绑定已补；未机械添加无用途草案列；0044 pending custody 已实现 | 0044真实迁移、SQL、锁等待/MVCC、约束/回滚及升级验收未运行 |
| §8.1 具体能力 | 本地/可靠 Binary HTTP 的具体 codec/config/输出事实；正片/默认音轨 helper；旧 map 等价安全门禁 | 更广 provider/source/device 矩阵；新 indexed recipe 未启用，旧 Worker 不懂新字段 |
| §8.2 可解释路线 | 四路线决定、copy/encode 区分、音频/SAR/VFR/rotation/no-audio/保护内容错误；mapping 专用说明 | 更广 upstream 事实、真实音轨/字幕/输出选择覆盖 |
| §8.3 deadline/fallback | 呈现预算和 HTTP continuation；有限 HLS capture、纯合同、pending存储；统一750ms检查 | 原 owner/RPC、父资源完整重验/读租约、原子发布、child队列/recipe和实际 Worker 激活仍未完整接入；公开关闭 |
| §8.4 上游权限 | 新授权 exact-login 与 B 兼容策略；受控协议模拟通过 | 两个固定实际 Jellyfin/Emby 产品的库/账号/token/权限变化完整矩阵；模拟数字不能合并成产品验收 |
| §9.1 redirect/CDN | 显式策略、1–5跳、每跳 origin/DNS/CIDR、凭据范围、最终 identity | 实际授权 TLS/CDN 验证；独立 CDN 凭据和旋转最终 URL continuation 未支持 |
| §11.2 时间轴 | 明确连续原点合同；非关键帧/小数 seek 和 sealed-HLS helper 有独立像素/PCM证据 | 更广 upstream/direct/browser时轴；Stage B recipe接入。v0.1可明确拒绝无法归一输入，无需伪造通用分段映射 |
| §9.4 Agent资源边界 | 当前保护和测量工具保留；此次不触碰被阻断实验 | 16+1并发、撤权/重启、慢读、RSS/FD和2小时实际资源证据；可信回执是前提 |
| §12.1 指标 | v2阶段、队列/运行累计、入口cohort、不可变首帧归因与任务事件已实现 | 独立真实producer/故障恢复时间相关性和持续运行；未知值不可补零或补warm |
| §12.2 双客户端同步 | 独立校准、原始样本/不确定性、rVFC和可见时间码工具 | 两个真正独立客户端/页面的30分钟重复测量；不得用被测目标时钟算法自证 |
| §12.3 N1–N6网络 | 场景/证据协调合同和自有应用级fixture | 隔离且经授权的双向包级故障/测量 adapter与真实实验；应用fixture不是netem证据 |
| §12.4 72h长稳 | scheduler、qualification、owned workload、部分F1/F2/cache工具；纯PG模型 | 正式镜像/呈现/容量 factory、生产F1/F2恢复、F3隔离卷，以及完整连续72h；未运行 |
| §12.5 证据收集 | source/binary/hash、日志、失败保留、redaction和结果索引 | 收齐最终候选的真实运行、失败和清理证据；不能只交成功片段 |
| §13.1 启动检查 | 支持配置/权限/目录/cache/可达性诊断；明确拒绝不完整split-origin拓扑 | 实际部署客户端/Agent拓扑验证；不声称所有拓扑都支持 |
| §13.2 固定交付/回退 | 工具锁定、build/preflight、preview切换及兼容恢复工具 | 实际amd64/arm64镜像、支持版本组合；Stage B/indexed需新的真实Worker兼容/停旧屏障 |
| §13.3 恢复链 | 自有preview材料的配置/source-key/Agent凭据链工具与早期演练 | 最终候选、真实授权材料和实际部署的全链恢复；不得输出真实凭据 |
| §20.2 lifecycle未知释放 | closing/unknown可见且保留义务 | 需要可信原始进程/资源闭合证据；UUID、超时、管理员断言不能代替 |
| §21.1 角色一致性 | 当前v0.1 REST/WS/排队控制/媒体入口已补 | 最终组合负例仍须验收；§21.4把完整私人库/Moderator模型放在后续，不纳入本次暗中扩展 |
| §22.3 事件重放 | v2 typed resolved输入、纯投影和v1冻结fixtures已实现 | 最终实时导出/持久化状态一致性；重放不证明外部副作用发生 |

## 验证检查点与精确证据

各行只证明其绑定源版本，不能跨版本累加成“当前全套通过”。完整索引和历史失败保留在对应目录。

| 检查点 | 已实际完成 | 证据位置/绑定 |
|---|---|---|
| 登录/指标组合 | 515 Rust、720前端、26权限、25排队权限、12诊断及33指标组；早期ENOSPC/cleanup错误保留 | `PARTIAL_PLAN_VALIDATION_20261002.md`，`tooling/partial-plan-login-metrics-frozen/backend-binding.json` |
| 能力/redirect组合 `4a008f2` | capability12/redirect4/local版本7/指标33/cohort5/wire5/login7；受控服务与实际产品分开 | `PARTIAL_PLAN_CAPABILITY_REDIRECT_20261002.md`；source digest `f31d5a259087b5af1675358c4aa52b495fcf327f5d79020c68660725fcc7816a` |
| Stage A关闭状态组合 `f7b6fe9` | 615 Rust测试调用、85 Node+4skip、724前端、strict Clippy/build；22 ignored标记保留 | `tooling/partial-plan-static43-validation-index.json` SHA `81454f92c8b96f1e07ff45d3f5efd92ae82deeb72a839e054e9af2e3ee659bc6` |
| HLS纯合同 `cd618e1` | 136选定Rust、13 Node、724前端及编译/build；修前两负例失败、修后通过 | `tooling/partial-plan-cloud-hls-integration-verification.json` SHA `b57e665384faf831ff38404adbc7478a45bc788d4233c52e167032103ad2cbf9`；Rust1.98.0 |
| 正片/音轨helper | 29纯测试、11有界FFmpeg/FFprobe命令，蓝色正片+显式约878Hz/默认约440Hz，原进程正向清理 | `tooling/motion-video-selection-final-frozen.json` SHA `8be939635107190b3d8e460c58289c40fbf78b2813c4151079bc6c648b244436`；实际cover在后，cover在前只纯元数据 |
| 0044 pending-only `6d82891` | 8纯测试、check、严格Clippy、独立SQL/callsite源码复核 | `tooling/partial-plan-pending-custody-integration-verification.json` SHA `f92d7775473a84b64dbecd81424b0f3cf324460918b918b25f378916dfef399a`；SQL未跑 |
| 当前组合 `d44f5fb` | 85相关Rust纯测试、59新Python模型、五包all-target check/Clippy、fmt；833源hash不变 | `tooling/partial-plan-composed44-mapping-model/verification.json` SHA `d2b3c0969dcf6003a981542c6406dc8010948b3e6283828dfdaa7a1b74c9a967` |
| 750ms修复 `aee43b7`→`cc10505` | 18纯测试（13新+5原）、严格Clippy；独立源码复核 | `tooling/artifacts/pending-authority-deadline-20261003/final-report.json` SHA `a20a6b27f9a230f592cc1c21d0f2e41ebbaca6d0359127647b8c376d81059c48` |

PG模型最终 `2c33d05` 的174项供应方记录包含59新模型+115原fake/static测试；当前本地只重跑59新项。模型没有运行权限，不能当实际Popen/pidfd/waitpid回执。被否定的初版 `d10055a` 不能单独回退采用。

## 兼容性与风险

1. 用户已选择策略B：旧无登录绑定票据保留原expires_at，不延长，不派生新的无绑定授权；重新播放使用新viewer/key的专用恢复只在可信的“确定未创建”错误后一次触发。200续期响应必须报告原到期时间，不能客户端自加TTL
2. 0041之后，不支持回退到不了解caller-origin的旧Server。当前exact契约比较不表示所有更高版本自动兼容；更新契约需成对审查。B兼容不等于redirect reader兼容
3. 0044需静止迁移窗口；NOWAIT忙则整个事务拒绝。历史capture缺request关联必须真实abort，不能补造归属。未验SQL不宜直接部署
4. 新indexed recipe仍关闭。旧Worker忽略新video-index字段，所以不能只加JSON字段就混队列发布。现交付仅在能证明等价旧0:v:0/0:a:0?时继续签发旧job，否则明确拒绝
5. HLS阶段的文件容量上限按实际文件字节计，不等于文件系统分配空间；capture35s、调用等待40s、disposal等待10s、ACK5s是不同预算。等待返回不代表物理闭合或释放reservation
6. 未达到约束的源、未知timeline/codec/identity和新旧worker兼容必须明确拒绝，不能靠宽松推测把不支持伪装成支持

## 未闭合的运行责任

旧F2运行 `15e2d8bb-b544-4985-9b72-c69dd5598d81` 的失败结果保持不变。Worker/FFmpeg已确认结束，原PostgreSQL根进程及17个子对象退出未确认。精确只读映射没有匹配，未发信号；原控制/观察句柄已无法可靠恢复。停止继续映射/控制尝试，不扩大PID、不nsenter、不killall，不移动/删除其数据或用另一个namespace的成功清理替代证据。旧已知端口33535、33637不复用，另一个旧Server端口未知，不猜测。

较早HLS stack failure同样保留actor/disposal unknown；后续独立成功运行不抵销它。未知义务继续阻止相应释放，不接受撤销的Agent凭据、管理员断言、UUID文件或超时作为回执。

新的独立PG正常流程只在WIP设计/静态adapter阶段。一次六秒短命child的cross-exec file RPC stop已实际通过，只证明那次固定child的控制路径；它不证明PG子树或异常关闭。没有新PG运行授权或验收。被阻断的NAS/Agent WS receipt实验、CodeGraph外传和浏览器EPERM路径均未通过其它方式绕过。

## 工具链与后续复核

当前任务本地 `tooling/env.sh` 配置Rust/Cargo1.98.1、PostgreSQL17.11；原生媒体证据使用已绑定FFmpeg版本。云返回的HLS组合用Rust1.98.0，已明确区分。新环境必须自行核版本与文件hash，不假设相同绝对路径存在。

可使用原有已授权纯检查方式：`cargo check --offline --locked --workspace --all-targets`、针对明确纯模块的 `cargo test --offline --locked -p <package> <filter>`、`cargo clippy ... -- -D warnings`、前端npm脚本。不要无筛选执行会创建服务/原生子进程的fixture。0044 SQL测试仅已写，未经实际运行。

本任务曾因共享target跨worktree复用错误rmeta出现编译失败。后续组合验证须独立target，或在独占目标锁后只使当前workspace包fingerprint失效；第三方缓存、冻结binary、源与证据不动。当前保留脚本 `tooling/invalidate_workspace_fingerprints.py` 和每次retirement.json记录，参数/源码归属须核对。构建使用 `CARGO_INCREMENTAL=0`、`CARGO_PROFILE_DEV_DEBUG=0`、`CARGO_PROFILE_TEST_DEBUG=0`。磁盘接近10%余量，不降低运行门槛，也不清理未知scope来让测试通过。

建议恢复顺序：先完成独立新PG owner的具体源码/配置/cleanup复核并获单次正常运行许可，再验证0044及最终服务组合；随后按Stage B分片接真实owner/RPC、父读取/发布与child。正式网络、浏览器/设备、镜像/架构、72h分别验收。不要继续堆未消费DTO替代实际链路。

## 源码包与未合分片

源码包包含交付ref、各相关已保存分支和未完成源码快照；不包含真实凭据、运行目录、PGdata、node_modules、target、冻结服务binary或媒体数据。历史native-faults的staged源码等价于 `handoff/20261003/native-faults-source-only` 的 `f3713016a9e9fdf8dbf2c706d33a9fbb54c84c03`，只保存源码，F2未验收，不合入当前主交付。PG正常adapter WIP独立保存，绝不当成可运行或已审通过的实现。

仓库是浅历史：边界 `464dc39fba02431807aef0bb924fd0b0e46ba11a` 的父对象不在原仓库。源码快照完整，不代表历史完整。包内SHALLOW必须保留；不要伪造graft或把producer中的bundle verify当成全历史证明。导入后按manifest逐一核对commit/tree/源文件，WIP只checkout审阅，不能自动merge。


## 最后收束快照

- 操作DTO/codec：原分片 `db5fe0742ab1d147281c8234bb1a9dd1c55cec3c`，26纯合同（8新+18原）、3纯cipher及严格all-target Clippy通过；独立复核修正了capture ID与operation ID绑定、verified音轨/child root绑定。已合为 `0c9eac8`。证据 `tooling/artifacts/hls-operation-final-evidence.json` SHA `a0d8517bdaddde1567333fd777d450248d800dd46c55bf58cb09c3f8ae3b109c`。这是未启用的DTO/codec，尚没有真实RPC endpoint、owner registry、一次性nonce消费或运行时授权证明
- PG正常生命周期WIP：`source/owned-pg-normal-adapter`，commit `b927b341b4e9f5b2f43e94c08cc4c14ab7dfe408`，tree `fadf966b327868607fb733ced188df7c1bd1d928`。只新增1259行真实syscall adapter草稿及162行WIP交接，入口硬禁用；AST/whitespace通过，0 adapter测试、0运行。已知阻塞含消息发布竞态、pin关闭同步、正常family/config/dependency绑定和未验异常退出。不可运行、不可直接合并
- PG包来源只读核验：已核Debian archive签名及Sources→DSC→orig/debian archive的hash链，选取26个源码数据文件供后续审查。索引 `tooling/pg-normal-source-review/source-chain-verification.json` SHA `89c92a5bf5898d5ad0e306bd11e42a005127352aae8e3819cd939252ea4d58de`。首次gpgv不存在的失败日志保留，后续实际gpg验签通过。来源核验本身不赋予normal-family运行/关闭证明
- 所有源码实施已停止；WIP与完整历史分片在源码包中独立保留。未跟踪node_modules与实验运行目录没有纳入源码包，也没有删除

最终代码 `0c9eac8` 的合成收尾已重新执行三包all-target离线编译，通过；只移出workspace fingerprint后构建，8个deadline/codec变动文件逐项匹配已审已测分片。未重复整仓测试。索引 `tooling/partial-plan-handoff-final-verification.json` SHA `d7f5b91bf377fedc14270fe749b28c3c62fed42efde58302064bbce3b901e2d8`。
