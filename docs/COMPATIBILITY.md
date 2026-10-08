# 兼容矩阵与升级边界

本文描述源码开发预览的接口范围。正式支持名单必须同时绑定精确源码 SHA、迁移集、
组件制品摘要、FFmpeg 构建和验收报告；下表不表示已经通过真机或长时发布验收。

| 组合 | 当前接口约束 | 安装与验收要求 |
| --- | --- | --- |
| Server / Worker / Web | 同一源码提交和生成协议；REST 路径 `/api/v1`，房间控制 `protocol_version: 1` | 默认整组升级；结构化错误 Web 可读旧字符串错误，其他跨提交组合需独立证明 |
| Server / NAS Agent / Compute | Agent 索引、媒体版本和计算任务均有专用契约；旧索引可能返回 `SOURCE_VERSION_REQUIRED` | 使用同一提交的后台镜像；重新连接和更新索引后恢复播放 |
| PostgreSQL | 默认 17；迁移校验和必须与安装版本及候选一致 | 禁止旧二进制直接连接未经证明兼容的新库；使用隔离新库验证升级/恢复 |
| linux/amd64 离线包 | 接受旧 schema 1 和新 schema 2；校验默认期望 amd64 | 三个镜像、来源标签、物理层、1.5 GiB 总预算与包摘要均核对 |
| linux/arm64 离线包 | 新 schema 2；必须显式 `--platform linux/arm64` | 原生 arm64 构建/离线程序探针与真实设备观影/恢复是不同门槛 |
| Chrome / Firefox / Edge / Safari | 根据浏览器报告与实际媒体选择 progressive、MSE、HLS 或平台原生 DASH | Android、iOS Safari 真机未在本文声明已验收；音视频编码、HDR、后台恢复逐项测试 |
| Jellyfin / Emby | 已有媒体选择、会话观测、续期、停止与回收代码 | 尚无对当前候选的完整固定版本支持名单；记录实际版本、真实媒体和完整生命周期结果 |
| FFmpeg / GPU | 日常镜像使用 Debian 包；正式路线固定镜像摘要、Debian snapshot、FFmpeg 包版本 | CUDA/NVENC、QSV、VAAPI 需对应设备、驱动、启动实测和并发槽位验收 |
| P2P / 控制集群 / NAS 计算 | 显式启用、授权及围栏检查；范围见 [高级功能](ADVANCED_FEATURES.md) | 每种开启组合记录开关、拓扑、故障与 HTTP 回退；不能从单机测试推断跨主机能力 |

当前没有通用 HTTP/WS/Agent 版本范围与 features 握手。独立业务版本字段不能替代通用协商，
也不保证任意新旧组件组合可运行。

升级前保存数据库与独立恢复材料、已部署镜像 ID、配置/密钥版本和完整迁移校验和。
在空缓存与隔离新库中验证旧库升级，覆盖登录、播放、seek、停止、Agent 与权限回收；
当前新旧组件组合使用 [隔离升级/恢复演练](../deploy/preview-transition.mjs)：
为实际基线和候选分别提供完整冻结源码、成功构建 binding、完整迁移集与二进制摘要，
同时在发布台账记录两个完整提交 SHA。工具拒绝同源/同二进制冒充升级；
升级后的迁移集合不被旧版本支持时，从原备份恢复到独立新库再运行旧版本。
不修改 SQLx 的未知版本或校验和检查来让旧二进制通过。

[近期基线 SQL 回归](../tests/current-baseline-upgrade.test.mjs) 固定
`bc0f9f1d8683ee27be581661d0e9dde36088fe55`（0086）并记录候选 HEAD 完整 SHA，
逐文件核对全部已发布迁移和候选字节，验证带账号/session/房间/媒体记录的 0086→0088
升级、guest 默认关闭，以及原基线和候选备份分别恢复到新库。执行前需完整 Git 历史、
`RAINSYNC_NATIVE_POSTGRES_BIN` 和独立的 `RAINSYNC_ARTIFACT_DIR`，运行
`node --test tests/current-baseline-upgrade.test.mjs`。此检查是合成 SQL/恢复证据，
不代替真实登录、播放、Agent 或两组实际二进制验收。

`tests/compatibility-rollback.mjs`、`tests/migration-upgrade.mjs` 与
`scripts/prepare-compatibility.ps1` 仅保留 0019→0022 的历史账号/profile 回归。
它们要求显式历史模式及冻结 0022 候选；不能作为当前版本兼容入口或当前通过凭据。
失败时使用已验证的旧镜像和原备份恢复到另一个新库，切换前检查两端连接。
不做降序迁移、不让旧二进制写入已升级的新库、不自动覆盖现有数据库。

发布台账应包括每个平台的 `source_commit`、Cargo/npm lock SHA-256、镜像与包摘要、
迁移版本/校验和、FFmpeg 包版本/构建证明、浏览器/操作系统与上游固定版本、
测试时间和报告摘要，以及明确的未通过项。构建步骤见 [运行制品](RUNTIME_ARTIFACTS.md)，
恢复步骤见 [备份运维](BACKUP_OPERATIONS.md)。

插件配置生命周期增加迁移 0084 与 `configuration_revisions` 读契约；删除后保留修订标记，
旧 Web 不具备重新安装时的完整围栏语义。使用同一候选的 Server/Web，禁止旧 Server 写入
已升级数据库；具体删除、重新授权与回退边界见 [高级功能](ADVANCED_FEATURES.md#内置插件配置的删除与重新安装)。
