import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { PlaybackObservation } from "../../packages/protocol";
import { appFixture } from "./fixtures/application";
import { chooseRoom } from "./fixtures/navigation";

async function setup(
  page: Page,
  options: { legacy?: boolean; seq?: number } = {},
) {
  const fixture = await appFixture(page);
  const clip = Buffer.from(
    readFileSync("tests/fixtures/browser-video.base64", "utf8").trim(),
    "base64",
  );
  // Seeking this real MP4 requires a Range response. A full 200 on a seek
  // request makes Chromium restart at zero, even without the application.
  await page.route("**/fixture-video.mp4", async (route) => {
    const range = route
      .request()
      .headers()
      .range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(clip.length - 1, Number(range[2]))
      : clip.length - 1;
    if (start >= clip.length || end < start)
      return route.fulfill({
        status: 416,
        headers: { "content-range": `bytes */${clip.length}` },
      });
    await route.fulfill({
      status: range ? 206 : 200,
      headers: {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${clip.length}` }
          : {}),
      },
      body: clip.subarray(start, end + 1),
    });
  });
  const observations: PlaybackObservation[] = [];
  const final: PlaybackObservation[] = [];
  const preparations: unknown[] = [];
  await page.route("**/api/v1/playback-sessions", async (route) => {
    preparations.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        session_id: "observed-video",
        plan_generation: route.request().postDataJSON().plan_generation,
        media_id: "movie",
        media_generation: 1,
        delivery_mode: "direct",
        transport: "progressive",
        playback_url: "/fixture-video.mp4",
        timeline_origin_ms: 0,
        duration_ms: 30000,
        expires_in_seconds: 1800,
        rebuild_on_seek: false,
        audio_tracks: [],
        subtitle_tracks: [],
        ...(!options.legacy
          ? { observation_version: 1, observation_seq: options.seq ?? 0 }
          : {}),
      },
    });
  });
  await page.route(
    "**/api/v1/playback-sessions/observed-video/observations",
    async (route) => {
      const body = route.request().postDataJSON() as PlaybackObservation;
      observations.push(body);
      await route.fulfill({
        json: {
          session_id: "observed-video",
          observation_seq: body.seq,
          has_played: observations.some((value) => value.has_played),
        },
      });
    },
  );
  await page.route(
    "**/api/v1/playback-sessions/observed-video",
    async (route) => {
      if (route.request().method() === "DELETE" && route.request().postData())
        final.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.goto("/");
  await chooseRoom(page, fixture.room.name);
  await expect
    .poll(() => page.locator("video").evaluate((el) => el.readyState))
    .toBeGreaterThanOrEqual(2);
  return { fixture, observations, preparations, final };
}

async function leaveViewing(page: Page) {
  const leave = page.getByRole("button", { name: "离开观看", exact: true });
  if (!(await leave.isVisible()))
    await page.getByRole("tab", { name: "待播", exact: true }).click();
  await leave.click();
}

test("actual decoded video events report its own paused and seek positions", async ({
  page,
}, testInfo) => {
  const { fixture, observations, preparations } = await setup(page);
  expect(preparations[0]).toMatchObject({ observation_version: 1 });
  await expect
    .poll(() => observations.length, { timeout: 8000 })
    .toBeGreaterThan(0);
  expect(observations.every((body) => !body.has_played)).toBe(true);
  const frame = await page.locator("video").evaluate(async (el) => {
    el.muted = true;
    await el.play();
    return await new Promise<{ time: number; frames: number }>((resolve) =>
      el.requestVideoFrameCallback((_, data) =>
        resolve({ time: data.mediaTime, frames: data.presentedFrames }),
      ),
    );
  });
  expect(frame.frames).toBeGreaterThan(0);
  await expect
    .poll(() =>
      observations.some((body) => body.event === "playing" && body.has_played),
    )
    .toBe(true);
  const pausedAt = await page.locator("video").evaluate((el) => {
    el.pause();
    return el.currentTime * 1000;
  });
  await expect
    .poll(() => observations.filter((body) => body.event === "pause").length)
    .toBeGreaterThan(0);
  const pause = observations.filter((body) => body.event === "pause").at(-1)!;
  expect(pause.paused).toBe(true);
  expect(pause.media_time_ms).toBeCloseTo(pausedAt, 0);
  expect(pause.has_played).toBe(true);
  const seekStart = observations.length;
  const seekAt = await page.locator("video").evaluate(async (el) => {
    return await new Promise<number>((resolve) => {
      el.addEventListener("seeked", () => resolve(el.currentTime * 1000), {
        once: true,
      });
      el.currentTime = 1.8;
    });
  });
  expect(seekAt).toBeGreaterThan(pausedAt);
  await expect
    .poll(
      () =>
        observations.slice(seekStart).filter((body) => body.event === "seeked")
          .length,
    )
    .toBeGreaterThan(0);
  const seek = observations
    .slice(seekStart)
    .filter((body) => body.event === "seeked")
    .at(-1)!;
  expect(seek.media_time_ms).toBeCloseTo(seekAt, 0);
  expect(seek.paused).toBe(true);
  expect(seek.seeking).toBe(false);
  expect(seek.media_time_ms).toBeGreaterThan(pause.media_time_ms);
  expect(fixture.state.anchor_position_ms).toBe(0);
  expect(fixture.preparations()).toBe(0); // The isolated v1 route above handled preparation.
  expect(preparations).toHaveLength(1);
  expect(fixture.connections()).toBe(1);
  expect(fixture.errors).toEqual([]);
  await testInfo.attach("actual-decoded-video-observations", {
    body: Buffer.from(
      JSON.stringify({ frame, pausedAt, seekAt, observations, preparations }),
    ),
    contentType: "application/json",
  });
});

test("explicit leave captures the old actual time and the persisted sequence before clearing src", async ({
  page,
}) => {
  const { observations, final } = await setup(page, { seq: 40 });
  const stoppedAt = await page.locator("video").evaluate((el) => {
    el.currentTime = el.duration * 0.55;
    return el.currentTime * 1000;
  });
  await expect
    .poll(() => observations.filter((body) => body.event === "seeked").length)
    .toBeGreaterThan(0);
  const previousSeq = observations.at(-1)!.seq;
  await leaveViewing(page);
  await expect.poll(() => final.length).toBe(1);
  expect(final[0].media_time_ms).toBeCloseTo(stoppedAt, 0);
  expect(final[0].seq).toBeGreaterThan(previousSeq);
  expect(final[0].seq).toBeGreaterThan(40);
  expect(final[0].has_played).toBe(false);
  expect(observations.every((body) => body.seq !== final[0].seq)).toBe(true);
});

test("a legacy plan keeps playback working without sending an unsupported observation endpoint", async ({
  page,
}) => {
  const { observations, final } = await setup(page, { legacy: true });
  await page.locator("video").evaluate(async (el) => {
    el.muted = true;
    await el.play();
  });
  await expect
    .poll(() => page.locator("video").evaluate((el) => el.currentTime))
    .toBeGreaterThan(0);
  await leaveViewing(page);
  expect(observations).toEqual([]);
  expect(final).toEqual([]);
});
