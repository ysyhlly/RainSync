# 播放器恢复增量：追赶状态 UI

本工作接在 binder 增量末端
`8c3a1fa7d598e53a5b8233b2b8210fb2e6ed0389`，仍使用
`feature/player-recovery-v01`。原四提交、binder 第五提交及此前两个交付包均
保持不变，本 UI 工作新增单独第六提交。这里完成的是播放器恢复工作包的
最小状态接线，不代表全项目首版或真机验收完成。

## 状态与显示

`playback-runtime.ts` 暴露独立 `recoveryState` 与只读计算文案
`recoveryLabel`。既有 room-runtime 的 `...playback` 已提供出口，无需修改
共享接线、公共协议、后端事实或主入口。

| 状态             | 用户提示或含义                                             |
| ---------------- | ---------------------------------------------------------- |
| calibrating      | 正在重新校准房间时间…                                      |
| catching_up      | 正在追赶房间进度…                                          |
| waiting          | 等待播放就绪后追赶…                                        |
| blocked          | 等待点击加入播放；原手势按钮保留                           |
| unsupported_rate | 本地播放器不支持此速率；停止无效自动收敛                   |
| reconnecting     | 正在重连，连接后重新校准…                                  |
| idle             | 当前没有需要展示的恢复过程，不作硬件能力或全局同步精度声明 |
| background       | 后台不显示前台追赶提示                                     |
| failed           | 保留既有鉴权/播放错误路径，不继续宣称追赶                  |

PlaybackHost 在原 `role="status"` 提示位置显示恢复文案；无恢复提示时仍
使用原准备文案。普通/全屏提示位于视频面板内、自动隐藏的控制栏之外；迷你
播放器使用现有 caption 内的 span，避开全局隐藏 buffering 和移动布局隐藏
caption p 的样式。三种播放器使用同一状态。PlaybackInformation 读取同一 store，连接文案明确
为“房间连接正常”，并显示恢复文案副本；副本 `aria-hidden` 避免与 Host 的
live status 重复播报。没有因 connected 而显示“已同步”或“同步完成”。

恢复状态不借用 waiting/blocked，也不改写 error。基础速率拒绝有独立状态，
即使原鉴权/媒体错误或手势按钮同时存在，也不会把不支持速率说成正在收敛，
已有错误与按钮仍可见。成功确认新基础速率仅按原逻辑清除自身速率错误。

## 关键不变量

- 真实校准失效及当前加载意图才开启恢复过程。普通 tick 的轻微漂移、周期
  校时、visible → visible 和非 persisted pageshow 不重开提示，避免稳定播放闪烁。
- UI computed/渲染只读 ref。更新状态使用既有动作边界、状态 watch 和 tick；
  不从模板采样时钟、发送网络请求、写 playbackRate 或 seek。
- 未就绪的新鲜时钟仍显示校准；生产关联、socket、epoch 与 5 秒 TTL 校验
  保持原样。新鲜样本只允许评估追赶，不自动宣称恢复完成。
- 结束追赶须当前计划、身份、房间、媒体代次与元素有效，目标属于真实可用
  区间，媒体已就绪且未 buffering/seeking/blocked，基础速率已确认，播放状态
  符合房间状态，并实际进入原稳定窗口：正常 150ms，仅细微倍速拒绝且基础
  速率可用时 500ms。暂停房间可以静态对齐，不强行 play。
- 等待生成、恢复和 pending play/seek 期间不提前清除。生成中 HLS 前缀的
  ended 保持等待；只有 completed 已确认完整片尾才终止该恢复状态。
- Stop/reset 在首次 await 前清除；离房、媒体/身份变化与失去所有权同样失效。
  晚到回调读取当前所有权，不能恢复旧过程。

## 有限浏览器 fixture 修正

`tests/browser/fixtures/application.ts` 与 `room-presence.spec.ts` 的
`CLOCK_SYNC_REPLY` 回填各自 snapshot 的 `clock_epoch`；recovery.spec.ts
使用其真实快照 epoch。已有 app.spec.ts 的同类缺字段 mock 与受连接文案影响
的断言也有界修正，没有重写测试基础设施或放松生产校验。

扣留超过 5 秒的校时回复按 stale 拒绝：测试先确认不能创建播放会话，再由
真实 persisted pageshow 开启新校准轮次，以当前请求的相关回复解除等待。
fixture 的显式新鲜恢复与发送旧回复区分，避免把过期 t1 当作有效校准。
两个使用真实短视频的 chooser/teardown smoke 回归对齐其快照时间轴；其中
teardown 使用暂停状态，专门验证资源清理错误，不用 3 秒素材模拟 1800 秒目标。

## 验证与交付

状态回归扩展既有 player-recovery 与真实 Pinia/WebSocket room-player-recovery，
覆盖迟到回复、连续唤醒、pageshow、真实收敛、普通路径不闪烁、区间缺失、
seek/缓冲/就绪不足、受阻手势、暂停房间、基础率拒绝及延迟夹紧、细微速率
稳定降级、Stop/媒体替换/片尾与生成前缀。

新增 player-recovery-ui.test.ts 使用项目已有 compiler-sfc、TypeScript 与
server-renderer 编译真实两个 SFC，验证 12 项模板/ARIA 接线，没有新增依赖或
全局测试配置。SSR 检查结构与文案，浏览器回归另行记录；均不代表操作系统
后台政策、硬件解码、iOS/Android 真机或长期漂移验收。

2026-10-01 最终验证：完整单元 30 个文件、283 项通过；针对性状态/UI 三个
文件、47 项通过，其中真实 SFC 渲染 12 项。类型检查、构建、格式与 diff
检查通过；Vite 保留既有 500kB chunk 提示。

相关 app/recovery/room-presence 浏览器回归在 Chromium 151 的桌面与 Pixel 7
移动尺寸模拟下 50/50 通过，迷你校准提示截图已目视检查。执行命令：

```sh
RAINSYNC_ARTIFACT_DIR=/workspace/artifacts/player-recovery-ui \
RAINSYNC_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
npx playwright test tests/browser/recovery.spec.ts tests/browser/room-presence.spec.ts tests/browser/app.spec.ts --workers=2
```

增量包附测试、类型、构建、格式与 handoff 日志。
增量包含以第五提交为 prerequisite 的 bundle、单提交 format-patch、组合补丁、
完整六提交清单和 SHA256 清单；在已经应用原包与 binder 增量的独立分支使用。
保留此前包，不推送远端或部署。
