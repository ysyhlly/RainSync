import { expect, it } from "vitest";
import {
  nativePlatformRequest,
  validNativePlatformQuality,
} from "../apps/web/src/features/playback/native-platform-intent";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function request() {
  return nativePlatformRequest({
    viewer_id: id(1),
    plan_generation: 3,
    idempotency_key: id(2),
    room_id: id(3),
    media_generation: 7,
    media_id: id(4),
    position_ms: 1250,
    provider: "youtube",
    credential_mode: "anonymous",
    mse_h264_aac: true,
    max_height: "p720",
  });
}
function plan(): any {
  return {
    media_id: id(4),
    native_platform: {
      provider: "youtube",
      quality: {
        version: 1,
        requested_max_height: "p720",
        selected_height: 704,
        options: [
          { max_height: "p360", height: 360 },
          { max_height: "p720", height: 704 },
          { max_height: "p1080", height: 1080 },
        ],
      },
    },
  };
}
it("quality labels use observed dimensions and allow lower actual resolution beneath a finite ceiling", () => {
  expect(validNativePlatformQuality(request(), plan())).toBe(true);
  expect(request().native_platform?.quality).toEqual({
    version: 1,
    provider: "youtube",
    media_id: id(4),
    max_height: "p720",
  });
});
it("quality responses reject changed target, unsupported ceiling, forged labels, duplicates and out-of-bound selections", () => {
  for (const mutate of [
    (p: any) => (p.media_id = id(5)),
    (p: any) => (p.native_platform.provider = "bilibili"),
    (p: any) => (p.native_platform.quality.requested_max_height = "p1080"),
    (p: any) => (p.native_platform.quality.selected_height = 1080),
    (p: any) => (p.native_platform.quality.options[1].height = 1080),
    (p: any) => (p.native_platform.quality.options[1].height = 360),
    (p: any) => (p.native_platform.quality.options[1].max_height = "p360"),
    (p: any) => (p.native_platform.quality.options[1].max_height = "bestvideo"),
    (p: any) => (p.native_platform.quality.options = []),
    (p: any) => (p.native_platform.quality = undefined),
  ]) {
    const p = plan();
    mutate(p);
    expect(validNativePlatformQuality(request(), p)).toBe(false);
  }
});
