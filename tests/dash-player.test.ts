import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createDashPlayback,
  createPlatformDashFence,
  platformDashSettings,
  validatePlatformDashManifest,
  validatePlatformDashRequest,
  type DashModuleBridge,
  type DashPlayerBridge,
} from "../packages/player-core/dash";

const origin = "https://rainsync.example";
const sessionId = "12345678-1234-1234-1234-123456789abc";
const anotherSession = "87654321-1234-1234-1234-123456789abc";
const token = "opaque_server_token_123456789";
const path = `/api/v1/platform-delivery/${sessionId}/`;
const playbackUrl = `${path}manifest.mpd?token=${token}`;
const trackUrl = (key = "video_1") => `${path}tracks/${key}?token=${token}`;
const fence = () => createPlatformDashFence({ origin, sessionId, playbackUrl });
// This exact shared artifact is asserted byte-for-byte by Descriptor::render's
// Rust test. Reading it here connects the server renderer to the browser guard,
// rather than maintaining an independently approximated client fixture.
const renderedMpd = () =>
  readFileSync(
    new URL(
      "../apps/server/src/platform_media/fixtures/clear-vod.mpd",
      import.meta.url,
    ),
    "utf8",
  );
const renderedYoutubeMpd = () =>
  readFileSync(
    new URL(
      "../apps/server/src/platform_media/fixtures/youtube-clear-vod.mpd",
      import.meta.url,
    ),
    "utf8",
  );
const rendererSession = "00000000-0000-0000-0000-00000000002a";
const rendererToken = "a".repeat(64);
const rendererPlaybackUrl = `/api/v1/platform-delivery/${rendererSession}/manifest.mpd?token=${rendererToken}`;
const rendererFence = () =>
  createPlatformDashFence({
    origin,
    sessionId: rendererSession,
    playbackUrl: rendererPlaybackUrl,
  });

