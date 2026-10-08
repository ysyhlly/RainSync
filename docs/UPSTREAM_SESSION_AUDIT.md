# 上游会话观测与核对范围

Jellyfin/Emby 播放会话由 RainSync 预约、观测与回收账本协调。
观测绑定当前用户、确切登录、房间成员代次、播放会话和媒体代次；
版本 1 样本包含位置、速率与单调序号。相同序号只可重复相同载荷，
冲突、旧序号和非法位置使用 [公开错误码](API_ERRORS.md)，不盲重编号重试。
停止本地会话与清理上游的失败有独立状态，不能因远端异常继续授予播放。

核对时覆盖开始、暂停、seek、速率、续期、停止、退房、房间关闭、
单个登录撤销、上游超时、进程优雅退出和重启后清理。
入口包括 `tests/upstream-reservations.mjs`、`tests/upstream-observations.mjs`、
`tests/upstream-graceful-shutdown.mjs` 和 `tests/room-cleanup-upstream.mjs`；
真实固定产品契约与完整 RainSync 播放入口分别为
`tests/upstream-real-contracts.mjs`、`tests/upstream-real-playback.mjs`。

本文是分发内的契约及验证导航，不是当前候选已通过的审计报告。
受控服务/短媒体解码不能关闭真实 Jellyfin/Emby 固定版本完整浏览器生命周期，
也不能证明长时会话回收、弱网同步或生产兼容性。报告需记录精确候选、
上游版本/镜像、样本摘要、测试时间、失败与未验证项。
