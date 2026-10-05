import { describe, expect, it } from "vitest";
import {
  staticHlsAvailability,
  staticHlsOfferCurrent,
  staticHlsAvailabilityLabel,
} from "../apps/web/src/features/playback/static-hls-availability";
describe("static HLS availability", () => {
  it("requires a closed consistent versioned actual-runtime response", () => {
    const ready = { version: 1, available: true, reason: "installed_runtime" };
    expect(staticHlsAvailability(ready)?.available).toBe(true);
    for (const value of [
      null,
      [],
      true,
      {},
      { ...ready, version: 2 },
      { ...ready, extra: true },
      { ...ready, reason: "operator_disabled" },
      { ...ready, available: "true" },
      { ...ready, reason: "ready" },
    ])
      expect(staticHlsAvailability(value)).toBeUndefined();
  });
  it("does not turn an unavailable or absent response into support", () => {
    for (const reason of [
      "operator_disabled",
      "source_unsupported",
      "worker_unavailable",
    ])
      expect(
        staticHlsAvailability({ version: 1, available: false, reason })
          ?.available,
      ).toBe(false);
    expect(staticHlsAvailabilityLabel()).toContain("尚未确认");
  });
  it("expires conservatively without granting media or playback authority", () => {
    const ready = staticHlsAvailability({
      version: 1,
      available: true,
      reason: "installed_runtime",
    });
    expect(staticHlsOfferCurrent(ready, 10, 10)).toBe(true);
    expect(staticHlsOfferCurrent(ready, 10, 5009)).toBe(true);
    for (const now of [9, 5010, NaN, Infinity])
      expect(staticHlsOfferCurrent(ready, 10, now)).toBe(false);
    expect(staticHlsOfferCurrent(ready, undefined, 10)).toBe(false);
  });
});