function representation(key: string, video = true) {
  return `<Representation id="${key}" codecs="${video ? "avc1.640028" : "mp4a.40.2"}" bandwidth="${video ? "1800000" : "128000"}" ${video ? 'width="1920" height="1080" frameRate="30000/1001"' : 'audioSamplingRate="48000"'} startWithSAP="1">
    <BaseURL>${trackUrl(key)}</BaseURL>
    <SegmentBase indexRange="800-1400" indexRangeExact="true"><Initialization range="0-799"/></SegmentBase>
  </Representation>`;
}
function mpd(videos = ["video_1", "video_2"]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" mediaPresentationDuration="PT120.5S" minBufferTime="PT1.5S">
  <Period id="vod" start="PT0S" duration="PT120.5S">
    <AdaptationSet id="video" contentType="video" mimeType="video/mp4" segmentAlignment="true">${videos.map((v) => representation(v)).join("")}</AdaptationSet>
    <AdaptationSet id="audio" contentType="audio" mimeType="audio/mp4" lang="zh-Hans">${representation("audio_1", false)}</AdaptationSet>
  </Period>
</MPD>`;
}

class FakeVideo extends EventTarget {
  autoplay = true;
  currentTime = 13;
  duration = 120.5;
  playbackRate = 1.25;
  paused = true;
  ended = false;
  readyState = 0;
  error: { code: number } | null = null;
  onloadedmetadata = vi.fn();
  onended = vi.fn();
  onerror = vi.fn();
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
  load = vi.fn();
  removeAttribute = vi.fn();
  video() {
    return this as unknown as HTMLVideoElement;
  }
}
type RequestInterceptor = Parameters<
  DashPlayerBridge["addRequestInterceptor"]
>[0];
type ResponseInterceptor = Parameters<
  DashPlayerBridge["addResponseInterceptor"]
>[0];
function bridge() {
  const handlers = new Map<string, (event: unknown) => void>();
  const history = new Map<string, (event: unknown) => void>();
  const requests = new Set<RequestInterceptor>();
  const responses = new Set<ResponseInterceptor>();
  const player: DashPlayerBridge = {
    initialize: vi.fn(),
    updateSettings: vi.fn(),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
      history.set(event, handler);
    }),
    off: vi.fn((event, handler) => {
      if (handlers.get(event) === handler) handlers.delete(event);
    }),
    addRequestInterceptor: vi.fn((interceptor) => {
      requests.add(interceptor);
    }),
    removeRequestInterceptor: vi.fn((interceptor) => {
      requests.delete(interceptor);
    }),
    addResponseInterceptor: vi.fn((interceptor) => {
      responses.add(interceptor);
    }),
    removeResponseInterceptor: vi.fn((interceptor) => {
      responses.delete(interceptor);
    }),
    destroy: vi.fn(),
  };
  return {
    player,
    handlers,
    history,
    requests,
    responses,
    emit: (event: string, value: unknown = {}) => handlers.get(event)?.(value),
    request: (input: Parameters<RequestInterceptor>[0]) =>
      [...requests][0](input),
    response: (input: Parameters<ResponseInterceptor>[0]) =>
      [...responses][0](input),
    manifest: () =>
      [...responses][0]({
        request: { url: origin + playbackUrl },
        url: origin + playbackUrl,
        status: 200,
        data: mpd(),
      }),
  };
}
function harness(
  extra: Partial<Parameters<typeof createDashPlayback>[0]> = {},
) {
  const video = new FakeVideo();
  const instances: ReturnType<typeof bridge>[] = [];
  const module: DashModuleBridge = {
    events: { ready: "ready", error: "error" },
    createPlayer: vi.fn(() => {
      const next = bridge();
      instances.push(next);
      return next.player;
    }),
  };
  const onReady = vi.fn(),
    onError = vi.fn(),
    onEnded = vi.fn(),
    onStatus = vi.fn();
  const loadModule = vi.fn(async () => module);
  const controller = createDashPlayback({
    video: video.video(),
    origin,
    sessionId,
    playbackUrl,
    onReady,
    onError,
    onEnded,
    onStatus,
    loadModule,
    ...extra,
  });
  return {
    video,
    module,
    instances,
    loadModule,
    onReady,
    onError,
    onEnded,
    onStatus,
    controller,
  };
}

it("reports source attachment after initialize, independently of SDK readiness", async () => {
  const onSourceAttached = vi.fn();
  const h = harness({ onSourceAttached });
  expect(await h.controller.load()).toBe(true);
  expect(h.instances[0].player.initialize).toHaveBeenCalledOnce();
  expect(onSourceAttached).toHaveBeenCalledOnce();
  expect(h.onStatus.mock.calls.at(-1)?.[0].status).toBe("loading_media");
  expect(h.onReady).not.toHaveBeenCalled();
  h.controller.destroy();

  const broken = bridge();
  vi.mocked(broken.player.initialize).mockImplementation(() => {
    throw new Error("cannot attach");
  });
  const failed = harness({
    onSourceAttached,
    loadModule: async () => ({
      events: { ready: "ready", error: "error" },
      createPlayer: () => broken.player,
    }),
  });
  expect(await failed.controller.load()).toBe(false);
  expect(onSourceAttached).toHaveBeenCalledOnce();
  expect(failed.onError).toHaveBeenCalledWith(
    expect.objectContaining({ code: "DASH_INITIALIZATION_FAILED" }),
  );
});

it("allows only canonical same-origin manifest and track routes in the same UUID/token grant", () => {
  const grant = fence();
  expect(grant.manifestUrl).toBe(origin + playbackUrl);
  expect(validatePlatformDashRequest(trackUrl(), grant, "track")).toBe(
    origin + trackUrl(),
  );
  expect(
    validatePlatformDashRequest(origin + playbackUrl, grant, "manifest"),
  ).toBe(grant.manifestUrl);
  expect(() =>
    validatePlatformDashRequest(trackUrl(), grant, "manifest"),
  ).toThrow();
  for (const bad of [
    `https://upstream.example${playbackUrl}`,
    `//rainsync.example${playbackUrl}`,
    playbackUrl.replace(sessionId, anotherSession),
    playbackUrl + "&other=1",
    playbackUrl + "#t=1",
    playbackUrl.replace(token, "different_server_token_12345"),
    trackUrl("foo/bar"),
    trackUrl("foo.bar"),
    trackUrl("x".repeat(65)),
    trackUrl("%2e%2e"),
    trackUrl("video_1").replace("/tracks/", "/tracks/../tracks/"),
    `https://user@rainsync.example${playbackUrl}`,
    `data:text/plain,${playbackUrl}`,
    playbackUrl.replace("?token=", "?token=%"),
    " " + playbackUrl,
    playbackUrl.replace("/manifest.mpd", "\\manifest.mpd"),
    `${path}license?token=${token}`,
    `${path}manifest.mpd`,
  ])
    expect(() => validatePlatformDashRequest(bad, grant)).toThrow();
  expect(() =>
    createPlatformDashFence({ origin, sessionId: "not-a-uuid", playbackUrl }),
  ).toThrow();
  expect(() =>
    createPlatformDashFence({
      origin: origin + "/page",
      sessionId,
      playbackUrl,
    }),
  ).toThrow();
});

