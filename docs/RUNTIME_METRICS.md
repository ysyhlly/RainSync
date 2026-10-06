# 运行指标与验证入口

运行指标用于判断实际传输、任务和资源消耗，契约见
[传输指标](TRANSPORT_METRICS_CONTRACT.md)。授权、限流、固定聚合预算和身份脱敏
均属于指标路径自身的约束；不能因指标写入失败阻塞正常播放或把指标 ACK 当作媒体交付证明。
进程重启、连接取消可能丢失未上报样本；短期统计没有生产稳定性承诺。

验证入口包括 `tests/runtime-metrics-auth.mjs`（授权）、
`tests/runtime-metrics-production.mjs`（生产者接入）、
`tests/nas-uplink-metrics.mjs`（Agent 实际上行）、
`tests/runtime-metrics-types.py`（类型边界）与
`scripts/acceptance-measurements.mjs`（验收测量组织）。
各集成脚本需其要求的隔离实例、二进制和外部输出目录。

当前分发不包含可绑定当前候选的完整实机/长时结果。
报告须绑定精确源码/制品、固定样本、网络条件、拓扑、人数、开始/结束时间、
采样范围、原始证据摘要、遗漏和失败；P2P 收益要有同条件 HTTP 对照。
两小时 NAS、100 用户各 60 分钟、同一最终候选 72 小时与 GPU/跨主机扩展验收
需要各自完整证据，不能从单个指标测试通过推断完成。
