import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useMediaCatalog } from "../apps/web/src/features/library/media-catalog.store";
import { createPlatformLoginFlow } from "../apps/web/src/features/account/platform-login-flow";
import {
  ordinaryBilibiliLink,
  ordinaryPlatformLink,
  recognizedPlatformProvider,
} from "../apps/web/src/features/rooms/platform-import";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
import { RequestFailure, stopsReconnect } from "../apps/web/src/errors";
import type { NativePlatformProvider } from "../packages/protocol";
import {
  nativePlatformRequest,
  validNativePlatformPlan,
  validNativeProgressiveUrl,
} from "../apps/web/src/features/playback/native-platform-intent";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const qr = (status = "pending") => ({
  id: id(1),
  provider: "bilibili" as const,
  status: status as any,
  stage: "waiting" as const,
  qr_payload:
    status === "pending"
      ? "https://passport.bilibili.com/h5-app/passport/login?oauthKey=local-capability"
      : null,
  expires_at: 180000,
  server_time: 0,
  next_poll_at: 3000,
});
afterEach(() => vi.useRealTimers());
it("ordinary import rejects unsupported platforms/content and canonicalizes part links", () => {
  expect(
    ordinaryBilibiliLink(
      "https://www.bilibili.com/video/BV1xx411c7mD?p=2&tracking=secret",
    ),
  ).toEqual({ url: "https://www.bilibili.com/video/BV1xx411c7mD", part: 2 });
  for (const link of [
    "https://b23.tv/a",
    "https://www.bilibili.com/bangumi/play/ep12",
    "https://live.bilibili.com/12",
    "https://youtube.com/watch?v=x",
    "https://www.bilibili.com/video/av123?p=0",
    "https://www.bilibili.com.evil/video/av123",
  ])
    expect(() => ordinaryBilibiliLink(link)).toThrow();
});
it("recognizes and canonicalizes only each provider's full ordinary video links", () => {
  const cases = [
    [
      "https://douyin.com/video/7300000000000000000/",
      "douyin",
      "https://www.douyin.com/video/7300000000000000000",
    ],
    [
      "https://tiktok.com/@creator.name_1/video/7300000000000000000/",
      "tiktok",
      "https://www.tiktok.com/@creator.name_1/video/7300000000000000000",
    ],
    [
      "https://youtube.com/watch?v=AbCde12_-34&si=safe_tracking&t=1h2m3s",
      "youtube",
      "https://www.youtube.com/watch?v=AbCde12_-34",
    ],
    [
      "https://youtu.be/AbCde12_-34?feature=share",
      "youtube",
      "https://www.youtube.com/watch?v=AbCde12_-34",
    ],
    [
      "https://m.youtube.com/shorts/AbCde12_-34/",
      "youtube",
      "https://www.youtube.com/watch?v=AbCde12_-34",
    ],
  ] as const;
  for (const [url, provider, canonical] of cases) {
    expect(recognizedPlatformProvider(url)).toBe(provider);
    expect(ordinaryPlatformLink(url)).toEqual({ provider, url: canonical });
  }
  expect(
    ordinaryPlatformLink("https://www.bilibili.com/video/av123?p=2"),
  ).toEqual({
    provider: "bilibili",
    url: "https://www.bilibili.com/video/av123",
    part: 2,
  });
  expect(() => ordinaryPlatformLink(cases[0][0], "tiktok")).toThrow();
});
it("rejects shortlinks, playlist imports, unsafe aliases, duplicate keys and provider-unsafe parameters", () => {
  for (const url of [
    "https://v.douyin.com/abc/",
    "https://vm.tiktok.com/abc/",
    "https://www.douyin.com/video/1?tracking=x",
    "https://www.douyin.com/video/1?",
    "https://www.douyin.com/video/0",
    "https://www.douyin.com/video/18446744073709551616",
    "https://www.douyin.com/video/1#x",
    "https://www.tiktok.com/@bad-user/video/1",
    "https://www.tiktok.com/@abcdefghijklmnopqrstuvwxy/video/1",
    "https://www.youtube.com/watch?v=AbCde12_-34&list=playlist",
    "https://youtu.be/AbCde12_-34?v=AbCde12_-34",
    "https://youtube.com/watch?v=AbCde12_-34&v=AbCde12_-34",
    "https://youtube.com/watch?v=AbCde12_-34&si=x&si=y",
    "https://youtube.com/watch?v=AbCde12_-34&t=hello",
    "https://youtube.com/watch?v=AbCde12_-34&si=%61",
    "https://youtu.be/AbCde12_-34#t=2",
    "https://youtu.be/AbCde12_-34?",
    "https://youtube.com/watch?v=AbCde12_-34&",
    "https://youtube.com/watch?&v=AbCde12_-34",
    "https://www.douyin.com:443/video/1",
    "https://user@www.douyin.com/video/1",
    "https://www.douyin.com/extra/../video/1",
    "https://www.douyin.com/%76ideo/1",
    "https://www.douyin.com\\video\\1",
    "http://www.douyin.com/video/1",
    "https://www.bilibili.com/video/av123?p=1&p=2",
  ])
    expect(() => ordinaryPlatformLink(url)).toThrow();
});
it("sends the imported provider while retaining the old Bilibili API call default", async () => {
  const request = vi.fn(async () => ({}));
  const api = roomsApi(request as any);
  await api.importPlatform(id(3), "https://www.bilibili.com/video/av123", 2);
  expect(request.mock.calls[0]).toEqual([
    `/rooms/${id(3)}/platform-media`,
    "POST",
    {
      provider: "bilibili",
      url: "https://www.bilibili.com/video/av123",
      part: 2,
    },
    undefined,
  ]);
  await api.importPlatform(
    id(3),
    "https://www.douyin.com/video/1",
    undefined,
    undefined,
    "douyin",
  );
  expect(request.mock.calls[1][2]).toEqual({
    provider: "douyin",
    url: "https://www.douyin.com/video/1",
  });
});
it("native request has only the dedicated intent and safe binding, no worker/fallback offer", () => {
  const body = nativePlatformRequest({
    viewer_id: id(1),
    plan_generation: 2,
    idempotency_key: id(2),
    room_id: id(3),
    media_generation: 4,
    position_ms: 5000,
    credential_mode: "anonymous",
    mse_h264_aac: true,
  });
  expect(body).toEqual({
    viewer_id: id(1),
    plan_generation: 2,
    idempotency_key: id(2),
    room_id: id(3),
    media_generation: 4,
    position_ms: 5000,
    mode: "direct",
    audio_index: null,
    capabilities: {
      progressive_h264_aac: false,
      native_hls: false,
      mse_h264_aac: true,
    },
    native_platform: { version: 1, credential_mode: "anonymous" },
  });
  const plan: any = {
    media_generation: 4,
    plan_generation: 2,
    native_platform: {
      version: 1,
      provider: "bilibili",
      credential_mode: "anonymous",
      refresh_after_seconds: 30,
    },
    session_id: id(4),
    delivery_mode: "direct",
    transport: "dash",
    timeline_origin_ms: 0,
    rebuild_on_seek: false,
    expires_in_seconds: 120,
    audio_tracks: [],
    subtitle_tracks: [],
    playback_url: `/api/v1/platform-delivery/${id(4)}/manifest.mpd?token=abcdefghijklmnop`,
  };
  expect(validNativePlatformPlan(body, plan, "https://rain.test")).toBe(true);
  for (const patch of [
    { transport: "hls" },
    {
      native_platform: {
        ...plan.native_platform,
        credential_mode: "own_account",
      },
    },
    { rebuild_on_seek: true },
    { static_hls_fallback_version: 1 },
    { pending_job_id: id(9) },
    { playback_url: "https://cdn.bilibili.com/x.mpd" },
  ])
    expect(
      validNativePlatformPlan(body, { ...plan, ...patch }, "https://rain.test"),
    ).toBe(false);
});
it.each(["douyin", "tiktok", "youtube"] as NativePlatformProvider[])(
  "%s requests and progressive grants remain anonymous and provider-bound",
  (provider) => {
    const request = nativePlatformRequest({
      viewer_id: id(1),
      plan_generation: 2,
      idempotency_key: id(2),
      room_id: id(3),
      media_generation: 4,
      position_ms: 5000,
      provider,
      credential_mode: "anonymous",
      mse_h264_aac: true,
      progressive_h264_aac: true,
    });
    expect(request.native_platform).toEqual({
      version: 1,
      credential_mode: "anonymous",
    });
    expect(request.capabilities).toEqual({
      progressive_h264_aac: true,
      native_hls: false,
      mse_h264_aac: provider === "youtube",
    });
    const plan: any = {
      media_generation: 4,
      plan_generation: 2,
      session_id: id(4),
      delivery_mode: "direct",
      transport: "progressive",
      timeline_origin_ms: 0,
      rebuild_on_seek: false,
      expires_in_seconds: 120,
      audio_tracks: [],
      subtitle_tracks: [],
      native_platform: {
        version: 1,
        provider,
        credential_mode: "anonymous",
        refresh_after_seconds: 30,
      },
      playback_url: `/api/v1/platform-delivery/${id(4)}/tracks/progressive?token=abcdefghijklmnop`,
    };
    expect(
      validNativePlatformPlan(request, plan, "https://rain.test", provider),
    ).toBe(true);
    for (const patch of [
      { transport: "dash" },
      { transport: "hls" },
      { delivery_mode: "transcode" },
      { decoder_fallback_modes: ["transcode"] },
      { static_hls_fallback_version: 1 },
      { native_platform: { ...plan.native_platform, provider: "bilibili" } },
      {
        native_platform: {
          ...plan.native_platform,
          credential_mode: "own_account",
        },
      },
      { native_platform: { ...plan.native_platform, account_id: id(7) } },
      { subtitle_tracks: [{ index: 0 }] },
      { plan_generation: 1 },
      { media_generation: 5 },
    ])
      expect(
        validNativePlatformPlan(
          request,
          { ...plan, ...patch },
          "https://rain.test",
          provider,
        ),
      ).toBe(false);
    expect(
      validNativePlatformPlan(
        {
          ...request,
          native_platform: { ...request.native_platform!, account_id: id(7) },
        },
        plan,
        "https://rain.test",
        provider,
      ),
    ).toBe(false);
    expect(
      validNativePlatformPlan(request, plan, "https://rain.test", "bilibili"),
    ).toBe(false);
  },
);
it("YouTube reports both browser capabilities and admits only its selected same-session transport", () => {
  const input = {
    viewer_id: id(1),
    plan_generation: 2,
    idempotency_key: id(2),
    room_id: id(3),
    media_generation: 4,
    position_ms: 5000,
    provider: "youtube" as const,
    credential_mode: "own_or_anonymous" as const,
    account_id: id(7),
  };
  const plan: any = {
    media_generation: 4,
    plan_generation: 2,
    session_id: id(4),
    delivery_mode: "direct",
    timeline_origin_ms: 0,
    rebuild_on_seek: false,
    expires_in_seconds: 120,
    audio_tracks: [],
    subtitle_tracks: [],
    native_platform: {
      version: 1,
      provider: "youtube",
      credential_mode: "anonymous",
      refresh_after_seconds: 30,
    },
  };
  const dash = {
    ...plan,
    transport: "dash",
    playback_url: `/api/v1/platform-delivery/${id(4)}/manifest.mpd?token=abcdefghijklmnop`,
  };
  const progressive = {
    ...plan,
    transport: "progressive",
    playback_url: `/api/v1/platform-delivery/${id(4)}/tracks/progressive?token=abcdefghijklmnop`,
  };
  for (const mse of [false, true]) {
    for (const mp4 of [false, true]) {
      const request = nativePlatformRequest({
        ...input,
        mse_h264_aac: mse,
        progressive_h264_aac: mp4,
      });
      expect(request.native_platform).toEqual({
        version: 1,
        credential_mode: "own_or_anonymous",
        account_id: id(7),
      });
      expect(request.capabilities).toEqual({
        progressive_h264_aac: mp4,
        native_hls: false,
        mse_h264_aac: mse,
      });
      expect(
        validNativePlatformPlan(request, dash, "https://rain.test", "youtube"),
      ).toBe(false);
      const ownDash = {
        ...dash,
        native_platform: {
          ...dash.native_platform,
          credential_mode: "own_account",
        },
      };
      const ownProgressive = {
        ...progressive,
        native_platform: {
          ...progressive.native_platform,
          credential_mode: "own_account",
        },
      };
      expect(
        validNativePlatformPlan(
          request,
          ownDash,
          "https://rain.test",
          "youtube",
        ),
      ).toBe(mse);
      expect(
        validNativePlatformPlan(
          request,
          ownProgressive,
          "https://rain.test",
          "youtube",
        ),
      ).toBe(mp4);
      expect(
        validNativePlatformPlan(
          request,
          progressive,
          "https://rain.test",
          "youtube",
        ),
      ).toBe(false);
    }
  }
  const request = nativePlatformRequest({
    ...input,
    mse_h264_aac: true,
    progressive_h264_aac: true,
  });
  for (const patch of [
    { transport: "hls" },
    { native_platform: { ...plan.native_platform, provider: "bilibili" } },
    { native_platform: { ...plan.native_platform, provider: "douyin" } },
    { native_platform: { ...plan.native_platform, account_id: id(7) } },
    { playback_url: progressive.playback_url },
    { playback_url: dash.playback_url.replace(id(4), id(5)) },
    { playback_url: `https://youtube.com${dash.playback_url}` },
    { playback_url: dash.playback_url + "&recovery=1" },
    {
      playback_url: dash.playback_url.replace("manifest.mpd", "tracks/video_1"),
    },
    { plan_generation: 1 },
    { media_generation: 5 },
    { selected_candidate_id: id(9) },
    { decoder_fallback_modes: ["transcode"] },
    { http_file_fallback_version: 1 },
    { audio_tracks: [{ index: 0 }] },
  ])
    expect(
      validNativePlatformPlan(
        request,
        { ...dash, ...patch },
        "https://rain.test",
        "youtube",
      ),
    ).toBe(false);
  expect(
    validNativePlatformPlan(
      request,
      { ...progressive, playback_url: dash.playback_url },
      "https://rain.test",
      "youtube",
    ),
  ).toBe(false);
  for (const provider of ["douyin", "tiktok"] as const)
    expect(
      validNativePlatformPlan(
        request,
        { ...dash, native_platform: { ...plan.native_platform, provider } },
        "https://rain.test",
        provider,
      ),
    ).toBe(false);
});
it("native progressive URL fence rejects upstream URLs, aliases and token/path mutations", () => {
  const valid = `/api/v1/platform-delivery/${id(4)}/tracks/progressive?token=abcdefghijklmnop`;
  expect(validNativeProgressiveUrl(valid, id(4), "https://rain.test")).toBe(
    true,
  );
  expect(
    validNativeProgressiveUrl(
      "https://rain.test" + valid,
      id(4),
      "https://rain.test",
    ),
  ).toBe(true);
  for (const url of [
    "https://cdn.evil/video.mp4",
    "//rain.test" + valid,
    valid + "&recovery=1",
    valid + "#t=1",
    valid.replace("progressive", "other"),
    valid.replace("progressive", "%70rogressive"),
    valid.replace("/tracks/", "/other/../tracks/"),
    valid.replace("token=", "token=bad%20"),
    valid.replace(id(4), id(5)),
    `https://user@rain.test${valid}`,
    valid.replace("/tracks/", "\\tracks/"),
  ])
    expect(validNativeProgressiveUrl(url, id(4), "https://rain.test")).toBe(
      false,
    );
});
it.each(["douyin", "tiktok"] as NativePlatformProvider[])(
  "%s own-account intent keeps the viewer's exact provider account and accepts a secret-free progressive grant",
  (provider) => {
    const request = nativePlatformRequest({
      viewer_id: id(1),
      plan_generation: 2,
      idempotency_key: id(2),
      room_id: id(3),
      media_generation: 4,
      position_ms: 5000,
      provider,
      credential_mode: "own_or_anonymous",
      account_id: id(7),
      mse_h264_aac: true,
      progressive_h264_aac: true,
    });
    expect(request.native_platform).toEqual({
      version: 1,
      credential_mode: "own_or_anonymous",
      account_id: id(7),
    });
    const plan: any = {
      media_generation: 4,
      plan_generation: 2,
      session_id: id(4),
      delivery_mode: "direct",
      transport: "progressive",
      timeline_origin_ms: 0,
      rebuild_on_seek: false,
      expires_in_seconds: 120,
      audio_tracks: [],
      subtitle_tracks: [],
      native_platform: {
        version: 1,
        provider,
        credential_mode: "own_account",
        refresh_after_seconds: 30,
      },
      playback_url: `/api/v1/platform-delivery/${id(4)}/tracks/progressive?token=abcdefghijklmnop`,
    };
    expect(
      validNativePlatformPlan(request, plan, "https://rain.test", provider),
    ).toBe(true);
    expect(
      validNativePlatformPlan(
        request,
        {
          ...plan,
          native_platform: {
            ...plan.native_platform,
            provider: provider === "douyin" ? "tiktok" : "douyin",
          },
        },
        "https://rain.test",
        provider,
      ),
    ).toBe(false);
    expect(
      validNativePlatformPlan(
        request,
        {
          ...plan,
          native_platform: { ...plan.native_platform, account_id: id(7) },
        },
        "https://rain.test",
        provider,
      ),
    ).toBe(false);
    const anonymous = nativePlatformRequest({
      ...request,
      provider,
      credential_mode: "anonymous",
      account_id: id(7),
      mse_h264_aac: false,
      progressive_h264_aac: true,
    });
    expect(anonymous.native_platform).not.toHaveProperty("account_id");
    expect(
      validNativePlatformPlan(anonymous, plan, "https://rain.test", provider),
    ).toBe(false);
    const youtube = nativePlatformRequest({
      ...request,
      provider: "youtube",
      credential_mode: "own_or_anonymous",
      account_id: id(7),
      mse_h264_aac: false,
      progressive_h264_aac: true,
    });
    expect(youtube.native_platform).toEqual({
      version: 1,
      credential_mode: "own_or_anonymous",
      account_id: id(7),
    });
  },
);
it("platform errors explain anonymous/extractor restrictions without stopping RainSync login", () => {
  const anonymous = new RequestFailure({
    error: { code: "NATIVE_PLATFORM_ANONYMOUS_UNSUPPORTED" },
  });
  expect(anonymous.message).toContain("当前请求使用匿名观看");
  expect(anonymous.message).toContain("自己的对应平台会话（平台支持时）");
  expect(anonymous.message).not.toContain("仅支持匿名");
  expect(stopsReconnect(anonymous)).toBe(false);
  expect(
    new RequestFailure({ error: "native_platform_extractor_unavailable" })
      .message,
  ).toContain("YouTube 提取器");
  expect(
    new RequestFailure({ error: "native_platform_access_denied" }).message,
  ).toContain("平台拒绝访问");
});
it("QR polling is bounded to 3s, stops at terminal result, and never exposes remote QR images", async () => {
  vi.useFakeTimers();
  const states: any[] = [],
    poll = vi.fn(async () => qr("confirmed")),
    confirmed = vi.fn();
  const f = createPlatformLoginFlow({
    current: () => true,
    start: async () => qr(),
    poll,
    cancel: async () => {},
    change: (v) => states.push(v),
    confirmed,
    uuid: () => id(1),
  });
  await f.start();
  expect(states.at(-1).phase).toBe("pending");
  await vi.advanceTimersByTimeAsync(2999);
  expect(poll).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(confirmed).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(12000);
  expect(poll).toHaveBeenCalledTimes(1);
  await f.close();
});
it("uncertain start retains exact idempotency key and close cancels before response", async () => {
  vi.useFakeTimers();
  const keys: string[] = [],
    states: any[] = [];
  let resolve!: (v: any) => void;
  const start = vi.fn(async (key: string) => {
    keys.push(key);
    if (keys.length === 1) throw TypeError("lost");
    return qr();
  });
  const f = createPlatformLoginFlow({
    current: () => true,
    start,
    poll: async () => qr(),
    cancel: async () => {},
    change: (v) => states.push(v),
    confirmed: () => {},
    uuid: () => id(1),
  });
  await f.start();
  await f.start();
  expect(keys).toEqual([id(1), id(1)]);
  await f.close();
  const cancel = vi.fn(async () => {}),
    publish = vi.fn();
  const g = createPlatformLoginFlow({
    current: () => true,
    start: () => new Promise((r) => (resolve = r)),
    poll: async () => qr(),
    cancel,
    change: publish,
    confirmed: () => {},
    uuid: () => id(2),
  });
  const work = g.start();
  await g.close();
  expect(cancel).toHaveBeenCalledWith(id(2));
  const before = publish.mock.calls.length;
  resolve(qr());
  await work;
  expect(publish).toHaveBeenCalledTimes(before);
});
it("malicious QR origins never become display payload or schedule polling", async () => {
  vi.useFakeTimers();
  const change = vi.fn(),
    poll = vi.fn();
  const f = createPlatformLoginFlow({
    current: () => true,
    start: async () => ({
      ...qr(),
      qr_payload: "https://qr.evil/image?key=private",
    }),
    poll,
    cancel: async () => {},
    change,
    confirmed: () => {},
    uuid: () => id(1),
  });
  await f.start();
  expect(change.mock.calls.at(-1)?.[0].phase).toBe("uncertain");
  expect(change.mock.calls.some(([s]) => s.payload)).toBe(false);
  await vi.advanceTimersByTimeAsync(12000);
  expect(poll).not.toHaveBeenCalled();
  await f.close();
});
it("room metadata never enters global cache and auth/leave fences late responses", async () => {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({ id: id(1), username: "alice", csrf: "x", admin: false });
  const c = useMediaCatalog(),
    media: any = {
      id: id(4),
      title: "room-private",
      kind: "native_platform",
      platform: {
        version: 1,
        provider: "bilibili",
        content_id: "BV1xx411c7mD",
        part: 1,
      },
    };
  c.remember([media]);
  expect(c.records[id(4)]).toBeUndefined();
  c.rememberRoom(id(2), [media]);
  expect(c.roomRecord(id(3), id(4))).toBeUndefined();
  let resolve!: (v: any) => void;
  session.api = vi.fn(() => new Promise((r) => (resolve = r))) as any;
  const pending = c.ensureRoom(id(2), id(4), true);
  c.clearRoom();
  resolve(media);
  await expect(pending).rejects.toThrow();
  expect(c.roomRecord(id(2), id(4))).toBeUndefined();
  c.rememberRoom(id(2), [media]);
  session.clear();
  expect(c.roomRecord(id(2), id(4))).toBeUndefined();
});

it("new explicit live entry families normalize separately from ordinary VOD", () => {
  expect(
    ordinaryPlatformLink("https://www.tiktok.com/@user/live", "tiktok"),
  ).toMatchObject({
    url: "https://www.tiktok.com/@user/live",
    live_version: 2,
  });
  expect(
    ordinaryPlatformLink("https://youtube.com/live/AbCde12_-34", "youtube"),
  ).toMatchObject({
    url: "https://www.youtube.com/live/AbCde12_-34",
    live_version: 2,
  });
  expect(() =>
    ordinaryPlatformLink(
      "https://youtube.com/live/AbCde12_-34?list=bad",
      "youtube",
    ),
  ).toThrow();
});
