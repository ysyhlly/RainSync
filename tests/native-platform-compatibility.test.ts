import { afterEach, expect, it, vi } from "vitest";
import {
  nativePlatformPlaybackChoice,
  nativePlatformRequest,
  validNativePlatformPlan,
  validNativeCompatibilityDeliveryUrl,
} from "../apps/web/src/features/playback/native-platform-intent";
import { platformTextBase } from "../apps/web/src/features/playback/platform-text";
import {
  PlaybackRequests,
  PlaybackCancelled,
  PlaybackTimeout,
} from "../apps/web/src/playback-request";
import { RequestFailure } from "../apps/web/src/errors";
import type { PlaybackPlan, PlaybackRequest } from "../packages/protocol";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const origin = "https://rain.test",
  token = "a".repeat(64);
function request(): PlaybackRequest {
  return nativePlatformRequest({
    viewer_id: id(1),
    plan_generation: 3,
    idempotency_key: id(2),
    room_id: id(3),
    media_generation: 7,
    media_id: id(4),
    position_ms: 5000,
    credential_mode: "anonymous",
    provider: "bilibili",
    mse_h264_aac: false,
    native_hls: true,
    compatibility: true,
  });
}
function pending(): PlaybackPlan {
  return {
    session_id: id(20),
    media_id: id(4),
    media_generation: 7,
    plan_generation: 3,
    delivery_mode: "transcode",
    transport: "pending_hls",
    playback_url: `/api/v1/platform-delivery/${id(20)}/compatibility/index.m3u8?token=${token}`,
    timeline_origin_ms: 5000,
    duration_ms: 100000,
    expires_in_seconds: 120,
    rebuild_on_seek: true,
    audio_tracks: [],
    subtitle_tracks: [],
    subtitle_mode: "none",
    pending_job_id: id(20),
    seekable_media_ranges_ms: [],
    decoder_fallback_modes: [],
    native_platform: {
      version: 1,
      provider: "bilibili",
      credential_mode: "anonymous",
      refresh_after_seconds: 90,
      quality: {
        version: 1,
        requested_max_height: "auto",
        selected_height: 1080,
        options: [{ max_height: "p1080", height: 1080 }],
      },
      compatibility: { version: 1, mode: "hls_avc_aac" },
    },
  };
}
function ready(): PlaybackPlan {
  const p = pending();
  p.transport = "hls";
  delete p.pending_job_id;
  p.expires_in_seconds = 119;
  p.seekable_media_ranges_ms = [{ start_ms: 5000, end_ms: 15000 }];
  p.native_platform!.compatibility!.output = {
    attempt: 7,
    complete: false,
    codecs: "avc1.64001F,mp4a.40.2",
    width: 1280,
    height: 720,
  };
  p.playback_url += "&attempt=7";
  return p;
}
const storage = () => {
  const saved = new Map<string, string>();
  return {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  };
};
const readiness = () => ({
  session_id: id(20),
  plan_generation: 3,
  status: "ready" as const,
  complete: false,
  available_until_ms: 10000,
});
afterEach(() => vi.useRealTimers());

