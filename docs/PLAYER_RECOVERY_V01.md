# v0.1 播放器恢复实现与交接

本次只完成客户端播放器恢复工作包。基点为 `ysyhlly/RainSync` 的
`integration/v0.1-next`，提交 `de0a3d23c73c03140157ecfdff7025a0dbff0fd7`。
工作分支为 `feature/player-recovery-v01`。公共协议、迁移、后端方案事实、
主入口与集成总控均未修改，未部署，也未推送远端分支。

## 校准与恢复

原运行时已有 visibility 唤醒处理；这里修复的是唤醒后旧 offset、旧纠偏器
和迟到校时回复仍可参与同步的问题。

- `Clock.reset()` 同步清空样本、offset 和 pending 请求，并增加本地 revision。
- 每个校时请求登记当前 epoch 与实际发送时间，最多保留 24 个，回复有效期
  为 5 秒。现有 `t1` 字段用作唯一关联键，不跨重置复用。粗粒度或倒退时钟
  下，关联键可与发送时间不同；RTT 与 offset 始终使用登记的真实发送时间。
  服务端仍按原 wire 原样回显 `t1`，没有增加协议字段。
- 回复必须来自当前物理连接，匹配本轮 pending 请求及当前 `clock_epoch`；
  重复、过期、上一轮、上一条连接和错误 epoch 的回复均不能使 clock ready。
- 新连接先取得 RESUME 的 SNAPSHOT，才允许采样。连续 revision 的 EVENT/ACK
  不能替代快照。HTTP 返回新 epoch 时同样重新确认快照；新 epoch 的较小
  revision 不按旧 epoch 的 revision 拒绝。
- 只有真实 hidden → visible、persisted pageshow，或明确计时异常触发唤醒
  重校准。visible → visible 与非 persisted pageshow 没有播放或校时动作。
  计时异常判据是单调时钟倒退、间隔超过 10 秒，或超过 10 秒的墙钟间隔
  中有超过 5 秒未体现在单调时钟上。正常 tick、定期校时不重置样本。
- 断连、离房和纪元变更也立即清除校准与纠偏。已有媒体恢复到房间基础倍速，
  等待新鲜回复时继续已有播放，不因校准暂停或重建播放会话。
- 普通恢复交给原纠偏器收敛；明确 metadata/显式 seek 所需的 force/userSeek
  参数保留到校准完成。正常路径保持 150ms 死区、2s 硬 seek 阈值、±5%
  微调、15s 收敛期限、5s 自动 seek 冷却；显式 seek 不受自动 seek 冷却限制。
- 异步 play 与生成恢复核对本地 clock revision、播放方案、元素与最新状态。
  晚到的 play 不覆盖更新的 PAUSE、Stop 或校准轮次。自动播放受阻后等待
  用户手势，不每个 tick 重新调用 play。

## 可定位区间

可定位必须属于 `seekable` 中的某个真实区间；原生播放未提供 seekable 时，
使用真实 buffered 区间。有限 duration、最后一个 end 或 min/max 包络均不能
授权向内部空洞 seek。区间读取异常按无可用区间处理。

直放目标不可定位时保留当前点并显示拒绝提示；已有后段区间仍可正常定位。
需要新方案的显式 seek 使用现有播放代次/有限恢复路径。初始没有区间时，
允许正常 play 建立缓冲，但不能提前写入目标 currentTime；区间出现后继续
待处理的 metadata 定位。生成中的清单保留原有有界恢复机制。恢复时目标落在内部空洞，
则退出追赶等待并显示拒绝提示；目标超过真实区间尾端则等待清单实际增长，
不以有限 duration 判断已可定位。

## 倍速行为与稳定降级

基础速率限制跟随当前 room-core 的 0.25–2.0 约束；细微纠偏限制在该基础速率
的 ±5%。setter 抛错、忽略写入或读回夹紧均视为属性行为拒绝。只有连续三次
稳定读回，才记录细微倍速的本地行为证据；这不证明硬件或解码器支持。

细微倍速被拒绝后恢复已验证的基础倍速，停止重复写入无效细微速率；同步
使用 500ms 稳定窗口和原有有限 seek。已接受写入在后续 tick 继续复核读回；延迟夹紧或读回失败也会锁定，
不会沿用缓存的支持结论反复写入。基础速率本身被拒绝时显示“本地播放器
不支持此速率”，停止微调与自动 seek，直到速率、元素改变或显式重载再试。
通过现有房间错误展示路径提示；鉴权或媒体错误优先保留，倍速恢复只清除自己的错误。
不得改写用户选择的房间速率、权威状态或时间轴 origin。校准等待和后台期间
恢复基础速率，不进行同步纠偏。

## 遥测与所有权

运行时对指标/观察的创建、读取、采样、绑定、完成和停止使用异常隔离。
遥测同步异常或慢请求不能阻止核心播放、会话 DELETE 与请求 key 撤销；成功
的 observation-v1 Stop 顺序保持不变。

独立审查发现 `observation-binding.ts` 与 `metrics-binding.ts` 内部事件/帧回调
的异常清理仍值得加固。这两个文件不在本次授权范围内，本次没有修改。
运行时边界已保证核心动作继续；绑定模块内部资源清理需由集成总控协调。
前台追赶状态展示、长期运行与 Android/iOS 真机验收也留后续验收，不据本次
单元测试宣称已完成。

## 验证与复现

针对性回归覆盖：当前请求关联、迟到/重复/错误纪元回复、24 个 pending 上限、
过期回复、粗粒度与倒退时钟、连续隐藏唤醒、persisted pageshow、断连重连、
首快照前回复/事件、新 HTTP epoch、正常周期采样、真实 room/player 联动、
区间空洞、倍速抛错/忽略/夹紧、受阻自动播放、晚到 play、显式 seek 延迟与
遥测失败下的 Stop。

2026-10-01 最终验证：`npm test` 通过 28 个文件、244 项测试；显式
`vue-tsc --noEmit` 类型检查与 `npm run build` 均通过；格式检查和
`git diff --check` 通过。Vite 提示产物 chunk 超过 500kB，构建成功。

最终交付包含完整提交序列、单个补丁、逐提交 patch、带基点 prerequisite 的
Git bundle、SHA256 清单及测试日志。先核对清单，然后可在已有基点的仓库执行：

```sh
git bundle verify rainsync-player-recovery.bundle
git fetch ./rainsync-player-recovery.bundle feature/player-recovery-v01
git switch -c review/player-recovery FETCH_HEAD
```

或在独立分支的基点应用逐提交 patch：

```sh
git switch -c review/player-recovery de0a3d23c73c03140157ecfdff7025a0dbff0fd7
git am patches/*.patch
```

完成后运行 `npm test`、`npx vue-tsc --noEmit -p apps/web/tsconfig.json` 和
`npm run build`。不包含长期、服务端或真机验收；本交付不代表全项目首版完成。
