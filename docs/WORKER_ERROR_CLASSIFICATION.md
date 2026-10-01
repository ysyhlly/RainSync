# Worker 执行错误说明

本切片细分已结束的媒体处理失败，让播放准备和实际媒体读取返回一致的可操作提示。既有网络/NAS重试、缓存容量检查、来源版本检查、执行代次和资源回收机制继续工作；没有新增自动重试路线或数据库迁移。

| 证据 | 保存原因 / 对外代码 | HTTP | 行为 |
|---|---|---|---|
| FFmpeg 非零退出，且有完整有界的已识别输入解析错误 | `media_input_invalid` / `MEDIA_INPUT_INVALID` | 422 | 检查格式或重新扫描 |
| FFmpeg 非零退出，且明确报告找不到解码器 | `media_decoder_unavailable` / `MEDIA_DECODER_UNAVAILABLE` | 422 | 管理员检查媒体处理程序 |
| FFmpeg 非零退出，且明确报告找不到编码器 | `media_encoder_unavailable` / `MEDIA_ENCODER_UNAVAILABLE` | 503 | 管理员补齐所需编码器 |
| 当前执行的已授权输入代理确实收到401/403 | `media_input_denied` / `MEDIA_INPUT_DENIED` | 502 | 检查片源账户或设备权限，不退出RainSync登录 |
| 未识别、冲突、过长或不完整的诊断 | `media_job_failed` / `MEDIA_JOB_FAILED` | 502 | 保留通用失败，不猜测根因 |

上述终态均不可通过重复请求原URL自动恢复，也不编造重试等待时间。浏览器沿用结构化错误消息及诊断编号，停止此次准备，保留房间观看连接。HTTP/NAS输入中已确认的临时传输故障仍使用既有三次上限与退避；未知非零退出码不会被当作临时网络故障。

## 证据与优先级

只有类型化的FFmpeg非零退出才允许消费诊断分类。已确认的缓存/来源/输入错误先处理；停止、失租、健康检查失败、进程回收失败和输出校验失败保留自己的结果。编码成功时的stderr消息不能把任务改成编码失败，诊断文本也不能覆盖已有的源版本冲突或权限拒绝。

输入代理的401/403观察仍绑定当前执行随机标识及会话，旧执行、普通浏览器请求和其他会话不能污染当前任务。准备阶段的Worker探测同样只透传这一固定白名单错误；任意上游JSON或原始文本不会被Server当作公开原因。

## 有界stderr处理

编码stderr在进程运行时同步消费，避免管道填满阻塞编码。每行固定2048字节缓冲、总分类预算64KiB、每次读取512字节；超过界限、非法文本或分类冲突会丢弃所有分类，后续内容继续读取并丢弃。监督器结束后最多再等待250毫秒取得完整EOF，仍未结束则返回未知。没有脱离进程监督器的后台读取任务。

只识别固定FFmpeg消息格式。FFmpeg5.1旧格式的输入解析错误必须逐字匹配本次命令已经使用的输入参数；不复制该参数，不把任意路径后缀匹配当作证据。FFmpeg6.1/7.1的固定输入错误格式不需要路径匹配。空、控制字符或超长输入不启用旧格式识别。stderr可能包含不可信媒体文本，所以分类只是失败解释，不是内容完整性、权限或自动重试凭据。原始stderr、来源URL、查询参数、路径和请求头不进入数据库、日志或公开响应。

现有进程树所有者继续独立执行kill/wait，stderr读取取消不能替代或阻止真实资源回收。Unix和Windows共用可选stderr句柄接口；本轮验证不替代Windows系统信号、真机或持续运行验收。

## 验证入口与范围

- `cargo test -p rainsync-media-worker -p media-core -p persistence --locked`：有界分类、洪泛/部分读取/冲突/超时、监督器错误与取消、执行隔离、进程树回收和既有Worker基础
- `cargo test -p rainsync-media-worker --locked -- execution_failure::tests::installed_ffmpeg_regression_for_each_category --ignored --exact`：明确依赖已安装FFmpeg 7.x的三类实际子进程输出；不能把未执行的ignored入口计为通过
- 旧格式的准确输入匹配以[FFmpeg5.1官方源码](https://ffmpeg.org/doxygen/5.1/cmdutils_8c_source.html#l00793)为契约夹具，涵盖URL、路径、Unicode、其他输入、控制字符及预算边界；本地没有安装或执行FFmpeg5.1，不能把这些夹具当作旧运行时实测
- `node tests/worker-error-classification.mjs`：使用冻结后端、隔离数据库及显式旧任务夹具，运行真实Worker/FFmpeg，检查非法输入、401/403、404、503重试耗尽、正常转码、HTTP/readiness一致性和持久资源回收
- 既有 `tests/worker-attempts.mjs` 增加四类终态的公开错误映射检查；Docker `tests/input-retries.mjs` 对相应新代码更新断言，是否实跑按候选记录说明

本切片不声称所有FFmpeg版本和所有编码失败均有细分类，也不关闭长测、物理设备、生产旧库或部署验收。