it("automatically chooses compatibility for split-track and progressive browser transport gaps", () => {
  expect(
    nativePlatformPlaybackChoice("auto", "bilibili", {
      mse_h264_aac: false,
      progressive_h264_aac: true,
      native_hls: true,
    }),
  ).toBe("compatibility");
  for (const provider of ["douyin", "tiktok"] as const)
    expect(
      nativePlatformPlaybackChoice("auto", provider, {
        mse_h264_aac: true,
        progressive_h264_aac: false,
        native_hls: false,
      }),
    ).toBe("compatibility");
  expect(
    nativePlatformPlaybackChoice("native", "bilibili", {
      mse_h264_aac: false,
      progressive_h264_aac: true,
      native_hls: true,
    }),
  ).toBe("unsupported");
  expect(
    nativePlatformPlaybackChoice("compatibility", "youtube", {
      mse_h264_aac: false,
      progressive_h264_aac: true,
      native_hls: false,
    }),
  ).toBe("unsupported");
  expect(
    nativePlatformPlaybackChoice("auto", "youtube", {
      mse_h264_aac: false,
      progressive_h264_aac: true,
      native_hls: false,
    }),
  ).toBe("native");
});
it("Live is excluded from the finite compatibility request and choice", () => {
  expect(() =>
    nativePlatformRequest({
      ...(request() as any),
      credential_mode: "anonymous",
      mse_h264_aac: true,
      live: true,
      compatibility: true,
    }),
  ).toThrow();
  expect(
    nativePlatformPlaybackChoice(
      "compatibility",
      "bilibili",
      { mse_h264_aac: true, progressive_h264_aac: true, native_hls: true },
      true,
    ),
  ).toBe("unsupported");
});
it("course compatibility retains its explicit opt-in independently of source/output quality", () => {
  const body = request();
  body.native_platform!.course_version = 1;
  const p = ready();
  p.native_platform!.course_version = 1;
  expect(
    validNativePlatformPlan(body, p, origin, "bilibili", undefined, true),
  ).toBe(true);
  expect(validNativePlatformPlan(body, p, origin)).toBe(false);
  delete body.native_platform!.course_version;
  expect(
    validNativePlatformPlan(body, p, origin, "bilibili", undefined, true),
  ).toBe(false);
});
it("pending grants omit an attempt, and qualified output stays separate from the 1080p source", () => {
  expect(validNativePlatformPlan(request(), pending(), origin)).toBe(true);
  expect(pending().playback_url).not.toContain("attempt=");
  const p = ready();
  expect(validNativePlatformPlan(request(), p, origin)).toBe(true);
  expect(p.native_platform!.quality!.selected_height).toBe(1080);
  expect(p.native_platform!.compatibility!.output!.height).toBe(720);
  expect(platformTextBase(p, origin)).toBe(
    `/platform-delivery/${id(20)}/text?token=${token}`,
  );
  expect(platformTextBase(pending(), origin)).toBeUndefined();
});
it("rejects dropped selection, invented pending attempts, changed output facts and composition", () => {
  const mutations = [
    (p: any) => delete p.native_platform.compatibility,
    (p: any) =>
      (p.playback_url = p.playback_url.replace("attempt=7", "attempt=1")),
    (p: any) => (p.native_platform.compatibility.output.height = 1080),
    (p: any) =>
      (p.native_platform.compatibility.output.url = "https://private.invalid"),
    (p: any) => delete p.native_platform.compatibility.output.complete,
    (p: any) => (p.native_platform.compatibility.output.complete = "true"),
    (p: any) => (p.advanced_playback = {}),
    (p: any) => (p.delivery_mode = "direct"),
    (p: any) => (p.timeline_origin_ms = 0),
    (p: any) => (p.native_platform.live = {}),
  ];
  for (const mutate of mutations) {
    const p = ready();
    mutate(p);
    expect(validNativePlatformPlan(request(), p, origin)).toBe(false);
  }
  const p = pending();
  p.playback_url += "&attempt=1";
  expect(validNativePlatformPlan(request(), p, origin)).toBe(false);
  const native = request();
  delete native.native_platform!.compatibility;
  native.mode = "direct";
  expect(validNativePlatformPlan(native, ready(), origin)).toBe(false);
});
it("HLS requests fence every resource to the original session token and actual attempt", () => {
  const p = ready(),
    base = p.playback_url.replace("index.m3u8", "init.mp4");
  expect(validNativeCompatibilityDeliveryUrl(base, p, origin)).toBe(true);
  expect(
    validNativeCompatibilityDeliveryUrl(
      base.replace("init.mp4", "index12.m4s"),
      p,
      origin,
    ),
  ).toBe(true);
  for (const url of [
    base.replace("attempt=7", "attempt=8"),
    base.replace(token, "b".repeat(64)),
    base.replace("init.mp4", "../init.mp4"),
    base.replace("/api/v1/", "/api/./v1/"),
    base + "&recovery=1",
    "https://other.test" + base,
    base.replace("init.mp4", "key.bin"),
  ])
    expect(validNativeCompatibilityDeliveryUrl(url, p, origin)).toBe(false);
});
it("readiness replays one deeply frozen exact request to acquire actual attempt before completion", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockResolvedValueOnce(pending())
    .mockResolvedValueOnce(pending())
    .mockResolvedValueOnce(ready());
  const read = vi.fn().mockResolvedValue(readiness()),
    cancel = vi.fn(async () => {});
  const manager = new PlaybackRequests(
    send,
    cancel,
    storage(),
    "compatibility",
    read,
  );
  const result = manager.prepare(request());
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).native_platform!.compatibility!.output!.attempt).toBe(
    7,
  );
  expect(send).toHaveBeenCalledTimes(3);
  expect(
    send.mock.calls.every(
      ([body]) =>
        JSON.stringify(body) === JSON.stringify(send.mock.calls[0][0]),
    ),
  ).toBe(true);
  expect(
    Object.isFrozen(send.mock.calls[0][0].native_platform.compatibility),
  ).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
});
it("Stop between readiness and exact replay prevents any second preparation", async () => {
  const send = vi.fn().mockResolvedValue(pending()),
    cancel = vi.fn(async () => {});
  let manager: PlaybackRequests;
  const read = vi.fn(async () => {
    void manager.stop();
    return readiness();
  });
  manager = new PlaybackRequests(
    send,
    cancel,
    storage(),
    "compatibility",
    read,
  );
  await expect(manager.prepare(request())).rejects.toBeInstanceOf(
    PlaybackCancelled,
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith(id(2), expect.any(AbortSignal));
});
it("expired source and transplanted replay revoke the key without native fallback", async () => {
  for (const next of [
    new RequestFailure({ error: { code: "NATIVE_PLATFORM_URL_EXPIRED" } }),
    { ...ready(), session_id: id(99) },
    {
      ...ready(),
      playback_url: ready().playback_url.replace(token, "b".repeat(64)),
    },
  ]) {
    const send = vi.fn().mockResolvedValueOnce(pending());
    if (next instanceof Error) send.mockRejectedValueOnce(next);
    else send.mockResolvedValueOnce(next);
    const cancel = vi.fn(async () => {}),
      manager = new PlaybackRequests(
        send,
        cancel,
        storage(),
        "compatibility",
        vi.fn().mockResolvedValue(readiness()),
      );
    await expect(manager.prepare(request())).rejects.toBeInstanceOf(Error);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(
        ([body]) => body.native_platform.compatibility.mode === "hls_avc_aac",
      ),
    ).toBe(true);
    expect(cancel).toHaveBeenCalled();
  }
});
it("readiness/replay disagreement shares one bounded total wait", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValue(pending()),
    cancel = vi.fn(async () => {});
  const manager = new PlaybackRequests(
    send,
    cancel,
    storage(),
    "compatibility",
    vi.fn().mockResolvedValue(readiness()),
  );
  const failure = expect(manager.prepare(request())).rejects.toBeInstanceOf(
    PlaybackTimeout,
  );
  await vi.advanceTimersByTimeAsync(180001);
  await failure;
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(send).toHaveBeenCalledTimes(count);
  expect(cancel).toHaveBeenCalled();
});
it("an earlier attempt's ready prefix cannot attach a shorter retry prefix before the current target and lead are covered", async () => {
  vi.useFakeTimers();
  let target = 9000,
    resolved = false;
  const shortRetry = ready();
  shortRetry.native_platform!.compatibility!.output!.attempt = 2;
  shortRetry.playback_url = shortRetry.playback_url.replace(
    "attempt=7",
    "attempt=2",
  );
  shortRetry.seekable_media_ranges_ms = [{ start_ms: 5000, end_ms: 11000 }];
  const stillBehind = structuredClone(shortRetry);
  stillBehind.seekable_media_ranges_ms = [{ start_ms: 5000, end_ms: 15500 }];
  const caughtUp = structuredClone(shortRetry);
  caughtUp.seekable_media_ranges_ms = [{ start_ms: 5000, end_ms: 18000 }];
  const send = vi
    .fn()
    .mockResolvedValueOnce(pending())
    // Attempt 1 reached readiness, but attempt 2 has only its first prefix.
    .mockImplementationOnce(async () => {
      target = 10000;
      return shortRetry;
    })
    .mockImplementationOnce(async () => {
      target = 12000;
      return stillBehind;
    })
    .mockImplementationOnce(async () => {
      target = 13000;
      return caughtUp;
    });
  const cancel = vi.fn(async () => {}),
    read = vi
      .fn()
      .mockResolvedValue({ ...readiness(), available_until_ms: 30000 });
  const manager = new PlaybackRequests(
    send,
    cancel,
    storage(),
    "compatibility-race",
    read,
    () => 4000,
  );
  const result = manager
    .prepare(request(), () => target)
    .then((plan) => {
      resolved = true;
      return plan;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(2);
  expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(3);
  expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  const plan = await result;
  expect(plan.native_platform!.compatibility!.output!.attempt).toBe(2);
  expect(plan.seekable_media_ranges_ms).toEqual([
    { start_ms: 5000, end_ms: 18000 },
  ]);
  expect(
    send.mock.calls.every(
      ([body]) =>
        JSON.stringify(body) === JSON.stringify(send.mock.calls[0][0]),
    ),
  ).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
});
it("zero-lead end-of-film policy belongs only to the replayed completed attempt", async () => {
  vi.useFakeTimers();
  const short = ready();
  short.seekable_media_ranges_ms = [{ start_ms: 5000, end_ms: 15000 }];
  const full = structuredClone(short);
  full.native_platform!.compatibility!.output!.complete = true;
  const send = vi
    .fn()
    .mockResolvedValueOnce(pending())
    .mockResolvedValueOnce(short)
    .mockResolvedValueOnce(full);
  const manager = new PlaybackRequests(
    send,
    vi.fn(async () => {}),
    storage(),
    "compatibility-completion",
    vi.fn().mockResolvedValue({ ...readiness(), complete: true }),
    () => 4000,
  );
  let resolved = false;
  const result = manager
    .prepare(request(), () => 14000)
    .then((plan) => {
      resolved = true;
      return plan;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).native_platform!.compatibility!.output!.complete).toBe(
    true,
  );
  expect(send).toHaveBeenCalledTimes(3);
});
it("paused compatibility playback requires current-target coverage without a playing-room lead", async () => {
  const prefix = ready();
  prefix.seekable_media_ranges_ms = [{ start_ms: 5000, end_ms: 15000 }];
  const send = vi
    .fn()
    .mockResolvedValueOnce(pending())
    .mockResolvedValueOnce(prefix);
  const manager = new PlaybackRequests(
    send,
    vi.fn(async () => {}),
    storage(),
    "compatibility-paused",
    vi.fn().mockResolvedValue(readiness()),
    () => 0,
  );
  expect(
    (await manager.prepare(request(), () => 14000)).native_platform!
      .compatibility!.output!.complete,
  ).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
});
