import { afterEach, expect, it, vi } from "vitest";
import {
  PlaybackCancelled,
  PlaybackRequests,
} from "../apps/web/src/playback-request";
import type { PlaybackPlan, PlaybackRequest } from "../packages/protocol";
import { RequestFailure } from "../apps/web/src/errors";

afterEach(() => vi.useRealTimers());
const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const root: PlaybackPlan = {
  session_id: "parent",
  media_id: "media",
  media_generation: 1,
  delivery_mode: "direct",
  transport: "progressive",
  playback_url: "/parent",
  timeline_origin_ms: 0,
  duration_ms: 2000,
  expires_in_seconds: 1800,
  rebuild_on_seek: false,
  audio_tracks: [],
  subtitle_tracks: [],
  http_file_fallback_version: 1,
  decoder_fallback_modes: ["transcode"],
};
const child: PlaybackPlan = {
  ...root,
  session_id: "child",
  delivery_mode: "transcode",
  http_file_fallback_version: undefined,
};
const initial: PlaybackRequest = {
  room_id: "room",
  media_generation: 1,
  position_ms: 0,
  idempotency_key: "old",
};
const final = {
  media_generation: 1,
  seq: 7,
  event: "progress" as const,
  media_time_ms: 500,
  paused: true,
  buffering: false,
  seeking: false,
  has_played: true,
  playback_rate: 1,
};
const next: PlaybackRequest = {
  ...initial,
  idempotency_key: "new",
  mode: "transcode",
  http_file_fallback_version: 1,
  http_file_fallback: { parent_session_id: "parent", final_observation: final },
};

function setup(
  send: (input: PlaybackRequest, signal: AbortSignal) => Promise<PlaybackPlan>,
  cancel?: (key: string) => Promise<void>,
) {
  const saved = new Map<string, string>();
  const events: string[] = [];
  const requests = new PlaybackRequests(
    async (input, signal) => {
      events.push(`post:${input.idempotency_key}`);
      return input.idempotency_key === "old" ? root : send(input, signal);
    },
    async (key) => {
      events.push(`cancel:${key}`);
      await cancel?.(key);
    },
    {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
    "requests",
  );
  return {
    requests,
    events,
    keys: () => JSON.parse(saved.get("requests") ?? "[]"),
  };
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

it("claims before final DELETE, then revokes only the old key and disallows child continuation", async () => {
  const f = setup(async (body) => {
    expect(body.http_file_fallback?.final_observation).toEqual(final);
    return child;
  });
  await f.requests.prepare(initial);
  const cleanup = async () => {
    f.events.push("final-delete");
  };
  expect((await f.requests.prepareContinuation(next, cleanup)).session_id).toBe(
    "child",
  );
  expect(f.events).toEqual([
    "post:old",
    "post:new",
    "final-delete",
    "cancel:old",
  ]);
  expect(f.keys()).toEqual(["new"]);
  await expect(
    f.requests.prepareContinuation(
      {
        ...next,
        idempotency_key: "third",
        http_file_fallback: { parent_session_id: "child" },
      },
      cleanup,
    ),
  ).rejects.toMatchObject({ code: "SOURCE_VERSION_REQUIRED" });
  expect(f.events).not.toContain("post:third");
});

it("Stop cancels an in-flight new key while the old final DELETE is blocked", async () => {
  const response = gate<PlaybackPlan>(),
    deletion = gate();
  let postSignal: AbortSignal | undefined;
  const f = setup(async (_body, signal) => {
    postSignal = signal;
    return response.promise;
  });
  await f.requests.prepare(initial);
  const cleanup = vi.fn(async () => {
    f.events.push("final-delete-start");
    await deletion.promise;
    f.events.push("final-delete-end");
  });
  const preparing = f.requests.prepareContinuation(next, cleanup);
  const rejected = expect(preparing).rejects.toBeInstanceOf(PlaybackCancelled);
  await settle();
  const stopped = f.requests.stop();
  await settle();
  expect(postSignal?.aborted).toBe(true);
  expect(f.events).toContain("cancel:new");
  expect(f.events).toContain("final-delete-start");
  expect(f.events).not.toContain("cancel:old");
  response.resolve(child);
  deletion.resolve();
  await Promise.all([stopped, rejected]);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(f.events.indexOf("final-delete-end")).toBeLessThan(
    f.events.indexOf("cancel:old"),
  );
  expect(f.keys()).toEqual([]);
});

it("Stop before the continuation POST prevents claim and still owns the final DELETE", async () => {
  const f = setup(async () => child);
  await f.requests.prepare(initial);
  const cleanup = vi.fn(async () => {
    f.events.push("final-delete");
  });
  const preparing = f.requests.prepareContinuation(next, cleanup);
  const rejected = expect(preparing).rejects.toBeInstanceOf(PlaybackCancelled);
  await f.requests.stop();
  await rejected;
  expect(f.events).not.toContain("post:new");
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(f.events.indexOf("final-delete")).toBeLessThan(
    f.events.indexOf("cancel:old"),
  );
});

it("lost response retries one immutable key and final sample without early parent cleanup", async () => {
  vi.useFakeTimers();
  const bodies: PlaybackRequest[] = [];
  const f = setup(async (body) => {
    bodies.push(structuredClone(body));
    if (bodies.length === 1) throw new TypeError("lost response");
    return child;
  });
  await f.requests.prepare(initial);
  const cleanup = vi.fn(async () => {
    f.events.push("final-delete");
  });
  const preparing = f.requests.prepareContinuation(next, cleanup);
  await vi.advanceTimersByTimeAsync(0);
  expect(cleanup).not.toHaveBeenCalled();
  expect(f.keys()).toEqual(["old", "new"]);
  await vi.advanceTimersByTimeAsync(1000);
  await preparing;
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("a rejected claim still finalizes the parent before cancelling its key", async () => {
  const f = setup(async () => {
    throw new RequestFailure({ error: { code: "SOURCE_CHANGED" } });
  });
  await f.requests.prepare(initial);
  await expect(
    f.requests.prepareContinuation(next, async () => {
      f.events.push("final-delete");
    }),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(f.events).toContain("cancel:new");
  expect(f.events.indexOf("final-delete")).toBeLessThan(
    f.events.indexOf("cancel:old"),
  );
  expect(f.keys()).toEqual([]);
});

it("a failed child cancellation stays in storage and blocks a fresh unrelated prepare", async () => {
  const f = setup(
    async () => {
      throw new RequestFailure({ error: { code: "SOURCE_CHANGED" } });
    },
    async (key) => {
      if (key === "new") throw new TypeError("offline");
    },
  );
  await f.requests.prepare(initial);
  await expect(
    f.requests.prepareContinuation(next, async () => {}),
  ).rejects.toThrow("尚待清理");
  expect(f.keys()).toEqual(["new"]);
  await expect(
    f.requests.prepare({ ...initial, idempotency_key: "later" }),
  ).rejects.toThrow("offline");
  expect(f.events).not.toContain("post:later");
});

it("never interprets a missing marker or reused parent key as a fresh continuation", async () => {
  const f = setup(async () => child);
  await f.requests.prepare(initial);
  await expect(
    f.requests.prepareContinuation(
      { ...next, idempotency_key: "old" },
      async () => {
        f.events.push("final-delete");
      },
    ),
  ).rejects.toMatchObject({ code: "SOURCE_VERSION_REQUIRED" });
  expect(f.events.filter((v) => v.startsWith("post:"))).toEqual(["post:old"]);
  expect(f.events.indexOf("final-delete")).toBeLessThan(
    f.events.indexOf("cancel:old"),
  );
});