it("accepts a bounded server-generated static AVC/AAC SegmentBase MPD before SDK parsing", () => {
  expect(() => validatePlatformDashManifest(mpd(), fence())).not.toThrow();
  expect(() =>
    validatePlatformDashManifest(
      mpd().replace('encoding="UTF-8"', "encoding='utf-8'"),
      fence(),
    ),
  ).not.toThrow();
  expect(() =>
    validatePlatformDashManifest(
      mpd().replaceAll(path, origin + path),
      fence(),
    ),
  ).not.toThrow();
});

it("accepts the exact Rust-rendered MPD artifact, including SAR, zero minBufferTime and omitted optional attributes", async () => {
  const xml = renderedMpd();
  expect(xml).toContain('sar="1:1"');
  expect(xml).toContain('minBufferTime="PT0S"');
  expect(xml).toContain("<Period>");
  expect(xml).toContain('<SegmentBase indexRange="100-200">');
  expect(() =>
    validatePlatformDashManifest(xml, rendererFence()),
  ).not.toThrow();
  const h = harness({
    sessionId: rendererSession,
    playbackUrl: rendererPlaybackUrl,
  });
  expect(await h.controller.load()).toBe(true);
  const b = h.instances[0];
  const input = {
    request: { url: origin + rendererPlaybackUrl },
    url: origin + rendererPlaybackUrl,
    status: 200,
    data: xml,
  };
  expect(await b.response(input)).toBe(input);
  b.emit("ready");
  expect(h.onReady).toHaveBeenCalledTimes(1);
  h.controller.destroy();
});

it("reuses the adapter for the exact server-selected YouTube AVC/AAC MPD and track ranges", async () => {
  const xml = renderedYoutubeMpd();
  expect(xml.match(/<Representation /g)).toHaveLength(2);
  expect(xml).toContain('codecs="avc1.640028"');
  expect(xml).toContain('codecs="mp4a.40.2"');
  expect(xml).toContain('startWithSAP="2"');
  expect(xml).toContain('startWithSAP="0"');
  expect(() =>
    validatePlatformDashManifest(xml, rendererFence()),
  ).not.toThrow();
  const h = harness({
    sessionId: rendererSession,
    playbackUrl: rendererPlaybackUrl,
  });
  expect(await h.controller.load()).toBe(true);
  const b = h.instances[0];
  const response = {
    request: { url: origin + rendererPlaybackUrl },
    url: origin + rendererPlaybackUrl,
    status: 200,
    data: xml,
  };
  expect(await b.response(response)).toBe(response);
  for (const track of ["video", "audio"]) {
    for (const range of ["bytes=0-99", "bytes=100-200"]) {
      const request = {
        url: `${origin}/api/v1/platform-delivery/${rendererSession}/tracks/${track}?token=${rendererToken}`,
        method: "GET",
        headers: { Range: range },
      };
      expect(await b.request(request)).toBe(request);
      expect(request).toMatchObject({
        credentials: "same-origin",
        mode: "same-origin",
      });
    }
  }
  b.emit("ready");
  expect(h.onReady).toHaveBeenCalledTimes(1);
  expect(b.player.initialize).toHaveBeenCalledWith(
    h.video.video(),
    origin + rendererPlaybackUrl,
    false,
  );
  expect(h.video.currentTime).toBe(13);
  expect(h.video.playbackRate).toBe(1.25);
  h.controller.destroy();
  b.history.get("ready")?.({});
  b.history.get("error")?.({ error: { code: 17 } });
  expect(h.onReady).toHaveBeenCalledTimes(1);
  expect(h.onError).not.toHaveBeenCalled();
  expect(b.player.destroy).toHaveBeenCalledTimes(1);
  expect(b.handlers.size + b.requests.size + b.responses.size).toBe(0);
});

