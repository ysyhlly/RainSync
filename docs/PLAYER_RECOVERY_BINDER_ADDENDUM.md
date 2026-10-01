# 播放器恢复增量：binder 异常清理与 UI 边界澄清

本增量接在原四提交的末端
`66aac3dc2c7920c4b36d6a9e6e9f887a399e1a48`，仍使用
`feature/player-recovery-v01`。原提交与原交付包保持不变。本文件补充并更正
`PLAYER_RECOVERY_V01.md` 中“binder 内部异常清理”和“前台追赶状态展示”的
笼统表述；不表示全项目首版完成。

## 分类与精确触发条件

下表的旧代码行号均按原交付末端 `66aac3d`。两个 binder 在原始基点
`de0a3d2` 到 `66aac3d` 间没有改动，因此这些是已有、可复现且与本次遥测隔离
直接相关的清理缺陷，不是仅缺少长期测试，也不是原四提交新增的缺陷。

| 文件与旧位置                                                                       | 触发条件                                                                                              | 修复前影响                                                                                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/playback/observation-binding.ts:118–124`                    | Stop 的最终媒体读取、`finalCurrent()` 或序号预留抛错；例如序号达到 `Number.MAX_SAFE_INTEGER` 后再预留 | 清理尚未执行，8 个媒体监听器仍注册，active 未关闭，正在发送的请求未 abort。运行时隔离异常后丢弃 handle，失去后续清理所有权。 |
| `apps/web/src/features/playback/observation-binding.ts:105–106`；媒体事件/采样入口 | 添加监听器中途抛错，或事件回调/序号捕获抛错                                                           | 部分已注册监听器无 handle；异步媒体事件异常逃逸，遥测来源仍存活。                                                            |
| `apps/web/src/features/playback/metrics-binding.ts:101–120`                        | 注册部分监听器或首次 `requestVideoFrameCallback()` 抛错                                               | 已注册的最多 9 个监听器遗留，绑定工厂未返回 handle；在 current 仍有效时仍可继续测量。                                        |
| `apps/web/src/features/playback/metrics-binding.ts:124–129`                        | Stop 的 `cancelVideoFrameCallback()`，或某个 `removeEventListener()` 抛错                             | 后续监听器移除被跳过。旧代码此时已经关闭 active，所以迟到回调不会继续计量；问题是资源清理未完成，不能宣称它必然污染指标。    |
| `apps/web/src/features/playback/metrics-binding.ts:103–117`；事件/读取入口         | `meter.observe()`、`meter.firstFrame()`、状态/媒体读取或下一轮帧注册抛错                              | 异步事件/帧异常逃逸，现有运行时 factory/stop 的外层隔离无法捕获这些未来回调，绑定未自行关闭。                                |

“追赶状态 UI”则是现有功能接线缺口，不只是没跑测试，也不是本增量修改的
UI 功能。`docs/NEXT_PLAN.md:333` 要求前台恢复重新校准并显示追赶状态，但：

- `apps/web/src/features/playback/playback-runtime.ts:1216–1235` 的
  `onClockInvalidated()`/`onClockReady()` 重置、等待并恢复纠偏，没有提供
  专门的响应式“重新校准/追赶中”状态。
- `apps/web/src/features/playback/PlaybackHost.vue:136–146` 仅显示受阻加入按钮
  与 `r.waiting` 对应的“正在准备影片…”。这不是新鲜校准等待状态。
- `apps/web/src/features/playback/PlaybackInformation.vue:15–18` 仅显示 WebSocket
  连接状态。持续播放、连接正常且 waiting/blocked 均为 false 的
  hidden → visible 恢复期间，等待新鲜校时仍会显示“已连接”，没有追赶提示。

最小后续接线建议：由总控协调新增独立响应式恢复状态，真实重校准时置为
“正在重新校准…”，有效相关样本到达后按实际漂移进入/退出“正在同步…”，
离房/Stop 时清除；在 PlaybackHost 现有 `role="status"` 位置展示。不要借用
缓冲 waiting、blocked 或 error 来表达恢复，也不要覆盖鉴权/媒体错误。本增量
未修改这些 UI 文件或共享出口；仍需总控另行分配所有权与状态接口。

iOS/Android 的锁屏、切后台、带声恢复、手势政策及长期漂移验收是另一个
“尚未执行测试”的项目，本次没有扩大到这些验收。

## 本次有界修复

仅修改上述两个 binder、一个针对性测试文件与本独立文档。核心播放运行时、
协议、后端、主入口与 UI 不变。收到本增量任务时已向父任务声明两个 binder
由本路修改，避免并行写同一路径。

两个 binder 都先关闭 active，再逐项尝试清理，保存已注册的回调并回滚部分
注册；异步事件、progress、帧回调的本地异常均使绑定关闭。关闭幂等，迟到
回调不读取媒体、不写指标、不再调度。如果底层 remove/cancel 本身抛错，
无法保证浏览器物理移除成功，但仍继续清理其他资源，并使剩余回调失效；
不在每个 tick 重试失败的关闭。

Observation Stop 用 finally 保证清理与发送取消，保留 finalCurrent 的终值
语义，重入 Stop 至多预留一次序号，不另发最终 POST；失败时返回 undefined，
不阻塞现有 DELETE。媒体事件与最终采样的异常可由 failure 读取。网络失败
仍走原发送器最多两次尝试，不因网络错误直接取消整个正常绑定。

Metric 的显式 read 失败先关闭，再重新抛出，让现有运行时隔离边界处理，
不伪造观察数据；正常停止后 read 的原读取语义保留。正常首帧尚未成立时
仍允许下一轮帧回调，成立后停止首帧采样。

## 回归与交付

`tests/playback-binder-cleanup.test.ts` 覆盖最终 Stop 序号耗尽/媒体 getter/
finalCurrent 抛错、重入、部分注册回滚、单项移除失败、初始/后续帧注册失败、
帧取消失败、事件/首帧/显式读取失败、迟到回调失效、正常首帧重试成功与
网络有界重试。先在原末端运行的 9 个基础异常测试全部失败；修复后的
16 个新增测试及原有相关回归通过。

2026-10-01 验证：相关 5 个文件、53 项测试通过；完整 `npm test` 通过
29 个文件、260 项测试；`npx vue-tsc --noEmit -p apps/web/tsconfig.json`、
`npm run build`、格式与 `git diff --check` 均通过，增量包附命令输出。
Vite 的既有 500kB chunk 提示不影响构建成功。

增量包仅含 `66aac3d..新末端` 的 patch、单提交 format-patch 和带该末端
prerequisite 的 bundle，附失败基线、通过日志、提交清单及 SHA256 清单。
先应用原包，再在原末端的独立分支应用此增量。没有远端推送、部署或生产操作。
