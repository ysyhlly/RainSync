# 安装与运维入口

当前源码为开发预览，固定候选的制品、真实上游、设备与长时验收仍是发布前提。
安装负责人选择精确源码 SHA，整组使用相同 Server/Worker/Web/Agent 版本，
按 [兼容矩阵](COMPATIBILITY.md) 保存部署台账。

离线安装先按 [运行制品](RUNTIME_ARTIFACTS.md) 校验包，手动加载后只读核对
`--daemon`，从结果设置三个 `RAINSYNC_*_IMAGE` 的精确本地镜像 ID。
预先准备数据库、共享缓存和只读媒体绑定目录，配置私有环境文件；
使用同一项目名、环境文件和下列 Compose 顺序完成 `config`、启动 db、
[交互式创建首个管理员](INTERACTIVE_ADMIN_BOOTSTRAP.md)、再启动 Server/Worker/Web：
`compose.yaml`、`deploy/imported-images.override.yaml`、`deploy/loopback.override.yaml`。
已导入模式禁止构建/拉取，入口默认 loopback，公网 TLS 代理由负责人配置。
Nginx 需包含 `deploy/nginx-playback.inc.conf` 并验证 Range `206`。

日常维护检查 Server/Worker ready、任务和缓存预算、设备撤销、备份年龄及异常日志的
诊断编号。日志/报告不含 Cookie、播放签名地址、密钥、原始片源凭据或真实用户数据。
每日任务、异地副本、保留和真实恢复演练见 [备份运维](BACKUP_OPERATIONS.md)。
计算节点、P2P、控制节点等启用与排空回退见 [高级功能](ADVANCED_FEATURES.md)。
全局准入上限、恢复部署继承和生效边界见 [管理员设置](ADMIN_SETTINGS.md)。

`tests/deployed-smoke.mjs`、远程媒体、`tests/upstream-real-contracts.mjs`、
`tests/upstream-real-playback.mjs` 与 Jellyfin/Emby 脚本可能创建测试用户、房间、源、
会话或上游配置，只运行在负责人提供的独立测试实例和生成样本上。
按脚本实际前置条件提供测试二进制、固定上游镜像、输出目录与浏览器，
不把生产 `DATABASE_URL`、媒体、凭据或设备用于这些脚本。
短期契约结果与模拟网络结果不能替代固定版本完整生命周期、移动真机、
100 用户两种拓扑各 60 分钟、严格两小时 NAS 或同一最终候选连续 72 小时验收。
