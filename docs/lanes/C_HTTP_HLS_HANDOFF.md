# C / W04 独立 HTTP/HLS 交付

基线为总控 `integration/v0.1-next` 的精确提交
`252100dee29cf4d13df00cbda55f0fa4814deb25`，分支 `codex/c-http-hls-v01`。
已完整阅读 `PARALLEL_CONTRACT_V01.md`；没有修改协议、SourceConfig、任何
main.rs/lib.rs、迁移、依赖/锁文件、CI 或总台账。未推送、合并、部署或操作生产。
这是 W04 在独立边界内的补强，不是 W04 整包或发布验收完成。

## 接口需求与已有基线

已有基线保留禁重定向、精确同 origin、加密/opaque 子资源授权、播放授权独立
复查、文件句柄版本检查、读租约及正向排空。未重写 Worker 队列、Agent 或播放器。

仍交总控的需求及具体接线点：

1. `providers::SourceConfig` 的管理员来源访问策略：策略版本、允许的 origin /
   协议/端口/网段与可选路径范围、每 origin 的凭据作用域。旧授权须与策略版本
   绑定并在变更时失效。当前契约刻意没有批准这些共享字段。
2. 共享 HTTP 客户端的 DNS 解析、地址检查与单次连接 pin，以及每跳校验。
   经出站代理的部署还须明确谁执行实际目标 DNS/连接一致性检查；不能用检查
   本机 DNS、随后由另一解析器连接的方式声称完成。当前继续拒绝全部重定向，
   没有开放跨 origin CDN 或任意 URL 代理。
3. `apps/media-worker/src/main.rs::delivery_response/rewrite_manifest` 使用结构化
   清单模块：URI 类型、深度、策略版本与会话一起签发/校验，兼容现有加密授权。
   本批没有修改该入口，它仍使用旧改写器；私有预览路径已经实际接线。
4. `crates/media-core/src/preview.rs::generate` 及 Worker 的 FFprobe/FFmpeg 输入路径
   需要受支持的 decoder format / 网络约束。有限前缀拒绝不是完整 decoder 沙箱，
   不能据此宣称所有格式的 SSRF 已闭合。
5. 跨请求的可靠 HTTP 表示版本及错误契约。来源无可靠 validator、同长度原地
   换内容或上游错误复用 ETag 时，当前 ETag/长度检查不能证明内容身份。本地
   stat-v1 也不是强内容 ETag。统一 SourceVersion/错误映射须由总控协调。

## 独立改动

| 文件 | 行为 |
| --- | --- |
| `apps/media-worker/src/file_delivery.rs` | GET 单 Range、suffix/open-ended/截尾/空文件；非法、未知单位、多范围与重复 Range 忽略为 200，合法不可满足为 416 且 `bytes */N`。HEAD 忽略 Range，表示元数据与完整 GET 一致。没有可靠强 ETag/日期时 If-Range 安全返回完整 200。保留原句柄版本/逐块变化校验与读租约。 |
| `apps/media-worker/src/hls_manifest.rs` | 结构化 URI-bearing tag/属性解析；普通分片、变体、音轨/字幕、MAP、AES-128 KEY、BYTERANGE 与 discontinuity 保持结构；精确 URI 替换，不改标题/相似属性。拒绝 DRM、变量、未知 URI 扩展、非法/重复属性。2MiB、每清单 20,000 引用、每属性记录 128 字段，解析/改写失败不返回部分清单。 |
| `apps/media-worker/src/http_delivery.rs` | 验证上游 206/416 Content-Range、总长度及区间长度；不伪造 206。按最多 1024 字节前缀识别隐藏 HLS，拒绝 XML/DASH、concat/PLS/SDP 等未支持文本清单与空/全白识别窗口。Latin1 的无效 UTF-8 不会绕过已知字节签名。 |
| `apps/media-worker/src/preview_input.rs` | 所有 HLS 引用先同 origin 校验，再登记 opaque grant；相对路径基于当前子清单。Target 保留引用类型，已知 Playlist 不依赖扩展/MIME，冲突采用更严格类型。键按 URL/深度稳定复用，自引用和 A→B→A 不重置四层预算；整个 attempt 20,000 登记上限。私有响应均 no-store，KEY 不进入公共缓存。 |
| `apps/media-worker/src/preview_input.rs` | 仅强 ETag 用 If-Match；412、validator/表示长度/416 总长度改变撤销 attempt 为 source_changed；401/403 也停止。未知 HEAD 不抢先固定 binary 版本，sniff HLS 持久提升类型，live 清单不固定旧 ETag。真实 binary→HLS 换类型仍拒绝，迟到并发 HLS 不能擦除已发布 binary 绑定。HEAD 与重写清单不返回原始字节的长度/ETag。请求等待头/前缀/清单均可取消，保留既有预算和 NAS 取消所有者。 |
| `tests/http-hls-preview.mjs` | 自有 native PG、动态 loopback HTTP/Worker、真实 FFmpeg 的独立入口，前后核验源码、三服务二进制和入口哈希；保存断言/清理报告。 |

拒绝已知文本签名的严格策略可能使某些二进制 Range 切片/加密媒体前缀被拒绝。
KEY 的原始 16 字节值不作 demuxer 前缀分类。当前模块是 URI/属性处理器，不宣称
完整 HLS 合规验证、DRM、所有 LL-HLS 行为或所有 codec/设备兼容。

## 最终新基线证据

本批最终 131 个后端 Rust/manifest/迁移输入摘要：
`95331737b578793e7142a572b6ddcde1a2542e0b9719b90094c5f3c2b79c9f26`。
绑定与日志在仓库外 `/workspace/RainSync-lane-artifacts/c/`，不会提交测试密钥或数据库。

