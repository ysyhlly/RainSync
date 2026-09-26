import { describe, expect, it } from "vitest";
import { detectCapabilities } from "../packages/player-core";

describe("playback transport detection", () => {
  it("recognizes native HLS without assuming MSE on Safari", () => {
    const caps = detectCapabilities({
      canPlayType: (type) => (type.includes("mpegurl") ? "maybe" : ""),
    });
    expect(caps).toEqual({
      progressive_h264_aac: false,
      native_hls: true,
      mse_h264_aac: false,
    });
  });
  it("keeps MSE independent of progressive decoding", () => {
    const caps = detectCapabilities(
      { canPlayType: () => "" },
      { isTypeSupported: () => true },
    );
    expect(caps.mse_h264_aac).toBe(true);
    expect(caps.progressive_h264_aac).toBe(false);
  });
});
