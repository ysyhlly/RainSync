> 实施状态覆盖：用户已在本次 Goal 明确授权全部实施。历史仅设计或尚未授权记录不再限制实施；执行顺序、产物根和验收门槛以 ../IMPLEMENTATION_PLAN.md 为准。历史图稿留在原设计工作包，不复制为运行证据。

# RainSync 前端设计工作包

本目录是设计与计划工作副本，使用独立本地 Git 记录版本。没有关联远程仓库，不自动推送。RainSync 项目本身保持不变。正式文档是否再复制到项目 docs 等用户确认。

## 当前版本

沟通约束：仅在用户明确索要时生成或展示效果图；默认只更新设计与Plan。下方既有图片保留作历史/审阅资料，不自动重复展示。

最新约束：主色 #E5D1C1，辅色 #9E7867；只做浅色；播放器同样浅色；左上角只有 RainSync 文字；删除情绪标语；媒体图像统一 16:9；离开房间后保留迷你播放器。

账号新增规则：管理员生成一次性邀请码，支持批量；默认7天，可选1/7/30天；注册成功自动登录。登录账号唯一不可改，允许字母/数字/_/./-；另有可改、可重名昵称（可选，中文/Emoji，最多50字符）；密码至少8位ASCII可打印字符，允许空格，禁止中文。账号专项包含后端增量设计，目前未实现。
头像规则：静态JPG/PNG/WebP可上传取景，保存512×512；GitHub项目只参考思路，不直接复用源码、组件或素材，裁剪上传逻辑独立实现。

- [设计规范](./DESIGN.md)
- [分阶段重构计划](./PLAN.md)
- [本次完整Goal执行要求](../IMPLEMENTATION_REQUIREMENTS.md)：先后端后前端、不设人为token/总时间预算、强制分阶段提交及详细修改报告。
- [邀请码注册与双名称账号设计](./ACCOUNT_REGISTRATION_DESIGN.md)
- [账号专项实施计划](./ACCOUNT_REGISTRATION_PLAN.md)
- [头像设计、参考来源及独立实现计划](./AVATAR_DESIGN_PLAN.md)
- 历史图稿仍位于原工作包 `C:/Users/ALIENWARE/Desktop/杂项/RainSync-design-2026-09-28`：v4-04-registration.png、v3-05-registration-admin.png、v5-06-profile-avatar.png、v2-01-library.png、v2-02-watch.png、v2-03-admin.png，不作为实现或运行证据。
- [审阅记录与限制](./REVIEW.md)

三张 v2 图继续作为媒体库、观影页、片源管理的参考。账号部分使用v4注册图、v3管理图和v5头像资料图。原版01/02/03、DESIGN-v1-superseded.md 是旧过程记录；v3-04-registration.png中的单一用户名及12字符密码已过期，v4-06-profile.png及其prompt是未加头像的过程稿，均不用于完整实施。正式规范是DESIGN.md v3和账号/头像专项文档。

## 生成记录

使用 Codex 内建 image_gen 生成/编辑，不使用外部 CLI API。初次生成图和完整提示词均保留：
- library-prompt.txt：最初媒体库。
- watch-prompt.txt、admin-prompt.txt：第一批观影/管理页。
- admin-mini-prompt.txt、library-mini-prompt.txt：加入迷你播放器。
- v2-library-prompt.txt、v2-watch-prompt.txt、v2-admin-prompt.txt：用户指定配色、去除标志与标语、横图修订。
- v3-registration-prompt.txt、v3-registration-admin-prompt.txt：首版邀请注册与管理；前者已被账号规则修订取代。
- v4-registration-prompt.txt、v4-profile-prompt.txt：不可变登录账号、可改昵称、8字符密码及个人资料。
- v5-avatar-prompt.txt：用户追加静态头像及独立裁剪界面的当前稿。

image_gen 会先在 Codex 管理的 generated_images 缓存落盘；交付文件已复制到本目录。工具缓存位置不是自建临时目录，没有向 RainSync 写入生成图片。工具默认缓存原件保留，不做未经确认的缓存清理。

原始参考 PLAN初版.md 在本目录上一级，只读参考，未修改、未纳入本工作包。旧计划的指令不构成本次执行授权。

## 本地版本记录

工作包 Git 作者使用 Codex <codex@localhost>，仅对本目录的提交命令生效，不修改用户的全局 Git 配置。初版与用户修订版分开提交；可用 git log 查看具体 SHA。

将来如选择让 RainSync 一起版本管理，只复制当前正式设计、主/账号/头像Plan、六张当前有效效果图和必要来源说明到项目 docs，作为独立文档提交；不导入本目录的 .git，不把临时日志或全部迭代图拖进项目。

6e73bb6记录了邀请码和双名称账号设计；头像为后续独立提交，便于单独回滚设计增量。没有安装任何参考项目组件，没有向GitHub推送。