it("rejects YouTube generated MPD track/token transplants before SDK readiness", async () => {
  const xml = renderedYoutubeMpd();
  for (const invalid of [
    xml.replace(
      `/platform-delivery/${rendererSession}/tracks/video`,
      `/platform-delivery/${anotherSession}/tracks/video`,
    ),
    xml.replace(
      `tracks/audio?token=${rendererToken}`,
      `tracks/audio?token=${token}`,
    ),
    xml.replace("<BaseURL>/api/", "<BaseURL>https://youtube.com/api/"),
  ]) {
    const h = harness({
      sessionId: rendererSession,
      playbackUrl: rendererPlaybackUrl,
    });
    await h.controller.load();
    const b = h.instances[0];
    void b.response({
      request: { url: origin + rendererPlaybackUrl },
      status: 200,
      data: invalid,
    });
    await Promise.resolve();
    b.history.get("ready")?.({});
    expect(h.onReady).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DASH_UNSAFE_MANIFEST" }),
    );
    expect(b.player.destroy).toHaveBeenCalledTimes(1);
    expect(h.video.play).not.toHaveBeenCalled();
    h.controller.destroy();
  }
});

it("bounds SAR metadata to positive u32 colon ratios and keeps AAC-LC-only scope", () => {
  const xml = renderedMpd();
  for (const sar of ["1:1", "16:15", "4294967295:1", "1:4294967295"])
    expect(() =>
      validatePlatformDashManifest(
        xml.replace('sar="1:1"', `sar="${sar}"`),
        rendererFence(),
      ),
    ).not.toThrow();
  for (const sar of [
    "1",
    "0:1",
    "1:0",
    "-1:1",
    "1/1",
    "1:1:1",
    "4294967296:1",
    "NaN",
    "https://evil.example",
    "1".repeat(33),
  ])
    expect(() =>
      validatePlatformDashManifest(
        xml.replace('sar="1:1"', `sar="${sar}"`),
        rendererFence(),
      ),
    ).toThrow();
  for (const codec of ["mp4a.40.5", "mp4a.40.29"])
    expect(() =>
      validatePlatformDashManifest(
        xml.replace("mp4a.40.2", codec),
        rendererFence(),
      ),
    ).toThrow();
  for (const buffer of ["PT-1S", "PT120.001S"])
    expect(() =>
      validatePlatformDashManifest(
        xml.replace('minBufferTime="PT0S"', `minBufferTime="${buffer}"`),
        rendererFence(),
      ),
    ).toThrow();
});

it("enforces shared server/client playback bounds using mutations of the actual rendered artifact", () => {
  const xml = renderedMpd();
  for (const [before, after] of [
    ['width="1920"', 'width="8193"'],
    ['height="1080"', 'height="4321"'],
    ['bandwidth="1000000"', 'bandwidth="80000001"'],
    ['bandwidth="192000"', 'bandwidth="512001"'],
    ['audioSamplingRate="48000"', 'audioSamplingRate="96001"'],
    ['audioSamplingRate="48000"', 'audioSamplingRate="7999"'],
    ['frameRate="30000/1001"', 'frameRate="121"'],
    ['frameRate="30000/1001"', 'frameRate="30.5"'],
    ['frameRate="30000/1001"', 'frameRate="30/0"'],
    ['frameRate="30000/1001"', 'frameRate="30/01"'],
    ['frameRate="30000/1001"', 'frameRate="4294967296/4294967296"'],
    ['range="0-99"', 'range="1-99"'],
    ['range="0-99"', 'range="0-100"'],
    ['indexRange="100-200"', 'indexRange="100-2097252"'],
    ['indexRange="100-200"', 'indexRange="9007199254740992-9007199254741092"'],
    [
      'mediaPresentationDuration="PT120S"',
      'mediaPresentationDuration="PT0.0009S"',
    ],
  ])
    expect(() =>
      validatePlatformDashManifest(xml.replace(before, after), rendererFence()),
    ).toThrow();
});

