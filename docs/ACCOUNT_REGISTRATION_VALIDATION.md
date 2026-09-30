# 账号、邀请码与头像联合验收

状态：后端R1–R3/A1已在前端实施前通过并提交；前端R4–R5/A2–A3、联合R6/A4及根入口最终重跑均完成。后端门槛`c6a27127f445cdc079f98ed2440a23154ecdf150`，最终产品提交`2f24be569b105fcbba3a3ef26d2457e9c2292f37`。精确完整证据及代码状态说明见[最终报告](IMPLEMENTATION_REPORT.md)第5节；本文件补齐专项验收索引，不替代原始日志。

## 执行层次

| 层次 | 正式测试 | 已验证结果 |
|---|---|---|
| Rust规则/图像单元与资源监督 | `apps/server/src/account_rules.rs`、`avatar_image.rs`等 | 新建字段边界、图像处理边界；最终workspace合计56通过，2个原有子进程fixture由上层监督测试调用 |
| 真实Server/数据库规则 | `tests/account-rules.mjs` | 新账号白名单、1/80/81账号、7/8密码、中文拒绝、8空格不trim、50/51昵称、管理员初始化及存量登录 |
| 真实管理员邀请 | `tests/registration-invites.mjs` | 1–50批次、默认7及1/30天、原码仅首次、UUID参数绑定、状态/游标、管理员权限、同批确认及丢失响应元数据恢复 |
| 真实注册/资料/安全 | `tests/registration.mjs` | 同码并发、撤销竞争、锁后过期、用户名占用不消费、昵称重名、四处故障事务全回滚、普通身份、字段白名单、Origin/CSRF/可信代理/限流、注册未知结果登录确认 |
| 真实头像/聊天 | `tests/avatar-upload.mjs` | 真实PNG→RGBA→WebP、512/alpha/体积、坏图/伪格式/动态/编码故障/进程回收、CAS/重放/父行锁/删除墓碑、重启字节版本、真实CHAT身份字段 |
| 前端单元 | `tests/{account-input,avatar-crop,api-session}.test.ts` | 码点/空格、正方形裁剪数学/边界/锚点、输入格式、身份epoch及资料合并；最终全部前端单元合计44通过 |
| 可控浏览器异常与交互 | `tests/browser/{account,admin}.spec.ts` | 10账户+16管理员案例，桌面/手机模拟；未知注册不自动重发、复制失败/关闭提醒、同批刷新重试、独立保存、取消零上传、拖动/键盘/双触点、真实Canvas像素、失败旧图和版本确认 |
| 真实根路由联合流程 | `tests/browser-real.mjs` | 真实管理员生成→校验→普通注册→Cookie/CSRF→资料/四次裁剪→旧登录账号再次登录→房间邀请观看→重启持久性；无HTTP/WS/媒体方法mock |
| 迁移/回退/备份 | `tests/{migration-upgrade,compatibility-rollback}.mjs` | 未改0019基线升级21、基线业务保留迁移回退、再升级与独立pg_dump/restore后全部账号/会话/资料/头像/批次留存 |

## 最终命令与证据

ARTIFACT=`C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28`。下列均退出0且未超时，时间为2026-09-27 UTC（上海2026-09-28）：

| 记录 | 命令 | 完成时间 |
|---|---|---|
| logs/final-accounts.json | `node --run test:accounts`，依次执行四套真实后端脚本 | 21:13:41.041Z |
| logs/d-switch-browser-final.json | `node node_modules/@playwright/test/cli.js test --workers=2` | 21:18:03.722Z，86例含上述账户/管理 |
| logs/final-unit.json | `node node_modules/vitest/vitest.mjs run` | 21:19:14.881Z，44项 |
| logs/final-real-browser.json | `node --run test:browser-real` | 21:19:39.503Z |

真实浏览器摘要`ARTIFACT/browser-real/f9ecebb8-3b8a-4db0-9e2e-c561e7f268ab/evidence.json`：wide-left/right及tall-top/bottom四次512×512 WebP，552/554字节，红/蓝中心像素；最终头像/昵称在Server重启后保持。生成2码仅消费1码；注册未加入任何房间。管理员手动创建admin=false，普通用户管理接口403。

最终测试在HEAD c06ae03的根入口工作树运行，之后同一产品变更提交2f24be5；evidence记录当时HEAD，不将其伪改为后来提交。后端回退证据及UTC时间见[BACKEND_VALIDATION.md](BACKEND_VALIDATION.md)；哈希与命令元数据见[VERIFICATION_MANIFEST.json](VERIFICATION_MANIFEST.json)。

## 修复、恢复语义与限制

注册未知结果先auth/me核对同一账号，再用所填凭据正常登录，不重发注册；批次同ID/同参数确认，原码丢失不可重建；头像未知先GET profile核对操作版本，保留同UUID/内容/预期版本供显式重试，冲突需重新确认。这些都是已实现并测试的反馈，不能用自动重复写入掩盖网络不确定性。

实施中修复步骤切换焦点、文件input撑宽、迟到资料覆盖隔离及管理select可访问定位；失败日志保留。真实服务关键事务没有被mock替代；仅特定故障使用数据库触发器/测试专用编码器，客户端交互异常用受控mock。

未连接用户生产数据库，未使用私人照片。Chromium触点/手机视口不是Safari/iOS/Android硬件；EXIF实际手机照片库、长期高并发头像处理、生产备份恢复没有验证。裁剪和处理实现独立，无外部裁剪组件或源码素材复用。所有本次必须实现的专项交付已完成，设备和生产边界见最终报告第9节。
