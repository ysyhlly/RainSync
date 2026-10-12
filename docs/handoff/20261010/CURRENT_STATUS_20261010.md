# RainSync 当前实现与验证索引

后续实现与本轮最终检查见 [2026-10-11 账号批次收尾](../20261011/ACCOUNT_BATCH_FINAL_STATUS.md)；早期前端/OAuth 检查另见 [账号边界集成](../20261011/ACCOUNT_BOUNDARY_INTEGRATION_STATUS.md)。本页各时间截点继续作为历史记录保留。

## 16:05 UTC 补充：错误证据链与 ORIGINAL 收尾

以下补充优先于后文 15:54 的历史截点。生产源仍与 `ffe4f7f` 相同；新的修改均限测试、验证命令和文档。

- YouTube 的整份缺失/falsy cleanup receipt 也已阻断，生产者 `53d7c7d59684d2cabdfeccf4ca9f4a39121fa948` 合入为 `76063a7`，最终独立纯复审通过。正常退出字段必须为 0/null，但 native 资格仍要求实际 ORIGINAL/CANDIDATE 运行、完整外层回执和无升级的有界 supervisor。
- 既有 shared owner gate 与 short/guest/kick 测试错误链由 `06ab1207e00df4a3b5a6f166366403e8b124a99b` 合入为 `f72ea93`：显式记录 falsy 失败；保留首错、清理错和写证据错；私有序列化捕获 getter/cycle 故障；终端不输出原始敏感错误。审查分别确认普通写入失败遮蔽首错的真实风险和非标准 falsy rejection 的注入风险，不把二者混为已观察到的产品故障。
- 独立 AST 核对保留三份 coordinator 的 167 条断言、95 段 SQL 及三组固定检查清单。19 项新纯合同显式登记进 backend 精确命令，未登记任何新增 native runner。共享 helper 已变更，因此历史 fixture/closure 哈希不能自动代表新版本；以后配对必须重新冻结两侧同字节测试与 helper。
- 本次六份纯合同联合 176/176 通过（新错误链 19 + 私库 15 + YouTube 82 + 既有 snapshot/response 58 + schema 2）。这些与 backend 门槛覆盖重叠，不累计为去重总数。
- 显式注册新纯合同后的最终 backend 348/348、CI verification 162/162、owner-gate 纯合同 25/25 全通过；backend 精确命令现在为23个文件，每个文件的漏项/重复负控均保留。没有运行 native runner。
- saved RainSync 的 queue-propagation ORIGINAL 单次 exit 0，10 次主断言求值、26 项后验通过；18 项绑定和23个保护程序未变。三个 WS 均观察到实际 close/TCP close，最终 CLOSED/destroyed；Node、Server、PG 退出、端口关闭、pg_ctl status=3。
- playlist-chat-regressions ORIGINAL 在范围预检 exit 2，**没有启动**。审查发现其房间命令事务执行播放会话更新与 cancel_jobs，进入排除范围，故没有重试或绕过。它不是测试失败，也不是通过。
- 两项结果归档由 saved 环境独立恢复核验：13,610,268 字节、2,490 个文件；SHA256 `9b7cee6279755216479f57c9cda8b1c387294ca158c41427e54ff09cb393edbe`。原始范围阻塞和 readiness 日志保留。主集成链读取了完成报告，没有在此工作区重新打开该远端归档。

新测试仍只有纯检查，没有新的 native 资格；旧 ORIGINAL 结果也不替代 CANDIDATE 数据库对照。候选传输/新分支发布仍待用户回应；没有新的 saved 环境任务、push、merge 或 deploy。

## 15:54 UTC 历史截点

状态截点：2026-10-10 15:54:05 UTC。本文件连接历史证据，不覆盖任何旧报告、失败、归档或授权范围；不是发布结论。

