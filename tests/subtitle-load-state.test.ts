import { describe, expect, it } from "vitest";
import type { MediaTrack } from "../packages/protocol";
import { SubtitleLoadState } from "../apps/web/src/features/playback/subtitle-load-state";

const track = (
  index: number,
  url = "/authorized.vtt?ticket=opaque",
): MediaTrack => ({
  index,
  label: "中文 <img src=x>",
  language: "zho",
  url,
});

describe("subtitle-only load recovery", () => {
  it("reports only the selected failed provider ID; loading and Off are not failures", () => {
    const state = new SubtitleLoadState();
    const [zero, sparse] = state.sync("plan-a", [track(0), track(31)]);
    expect(state.settle(sparse, 1)).toBe(false);
    expect(state.failure(31)).toBeUndefined();
    expect(state.settle(sparse, 3)).toBe(true);
    expect(state.failure(0)).toBeUndefined();
    expect(state.failure(undefined)).toBeUndefined();
    expect(state.failure(31)).toBe(sparse);
    expect(state.settle(zero, 3)).toBe(true);
    expect(state.failure(0)).toBe(zero);
    expect(state.settle(sparse, 2)).toBe(true);
    expect(state.failure(31)).toBeUndefined();
  });

  it("retries once per user action with a new binding and the exact same signed URL", () => {
    const state = new SubtitleLoadState();
    const [original] = state.sync("plan-a", [track(31)]);
    expect(state.retry(original)).toBe(false);
    state.settle(original, 3);
    expect(state.retry(original)).toBe(true);
    const [replacement] = state.resources;
    expect(replacement).not.toBe(original);
    expect(replacement.key).not.toBe(original.key);
    expect(replacement.url).toBe(original.url);
    expect(replacement.index).toBe(31);
    expect(replacement.language).toBe("zho");
    expect(state.failure(31)).toBeUndefined();
    expect(state.retry(original)).toBe(false);
    expect(state.retry(replacement)).toBe(false);
    expect(state.settle(original, 3)).toBe(false);
    expect(state.settle(original, 2)).toBe(false);
    expect(state.failure(31)).toBeUndefined();
    state.settle(replacement, 3);
    expect(state.failure(31)).toBe(replacement);
    expect(state.retry(replacement)).toBe(true);
  });

  it.each([null, undefined])(
    "fences old plan events and clears resources on reset (%s), even for same-URL plans",
    (resetSession) => {
      const state = new SubtitleLoadState();
      const [oldPlan] = state.sync("plan-a", [track(31)]);
      state.settle(oldPlan, 3);
      const [newPlan] = state.sync("plan-b", [track(31)]);
      expect(newPlan.key).not.toBe(oldPlan.key);
      expect(state.failure(31)).toBeUndefined();
      expect(state.settle(oldPlan, 3)).toBe(false);
      expect(state.retry(oldPlan)).toBe(false);
      state.settle(newPlan, 3);
      expect(state.settle(oldPlan, 2)).toBe(false);
      expect(state.failure(31)).toBe(newPlan);
      state.sync(resetSession, [track(31)]);
      expect(state.resources).toEqual([]);
      expect(state.failure(31)).toBeUndefined();
      expect(state.settle(newPlan, 3)).toBe(false);
    },
  );

  it("preserves sparse-ID status on reorder, but replaces a changed URL", () => {
    const state = new SubtitleLoadState();
    const [first, second] = state.sync("plan-a", [track(17), track(31)]);
    state.settle(second, 3);
    expect(state.sync("plan-a", [track(31), track(17)])).toEqual([
      second,
      first,
    ]);
    expect(state.failure(31)).toBe(second);
    const [replacement] = state.sync("plan-a", [track(31, "/new.vtt")]);
    expect(replacement.key).not.toBe(second.key);
    expect(state.failure(31)).toBeUndefined();
    expect(state.settle(second, 3)).toBe(false);
    expect(state.settle(first, 3)).toBe(false);
  });

  it("renders only selectable IDs with URLs, without interpreting labels as HTML", () => {
    const state = new SubtitleLoadState();
    const resources = state.sync("plan-a", [
      track(0),
      track(1, ""),
      { ...track(2), url: null },
      track(3, "  "),
      track(17),
      track(17),
      track(-1),
      track(1.5),
      track(31),
    ]);
    expect(resources.map((resource) => resource.index)).toEqual([0, 31]);
    expect(resources[1].label).toBe("中文 <img src=x>");
  });
});
