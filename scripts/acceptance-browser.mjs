// Real Playwright-page observation driver. Works with existing disposable test
// pages; it never uses RainSync's target-clock/position-correction implementation.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export async function createBrowserMeasurementDriver({
  clients,
  decodeTimecode,
  saveFrame,
}) {
  assert.ok(Array.isArray(clients) && clients.length >= 1);
  assert.equal(
    typeof decodeTimecode,
    "function",
    "independent fixture timecode decoder required",
  );
  assert.equal(
    typeof saveFrame,
    "function",
    "private frame artifact sink required",
  );
  const handles = new Map();
  for (const client of clients) {
    assert.ok(
      client.client_id &&
        client.room &&
        client.page &&
        !handles.has(client.client_id),
    );
    assert.ok(
      Number.isFinite(client.media_origin_ms) && client.media_origin_ms >= 0,
      "explicit fixture original-coordinate origin required",
    );
    assert.ok(
      typeof client.source_url === "string" && client.source_url,
      "pin the current fixture source URL; never publish it",
    );
    const clock_id = randomUUID();
    await client.page.evaluate(
      ({ clock_id, source_url, media_origin_ms, client_id }) => {
        if (window.__rainsyncAcceptanceObserver)
          throw Error("acceptance observer already installed");
        const video = document.querySelector("video");
        if (!video) throw Error("video element missing");
        if (typeof video.requestVideoFrameCallback !== "function")
          throw Error(
            "independent presented-frame callback unavailable; supply a separately labelled fallback driver",
          );
        const observer = {
          clock_id,
          client_id,
          video,
          source_url,
          media_origin_ms,
          last_frame: null,
          frames: 0,
          intervals: [],
          last: performance.now(),
          state: null,
          expected_playing: true,
          listeners: [],
          callback: null,
        };
        const state = () => ({
          state: video.seeking
            ? "seeking"
            : video.paused
              ? observer.expected_playing
                ? "autoplay-blocked"
                : "paused"
              : !observer.last_frame
                ? "startup"
                : video.readyState < 3
                  ? "rebuffering"
                  : "playing",
          foreground: document.visibilityState === "visible",
          expected_playing: observer.expected_playing,
        });
        const flush = () => {
          const now = performance.now();
          if (observer.state && now > observer.last)
            observer.intervals.push({
              start_ms: observer.last,
              end_ms: now,
              ...observer.state,
            });
          observer.last = now;
          observer.state = state();
          // No hidden unbounded buffer if the controller disappears.
          if (observer.intervals.length > 4096)
            throw Error("acceptance playback-interval buffer overflow");
        };
        observer.flush = flush;
        const frame = (now, metadata) => {
          observer.last_frame = {
            monotonic_ms: now,
            original_position_ms: metadata.mediaTime * 1000 + media_origin_ms,
            presented_frames: metadata.presentedFrames,
            presentation_ms: metadata.expectedDisplayTime,
          };
          observer.frames++;
          flush();
          observer.callback = video.requestVideoFrameCallback(frame);
        };
        observer.callback = video.requestVideoFrameCallback(frame);
        for (const event of [
          "playing",
          "waiting",
          "seeking",
          "seeked",
          "pause",
          "ratechange",
          "ended",
        ]) {
          video.addEventListener(event, flush);
          observer.listeners.push([video, event, flush]);
        }
        document.addEventListener("visibilitychange", flush);
        observer.listeners.push([document, "visibilitychange", flush]);
        observer.state = state();
        window.__rainsyncAcceptanceObserver = observer;
      },
      {
        clock_id,
        source_url: client.source_url,
        media_origin_ms: client.media_origin_ms,
        client_id: client.client_id,
      },
    );
    handles.set(client.client_id, { ...client, clock_id });
  }
  const identities = () =>
    [...handles.values()].map(({ client_id, clock_id, room }) => ({
      client_id,
      clock_id,
      room,
    }));
  const read = async (client) => {
    const snapshot = await client.page.evaluate(() => {
      const observer = window.__rainsyncAcceptanceObserver;
      if (!observer || observer.video !== document.querySelector("video"))
        throw Error(
          "video/page generation changed; recalibration and remapping required",
        );
      const video = observer.video;
      if (video.currentSrc !== observer.source_url)
        throw Error(
          "fixture source changed; original-coordinate mapping no longer valid",
        );
      observer.flush();
      const intervals = observer.intervals.splice(0);
      const frame = observer.last_frame;
      return {
        client_id: observer.client_id,
        clock_id: observer.clock_id,
        ...(frame ?? {}),
        unavailable: !frame,
        playback_rate: video.playbackRate,
        playing: !video.paused && !video.ended,
        seeking: video.seeking,
        buffering: video.readyState < 3,
        foreground: document.visibilityState === "visible",
        presented_frames: observer.frames,
        playback_intervals: intervals,
      };
    });
    return { ...snapshot, room: client.room, evidence: "video-frame-callback" };
  };
  return {
    mode: "real",
    clients: async () => identities(),
    async clockExchange({ client_id, clock_id }) {
      const client = handles.get(client_id);
      assert.ok(client && client.clock_id === clock_id, "unknown client clock");
      return client.page.evaluate(() => {
        const client_receive_ms = performance.now(),
          observer = window.__rainsyncAcceptanceObserver;
        if (!observer) throw Error("client page clock epoch was reset");
        return {
          client_id: observer.client_id,
          clock_id: observer.clock_id,
          client_receive_ms,
          client_send_ms: performance.now(),
        };
      });
    },
    async sample() {
      return {
        clients: await Promise.all(
          [...handles.values()].map(async (client) => {
            try {
              return await read(client);
            } catch (error) {
              return {
                client_id: client.client_id,
                clock_id: client.clock_id,
                unavailable: true,
                reason: error.message,
              };
            }
          }),
        ),
      };
    },
    async setPlayIntent(client_id, expected_playing) {
      assert.equal(typeof expected_playing, "boolean");
      const client = handles.get(client_id);
      assert.ok(client);
      await client.page.evaluate((intent) => {
        const observer = window.__rainsyncAcceptanceObserver;
        observer.flush();
        observer.expected_playing = intent;
        observer.flush();
      }, expected_playing);
    },
    async timecodeChecks() {
      return Promise.all(
        [...handles.values()].map(async (client) => {
          // Bracket screenshot acquisition: a frame decoded during capture may be
          // any frame in this interval. Match against the nearest endpoint and
          // include the bracket in raw evidence for independent review.
          const before = await read(client);
          const png = await client.page.locator("video").screenshot();
          const after = await read(client);
          const frame_sha256 = createHash("sha256").update(png).digest("hex");
          const artifact = await saveFrame(png, {
            sha256: frame_sha256,
            client_id: client.client_id,
          });
          assert.ok(
            artifact?.path && artifact.sha256 === frame_sha256,
            "saved frame artifact identity required",
          );
          // Save before decoding so failed contrast/checksum/ROI checks retain
          // the exact raw screenshot too. A decoder failure never becomes pass.
          let decoded;
          try {
            decoded = await decodeTimecode(png, {
              client_id: client.client_id,
            });
          } catch (cause) {
            const error = new Error(
              "visible timecode decoding failed; raw frame saved",
              { cause },
            );
            error.frame_artifact = { ...artifact, client_id: client.client_id };
            throw error;
          }
          assert.ok(
            Number.isFinite(decoded.original_position_ms) &&
              decoded.original_position_ms >= 0,
          );
          assert.ok(
            decoded.method && decoded.method !== "player-currentTime",
            "timecode decoder must read fixture pixels",
          );
          if (decoded.frame_sha256 !== undefined)
            assert.equal(
              decoded.frame_sha256,
              frame_sha256,
              "decoder frame identity mismatch",
            );
          const decoder_evidence = {};
          for (const name of [
            "frame_index",
            "frame_duration_ms",
            "timestamp_rounding_bound_ms",
          ]) {
            if (decoded[name] !== undefined) {
              assert.ok(
                Number.isFinite(decoded[name]) && decoded[name] >= 0,
                `invalid decoder ${name}`,
              );
              decoder_evidence[name] = decoded[name];
            }
          }
          for (const name of ["sample_id", "human_readable"]) {
            if (decoded[name] !== undefined) {
              assert.ok(
                typeof decoded[name] === "string" &&
                  decoded[name].length <= 128,
              );
              decoder_evidence[name] = decoded[name];
            }
          }
          const nearest = [before, after].sort(
            (a, b) =>
              Math.abs(a.original_position_ms - decoded.original_position_ms) -
              Math.abs(b.original_position_ms - decoded.original_position_ms),
          )[0];
          return {
            client_id: client.client_id,
            method: "visible-frame-timecode",
            decoder: decoded.method,
            decoder_evidence,
            observation_id: randomUUID(),
            frame_sha256,
            artifact,
            visible_original_position_ms: decoded.original_position_ms,
            sample_original_position_ms: nearest.original_position_ms,
            tolerance_ms: 100,
            bracket: { before, after },
          };
        }),
      );
    },
    async dispose() {
      for (const client of handles.values())
        await client.page.evaluate(() => {
          const observer = window.__rainsyncAcceptanceObserver;
          if (!observer) return;
          observer.video.cancelVideoFrameCallback(observer.callback);
          for (const [target, event, listener] of observer.listeners)
            target.removeEventListener(event, listener);
          delete window.__rainsyncAcceptanceObserver;
        });
      handles.clear();
    },
  };
}