it.each([
  ["dynamic", (xml: string) => xml.replace('type="static"', 'type="dynamic"')],
  [
    "DRM",
    (xml: string) =>
      xml.replace(
        "<Period ",
        '<ContentProtection schemeIdUri="urn:uuid:edef8ba9"/><Period ',
      ),
  ],
  [
    "UTC",
    (xml: string) =>
      xml.replace(
        "<Period ",
        '<UTCTiming value="https://evil.example"/><Period ',
      ),
  ],
  [
    "XLink",
    (xml: string) =>
      xml.replace('id="vod"', 'id="vod" xlink:href="https://evil.example"'),
  ],
  [
    "steering",
    (xml: string) =>
      xml.replace(
        "<Period ",
        "<ContentSteering>https://evil.example</ContentSteering><Period ",
      ),
  ],
  [
    "location",
    (xml: string) =>
      xml.replace(
        "<Period ",
        "<Location>https://evil.example</Location><Period ",
      ),
  ],
  [
    "patch",
    (xml: string) =>
      xml.replace(
        "<Period ",
        "<PatchLocation>https://evil.example</PatchLocation><Period ",
      ),
  ],
  [
    "events",
    (xml: string) =>
      xml.replace(
        "<Period ",
        '<EventStream schemeIdUri="urn:mpeg:dash:event:2012"/><Period ',
      ),
  ],
  [
    "query extensions",
    (xml: string) =>
      xml.replace(
        "<Period ",
        '<EssentialProperty schemeIdUri="urn:mpeg:dash:urlparam:2016"/><Period ',
      ),
  ],
  [
    "external entity",
    (xml: string) =>
      xml.replace(
        "<MPD ",
        '<!DOCTYPE MPD [<!ENTITY foo SYSTEM "https://evil.example">]><MPD ',
      ),
  ],
  [
    "entity escaped URL",
    (xml: string) => xml.replace("opaque_server", "&#111;paque_server"),
  ],
  [
    "unknown namespace",
    (xml: string) => xml.replace("urn:mpeg:dash:schema:mpd:2011", "urn:evil"),
  ],
  [
    "inherited namespace",
    (xml: string) => xml.replace('id="vod"', 'id="vod" xmlns="urn:evil"'),
  ],
  [
    "unexpected instruction",
    (xml: string) =>
      xml.replace(
        "<Period ",
        '<?xml-stylesheet href="https://evil.example"?><Period ',
      ),
  ],
  ["HEVC", (xml: string) => xml.replace("avc1.640028", "hev1.1.6.L120.B0")],
  ["AV1", (xml: string) => xml.replace("avc1.640028", "av01.0.08M.08")],
  ["non-AAC audio", (xml: string) => xml.replace("mp4a.40.2", "ec-3")],
  [
    "cross-origin track",
    (xml: string) =>
      xml.replace(`<BaseURL>${path}`, `<BaseURL>https://evil.example${path}`),
  ],
  [
    "other-session track",
    (xml: string) =>
      xml.replace(
        `${path}tracks/video_1`,
        `/api/v1/platform-delivery/${anotherSession}/tracks/video_1`,
      ),
  ],
  [
    "other-token track",
    (xml: string) => xml.replace(token, "another_server_token_1234567"),
  ],
  [
    "initialization source",
    (xml: string) =>
      xml.replace(
        "<Initialization range=",
        '<Initialization sourceURL="https://evil.example" range=',
      ),
  ],
  [
    "duplicate representation",
    (xml: string) => xml.replaceAll("video_2", "video_1"),
  ],
  [
    "missing audio",
    (xml: string) =>
      xml.replace(/<AdaptationSet id="audio"[\s\S]*?<\/AdaptationSet>/, ""),
  ],
  ["reversed range", (xml: string) => xml.replace("800-1400", "1400-800")],
  ["oversized index", (xml: string) => xml.replace("800-1400", "0-3000000")],
  [
    "invalid bandwidth",
    (xml: string) => xml.replace('bandwidth="1800000"', 'bandwidth="NaN"'),
  ],
  [
    "zero duration",
    (xml: string) =>
      xml.replace(
        'mediaPresentationDuration="PT120.5S"',
        'mediaPresentationDuration="PT0S"',
      ),
  ],
  [
    "duplicate attribute",
    (xml: string) =>
      xml.replace('type="static"', 'type="static" type="static"'),
  ],
  ["unbalanced XML", (xml: string) => xml.replace("</MPD>", "</Period>")],
])("rejects %s before any SDK interpretation", (_name, change) => {
  expect(() => validatePlatformDashManifest(change(mpd()), fence())).toThrow();
});

