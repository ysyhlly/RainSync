import { describe, it, expect } from "vitest";
import {
  finiteHlsRequestParameters,
  validateFiniteHlsChoice,
} from "../apps/web/src/features/playback/finite-hls-intent";
const caps = {
  progressive_h264_aac: true,
  native_hls: false,
  mse_h264_aac: true,
};
describe("explicit finite HLS playback intent", () => {
  it("keeps ordinary modes unchanged and explicitly maps finite to one fresh transcode capability", () => {
    expect(finiteHlsRequestParameters("auto", "http", caps)).toEqual({
      mode: "auto",
    });
    expect(finiteHlsRequestParameters("finite_hls", "http", caps)).toEqual({
      mode: "transcode",
      finite_hls_version: 1,
    });
    expect(
      Object.keys(
        finiteHlsRequestParameters("finite_hls", "http", caps),
      ).sort(),
    ).toEqual(["finite_hls_version", "mode"]);
  });
  it("refuses incompatible sources, browsers and mixed/continuation intents", () => {
    for (const kind of [
      undefined,
      "local",
      "agent",
      "native_platform",
      "jellyfin",
      "emby",
    ])
      expect(() =>
        finiteHlsRequestParameters("finite_hls", kind, caps),
      ).toThrow();
    expect(() =>
      finiteHlsRequestParameters("finite_hls", "http", {
        ...caps,
        mse_h264_aac: false,
      }),
    ).toThrow();
    for (const scope of [
      { advanced: {} },
      { ladder: {} },
      { distributed: {} },
      { continuation: {} },
    ])
      expect(() => validateFiniteHlsChoice("finite_hls", scope)).toThrow();
    expect(() => validateFiniteHlsChoice("finite_hls", {})).not.toThrow();
    expect(() =>
      validateFiniteHlsChoice("auto", { distributed: {} }),
    ).not.toThrow();
  });
});
