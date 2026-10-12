import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import {
  dashFixtureManifest,
  dashTrackFixture,
} from "./fixtures/dash-segment-base";

const sessionId = "12345678-1234-1234-1234-123456789abc";
const delivery = `/api/v1/platform-delivery/${sessionId}/`;
const query = "?token=local_clear_vod_fixture_token";
const video = dashTrackFixture("video"),
  audio = dashTrackFixture("audio");
const manifest = dashFixtureManifest(delivery, query, video, audio);
const adapterUrl =
  "/@fs/" + resolve("packages/player-core/dash.ts").replaceAll("\\", "/");

test("real dash.js SIDX seeks present the target frame without downloading the previous video segment", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const reads: { track: string; range: string }[] = [],
    errors: string[] = [];
  let delayedManifest: Promise<void> | undefined;
  let delayedResponse: (() => void) | undefined;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__dash_segment_base_fixture__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local DASH seek fixture</title>",
    }),
  );
  await page.route(`**${delivery}**`, async (route) => {
    const request = route.request(),
      pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("manifest.mpd")) {
      if (delayedManifest) await delayedManifest;
      try {
        await route.fulfill({
          contentType: "application/dash+xml",
          body: manifest,
        });
      } catch (failure) {
        if (!delayedManifest) throw failure;
      } finally {
        // destroyed request may already be aborted
        delayedResponse?.();
      }
      return;
    }
    const kind = pathname.endsWith("video_1") ? "video" : "audio";
    const track = kind === "video" ? video : audio;
    const range = request.headers().range ?? "";
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match)
      throw new Error(`Expected bounded DASH byte range, received ${range}`);
    const start = Number(match[1]),
      end = match[2] ? Number(match[2]) : track.data.length - 1;
    if (start > end || end >= track.data.length)
      throw new Error("Invalid SDK fixture range");
    reads.push({ track: kind, range: `${start}-${end}` });
    await route.fulfill({
      status: 206,
      headers: {
        "Content-Type": `${kind}/mp4`,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${track.data.length}`,
      },
      body: track.data.subarray(start, end + 1),
    });
  });
  await page.goto("/__dash_segment_base_fixture__");
  await page.evaluate(
    async ({ adapterUrl, sessionId, playbackUrl }) => {
      const { createDashPlayback, loadDashJs } = await import(adapterUrl);
      const module = await loadDashJs();
      const state = {
        player: undefined as ReturnType<typeof createDashPlayback> | undefined,
        video: undefined as HTMLVideoElement | undefined,
        failures: [] as unknown[],
      };
      const attach = async (optimized: boolean) => {
        state.player?.destroy();
        state.video?.remove();
        state.video = document.createElement("video");
        state.video.muted = true;
        state.video.style.width = "320px";
        document.body.append(state.video);
        state.player = createDashPlayback({
          video: state.video,
          sessionId,
          playbackUrl,
          onError: (failure: unknown) => state.failures.push(failure),
          loadModule: async () => ({
            ...module,
            createPlayer: () => {
              const actual = module.createPlayer();
              return {
                ...actual,
                extend: optimized ? actual.extend?.bind(actual) : undefined,
                updateSettings(settings: unknown) {
                  actual.updateSettings(settings);
                  // Equal, small test buffer ceilings prevent prefetch from
                  // hiding extra seek requests. Production settings stay exact.
                  actual.updateSettings({
                    streaming: {
                      buffer: {
                        bufferTimeDefault: 1,
                        bufferTimeAtTopQuality: 1,
                        bufferTimeAtTopQualityLongForm: 1,
                      },
                    },
                  });
                },
              };
            },
          }),
        });
        if (!(await state.player.load()))
          throw new Error("Adapter did not attach source");
      };
      const frame = (target: number) =>
        new Promise<number>((resolve, reject) => {
          const video = state.video!;
          const timer = setTimeout(
            () => reject(new Error(`No presented frame near ${target}s`)),
            8000,
          );
          const observe = (
            _now: number,
            metadata: VideoFrameCallbackMetadata,
          ) => {
            if (Math.abs(metadata.mediaTime - target) < 0.25) {
              clearTimeout(timer);
              resolve(metadata.mediaTime);
            } else video.requestVideoFrameCallback(observe);
          };
          video.requestVideoFrameCallback(observe);
        });
      Object.assign(window, {
        dashSeekFixture: {
          async start(optimized: boolean) {
            await attach(optimized);
            const first = frame(0);
            await state.video!.play();
            await first;
            state.video!.pause();
          },
          startOnly() {
            return attach(true);
          },
          async seek(target: number, playing = false) {
            const presented = frame(target);
            state.video!.currentTime = target;
            if (playing) await state.video!.play();
            const mediaTime = await presented;
            state.video!.pause();
            return mediaTime;
          },
          async consecutiveSeek() {
            const presented = frame(40);
            state.video!.currentTime = 17;
            state.video!.currentTime = 36;
            state.video!.currentTime = 40;
            return presented;
          },
          destroy() {
            state.player?.destroy();
          },
          failures: state.failures,
        },
      });
    },
    { adapterUrl, sessionId, playbackUrl: delivery + "manifest.mpd" + query },
  );

  const call = (
    name: "start" | "startOnly" | "seek" | "consecutiveSeek" | "destroy",
    args: unknown[] = [],
  ) =>
    page.evaluate(
      ({ name, args }) =>
        (
          window as unknown as {
            dashSeekFixture: Record<string, (...args: unknown[]) => unknown>;
          }
        ).dashSeekFixture[name](...args),
      { name, args },
    );
  const evidence: unknown[] = [];
  await call("start", [false]);
  let checkpoint = reads.length;
  const controlFrame = await call("seek", [36]);
  const controlReads = reads
    .slice(checkpoint)
    .filter((read) => read.track === "video");
  expect(controlReads.map((read) => read.range)).toContain(
    video.segments[6].range,
  );
  expect(controlReads.map((read) => read.range)).toContain(
    video.segments[7].range,
  );
  evidence.push({
    mode: "installed-sdk-control",
    target: 36,
    presentedMediaTime: controlFrame,
    reads: controlReads,
  });

  for (const [target, index, audioIndex, playing] of [
    [35, 7, 6, false],
    [36, 7, 7, false],
    [38, 7, 7, false],
    [40, 8, 7, false],
    [36, 7, 7, true],
  ] as const) {
    await call("start", [true]);
    checkpoint = reads.length;
    const presented = await call("seek", [target, playing]);
    const targetReads = reads
      .slice(checkpoint)
      .filter((read) => read.track === "video");
    const audioReads = reads
      .slice(checkpoint)
      .filter((read) => read.track === "audio");
    expect(targetReads.map((read) => read.range)).toContain(
      video.segments[index].range,
    );
    expect(targetReads.map((read) => read.range)).not.toContain(
      video.segments[index - 1].range,
    );
    // Audio's real AAC index boundaries differ: at 35/40 s its covering
    // fragment is still the previous numbered one and must not be skipped.
    expect(audioReads.map((read) => read.range)).toContain(
      audio.segments[audioIndex].range,
    );
    evidence.push({
      mode: "scoped-adapter",
      target,
      playing,
      presentedMediaTime: presented,
      reads: targetReads,
      audioReads,
    });
  }
  await call("start", [true]);
  expect(await call("consecutiveSeek")).toBeGreaterThanOrEqual(39.75);
  // A reset while the actual SDK's MPD fetch is in flight must not let its late
  // response attach tracks or report a stale failure against a newer source.
  let releaseManifest!: () => void;
  delayedManifest = new Promise((resolve) => {
    releaseManifest = resolve;
  });
  const responded = new Promise<void>((resolve) => {
    delayedResponse = resolve;
  });
  const pendingRequest = page.waitForRequest((request) =>
    request.url().includes(delivery + "manifest.mpd"),
  );
  checkpoint = reads.length;
  await call("startOnly");
  await pendingRequest;
  await call("destroy");
  releaseManifest();
  await responded;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(reads.slice(checkpoint)).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { dashSeekFixture: { failures: unknown[] } })
          .dashSeekFixture.failures,
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
  const evidenceFile = info.outputPath("dash-seek-evidence.json");
  writeFileSync(
    evidenceFile,
    JSON.stringify(
      {
        sdkVersion: "5.2.0",
        controlledBufferSeconds: 1,
        frameToleranceSeconds: 0.25,
        videoSegments: video.segments,
        audioSegments: audio.segments,
        samples: evidence,
        consecutiveSeekPresented: true,
        lateManifestAfterDestroyReads: reads.slice(checkpoint),
      },
      null,
      2,
    ),
  );
  await info.attach("dash-seek-range-and-presented-frame-evidence", {
    path: evidenceFile,
    contentType: "application/json",
  });
});