it("rejects unbounded renditions, XML sizes and extra periods", () => {
  expect(() =>
    validatePlatformDashManifest(
      mpd(Array.from({ length: 9 }, (_, i) => `video_${i}`)),
      fence(),
    ),
  ).toThrow();
  expect(() =>
    validatePlatformDashManifest(" ".repeat(128 * 1024) + mpd(), fence()),
  ).toThrow();
  expect(() =>
    validatePlatformDashManifest(
      mpd().replace("</MPD>", '<Period id="second"/></MPD>'),
      fence(),
    ),
  ).toThrow();
});

it("disables SDK autonomous timing, rate, gap, telemetry and encrypted-media behavior", () => {
  const settings = platformDashSettings().streaming!;
  expect(settings.utcSynchronization?.enabled).toBe(false);
  expect(settings.applyContentSteering).toBe(false);
  expect(settings.applyServiceDescription).toBe(false);
  expect(settings.liveCatchup?.enabled).toBe(false);
  expect(settings.gaps?.jumpGaps).toBe(false);
  expect(settings.protection?.ignoreEmeEncryptedEvent).toBe(true);
  expect(settings.cmcd?.enabled).toBe(false);
  expect(settings.cmcd?.applyParametersFromMpd).toBe(false);
  expect(settings.text?.defaultEnabled).toBe(false);
  expect(settings.abr?.autoSwitchBitrate).toEqual({ video: true, audio: true });
  expect(settings.retryAttempts?.license).toBe(0);
});

it("attaches to the identical video with autoplay false and leaves room time/rate and existing handlers intact", async () => {
  const h = harness();
  const metadata = h.video.onloadedmetadata,
    ended = h.video.onended,
    error = h.video.onerror;
  expect(await h.controller.load()).toBe(true);
  const b = h.instances[0];
  expect(b.player.initialize).toHaveBeenCalledWith(
    h.video.video(),
    origin + playbackUrl,
    false,
  );
  expect(h.controller.video).toBe(h.video.video());
  expect(h.video.autoplay).toBe(false);
  expect(h.video.currentTime).toBe(13);
  expect(h.video.playbackRate).toBe(1.25);
  expect(h.video.play).not.toHaveBeenCalled();
  expect(h.video.onloadedmetadata).toBe(metadata);
  expect(h.video.onended).toBe(ended);
  expect(h.video.onerror).toBe(error);
  expect(h.onReady).not.toHaveBeenCalled();
  await b.manifest();
  b.emit("ready");
  b.emit("ready");
  expect(h.onReady).toHaveBeenCalledTimes(1);
  expect(h.controller.status).toBe("ready");
  // Pipeline ready is not the real first frame: no decoded media or playback.
  expect(h.video.readyState).toBe(0);
  expect(h.video.play).not.toHaveBeenCalled();
  h.controller.destroy();
});

it("settles the allowed same-session request and retains only a Range header plus same-origin credentials", async () => {
  const h = harness();
  await h.controller.load();
  const input = {
    url: origin + trackUrl(),
    method: "GET",
    headers: { Range: "bytes=0-799" },
  };
  expect(await h.instances[0].request(input)).toBe(input);
  expect(input).toMatchObject({
    credentials: "same-origin",
    mode: "same-origin",
  });
  h.controller.destroy();
});

it.each([
  { url: "https://upstream.example/video" },
  { url: origin + trackUrl(), method: "POST" },
  { url: origin + trackUrl(), headers: { Authorization: "not-permitted" } },
  { url: origin + trackUrl(), body: "not-permitted" },
])(
  "terminates an unsafe request without releasing its pre-network gate or retaining SDK listeners",
  async (input) => {
    const h = harness();
    await h.controller.load();
    const b = h.instances[0];
    const gate = b.request(input);
    let settled = false;
    void gate.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.controller.status).toBe("failed");
    expect(h.controller.attached).toBe(false);
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DASH_UNSAFE_REQUEST" }),
    );
    expect(b.player.destroy).toHaveBeenCalledTimes(1);
    expect(b.handlers.size + b.requests.size + b.responses.size).toBe(0);
    expect(h.video.removeAttribute).toHaveBeenCalledWith("src");
    h.controller.destroy();
    expect(b.player.destroy).toHaveBeenCalledTimes(1);
  },
);