本次观察的已提交 HEAD 为 `526a5906fb7a5dfdfbabbe6a8ae252b5ed236afe`。相对 `ffe4f7f03450d2a59d89b309d63dfcf951590cc9`，已提交变化仅涉及新 private/YouTube native 夹具、其纯合同和文档，生产 Rust/前端源码没有变化。YouTube 正常退出 gate 与外层 supervisor 要求由 `db9658a5862df09cb20deb8248dafa390a37c6eb` 合入为 `526a590`，仍待最终独立复审；这里的 HEAD 和测试数不冻结夹具，也不赋予 ORIGINAL/CANDIDATE 运行资格。

## 如何阅读历史文件

- [README](README.md) 的历史正文和 [status.json](status.json) 的原有字段冻结于 13:26 UTC。其源码基线、提交数、远端 main、未推送数、草稿分类、未运行清单和 `cloud_role` 不应作为后续任务的现状。
- `pending-source-proposals.zip`、`pending-source-index.json` 和原 manifest 保持原字节。归档中某份候选当时“未应用”，不代表同类操作现在仍未实现；也不能把归档整份源码覆盖到当前集成树。
- ZIP SHA256 仍为 `7ea9f669b08e6092dc3d6bea46af0e4d1b60a2d467d5e2100ba36c6749c550e5`。此摘要属于旧源码草稿归档，不是下文 private ORIGINAL 运行证据归档。
- 原 `publication_authorization` 只记录旧交接的推送授权。新分支发布/候选传输仍待用户回应；不重复征询，不沿用旧授权，也没有 merge/deploy 授权。

## 已实现的阶段与原始证据

| 阶段报告 | 报告内源码/检查点 | 已集成范围 |
| --- | --- | --- |
| [五操作，14:19 UTC](FIVE_OPERATION_INTEGRATION_STATUS.md) | Rust/test `87be4e478769be23e084d07c0b5c477d4f0a3763`；后续 observer 修复保留在 `aebc55df2a3f132955261b848814e5a664a78e31` | kick、guest-policy GET/PUT、lifecycle、directory list/create、short-account status/import/unlink |
| [后续操作，14:50 UTC](NEXT_OPERATION_INTEGRATION_STATUS.md) | `e2b03519c2e92b9f28ffdb47b35e4d04fd8e2e8e` | preview 完整准入、playlist list/add/remove、选定账号及管理员设置的 unknown/parser 响应边界 |
| [私库入口，15:21 UTC](PRIVATE_LIBRARY_INTEGRATION_STATUS.md) | Rust `af1bb109fabf89b942d05772b26dbe9fc8dac01e`；Node/CI `27906dbf48d1b6c5ace26d10de335234a89c2714` | 全部 20 个 private-library HTTP 入口：10 个 library/grants/private-media、3 个 room-share、7 个 source/settings/scan |
| [YouTube 入口，15:33 UTC](YOUTUBE_INTEGRATION_STATUS.md) | `2bcd49107e7ac538a83b2222bb094c8bd0ad0407`；生产提取 `3b1dca2` | status/import/unlink 三入口，窄 RequestContext、启动 opt-in 与 import-only cipher 回调 |

这四份报告保持原样。它们的“pending”“断线待确认”或“正在编写”描述只对应各自时间；后续变化见本页。已实现不等于已通过真实数据库配对、浏览器、真实 provider 或完整发布验收。

当前源代码也保留这些明确边界：`apps/server/src/private_library.rs` 委托具名 catalog 操作；`platform_accounts/youtube.rs` 包含三个完整事务；`room_playlist_operations.rs` 返回具名结果。早期阶段已有 bootstrap/identity、房间持久命令、播放纯选择/前端 ports、Worker/NAS/compute、P2P/cluster 等局部提取；不能仅据模块存在就宣布对应整项计划完成。插件稳定 closed-catalog digest 已在 `apps/server/src/plugins.rs` 实现，不是待新做的空白项。

## 本轮纯检查与此前同源 Rust 结果

主集成执行链提供的本轮实际复跑结果：

