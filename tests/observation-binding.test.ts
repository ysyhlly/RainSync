import { expect, test } from "vitest";
import type { PlaybackObservation, PlaybackPlan } from "../packages/protocol";
import { bindPlaybackObservations } from "../apps/web/src/features/playback/observation-binding";

class Media extends EventTarget {
  currentTime = 3.125;
  playbackRate = 1;
  paused = true;
  seeking = false;
  readyState = 4;
  ended = false;
}
const grant = {
  session_id: "grant",
  media_generation: 7,
  timeline_origin_ms: 60_000,
  observation_version: 1,
  observation_seq: 0,
} as PlaybackPlan;
function setup(
  options: {
    plan?: PlaybackPlan;
    send?: (body: PlaybackObservation, signal: AbortSignal) => Promise<void>;
    savedSeq?: string;
  } = {},
) {
  const element = new Media();
  let current = true;
  let identity = true;
  const saved = new Map<string, string>();
  if (options.savedSeq != null) saved.set("seq", options.savedSeq);
  const received: PlaybackObservation[] = [];
  const binding = bindPlaybackObservations({
    element: element as unknown as HTMLVideoElement,
    plan: options.plan ?? grant,
    current: () => current && identity,
    finalCurrent: () => identity,
    send: async (body, signal) => {
      received.push(body);
      await options.send?.(body, signal);
    },
    storage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
    storageKey: "seq",
  });
  return {
    element,
    binding,
    received,
    saved,
    supersede: () => (current = false),
    changeIdentity: () => (identity = false),
  };
}

test("metadata and an unfulfilled play request never invent a real playing event", async () => {
  const { element, binding, received } = setup();
  element.dispatchEvent(new Event("loadedmetadata"));
  element.dispatchEvent(new Event("canplay"));
  element.dispatchEvent(new Event("play"));
  binding.progress();
  await binding.flush();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    event: "progress",
    has_played: false,
    media_time_ms: 3125,
    paused: true,
  });
  element.dispatchEvent(new Event("playing"));
  await binding.flush();
  expect(received).toHaveLength(1);
  binding.stop();
});

test("a real playing fact survives coalescing while every position comes from the element", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const { element, binding, received } = setup({
    send: async () => {
      if (received.length === 1) await gate;
    },
  });
  element.paused = false;
  element.dispatchEvent(new Event("playing"));
  element.currentTime = 8.75;
  binding.progress();
  element.currentTime = 9.5;
  element.paused = true;
  element.dispatchEvent(new Event("pause"));
  release();
  await binding.flush();
  expect(
    received.map((body) => [body.seq, body.event, body.media_time_ms]),
  ).toEqual([
    [1, "playing", 3125],
    [3, "pause", 9500],
  ]);
  expect(received.every((body) => body.has_played)).toBe(true);
  // Origin is fixed by the grant on the server; the client reports relative time.
  expect(received[1]).not.toHaveProperty("timeline_origin_ms");
  binding.stop();
});

test("waiting and seeks report frozen/actual media data independently of room correction", async () => {
  const { element, binding, received } = setup();
  element.paused = false;
  element.dispatchEvent(new Event("playing"));
  await binding.flush();
  element.readyState = 1;
  element.dispatchEvent(new Event("waiting"));
  await binding.flush();
  binding.progress();
  await binding.flush();
  expect(received.slice(-2).map((body) => body.media_time_ms)).toEqual([
    3125, 3125,
  ]);
  expect(received.at(-1)?.buffering).toBe(true);
  element.currentTime = 21.125;
  element.seeking = true;
  element.dispatchEvent(new Event("seeking"));
  await binding.flush();
  element.seeking = false;
  element.dispatchEvent(new Event("seeked"));
  await binding.flush();
  expect(received.at(-1)).toMatchObject({
    event: "seeked",
    media_time_ms: 21_125,
    seeking: false,
    has_played: true,
  });
  binding.stop();
});

test("Stop reserves the old final position before teardown without another POST", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let signal: AbortSignal | undefined;
  const { element, binding, received, saved, supersede } = setup({
    send: async (_, requestSignal) => {
      signal = requestSignal;
      await gate;
    },
  });
  element.paused = false;
  element.dispatchEvent(new Event("playing"));
  element.currentTime = 42.25;
  binding.progress();
  supersede();
  const final = binding.stop();
  expect(final).toMatchObject({
    seq: 3,
    media_time_ms: 42_250,
    has_played: true,
  });
  expect(saved.get("seq")).toBe("3");
  expect(signal?.aborted).toBe(true);
  element.currentTime = 0;
  element.dispatchEvent(new Event("pause"));
  release();
  await binding.flush();
  expect(received).toHaveLength(1);
  expect(binding.stop()).toBeUndefined();
});

test("identity changes fence periodic, event and final observations", async () => {
  const { element, binding, received, changeIdentity } = setup();
  changeIdentity();
  element.paused = false;
  element.dispatchEvent(new Event("playing"));
  binding.progress();
  await binding.flush();
  expect(binding.stop()).toBeUndefined();
  expect(received).toHaveLength(0);
});

test("replay seeds use the greater server and tab sequence and save captures before wire", async () => {
  for (const [server, stored, expected] of [
    [40, "44", 45],
    [40, "4", 41],
    [40, "NaN", 41],
  ] as const) {
    const { binding, received, saved } = setup({
      plan: { ...grant, observation_seq: server },
      savedSeq: stored,
      send: async (body) => {
        expect(saved.get("seq")).toBe(String(body.seq));
      },
    });
    binding.progress();
    await binding.flush();
    expect(received[0].seq).toBe(expected);
    binding.stop();
  }
});

test("a generated prefix ending needs explicit complete readiness and does not reset its playing fact", async () => {
  const { element, binding, received } = setup();
  element.paused = false;
  element.dispatchEvent(new Event("playing"));
  await binding.flush();
  element.ended = true;
  element.paused = true;
  element.dispatchEvent(new Event("ended"));
  binding.progress();
  await binding.flush();
  expect(received.at(-1)?.event).toBe("progress");
  expect(received.at(-1)?.has_played).toBe(true);
  binding.completed();
  await binding.flush();
  expect(received.at(-1)?.event).toBe("ended");
  expect(binding.stop()?.event).toBe("ended");
});

test("invalid element values are skipped without clamping them to a valid position", async () => {
  const { element, binding, received } = setup();
  for (const value of [-1, NaN, Infinity]) {
    element.currentTime = value;
    binding.progress();
  }
  await binding.flush();
  expect(received).toHaveLength(0);
  expect(binding.stop()).toBeUndefined();
});

test("legal correction at both room rate boundaries preserves the actual element rate", async () => {
  const { element, binding, received } = setup();
  for (const rate of [0.25 * 0.95, 4 * 1.05]) {
    element.playbackRate = rate;
    element.dispatchEvent(new Event("ratechange"));
    await binding.flush();
    expect(received.at(-1)?.playback_rate).toBe(rate);
  }
  binding.stop();
});
