# 头像接口、存储和处理边界

头像在登录后单独保存。昵称 PATCH 不写头像；上传或恢复默认不写昵称。前端支持JPG/PNG/WebP原图选择与独立裁剪，后端只接受裁剪后的静态512×512 PNG中间图；前端与联合验收见[ACCOUNT_FRONTEND.md](ACCOUNT_FRONTEND.md)和[REAL_BROWSER_VALIDATION.md](REAL_BROWSER_VALIDATION.md)。

## 接口

- `PUT /api/v1/users/me/avatar`：本人 Cookie、Origin、CSRF，`Content-Type: image/png`；二进制 PNG，最多 2 MiB。
- `DELETE /api/v1/users/me/avatar`：相同身份/Origin/CSRF；不需要请求正文，恢复默认。
- 两个写接口均要求 `x-avatar-operation-id: UUID` 及 `If-Match: "UUID"`。尚未设置过头像时使用 `If-Match: "none"`。恢复默认之后必须使用返回的非空版本，不能再次假设为 none。
- 成功均为200、no-store，返回 `{avatar_url:string|null,avatar_version:UUID}`。操作编号等于新版本。重复已成功的同操作/输入/预期版本不再写入，返回**当前**头像元数据，避免重放旧响应覆盖更新后的界面。
- `GET /api/v1/users/{id}/avatar?v=UUID`：登录用户读取当前指定版本。认证先于 ETag；成功为固定 `image/webp`、`private, no-cache`、`nosniff`。匹配当前 ETag 时304；匿名401，旧版本/无头像404。没有原图下载接口。

me、资料 GET/PATCH、聊天历史和新 CHAT 包含 avatar_url/avatar_version。判断是否有头像只看 URL；恢复默认的版本不为空。其他客户端通过新消息或重新读取更新，不提供全站资料变更广播。

## 处理与资源

1. 在读取正文和启动进程前检查身份、Origin、CSRF、操作和预期版本头、类型及账号频率。其他 JSON 路由继续维持64 KiB上限。
2. 有界读取2 MiB，检查PNG签名、块边界、512×512 IHDR、完整IEND，明确拒绝APNG的acTL/fcTL/fdAT。不是按扩展名或浏览器声明信任图片。
3. 仅向解码器保留像素/色彩相关必要块和有界普通文本，不展开不需要的ICC、压缩文本、EXIF等元数据；目标是浏览器Canvas已转换的sRGB中间图。未知关键块拒绝。
4. FFmpeg以固定PNG解码器、严格CRC/解码错误检查、只允许pipe协议输出RGBA；实际解码输出必须恰好为512×512×4字节。没有缩放/拉伸步骤。
5. 第二个FFmpeg将这个已验证的RGBA缓冲编码为单帧WebP，优先质量82；只有超出256 KiB时才在同一总期限内尝试60/40。保留alpha，原图元数据不进入编码输入。再次检查真实WebP尺寸、单帧、RIFF长度和体积，并拒绝EXIF/XMP/ICC/动画块。
6. 所有进程使用参数数组和内存管道，无用户路径/URL/shell，无媒体队列。stdout、线程数、总处理期限、并发均受控；设置FFmpeg单次分配上限16 MiB（不把它宣称为整个进程总内存上限），禁用继承的FFREPORT文件输出。

`AVATAR_PROCESS_CONCURRENCY=2`，允许1–8；`AVATAR_PROCESS_TIMEOUT_MS=5000`，允许100–30000。并发满时立即429，没有等待队列。`AVATAR_WRITES_PER_MINUTE=10` 通过账号级数据库窗口持久限流；PUT/DELETE共用。`AVATAR_FFMPEG_BIN` 可选可信本地可执行路径，默认PATH中的ffmpeg，需要PNG解码与libwebp编码支持。既有容器已安装FFmpeg，无新增图床或磁盘卷。

编码任务拥有并发许可，处理future取消时通知任务中止；只有现有process-tree owner实际kill/reap后才释放许可。HTTP客户端中断测试证明进程在配置处理期限内被回收；不承诺所有HTTP断开都能立即被框架感知。超时和已检测取消不会提交图片。

## 事务、版本和保留

增量迁移 `0021_user_avatars.sql`：user_avatars每用户一行当前bytea，数据库限制≤256 KiB；avatar_operations只保留操作元数据/摘要，不存历史图片或原图。上传成功替换当前字节；删除把content/content_type置null但保留新版本。PostgreSQL旧行版本/备份仍受数据库自身vacuum及备份保留策略管理，不承诺物理擦除历史备份。

编码前预检版本，编码后在事务中锁稳定users父行，再次检查版本、操作幂等和内容摘要，原子更新操作记录与头像。父行锁解决初次没有头像行时的竞争。两个同版本操作只能一个生效；旧上传在替换和恢复默认后均冲突，不会重新激活头像。操作元数据不自动过期，避免历史操作UUID被复用后出现版本回绕；若将来需要压缩历史，必须另行保留幂等/版本保障。

响应丢失先读取本人资料核对操作版本；若还需重试，保持同操作UUID/内容/预期版本，不能自动以最新版本无条件覆盖。版本冲突应让用户刷新并重新确认。失败时此前已存图片不变。

## 错误

| HTTP | 稳定码 | 含义 |
|---|---|---|
| 400 | AVATAR_INVALID / INVALID_REQUEST | 坏图、动态/非512 PNG或缺少合法操作头 |
| 401/403 | 既有认证/Origin/CSRF错误 | 无权写入/读取 |
| 409 | AVATAR_VERSION_CONFLICT | 预期版本落后 |
| 409 | AVATAR_OPERATION_CONFLICT | 同操作ID绑定了其他内容/动作/预期版本 |
| 413 | AVATAR_TOO_LARGE | 请求或最终编码超过边界 |
| 415 | UNSUPPORTED_MEDIA_TYPE | 中间图不是image/png |
| 429 | RATE_LIMITED | 写频率或编码并发已满；含Retry-After |
| 503/504 | AVATAR_PROCESSING_FAILED / AVATAR_PROCESSING_TIMEOUT | 编码不可用或超时，不修改旧头像 |

## 真实证据

`tests/avatar-upload.mjs` 使用合成RGBA/PNG，真实HTTP、PostgreSQL、FFmpeg与ffprobe确认文件尺寸/alpha/体积、格式与权限、失败保留、并发CAS、初始无头像的迟到上传、恢复默认墓碑、操作重放、重启和昵称独立。独立Rust测试可执行文件注入编码失败、超大输出、暂停和超时，不进入产品逻辑；真实进程PID用于核对回收。原码、Cookie、凭据、用户照片均不写入Git。
