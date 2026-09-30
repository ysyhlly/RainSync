# 真实浏览器、Server与Worker联合验收

首次门槛在旧UI默认入口删除前以`/preview`完成；根入口切换及最后修复后的最终重跑也已完成，见下方最终记录。`tests/browser-real.mjs`不拦截任何HTTP或WebSocket，不替换HTMLMediaElement方法。启动独立随机端口PostgreSQL17容器、真实Server及Worker，再用Vite同源代理和两份隔离Chromium Cookie上下文操作页面。使用FFmpeg现场合成180秒H264/AAC素材，无私人媒体或照片。

## 已实测流程

1. 管理员登录，页面添加本地片源并扫描两部实际文件；FFprobe返回真实时长和轨道。
2. 管理页生成两个注册码，首次复制；匿名页面校验其中一个→设置账号/中文Emoji昵称/含首尾空格密码→注册→自动登录。检查真实Cookie/CSRF身份为普通用户，无自动房间成员关系，数据库仅一个邀请码被消费。
3. 宽1800×900与长900×1800合成图分别取两侧，共四次独立裁剪保存；从真实认证头像GET取回WebP，真实解码512×512、检查尺寸/格式/≤256KiB和中心像素颜色。昵称草稿仍保留且未被头像保存写入，保存昵称又不改变头像版本；刷新以及原固定账号登录均通过。
4. 管理员页面创建房间并生成房间邀请，注册用户页面解析并加入；媒体库加入两个待播、选片，Worker真实读取媒体，两个浏览器currentTime均推进。管理员暂停/跳转20秒/恢复后，观众同步，观众播放按钮不可控制。真实聊天同时收到昵称，待播添加/移除通过。
5. 管理员观影→媒体库→片源→NAS→邀请码→个人资料→同一房间，逐段currentTime推进且保留相同video对象。真实WS连接1、播放POST1、全库两人的playback_sessions共2，前后均不变。
6. 普通用户访问管理路由被引导并提示，直接管理API403。管理员手动创建仅普通账号，真实NAS配对码创建与撤销页面生效。撤销测试等待对话框关闭和“已撤销”历史状态，避免把请求中的暂时disabled误当提交成功。
7. 停止并重新启动Server，同一Cookie和资料保持、最终WebP版本/像素保持、邀请码消费次数仍为1。Server重启时预期连接重置日志保留，没有将故意断网诊断包装为未发生。

## 执行与证据

```powershell
. ./scripts/validation-env.ps1 -ArtifactRoot 'C:/Users/ALIENWARE/Desktop/杂项/RainSync-implementation-2026-09-28'
node scripts/run-check.mjs d-real-browser-verified 360 node tests/browser-real.mjs
```

2026-09-27T21:05:32.219Z至21:05:59.208Z退出0。真实代码状态为C7提交`e0a2704c650526e9199ae08f23797b73ba9042d3`加本验收设施。JSON/日志在ARTIFACT/logs/d-real-browser-verified.*；每次隔离运行的无凭据evidence.json、服务日志和合成文件在ARTIFACT/browser-real/随机UUID，实际路径由日志末行列出。前一次已通过的证据`de577d0b-f2fe-4c32-8e54-035a7aa44f29/evidence.json`记录双用户相位差约0.040秒，跨页面时间20.539→22.188秒，播放实例计数保持。它是该次受控本机观察，不承诺所有网络下的固定漂移上界。

首次测试在创建房间后的路由过渡同时看到h1/h2同名标题，改为精确level1断言后通过。后续加强NAS撤销提交等待并完整重跑通过。没有削弱业务要求或用mock替换真实服务。

## 设施说明与边界

Vite可通过`RAINSYNC_SERVER_PROXY_URL`、`RAINSYNC_WORKER_PROXY_URL`显式指定本地测试服务，默认8080/8081保持。独立fixture的HTTP客户端Origin跟随配置PUBLIC_ORIGIN，以适应同源Vite代理；仍只在自建随机数据库写入。正式部署不依赖这些测试开关。

联合验收为桌面Chromium直接播放，模拟HLS恢复、取消/幂等/生成区间由既有浏览器回归和真实Server/Worker集成覆盖。Safari/iOS/Android实机、长时连续播放和真实弱网未验证。最终交付状态与提交清单见IMPLEMENTATION_REPORT。

## 根入口最终重跑

`final-real-browser`于2026-09-27T21:19:12.238Z开始、21:19:39.503Z结束，执行`node --run test:browser-real`，退出0、未超时。运行在唯一根路由，包含入口切换后的迟到房间/聊天ACK/片库刷新修复；同批产品变更随后提交`2f24be569b105fcbba3a3ef26d2457e9c2292f37`。测试时HEAD仍为`c06ae0394323517851b64ae5f66558f332c8925e`，evidence如实记录此前置HEAD及空entry，不将后来的提交号写回证据。

最终路径`ARTIFACT/browser-real/f9ecebb8-3b8a-4db0-9e2e-c561e7f268ab/evidence.json`。四次实际WebP均512×512、552/554字节且分别红/蓝像素；跨页currentTime为20.570→20.965→21.376→21.790→22.205秒，视频同对象、WS1→1、播放POST1→1、全库两用户会话2→2。此轮同步偏差约0.002704秒，仅为本地受控观察。全部上述账户/权限/管理/重启流程通过。

完整原业务浏览器测试同期`d-switch-browser-final`共86例通过，包含原38例。最终前端44单测/类型/构建及Rust/真实接口/原集成均通过。准确命令、时间与选定证据哈希见VERIFICATION_MANIFEST.json；详细边界及失败修复见IMPLEMENTATION_REPORT第5/9节。
