# 媒体显示名称与预览接口

这些接口随迁移 0023/0024 引入。媒体原名仍由扫描维护；显示名和小图不会修改片源。接口前缀为 `/api/v1`，沿用登录 Cookie，写接口必须提供合法 Origin 和 `x-csrf-token`。

## 编辑名称

| 请求 | 权限 | 返回 |
| --- | --- | --- |
| GET /media?search=&after=&limit= | 登录 | Media 数组，按当前用户有效名称搜索，UUID 游标 |
| GET /media/{id} | 登录且媒体可见 | 单个 Media |
| PUT /media/{id}/personal-title | 登录 | 本人视角 Media |
| PUT /admin/media/{id}/shared-title | 管理员 | 管理员视角 Media |
| GET /rooms/{id}/playlist | 房间成员 | 保留 id/media_id/title，增加 cover |

PUT JSON：`{"title":"我的影片","expected_revision":"0"}`。title 为 null 清除覆盖；非 null 时 trim 后 1–200 个 Unicode 字符，不允许空串、控制字符、换行。两种 scope 的版本独立，非负十进制字符串避免 JS bigint 精度损失。不能传 user_id 或额外字段。

Media 包含 id、title、original_title、shared_title、shared_title_revision、personal_title、personal_title_revision、duration_ms、kind、cover。有效 title = personal_title ?? shared_title ?? original_title。清除个人名保留版本墓碑，防止旧的 revision=0 覆写。

错误：400 MEDIA_TITLE_INVALID（非法版本/字段亦为 400）；409 MEDIA_TITLE_CONFLICT；401 未登录；403 管理员/Origin/CSRF 校验失败；404 不存在、不可见或失效媒体。错误沿用项目结构化 error/request_id。名称资料返回 no-store，不写入房间广播。

409 时保留草稿、GET 最新版本并让用户再次确认保存；网络响应丢失后 GET 核验目标 scope，不自动重发 PUT。

## 请求封面

| 请求 | 行为 |
| --- | --- |
| POST /media/previews，JSON `{"media_ids":["uuid"]}` | 去重最多 24 项，未知/不可见项不入队，已有任务复用 |
| GET /media/previews?ids=uuid,uuid | 只读状态，不创建任务，最多 24 项 |
| GET /media/{id}/cover?revision=uuid | 认证、可见性和源版本验证后返回静态 image/webp；支持 ETag |

状态响应为 `{"items":[{"media_id":"uuid","cover":{...}}]}`。cover 字段：status 为 missing/queued/running/ready/unavailable，revision/url 在 ready 时提供，retry_after_ms 表示等待建议。图片地址仅为同源 Server 地址，凭据和源路径不交给浏览器。

状态 no-store；图片 private, no-cache，认证先于 304。旧版本 409 MEDIA_PREVIEW_STALE，队列满 503 MEDIA_PREVIEW_QUEUE_FULL，不可生成 MEDIA_PREVIEW_UNAVAILABLE。前端只请求可见卡片，每批最多 24、一批在途，2 秒起合并轮询，60 秒后停止等待并提供手动重试；页面隐藏/卸载取消。

## Worker 与配置

| 环境变量 | 默认 | 合法范围 |
| --- | --- | --- |
| MEDIA_PREVIEW_CONCURRENCY | 1 | 1–8 |
| MEDIA_PREVIEW_TIMEOUT_SECONDS | 30 | 1–120 秒 |
| MEDIA_PREVIEW_CACHE_BYTES | 134217728 | 1–1073741824 字节 |
| MEDIA_PREVIEW_QUEUE_LIMIT | 128 | 1–4096 |
| MEDIA_PREVIEW_INPUT_BYTES | 268435456 | 1–1073741824 字节 |

Server/Worker 使用对应相同配置。缓存预算小于单张图时任务返回 unavailable，不无限续租。独立 SKIP LOCKED 队列、15 秒租约、5 秒续租、最多 3 次尝试、2/5 秒退避和 60 秒失败重试。发布检查 attempt/owner/lease/源 generation；事务锁保护 LRU 字节预算。

Jellyfin/Emby 优先 Backdrop 再 Primary，失败后使用认证静态视频流；本地/HTTP/NAS 从开头顺序解码。完整帧缩放采样用于黑帧判定（灰度<24，比例>=99.5%），接受后输出按比例中心裁剪 640×360。WebP 使用 libwebp/image2pipe，检查 RIFF、尺寸、静态结构及 256KiB 上限。

预览输入授权只在本 attempt 内有效，累计网络/relay 输入预算，HTTP/嵌套 HLS 保持同源，不跟随重定向。local 前后比较读取侧文件属性；NAS 验证 source_version。HTTP 同 attempt 绑定 ETag/Last-Modified；重新扫描和 24 小时上限保守失效，不保证无扫描时即时发现上游替换。修改片源配置/资源/版本/metadata/可用性会改变 generation，改名不会。

兼容边界：静态上游流未经 PlaybackInfo 转码协商；需要动态转码而无可读静态流的项目可能显示 unavailable。此路径避免为封面建立房间播放会话。不能把预览当作原视频质量分析或内容哈希。

## 本地复现

先运行 `scripts/validation-env.ps1 -ArtifactRoot <Desktop/杂项 下专用绝对目录>`，使用已有有效 Playwright 浏览器路径。`tests/media-titles.mjs`、`media-previews.mjs`、`media-preview-sources.mjs`、`media-preview-products.mjs`、`media-migration-upgrade.mjs`、`library-player-real.mjs` 均创建自己的资源。products 使用独立标签 rainsync-polish-fixture:20260929 和固定版本 Jellyfin/Emby 测试镜像，详细命令和限制见实施报告。

新迁移加入后，旧 SQLx 二进制可能拒绝未知迁移。UI 可回退同时保留新表；后端回退应制作包含新迁移记录的兼容构建或前向修复。名称是用户数据，不能当缓存删除。未授权部署或操作用户服务。
