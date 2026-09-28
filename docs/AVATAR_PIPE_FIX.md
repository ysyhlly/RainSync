# 部分头像上传失败修复及浅色主题调整

2026-09-28：诊断编号 `e139ad01-db8b-4719-8b35-e12515e081c2` 对应运行容器的 `AVATAR_PROCESSING_FAILED` / HTTP 503。

## 原因与修复

本地部署镜像使用 Debian Bookworm FFmpeg 5.1.9。本机原生测试使用较新的 FFmpeg，因此先前原生测试未暴露这个版本差异。5.1 的 `webp` 封装器通过不可寻址的 stdout 管道输出较大文件时，无法回填 RIFF 长度：细节较多的合成头像原输出186212字节，但头部长度为0，被现有严格校验拒绝；小图可以正常保存。这解释了为什么只有部分头像失败。

保留 libwebp 编码器，将单帧输出封装改为 `image2pipe`，直接保留编码器生成的完整 RIFF 帧。未放宽512×512、256KiB、静态图片、版本冲突、并发、超时或进程回收限制。浏览器上传流程及数据库结构未改变。

新增 `tests/avatar-container.mjs` / `npm run test:avatar-container`，对实际部署镜像执行隔离数据库的上传/读取回归：透明图及超过32KiB的高细节图，断言真实HTTP成功、RIFF长度正确、输出大小合规。CI新增构建部署镜像后执行该测试，避免只测试宿主机新版FFmpeg。

浅色主背景改为 `#ffefc1`，面板、播放器底色及柔和边框同步调整为相配的浅米黄色；辅色仍为 `#9E7867`。未加入深色模式。

## 实际验证

证据目录：`C:/Users/ALIENWARE/Desktop/杂项/RainSync-avatar-theme-2026-09-28`。每项 logs/NAME.json 记录实际命令、起止时间和退出码，同名 .log 为输出。

- `avatar-regression-red`：旧部署镜像透明图成功，高细节图503，回归测试按预期失败。
- `docker-server-proxy`、`docker-web-proxy`：两个修复镜像构建通过。最初直连镜像仓库失败；后按用户提供的7897代理，仅为构建进程和构建步骤设置代理，没有修改全局设置。
- `avatar-container-green`：修复后的Linux镜像，透明图604字节、高细节图186208字节、用户提供图片的本地512×512裁剪38000字节，均成功上传并读取，RIFF长度正确。用户图片仅保存在杂项作为临时验证输入，没有提交Git，也没有替换用户当前头像。
- `native-build`、`avatar-native`：宿主机完整二进制构建及现有真实头像集成通过，含透明度、版本竞争、删除墓碑、故障与超时回收。
- `theme-browser`：桌面/移动配置共22个新界面与布局回归通过，包含主色、对比度、裁剪之外的界面尺寸、动效和跨路由播放器保持。
- `theme-build`：前端构建通过，原有约806kB JS chunk提示仍在；`cargo fmt --all --check`通过。
- `local-update`：仅重建本地已运行的 server/web 容器，数据库与worker未重建；没有推送GitHub。更新后HTTP首页200、匿名账号接口401，实际加载CSS包含 `#ffefc1` 和 `#9e7867`，后端日志确认ready。

远程CI尚未运行。本轮使用隔离账号测试实际图片，没有读取或改动用户部署账号/头像。原有Dockerfile的HTTPS软件源修改及三个文件删除均保留，未纳入本次提交。

## 本地回滚

更新前已保存旧镜像标签。以下仅在需要回滚时执行，会短暂重启后端/前端；不删除数据库或卷：

```powershell
docker tag rainsync-server:rollback-avatar-20260928-185531 rainsync-server:dev
docker tag rainsync-web:rollback-avatar-20260928-185531 rainsync-web:dev
docker compose up -d --no-deps --no-build server web
```

修复镜像也保留为 `rainsync-server:avatar-pipe-fix` 和 `rainsync-web:cream-fix`。源代码回退使用本次提交的 `git revert`，不会覆盖用户保留的未提交修改。
