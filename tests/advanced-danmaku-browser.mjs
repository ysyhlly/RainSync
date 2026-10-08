// Actual Vue renderer + module Worker + finite native HTMLVideoElement clock.
// Controlled same-origin text fixtures; no production user/account/media writes.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "@playwright/test";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts =
  process.env.RAINSYNC_ARTIFACT_DIR ?? resolve(root, ".artifacts");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(
  resolve(artifacts, "advanced-danmaku-browser-"),
);
const videoFile = resolve(directory, "clip.mp4");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x142839:s=960x540:r=10:d=10",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  videoFile,
]);
const cues = [
  {
    at_ms: 0,
    text: "BAS 弹幕",
    mode: "top",
    program: {
      language: "bas",
      source: `
    def text t {content="BAS 初始" x=10% y=12% fontSize=4% duration=8s color=0x00a1d6}
    def button b {text="跳转到3秒" x=35% y=72% fontSize=3% duration=8s target=seek {time=3s}}
    def button link {text="打开关联视频" x=12% y=84% fontSize=2% duration=8s target=av {bvid="BV1dGhd68Epd" page=2 time=1s}}
    def path p {d="M0 0 L32 0 L16 32 Z" viewBox="0 0 32 32" x=75% y=60% width=8% height=14% fillColor=0xffca28 duration=8s}
    set t {x=50%} 2s then set t {content="BAS 变化" alpha=0.5} 2s`,
    },
  },
  {
    at_ms: 0,
    text: "Script 弹幕",
    mode: "top",
    program: {
      language: "script",
      source: `
    var c=$.createComment("Script 初始",{x:30,y:120,size:24,lifeTime:8});
    Utils.timer(function(){c.text="Script 定时变化";},2000);
    Tween.to(c,{x:250},4).play();`,
    },
  },
  {
    at_ms: 0,
    text: "互动投票",
    mode: "top",
    interaction: {
      kind: "vote",
      duration_ms: 8000,
      video: "BV1dGhd68Epd",
      options: ["选项一", "选项二"],
    },
  },
  { at_ms: 0, text: "普通弹幕", mode: "scroll" },
];
const main = resolve(directory, "main.ts");
await writeFile(
  main,
  `import {createApp,h,shallowRef,ref,effectScope,onMounted} from "vue";
import PlatformDanmaku from "/@fs/${root}/apps/web/src/features/playback/PlatformDanmaku.vue";
import {createPlatformTextRuntime} from "/@fs/${root}/apps/web/src/features/playback/platform-text-runtime.ts";
const video=shallowRef(),canSeek=ref(false),seek=ref(null),scope=effectScope();
const session={epoch:0,api:async (path,method,body,signal)=>{const r=await fetch('/api/v1'+path,{signal});if(!r.ok)throw Error('fixture_api_failed');return r.json();}};
const runtime=scope.run(()=>createPlatformTextRuntime({video,api:session.api,identity:{current:()=>({userId:undefined,epoch:session.epoch}),invalidate:()=>{},subscribeInvalidation:()=>()=>{}}}));
const plan={session_id:'00000000-0000-4000-8000-000000000001',native_platform:{version:1},playback_url:'/api/v1/platform-delivery/00000000-0000-4000-8000-000000000001/manifest.mpd?token='+'a'.repeat(64)};
createApp({setup(){onMounted(async()=>{if(video.value.readyState<1)await new Promise(r=>video.value.addEventListener('loadedmetadata',r,{once:true}));await runtime.bind(plan);await runtime.setPlatformDanmaku(true);});
return ()=>h('main',[h('div',{class:'stage'},[h('video',{ref:video,src:'/__danmaku_test/clip.mp4',preload:'auto',muted:true}),h(PlatformDanmaku,{video:video.value,cues:runtime.platformDanmakuCues.value,enabled:runtime.platformDanmakuEnabled.value,canSeek:canSeek.value,onSeek:at=>{seek.value=at;if(canSeek.value)video.value.currentTime=at/1000;}})]),h('button',{onClick:()=>runtime.setPlatformDanmaku(false)},'关闭弹幕')]);}}).mount('#app');
(window as any).__danmaku={video,canSeek,seek,runtime,dispose:()=>scope.stop(),replace:()=>runtime.bind({...plan,session_id:'00000000-0000-4000-8000-000000000002',playback_url:plan.playback_url.replace('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')})};`,
);
const html = `<!doctype html><html><meta charset="utf-8"><link rel="icon" href="data:,"><style>body{margin:0;background:#eef3f5;font-family:sans-serif}.stage{position:relative;width:min(960px,100vw);margin:auto}video{width:100%;display:block}button{margin:8px}</style><div id="app"></div><script type="module" src="/@fs/${main}"></script></html>`;
const requests = [];
const server = await createServer({
  configFile: false,
  root,
  resolve: {
    dedupe: ["vue"],
    alias: {
      vue: resolve(root, "node_modules/vue/dist/vue.runtime.esm-bundler.js"),
    },
  },
  optimizeDeps: { include: ["vue", "acorn"] },
  plugins: [
    vue(),
    {
      name: "finite-danmaku-fixtures",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          const pathname = new URL(req.url, "http://localhost").pathname;
          if (pathname === "/__danmaku_test/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(await s.transformIndexHtml(pathname, html));
            return;
          }
          if (pathname === "/__danmaku_test/clip.mp4") {
            res.setHeader("Content-Type", "video/mp4");
            const bytes = await readFile(videoFile);
            res.setHeader("Accept-Ranges", "bytes");
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
            if (range) {
              const start = Number(range[1]),
                end = range[2]
                  ? Math.min(Number(range[2]), bytes.length - 1)
                  : bytes.length - 1;
              res.statusCode = 206;
              res.setHeader(
                "Content-Range",
                `bytes ${start}-${end}/${bytes.length}`,
              );
              res.setHeader("Content-Length", end - start + 1);
              res.end(bytes.subarray(start, end + 1));
            } else {
              res.setHeader("Content-Length", bytes.length);
              res.end(bytes);
            }
            return;
          }
          if (pathname.startsWith("/api/v1/platform-delivery/")) {
            requests.push(req.url);
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify(
                pathname.endsWith("/catalog")
                  ? {
                      subtitle_tracks: [],
                      subtitles_status: "none",
                      danmaku_status: "available",
                    }
                  : { snapshot: true, cues, warnings: [] },
              ),
            );
            return;
          }
          next();
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root, directory] } },
});
let browser, currentPage, currentErrors;
try {
  await server.listen();
  const address = server.httpServer.address(),
    url = `http://127.0.0.1:${address.port}/__danmaku_test/`;
  browser = await chromium.launch({
    executablePath: process.env.RAINSYNC_CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  const results = [];
  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(),
      errors = [];
    currentPage = page;
    currentErrors = errors;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(url);
    await page.getByText("BAS 初始", { exact: true }).waitFor();
    await page.getByText("Script 初始", { exact: true }).waitFor();
    assert.equal(await page.locator(".advanced-node path").count(), 1);
    const button = page.getByRole("button", { name: "跳转到3秒" });
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.getByText("选项一 · 选项二").count(), 1);
    await page.evaluate(() => (window.__danmaku.canSeek.value = true));
    await button.click();
    await page.getByText("BAS 变化", { exact: true }).waitFor();
    await page.getByText("Script 定时变化", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__danmaku.seek.value), 3000);
    const before = await page
      .getByText("BAS 变化", { exact: true })
      .evaluate((e) => e.parentElement.style.cssText);
    await page.waitForTimeout(200);
    assert.equal(
      await page
        .getByText("BAS 变化", { exact: true })
        .evaluate((e) => e.parentElement.style.cssText),
      before,
    );
    await page.screenshot({
      path: resolve(directory, `scene-${viewport.width}.png`),
    });
    const link = page.getByRole("link", {
      name: "打开关联视频（在新窗口打开原站）",
    });
    assert.equal(
      await link.getAttribute("href"),
      "https://www.bilibili.com/video/BV1dGhd68Epd/?p=2&t=1",
    );
    await page.evaluate(() => {
      window.__danmaku.video.value.currentTime = 0.5;
    });
    await page.getByText("BAS 初始", { exact: true }).waitFor();
    await page.getByText("Script 初始", { exact: true }).waitFor();
    await page.evaluate(async () => {
      const v = window.__danmaku.video.value;
      v.playbackRate = 2;
      await v.play();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__danmaku.video.value.pause());
    assert.equal(
      await page.evaluate(() => window.__danmaku.video.value.playbackRate),
      2,
    );
    await page.getByRole("button", { name: "关闭弹幕" }).click();
    assert.equal(await page.locator(".platform-danmaku").count(), 0);
    await page.evaluate(() => window.__danmaku.replace());
    assert.equal(await page.locator(".advanced-node").count(), 0);
    await page.evaluate(() => window.__danmaku.dispose());
    assert.deepEqual(errors, []);
    results.push({
      viewport,
      passed: true,
      checks: [
        "actual_module_worker",
        "native_video_clock",
        "script_timer",
        "bas_path",
        "seek_button_permission",
        "pause",
        "backwards_seek",
        "rate",
        "disable",
        "media_replace",
        "dispose",
      ],
    });
    await context.close();
  }
  assert(requests.some((r) => r.includes("rendering_version=3")));
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify({ fixtureTransport: true, results, requests }, null, 2),
  );
  console.log(
    JSON.stringify(
      { passed: true, report: resolve(directory, "result.json") },
      null,
      2,
    ),
  );
} catch (error) {
  if (currentPage) {
    await writeFile(
      resolve(directory, "failed.html"),
      await currentPage.content(),
    );
    await currentPage.screenshot({ path: resolve(directory, "failed.png") });
    console.error(
      JSON.stringify({
        directory,
        errors: currentErrors,
        requests,
        debug: await currentPage.evaluate(() => ({
          ready: window.__danmaku?.video.value.readyState,
          time: window.__danmaku?.video.value.currentTime,
          seeking: window.__danmaku?.video.value.seeking,
          seek: window.__danmaku?.seek.value,
          error: window.__danmaku?.runtime.platformTextError.value,
          enabled: window.__danmaku?.runtime.platformDanmakuEnabled.value,
          cues: window.__danmaku?.runtime.platformDanmakuCues.value,
        })),
      }),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