- 最终联合五份 fixture 合同 151 passed / 0 failed：private 15、YouTube 76、既有 short snapshot/response 58、既有 YouTube schema 2。两份新增合同的 91 项包含在 151 项中，不另加总。
- 既有 backend 合同 329 / 0、CI verification 合同 160 / 0、owner-gate 纯合同 25 / 0。
- 五文件运行已覆盖 `526a590` 的 Server/PG 正常退出 receipt 严格 `0/null` 断言及其纯负控。它仍不是 native owner、HTTP、数据库、真实子进程或 provider 成功；正常退出与外层有界 supervisor 的真实证据仍待允许的 native 运行建立。
- 上述 backend/CI/owner 是分别执行的既有门槛，存在合同覆盖重叠，不能与 151 拼成一个去重后的总测试数。

Server 的 83 个 distinct tests、104 次实际调用（private flag false 下 83 次，true 下 21 次）来自 [15:33 阶段报告](YOUTUBE_INTEGRATION_STATUS.md) 中此前的同源执行，本次没有重新编译或重跑 Rust。447 个 Server tests 的 discovery 不是全部执行。此前 workspace check、严格 Clippy、provider parser 4/4 等结果仍归属该报告的源码及二进制绑定。

前端完整 168 文件/2,758 项、build/type/lint 和 bundle 4/4 仍归属 [14:50 阶段](NEXT_OPERATION_INTEGRATION_STATUS.md)，没有在私库、YouTube 或本次文档更新中再次计作新运行。旧 whole-workspace、Chromium、P22 计数同样保留原源码范围。

## Saved RainSync 环境中的 ORIGINAL 证据

以下是 saved 测试环境执行后转交主集成链的结果；本次文档更新只读其报告信息，没有独立重新打开原始运行归档。它们不是当前 CANDIDATE 的结果。

- kick ORIGINAL：修正冻结夹具后六组成功，18 binding artifacts 不变，正向清理通过；见 [14:50 报告](NEXT_OPERATION_INTEGRATION_STATUS.md)。其早期错误码失败和随后快照失败仍保留。
- media-preview ORIGINAL：exit 0，21 个 post-run checks；见 [15:21 报告](PRIVATE_LIBRARY_INTEGRATION_STATUS.md)。此前 26 MiB 空间 preflight 的 exit 2 仍是独立失败记录。
- private-library-expiry ORIGINAL：4 次 lock wait + 1 次 self revoke，exit 0，post-run 23/23。
- catalog-media-reads ORIGINAL：19 项，exit 0，post-run 23/23。
- catalog-scan-pages ORIGINAL：9 项，exit 0，post-run 24/24。
- 上述三项 private ORIGINAL 的 18 bindings、23 protected inputs 不变，7 个 ports 完成清理；证据归档 SHA256：`57ec5344a95a9194de2905094b820b4bc91a357e55cde0ba0e643a1e7f19a1fb`。
- 此状态截点的既有 playlist-chat / queue-propagation ORIGINAL 仍在运行中；不记成功，也不等于新 playlist authority 夹具或候选配对。

三项 private ORIGINAL 不能组成 20/20 私库入口完整验收，也不证明所有自然登录到期、配置 no-op、COMMIT 故障、物理释放或跨节点行为。CANDIDATE 仍需自己的独立源码树与成功 source/binary binding、相同已审定 fixture/helper 字节、独立工具路径/摘要/版本记录和正向 owned-service 清理。原版二进制绑定不可复用于候选。

## 新 native 夹具与尚未完成的部分

