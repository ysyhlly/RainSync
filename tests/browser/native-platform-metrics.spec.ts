import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlaybackMetricsSnapshot } from "../../apps/web/src/features/playback/playback-metrics";
import {
  dashFixtureManifest,
  dashTrackFixture,
} from "./fixtures/dash-segment-base";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const sessionId = id(21);
const delivery = `/api/v1/platform-delivery/${sessionId}/`;
const token = "?token=local_clear_native_metrics_fixture_token";
const video = dashTrackFixture("video"),
  audio = dashTrackFixture("audio");
const manifest = dashFixtureManifest(delivery, token, video, audio);
const runtimeUrl =
  "/@fs/" +
  resolve("apps/web/src/features/playback/playback-runtime.ts").replaceAll(
    "\\",
    "/",
  );
type BrowserEvidence = {
  local?: PlaybackMetricsSnapshot;
  stage: string;
  session: string;
  error: string;
  frames: (VideoFrameCallbackMetadata & { now: number })[];
  responseReceipts: unknown[];
  video: {
    readyState: number;
    currentTime: number;
    width: number;
    height: number;
    paused: boolean;
  };
};

// HTTP grant/receipt fixtures exercise the production browser runtime, meter,
// sender and dash.js. They do not qualify platform authorization or a live CDN.
for (const granted of [true, false]) {
  test(`real native Bilibili DASH ${granted ? "v2 grant posts its presented-frame meter" : "legacy response retains local evidence without posting"}`, async ({
    page,
  }, info) => {
    test.setTimeout(30_000);
    const prepares: Record<string, unknown>[] = [],
      packets: Record<string, unknown>[] = [],
      receipts: Record<string, unknown>[] = [],
      reads: { track: string; range: string }[] = [],
      errors: string[] = [],
      apiPaths: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/__native_metrics_fixture__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Local native playback metrics fixture</title>",
      }),
    );
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      apiPaths.push(`${request.method()} ${path}`);
      if (path === "/api/v1/playback-sessions/native-platform") {
        expect(request.method()).toBe("POST");
        const body = request.postDataJSON();
        prepares.push(body);
        // Keep a measurable preparation phase without modifying performance.now.
        await new Promise((done) => setTimeout(done, 75));
        await route.fulfill({
          json: {
            session_id: sessionId,
            media_id: id(3),
            media_generation: 7,
            plan_generation: body.plan_generation,
            delivery_mode: "direct",
            transport: "dash",
            playback_url: delivery + "manifest.mpd" + token,
            timeline_origin_ms: 0,
            duration_ms: 45_000,
            expires_in_seconds: 120,
            rebuild_on_seek: false,
            audio_tracks: [],
            subtitle_tracks: [],
            native_platform: {
              version: 1,
              provider: "bilibili",
              credential_mode: "anonymous",
              refresh_after_seconds: 30,
            },
            ...(granted
              ? {
                  playback_metrics_version: 2,
                  playback_metrics: {
                    ...body.playback_metrics,
                    metrics_seq: 0,
                    closed: false,
                  },
                }
              : {}),
          },
        });
        return;
      }
      if (path === `/api/v1/playback-sessions/${sessionId}/metrics`) {
        expect(request.method()).toBe("POST");
        const packet = request.postDataJSON();
        packets.push(packet);
        const receipt = {
          session_id: sessionId,
          meter_start_generation: packet.meter_start_generation,
          metrics_seq: packet.seq,
          closed: packet.final,
        };
        receipts.push(receipt);
        await route.fulfill({ json: receipt });
        return;
      }
      if (path.startsWith(delivery)) {
        if (path.endsWith("manifest.mpd")) {
          await route.fulfill({
            contentType: "application/dash+xml",
            body: manifest,
          });
          return;
        }
        const kind = path.endsWith("video_1") ? "video" : "audio",
          track = kind === "video" ? video : audio,
          range = request.headers().range ?? "",
          match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) throw new Error(`Missing native DASH byte range: ${range}`);
        const start = Number(match[1]),
          end = match[2] ? Number(match[2]) : track.data.length - 1;
        expect(start).toBeLessThanOrEqual(end);
        expect(end).toBeLessThan(track.data.length);
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
        return;
      }
      // Optional native text discovery has no tracks/cues in this clear fixture;
      // reset uses the ordinary DELETE route after evidence is collected.
      await route.fulfill({ json: { tracks: [], cues: [], ok: true } });
    });
    await page.goto("/__native_metrics_fixture__");
    await page.evaluate(
      async ({ runtimeUrl, ids }) => {
        const { ref, effectScope } =
            await import("/node_modules/.vite/deps/vue.js"),
          { createPlaybackRuntime } = await import(runtimeUrl);
        const error = ref("");
        const state = ref({
          room_id: ids.room,
          media_id: ids.media,
          media_generation: 7,
          revision: 1,
          playback_status: "playing",
          anchor_position_ms: 0,
          anchor_server_time_ms: 0,
          playback_rate: 1,
        });
        const responseReceipts: unknown[] = [];
        const session = {
          user: { id: ids.user },
          epoch: 1,
          async api(
            path: string,
            method = "GET",
            body?: unknown,
            signal?: AbortSignal,
          ) {
            const response = await fetch("/api/v1" + path, {
              method,
              signal,
              headers: body ? { "Content-Type": "application/json" } : {},
              body: body ? JSON.stringify(body) : undefined,
            });
            if (!response.ok)
              throw new Error(`Fixture HTTP ${response.status}`);
            const result = await response.json();
            if (path.endsWith("/metrics")) responseReceipts.push(result);
            return result;
          },
        };
        const scope = effectScope();
        const runtime = scope.run(() =>
          createPlaybackRuntime({
            session,
            state,
            connected: ref(true),
            active: ref(true),
            clock: { ready: true, revision: 1, now: () => 0 },
            error,
            resolveMedia: async () => ({
              id: ids.media,
              kind: "native_platform",
              title: "Clear local Bilibili route fixture",
              platform: {
                version: 1,
                provider: "bilibili",
                content_id: "BV1xx411c7mD",
                part: 1,
              },
            }),
            run: async (action: () => Promise<void>) => action(),
          }),
        )!;
        const element = document.createElement("video");
        element.muted = true;
        element.playsInline = true;
        element.style.width = "320px";
        document.body.append(element);
        const callbacks: unknown[] = [],
          requestFrame = element.requestVideoFrameCallback.bind(element);
        // Observe the real browser callback consumed by the production meter.
        // No synthetic media events, metadata, timers or SDK factories are used.
        element.requestVideoFrameCallback = (callback) =>
          requestFrame((now, metadata) => {
            callbacks.push({ now, ...metadata });
            callback(now, metadata);
          });
        runtime.attach(element);
        Object.assign(window, {
          nativeMetricsFixture: {
            snapshot: () => ({
              local: runtime.startupDiagnostics.value,
              stage: runtime.loadingStage.value,
              session: runtime.sessionId.value,
              error: error.value,
              frames: callbacks,
              responseReceipts,
              video: {
                readyState: element.readyState,
                currentTime: element.currentTime,
                width: element.videoWidth,
                height: element.videoHeight,
                paused: element.paused,
              },
            }),
            stop: () => scope.stop(),
          },
        });
        await runtime.loadMedia();
        await runtime.enablePlayback();
      },
      { runtimeUrl, ids: { room: id(5), media: id(3), user: id(6) } },
    );
    const snapshot = () =>
      page.evaluate(() =>
        (
          window as unknown as {
            nativeMetricsFixture: { snapshot: () => BrowserEvidence };
          }
        ).nativeMetricsFixture.snapshot(),
      );
    await expect
      .poll(async () => (await snapshot()).local?.first_frame?.evidence, {
        timeout: 8_000,
      })
      .toBe("video_frame_callback");
    // The ordinary maintenance sampler must run for both negotiated and older
    // responses; a missing POST is only meaningful after the same sampling span.
    await expect
      .poll(async () => (await snapshot()).local?.elapsed_ms, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(5_000);
    if (granted) {
      await expect.poll(() => packets.length, { timeout: 2_000 }).toBe(1);
      await expect
        .poll(async () => (await snapshot()).responseReceipts.length)
        .toBe(1);
    }
    const evidence = await snapshot();
    expect(evidence.local).toBeDefined();
    const local = evidence.local!,
      firstFrame = local.first_frame!;
    // The first sample is due from the actual intent's t0, including when the
    // constructor's maintenance tick lands a few ms before meter eligibility.
    expect(local.elapsed_ms).toBeGreaterThanOrEqual(5_000);
    expect(local.elapsed_ms).toBeLessThan(6_500);
    expect(prepares).toHaveLength(1);
    expect(prepares[0]).toMatchObject({
      playback_metrics_version: 1,
      playback_metrics_supported_versions: [1, 2],
      plan_generation: 1,
      playback_metrics: {
        meter_start_generation: 1,
        startup_origin: "user_intent",
      },
    });
    expect(evidence.error).toBe("");
    expect(evidence.frames.length).toBeGreaterThan(0);
    expect(evidence.video).toMatchObject({ width: 160, height: 90 });
    expect(local.startup_phases.preparation_ms).toBeGreaterThan(0);
    expect(local.startup_phases.loading_ms).toBeGreaterThan(0);
    expect(local.startup_phases.unobserved_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(local.startup_phases.unobserved_ms)).toBe(true);
    expect(
      local.startup_phases.preparation_ms +
        local.startup_phases.loading_ms +
        local.startup_phases.unobserved_ms,
    ).toBe(firstFrame.confirmed_elapsed_ms);
    expect(firstFrame).toMatchObject({
      evidence: "video_frame_callback",
    });
    expect(firstFrame.confirmed_elapsed_ms).toBeGreaterThanOrEqual(
      firstFrame.elapsed_ms,
    );
    expect(reads.some((read) => read.track === "video")).toBe(true);
    expect(reads.some((read) => read.track === "audio")).toBe(true);
    if (granted) {
      expect(packets[0]).toMatchObject({
        version: 2,
        seq: 1,
        plan_generation: 1,
        media_generation: 7,
        meter_start_generation: 1,
        first_frame_plan_generation: 1,
        startup_origin: "user_intent",
        final: false,
        startup_phases: local.startup_phases,
        first_frame: firstFrame,
      });
      expect(evidence.responseReceipts).toEqual(receipts);
      expect(receipts).toEqual([
        {
          session_id: sessionId,
          meter_start_generation: 1,
          metrics_seq: 1,
          closed: false,
        },
      ]);
    } else {
      expect(packets).toHaveLength(0);
      expect(evidence.responseReceipts).toHaveLength(0);
    }
    expect(errors).toEqual([]);
    const evidencePath = info.outputPath("native-metrics-evidence.json");
    writeFileSync(
      evidencePath,
      JSON.stringify(
        { granted, prepares, packets, receipts, reads, apiPaths, evidence },
        null,
        2,
      ),
    );
    await info.attach("native-metrics-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });
    await page.evaluate(() =>
      (
        window as unknown as {
          nativeMetricsFixture: { stop: () => void };
        }
      ).nativeMetricsFixture.stop(),
    );
  });
}