| 检查 | 实际结果 | 路径 |
| --- | --- | --- |
| Worker 单包单元/回归 | 63 passed、2 ignored、0 failed，退出 0；ignored 为既有子进程辅助入口及单独 PG 健康入口，未计通过 | `v01/worker-tests.log` |
| Clippy 全目标 `-D warnings` | 退出 0 | `v01/clippy.log` |
| 锁定全 workspace bins/examples、单并行构建 | 退出 0；Source/binary 前后绑定 | `v01/backend-build.log`、`v01/backend-binding.json` |
| 原生 HTTP/HLS/FFmpeg | 7/7，退出 0；无扩展/octet-stream 子清单与 MAP 实际解码 ready；子清单越权、隐藏 HLS、DASH、Latin1、跨 chunk 长 padding 与 redirect 均 unavailable，foreign origin 请求始终 0；报告确认 Server/Worker/PG 清理、Worker PID 消失/端口关闭 | `v01/http-hls-preview.log`、`c-http-hls-preview/a0b81b97-b7d1-4310-9ab9-8f862ffe493e/report.json` |
| 既有长响应/撤权/池恢复 | 17/17，退出 0；这是短故障场景，不是正式长测。覆盖 shared 主入口既有鉴权，不能当它已采用新 parser | `v01/stream-revocation.log`、`stream-revocation/77b8a59f-5e5e-4422-832c-987cba5648db/stream-revocation.json` |

单元/loopback 还覆盖所有引用授权、nested base、重复 BYTERANGE 稳定 URL、
MAP/KEY/音轨/字幕/discontinuity、四层自/互引用、registry/manifest/attribute 上限、
Range/HEAD/If-Range/416、弱 ETag、资源变化、未 polling 正文时的既有 NAS owner
取消、等待上游头取消、extensionless live HLS HEAD/GET 与并发类型绑定。
原生样本由本次 FFmpeg 生成；这是受控 HTTP 输入，未冒充真实 Jellyfin/Emby、
浏览器观影、移动实机或 2 小时 NAS / 72 小时验收。

## 保留的失败与中间证据

- 旧 `5ce1c849…` 的历史分支为 `codex/c-http-hls`，WIP
  `c6136e3b2b57c52e6c3c3d6b8deaa45f2bc4d2ab`。其中旧 56 单元通过不作新基线证据。
- 旧 `tests/media-preview-sources.mjs` 整链**退出 1**：第 76 行 NAS 换文件/Agent
  重启后 45 秒仍未 ready。之前本地/HTTP/协议海报与首轮真实 NAS 断言已执行，
  但整条不能记通过。保留 `media-preview-sources.log` 与
  `preview-sources/5b6e8374-c307-4101-959b-7cc080654b91/`。
- D 在 `252100d` 自有真实 PG/Agent 中独立复现 generation 1→2 后旧 queued 行
  被 FRESH 过滤而无人领取；报告
  `/workspace/RainSync-lane-artifacts/d-v01/preview-queue-recovery/89fe9f4a-d5a0-4cab-ba4e-f4b19b728c5e/report.json`。
  它不是对旧 C 失败的事后归因，本批未引入 D 补丁；集中集成后须联合重跑整链。
- 新基线 b8d1 的中间 17 场景通过保留在 `v01/intermediate-b8d1/`；它早于
  Latin1/live HEAD 补强，不替代上述最终版本。旧 Clippy 首轮可合并 if 的失败
  保留在 `clippy-first-failure.log`，修正后最终 Clippy 退出 0。

## 复跑与集中集成

使用本任务已有隔离 checkout，不另建工作树；只使用自有 artifact/PG/端口。

```bash
source /workspace/.rainsync-cloud/env.sh
export RAINSYNC_ARTIFACT_DIR=/workspace/RainSync-lane-artifacts/c
export CARGO_TARGET_DIR="$RAINSYNC_ARTIFACT_DIR/cargo-target"
export CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
export RAINSYNC_NATIVE_POSTGRES_BIN=/workspace/.rainsync-cloud/postgres/usr/lib/postgresql/17/bin
cargo test --locked -p rainsync-media-worker
cargo clippy --locked -p rainsync-media-worker --all-targets -- -D warnings
export RAINSYNC_C_BINDING_FILE="$RAINSYNC_ARTIFACT_DIR/v01/backend-binding.json"
node tests/http-hls-preview.mjs
node tests/stream-revocation.mjs
```

上述 binding 只可用于它仍与源码/二进制匹配的情况；源码/制品变化后重新锁定
构建与前后快照，不能仅改摘要。独立入口接受本批 binding 的 `inputs` 映射
和 `binaries` 数组。若用仓库 `scripts/bind-native-backend.mjs` 的正式 binding，
可在仓库外派生兼容副本：保留全部字段并令
`inputs = Object.fromEntries(source.map(entry => [entry.path, entry.sha256]))`；
原始 binding 保留，不改 producer 原文、校验值或受保护脚本。

总控可集中 cherry-pick 本功能分支。接主播放交付入口前，须先统一策略/
DNS/decoder 约束及 ticket 深度/类型/版本契约，再接本模块并重跑实际主入口
HLS、撤权、房间生命周期、D 预览恢复及各来源回归。跨 origin 策略、真实 DNS
rebinding、重定向每跳、可靠表示版本、NAS Range 对齐、真实 HTTPS/CDN/产品/
设备与正式持续负载均保持待验收，不借本批短测关闭。