it("rejects hostile manifest responses before ready and aborts the owned SDK queues", async () => {
  const h = harness();
  await h.controller.load();
  const b = h.instances[0];
  void b.response({
    request: { url: origin + playbackUrl },
    status: 200,
    data: mpd().replace("<Period ", "<ContentProtection/><Period "),
  });
  await Promise.resolve();
  b.history.get("ready")?.({});
  expect(h.onReady).not.toHaveBeenCalled();
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ code: "DASH_UNSAFE_MANIFEST" }),
  );
  expect(b.player.destroy).toHaveBeenCalledTimes(1);
  expect(b.handlers.size + b.requests.size + b.responses.size).toBe(0);
});

it("fails closed when SDK signals ready without a validated clear MPD response", async () => {
  const h = harness();
  await h.controller.load();
  h.instances[0].emit("ready");
  expect(h.controller.status).toBe("failed");
  expect(h.onReady).not.toHaveBeenCalled();
});

it("rejects a changed final response URL even when its new route remains in the grant", async () => {
  const h = harness();
  await h.controller.load();
  void h.instances[0].response({
    request: { url: origin + playbackUrl },
    url: origin + trackUrl(),
    status: 200,
    data: mpd(),
  });
  await Promise.resolve();
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ code: "DASH_UNSAFE_MANIFEST" }),
  );
  expect(h.controller.attached).toBe(false);
});

it("keeps local play/pause/seek/ended observations out of room controls", async () => {
  const h = harness();
  await h.controller.load();
  await h.instances[0].manifest();
  h.instances[0].emit("ready");
  h.video.paused = false;
  h.video.dispatchEvent(new Event("playing"));
  expect(h.controller.status).toBe("playing");
  h.video.dispatchEvent(new Event("waiting"));
  expect(h.controller.status).toBe("waiting");
  h.video.dispatchEvent(new Event("seeking"));
  expect(h.controller.status).toBe("seeking");
  h.video.dispatchEvent(new Event("ended"));
  expect(h.onEnded).not.toHaveBeenCalled();
  h.video.ended = true;
  h.video.currentTime = 120.5;
  h.video.dispatchEvent(new Event("ended"));
  expect(h.onEnded).toHaveBeenCalledWith(120.5);
  expect(h.video.currentTime).toBe(120.5);
  expect(h.video.playbackRate).toBe(1.25);
  expect(h.video.play).not.toHaveBeenCalled();
  expect(h.video.pause).toHaveBeenCalledTimes(1); // initial attach only
  h.controller.destroy();
});

it("suppresses stale SDK callbacks after reload/detach and clears each owned instance exactly once", async () => {
  const h = harness();
  await h.controller.load();
  const first = h.instances[0];
  await first.manifest();
  const ready = first.history.get("ready")!,
    error = first.history.get("error")!;
  expect(await h.controller.load()).toBe(true);
  expect(first.player.destroy).toHaveBeenCalledTimes(1);
  ready({});
  error({ error: { code: 17 } });
  expect(h.onReady).not.toHaveBeenCalled();
  expect(h.onError).not.toHaveBeenCalled();
  const second = h.instances[1];
  await second.manifest();
  second.emit("ready");
  h.controller.detach();
  const statusCalls = h.onStatus.mock.calls.length;
  second.history.get("error")?.({ error: { code: 17 } });
  h.video.dispatchEvent(new Event("playing"));
  expect(h.onStatus).toHaveBeenCalledTimes(statusCalls);
  expect(h.onError).not.toHaveBeenCalled();
  expect(second.player.destroy).toHaveBeenCalledTimes(1);
  expect(
    second.handlers.size + second.requests.size + second.responses.size,
  ).toBe(0);
  h.controller.destroy();
  h.controller.destroy();
  expect(await h.controller.load()).toBe(false);
  expect(second.player.destroy).toHaveBeenCalledTimes(1);
});

it("fences late SDK imports after detach and lets a newer load win", async () => {
  let resolve!: (module: DashModuleBridge) => void;
  const deferred = new Promise<DashModuleBridge>((done) => {
    resolve = done;
  });
  const h = harness({ loadModule: () => deferred });
  const old = h.controller.load();
  h.controller.detach();
  const newest = h.controller.load();
  resolve(h.module);
  expect(await old).toBe(false);
  expect(await newest).toBe(true);
  expect(h.module.createPlayer).toHaveBeenCalledTimes(1);
  h.controller.destroy();
});

