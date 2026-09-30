import { afterEach, expect, it, vi } from "vitest";
import {
  PlaybackPlanGenerations,
  matchesPlanGeneration,
} from "../packages/player-core";
import {
  PlaybackRequests,
  requestPlayback,
  waitPlaybackReady,
} from "../apps/web/src/playback-request";
import type { PlaybackPlan, PlaybackRequest } from "../packages/protocol";

afterEach(() => vi.useRealTimers());

const input: PlaybackRequest = {
  room_id: "room",
  media_generation: 4,
  mode: "auto",
  position_ms: 12000,
  audio_index: 2,
  capabilities: null,
  viewer_id: "viewer",
  plan_generation: 7,
};
const plan = (generation = 7) =>
  ({
    session_id: "session",
    media_generation: 4,
    plan_generation: generation,
    rebuild_on_seek: false,
  }) as PlaybackPlan;

it("advances only local intent without changing the room or prior snapshots", () => {
  const generations = new PlaybackPlanGenerations("viewer");
  const first = generations.next();
  const second = generations.next();
  expect(first).toEqual({ viewer_id: "viewer", plan_generation: 1 });
  expect(second).toEqual({ viewer_id: "viewer", plan_generation: 2 });
  expect(Object.isFrozen(first)).toBe(true);
  expect(generations.current(first)).toBe(false);
  expect(generations.current(second)).toBe(true);
  expect(generations.current({})).toBe(false);
  expect(new PlaybackPlanGenerations().next().viewer_id).not.toBe(
    new PlaybackPlanGenerations().next().viewer_id,
  );
});

it("matches positive uint32 generations exactly while retaining legacy callers", () => {
  expect(matchesPlanGeneration(undefined, undefined)).toBe(true);
  for (const value of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000])
    expect(matchesPlanGeneration(value, value)).toBe(false);
  expect(matchesPlanGeneration(0xffff_ffff, 0xffff_ffff)).toBe(true);
  expect(matchesPlanGeneration(7, 6)).toBe(false);
  expect(matchesPlanGeneration(7, undefined)).toBe(false);
});

it("retries an uncertain HTTP result with the same viewer, generation and key", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockResolvedValue(plan());
  const result = requestPlayback(send, input);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).plan_generation).toBe(7);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[0][0]).toMatchObject({
    viewer_id: "viewer",
    plan_generation: 7,
  });
});

it("rejects missing or stale plan echoes without spending the retry budget", async () => {
  for (const response of [plan(6), { ...plan(), plan_generation: undefined }]) {
    const send = vi.fn().mockResolvedValue(response);
    await expect(requestPlayback(send, input)).rejects.toMatchObject({
      code: "STALE_PLAYBACK_PLAN",
    });
    expect(send).toHaveBeenCalledTimes(1);
  }
});

it("rejects a ready response for a different generation even with the same session", async () => {
  const read = vi
    .fn()
    .mockResolvedValue({
      session_id: "session",
      status: "ready",
      plan_generation: 6,
    });
  await expect(
    waitPlaybackReady(read, "session", new AbortController().signal, 7),
  ).rejects.toMatchObject({ code: "STALE_PLAYBACK_PLAN" });
  expect(read).toHaveBeenCalledTimes(1);
});

it("revokes a plan whose readiness generation is stale before exposing its URL", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const send = vi
    .fn()
    .mockResolvedValue({
      ...plan(),
      rebuild_on_seek: true,
      timeline_origin_ms: 10000,
    });
  const cancel = vi.fn().mockResolvedValue({});
  const read = vi
    .fn()
    .mockResolvedValue({
      session_id: "session",
      status: "ready",
      plan_generation: 6,
    });
  const requests = new PlaybackRequests(send, cancel, storage, "key", read);
  await expect(requests.prepare(input)).rejects.toMatchObject({
    code: "STALE_PLAYBACK_PLAN",
  });
  expect(read).toHaveBeenCalledWith(
    "session",
    expect.any(AbortSignal),
    2000,
    7,
  );
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(storage.getItem("key")).toBe("[]");
});
