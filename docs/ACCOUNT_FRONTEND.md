# 注册、资料与独立头像前端

已在 `/register` 与 `/account/profile` 实现，完整替换旧默认入口。真实后端联合验收见REAL_BROWSER_VALIDATION；本记录描述前端实现，不替代后端事务证据。

## 注册

RegisterPage首先匿名验证邀请码，再输入固定登录账号、可选昵称、密码与确认密码。新账号规则与Server一致：1–80 ASCII账号字符、8–1024可打印ASCII密码且保留空格、最多50 Unicode码点昵称。登录页继续允许存量原凭据，不套用新建规则。

邀请码失效回到第一步，账号占用保留其他草稿并聚焦账号，限流使用服务端retry_after_ms倒计时。注册请求不自动重发。网络/截断响应进入未知状态，先auth/me核对本次登录账号，再提供使用刚设置凭据正常登录的操作；不同身份不能冒充本次注册成功。成功只进入放映室列表，没有自动房间成员请求。代码/密码只保存在组件内存，离开页面清除，不放URL、日志或浏览器持久存储。

## 资料独立性

登录账号只读。昵称PATCH成功只更新display_name/custom_display_name，不覆盖同时完成的头像写入；头像只更新其URL/version，不改未保存昵称草稿。session store记录本地资料修订，迟到auth/me不能回退已确认的新昵称/头像。身份变化仍使用epoch拒绝旧结果。

## 原图、取景与导出

crop-model.ts、image-input.ts和AvatarCropDialog.vue均在本项目独立编写。未安装、复制或移植Cropper.js、Vue Advanced Cropper、Uppy的源码、组件、主题或素材。只使用Vue、Canvas、ImageBitmap、Pointer Events及浏览器内建解码。

源图≤10MiB、≤4000万像素、单边≤16384；读取PNG/JPEG/WebP签名与尺寸后才解码。拒绝APNG、WebP动画标记、JPEG多图MPF、GIF/SVG；真正解码失败仍拒绝。ImageBitmap按from-image处理EXIF方向，解码后再检查尺寸。原图不上传，无blob图片URL，Canvas预览与既有CSP兼容；选择序号防止迟到解码覆盖新图，关闭/换图释放bitmap。

取景状态为原图宽高、中心和zoom(1–8)。正方形边长min(W,H)/zoom，中心限制使图像完整覆盖方框。平移按原图边长/可视宽度换算；缩放可保持指针锚点。双指同时缩放和平移，单指/鼠标拖动，键盘方向键和Shift加速、滑块/按钮/重置均可用。导出drawImage的正方形source rect到真实512×512 Canvas，再输出PNG中间Blob≤2MiB；不拉伸，不圆形擦除，不主动填背景，保留alpha。

## 保存与失败

PUT/DELETE绑定随机操作UUID和当前版本If-Match；删除后保留服务端墓碑版本。成功后才更新本人图片。异常先GET profile核对操作ID；相同版本确认完成，未知则保留原UUID/Blob/预期版本供明确重试，不偷偷按最新版本覆盖。冲突显示刷新并重新确认提示。编码失败保持裁剪和旧头像；取消尚未提交的裁剪发送零请求。已经发出的未知请求不能被关闭弹窗追溯撤回，页面明确提示确认状态。

## 阶段验证

2026-09-27 20:29–20:41 UTC（上海次日04:29–04:41）：c5-crop-red先确认模块缺失；实现后c5-unit-final共44测试、c5-types-final、c5-browser-verified共56浏览器案例、c5-build-final退出0。原38播放回归保留，新账号与头像测试在桌面Chrome和Pixel7模拟各执行。

覆盖密码空格/中文拒绝/昵称码点、双步骤焦点、未知注册只一次POST、昵称与头像独立、真实Canvas512 PNG签名及像素、宽/长图、鼠标/键盘取景、真实CDP双触点缩放、无效文件/取消不上传、失败旧版本、成功响应截断后读取确认、资料操作期间video/WS/播放POST身份保持。

发现并修复：步骤切换时输入仍disabled导致焦点失败；个人资料链接缺少独立可访问名称；隐藏文件input被通用input样式撑宽，引发移动视口和点击坐标偏移（修复sr-only尺寸优先级，新增真实视口宽度断言）；CSS格式化小写十六进制导致字符串测试误报（按大小写无关的同一颜色比较）。全部失败日志留在ARTIFACT/logs，未删除业务断言。

D阶段已串联真实管理员生成、用户注册、昵称/头像、四次宽长图不同取景、真实512WebP、原账号登录及Server重启后的浏览器持久性。没有把手机模拟当作实机；EXIF真实手机照片、Safari/iOS/Android设备、生产图像负载仍未覆盖，最终报告单列。