it("ignores late import errors and native events when the runtime plan/identity fence is stale", async () => {
  let current = true,
    reject!: (error: Error) => void;
  const h = harness({
    current: () => current,
    loadModule: () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  });
  const loading = h.controller.load();
  current = false;
  reject(new Error("old identity"));
  expect(await loading).toBe(false);
  expect(h.onError).not.toHaveBeenCalled();
  expect(h.module.createPlayer).not.toHaveBeenCalled();
  h.controller.destroy();
});

it("reports library/initialization failures and releases partially registered instances", async () => {
  const unavailable = harness({
    loadModule: async () => {
      throw new Error("not available");
    },
  });
  expect(await unavailable.controller.load()).toBe(false);
  expect(unavailable.onError).toHaveBeenCalledWith(
    expect.objectContaining({ code: "DASH_LIBRARY_LOAD_FAILED" }),
  );
  const h = harness();
  vi.mocked(h.module.createPlayer).mockImplementationOnce(() => {
    const b = bridge();
    h.instances.push(b);
    vi.mocked(b.player.initialize).mockImplementation(() => {
      throw new Error("initialization");
    });
    return b.player;
  });
  expect(await h.controller.load()).toBe(false);
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ code: "DASH_INITIALIZATION_FAILED" }),
  );
  expect(h.instances[0].player.destroy).toHaveBeenCalledTimes(1);
  expect(
    h.instances[0].handlers.size +
      h.instances[0].requests.size +
      h.instances[0].responses.size,
  ).toBe(0);
});

it("does not leak SDK error payloads or tokens into diagnostics and treats encrypted media as terminal", async () => {
  const h = harness();
  await h.controller.load();
  h.instances[0].emit("error", {
    error: { code: 17, url: origin + playbackUrl, data: "private response" },
  });
  expect(h.onError.mock.calls[0][0]).toEqual({
    code: "DASH_PLAYBACK_ERROR",
    message: "DASH 媒体加载或解码失败，请重新加载",
    dashCode: 17,
  });
  expect(JSON.stringify(h.onError.mock.calls)).not.toContain(token);
  expect(h.instances[0].player.destroy).toHaveBeenCalledTimes(1);
  const encrypted = harness();
  await encrypted.controller.load();
  encrypted.video.dispatchEvent(new Event("encrypted"));
  expect(encrypted.onError).toHaveBeenCalledWith(
    expect.objectContaining({ code: "DASH_ENCRYPTED_MEDIA" }),
  );
  expect(encrypted.controller.attached).toBe(false);
});

it("invalid manifests do not trigger an SDK import and throwing observers do not block teardown", async () => {
  const h = harness({ playbackUrl: "https://upstream.example/manifest.mpd" });
  expect(await h.controller.load()).toBe(false);
  expect(h.loadModule).not.toHaveBeenCalled();
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ code: "DASH_UNSAFE_SOURCE" }),
  );
  const badObserver = harness({
    onReady: () => {
      throw new Error();
    },
    onStatus: () => {
      throw new Error();
    },
    onError: () => {
      throw new Error();
    },
  });
  await badObserver.controller.load();
  await badObserver.instances[0].manifest();
  badObserver.instances[0].emit("ready");
  expect(() => badObserver.controller.destroy()).not.toThrow();
  expect(badObserver.instances[0].player.destroy).toHaveBeenCalledTimes(1);
});

it("a status observer replacing an attachment suppresses the old remaining failure callback", async () => {
  let controller: ReturnType<typeof createDashPlayback>;
  const h = harness({
    onStatus: (status) => {
      if (status.status === "failed") controller.detach();
    },
  });
  controller = h.controller;
  await controller.load();
  h.instances[0].emit("error", { error: { code: 17 } });
  expect(controller.status).toBe("detached");
  expect(h.onError).not.toHaveBeenCalled();
  expect(h.instances[0].player.destroy).toHaveBeenCalledTimes(1);
});

it("an explicit test origin cannot override the actual browser origin", async () => {
  vi.stubGlobal("location", { origin: "https://another-rainsync.example" });
  try {
    const h = harness();
    expect(await h.controller.load()).toBe(false);
    expect(h.loadModule).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DASH_UNSAFE_SOURCE" }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