- [Private local mutations](../../PRIVATE_LIBRARY_LOCAL_MUTATIONS_NATIVE.md)：有限 metadata-only 的四组/36 个固定检查设计，已编写和纯检查；没有 ORIGINAL/CANDIDATE 运行资格或 native 成功，没有注册 package/CI。文档列出的锁等待、自然到期、全部入口 admission、COMMIT/retirement 故障等缺口继续保留。
- [YouTube native fixture](../../YOUTUBE_ACCOUNT_NATIVE_FIXTURE_20261010.md)：八组设计，正常退出 gate 和文档修订已合入 `526a590`，仍待最终复审，尚未冻结；没有 ORIGINAL/CANDIDATE 资格、native 成功或 CI authority-gate 注册。此前 `06d280a` 的纯检查仅属于此前版本；最终五文件 151 项也只是纯检查。
- [P20](P20_RESPONSE_BOUNDARIES.md) 只是局部实现：共享 transport 仍保留泛型 `as T`；QR、Bilibili renewal、OAuth、playback plan、其余生成 DTO/SQL 合同迁移不在已完成集合。现存 Bilibili/renewal/OAuth 代码仍有 App、事务和上游交互耦合，不据此临时发明一个“低耦合”生产改动。
- P08 两次拒绝仍有效，P09 及依赖播放范围继续排除。P11–P16 等历史局部实现不能建立 P08/P09 的完成结论；[P15 设计](../../design/WORKER_SCHEDULER_P15.md) 明确保留该限制。
- P22/P23/P24 的完整 ACK-pending room-close、物理子进程 drain、overflow/saturation、长稳、Windows/真实 provider、跨主机 TLS、升级兼容、确切离线 Docker 镜像、required checks 和最终能力矩阵仍有未验证范围。私库播放兼容入口仍在，不能未经调用方迁移便删除。

## 失败与限制不能被后续成功覆盖

全部原始记录原样保留；以下只是索引，不替代原报告：

- [13:26 交接](README.md)：kick 首次 403/FORBIDDEN 与夹具 GUEST_RESTRICTED 不符、0 组完成；两次 2 秒 FFmpeg readiness 失败；metadata 子进程 status=null；未解释 NAS 401；Library 上传 HTTP401；P2P Chromium 的 SUID/socket 限制。
- [五操作报告](FIVE_OPERATION_INTEGRATION_STATUS.md)：ENOTCACHED、Clippy stale import、short-account 合成 cookie 首次失败；kick 后续 SESSION_EXPIRED 虽正确但全行回滚快照失败。maintenance writer 归因只有相关性，没有直接写事务 PID 证明。后续修正/通过不删除这些结果。
- [后续操作报告](NEXT_OPERATION_INTEGRATION_STATUS.md)：package conflict markers、CI install 计数 105/106、Vitest player-recovery 原五秒超时及原限制重跑、registry 拒绝、preview 空间 preflight exit 2、observer 终止帧/清理缺陷及纯负控。
- [P20 生产者报告](P20_RESPONSE_BOUNDARIES.md)：默认并发时三个既有五秒超时与受限 worker 重跑分开记录；不把分轮测试拼成一次执行。
- [P15 设计](../../design/WORKER_SCHEDULER_P15.md)：Tokio stack overflow、heap-storage 修复和后续有限运行结果分别保留。
- [YouTube 入口报告](YOUTUBE_INTEGRATION_STATUS.md) 与新夹具文档：Cache-Control、expiry floor、unlink 锁等待模型、失败序列化/错误保留和退出门槛的修正属于夹具审查；纯 mock 不能代替 native 证明。

## 下一步边界

本轮能确定的独立收尾是这份现状索引，解决旧快照被误当现状的问题；没有确认一个新的、已审定且不依赖排除范围的低耦合生产实现项。继续完成现有 YouTube 夹具复审，按原授权核对正在运行的 ORIGINAL 结果；新的 private/YouTube native 调用必须另经执行准入。候选传输/新分支发布保持待回应，随后才能在适当权限和独立绑定下完成候选配对。

不操作用户电脑、不推送、不 merge/deploy，不重试或绕过 P08/P09 拒绝。本次状态核对按仓库 AGENTS 的 fallback 直接阅读源码，因为没有可用 GitNexus 工具；不声称有当前图索引/impact 证明。本次文档编辑没有运行 Cargo、native、数据库、socket 或网络。
