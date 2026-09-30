# 持续验证入口

这两个入口分别验证真实 NAS 观影和控制面负载。短测明确输出 smoke，不计入两小时/每拓扑六十分钟门槛；最终七十二小时验收还须在后续功能和资源生命周期修复稳定后重新开始。

## 冻结候选

在活仓库根目录运行：

~~~powershell
node scripts/validation-candidate.mjs --id=<本次编号> --build --image=<本次镜像标签> --frontend-ref=origin/front/rainsync-implementation
node scripts/validation-candidate.mjs --verify=<本次编号>
~~~

候选保存在 .runtime/validation-candidates/<本次编号>。candidate.json 记录允许源码的逐文件清单、生产清单、Git 差异摘要、锁文件、宿主与 Docker 分配资源、构建输入、镜像 ID、源码 label、实际三份二进制 SHA-256 和 FFmpeg 构建信息。复制前后检查活源码；构建前后检查冻结源码和 vendor。此工具不读取 .env、密钥、容器配置或用户媒体。

前端来源固定为 `origin/front/rainsync-implementation`。`--frontend-ref` 保存该引用解析出的提交、Git 基线树及最终冻结前端的实际文件清单与摘要；镜像记录相同前端提交 label。分支来源和最终集成源码分别可核查，后续分支移动不改变已冻结候选。

后续候选可加 --vendor-candidate=<已构建编号> 复用其只读冻结 vendor；构建仍真正使用新候选源码。仅允许一个明确来源，不允许任意目录、引用链或自引用；每次构建和 verify 重新核对其清单。

进入候选 source 目录运行测试。VALIDATION_CANDIDATE 指向上层 candidate.json；WORKER_TEST_IMAGE 使用其中 image.id。持续入口要求 built 候选，并核对源码、镜像 label 和容器实际二进制。活仓库后续改动不混入同一次测试。基底镜像和 APT 软件版本的正式发布固定仍属 W10。

## 控制面

node tests/control-load.mjs 默认依次执行十房×十人和五十房×两人，各 3600 秒。--duration-seconds=25 是短测；--topology=10x10 或 --topology=50x2 可选择一项。

每个拓扑使用 100 个独立登录身份，核对 /auth/me、每房 owner 和完整成员集合。五秒状态/时钟上报、十秒每房交替 PLAY/PAUSE、十秒有界聊天、轮转重连都有计划次数与实际调度记录；迟到超过两秒或次数不足直接失败。每条 ACK 比较动作、完整状态和 revision；每名成员收到的 EVENT、数据库命令结果/事件与最终快照必须一致。重连立即检查新控制令牌与完整权威快照。

身份准备通过正常创建/登录 API 逐个执行，尊重服务端共享密码哈希预算；该准备时间不计入拓扑持续负载。进入测量阶段后仍保持 100 个独立身份同时在线，不降低连接数、动作次数或 ACK 门槛。

真实行锁阻塞证明队列指标能够观察排队请求；该故障证明不计入正常链路 ACK 分位数。持续阶段保存 RTT、ACK/事件传播、连接/队列/数据库池、数据库连接、RSS 和 FD。控制 ACK p95 门槛为 300ms；合成 SQL 媒体夹具不代表视频吞吐或同步容量。

Windows 的 node tests/control-load-interrupt.mjs 在隐藏独立控制台中，对行锁阻塞期间的待处理 ACK 发送真实 Ctrl+C，验证 failed 报告和全部隔离容器/网络清理。它不附着用户的控制台。强杀/主机崩溃不会运行 JavaScript finally，不属于该信号测试的证明范围。

原始证据：source/.runtime/control-load/<随机编号>/samples.jsonl、progress.json 与最终 report.json 或 failed-report.json；中断证明另存 .runtime/control-interrupt。

## NAS 观影

node tests/nas-soak.mjs --duration-seconds=7200 使用真实 Server、Worker、Agent、PostgreSQL 和 Chromium。入口通过指定前端的房间、播放器设置、片库播放按钮完成自动播放，遵循 CHANGE_MEDIA 后 playing 的实际语义。低码率 MPEG-4/AAC 样本需要自动探测及转码，FFmpeg 按实时速度附近读取，保留真实背压。短测先检验这条链路，不通过时不启动两小时。

记录实际媒体时间、呈现帧、缓冲、控制收包、媒体字节和容器 RSS/FD/连接/源句柄/租约；固定同一播放会话和计划，防止重建方案掩盖失败。原生帧计数器可能在播放器重载时重置，测量必须记录计数段并累计实际呈现帧，不能将重置值当作累计帧或降低观影要求。停止计时从 DELETE 发出起，源句柄、子进程与持久化传输均须收尾。

专门的 node tests/agent-backpressure.mjs 先保持健康背压超过四十秒，再恢复并核对完整 Range 字节；普通 Ping/Pong 不延长无进展期限。另验证停止专用健康信号后的有界释放、已收到健康信号后 Close 与控制撤销的五秒释放。该专测使用受控消费者，不能替代浏览器连续观影。

原始证据：source/.runtime/nas-soak/<随机编号> 的 samples/progress/report 与各服务日志。文件系统身份和变化时间的保证、真实网络文件系统、Windows 全服务链路和移动实机仍按原计划单独验收。
