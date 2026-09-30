import { expect, test } from "vitest";
import {
  createObservationSender,
  type ObservationPacket,
} from "../apps/web/src/features/playback/observation-sender";

type VideoSample = { event: string; position: number; hasPlayed: boolean };

function held() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

test("slow HTTP keeps one request and the latest independently captured video sample", async () => {
  const gate = held();
  const received: ObservationPacket<VideoSample>[] = [];
  let concurrent = 0;
  let peak = 0;
  const sender = createObservationSender<VideoSample>(async (packet) => {
    received.push(packet);
    peak = Math.max(peak, ++concurrent);
    if (received.length === 1) await gate.promise;
    concurrent--;
  });
  sender.capture({ event: "playing", position: 0.4, hasPlayed: true });
  sender.capture({ event: "progress", position: 2.1, hasPlayed: true });
  sender.capture({ event: "pause", position: 2.4, hasPlayed: true });
  expect(received).toHaveLength(1);
  gate.resolve();
  await sender.flush();
  expect(peak).toBe(1);
  expect(received.map((value) => value.seq)).toEqual([1, 3]);
  expect(received[1].sample).toEqual({
    event: "pause",
    position: 2.4,
    hasPlayed: true,
  });
});

test("a response lost after commit retries the exact sequence and immutable captured payload", async () => {
  const captured = { position: 15, nested: { paused: false } };
  const received: ObservationPacket<typeof captured>[] = [];
  const gate = held();
  const sender = createObservationSender<typeof captured>(async (packet) => {
    received.push(packet);
    if (received.length === 1) await gate.promise;
  });
  sender.capture(captured);
  captured.position = 99;
  captured.nested.paused = true;
  gate.reject(new Error("response lost"));
  await sender.flush();
  expect(received).toHaveLength(2);
  expect(received[1]).toBe(received[0]);
  expect(received[1]).toEqual({
    seq: 1,
    sample: { position: 15, nested: { paused: false } },
  });
  expect(sender.failure).toBeUndefined();
});

test("a newer video sample replaces an unsuccessful request instead of retrying its old position", async () => {
  const gate = held();
  const received: ObservationPacket<{ position: number }>[] = [];
  const sender = createObservationSender<{ position: number }>(
    async (packet) => {
      received.push(packet);
      if (received.length === 1) await gate.promise;
    },
  );
  sender.capture({ position: 1 });
  sender.capture({ position: 8 });
  gate.reject(new Error("connection lost"));
  await sender.flush();
  expect(
    received.map((packet) => [packet.seq, packet.sample.position]),
  ).toEqual([
    [1, 1],
    [2, 8],
  ]);
});

test("persistent network failure has two attempts per packet and can recover on a new observation", async () => {
  const received: number[] = [];
  let offline = true;
  const sender = createObservationSender<{ position: number }>(
    async (packet) => {
      received.push(packet.seq);
      if (offline) throw new Error("offline");
    },
  );
  sender.capture({ position: 1 });
  await sender.flush();
  expect(received).toEqual([1, 1]);
  expect(sender.failure).toBeInstanceOf(Error);
  offline = false;
  sender.capture({ position: 4 });
  await sender.flush();
  expect(received).toEqual([1, 1, 2]);
  expect(sender.failure).toBeUndefined();
});

test("teardown aborts the old in-flight request, discards pending data and cannot restart on late completion", async () => {
  const gate = held();
  const received: number[] = [];
  let requestSignal: AbortSignal | undefined;
  const sender = createObservationSender<{ position: number }>(
    async (packet, signal) => {
      received.push(packet.seq);
      requestSignal = signal;
      // This endpoint deliberately ignores abort to demonstrate a late response.
      await gate.promise;
    },
  );
  sender.capture({ position: 1 });
  sender.capture({ position: 2 });
  sender.stop();
  expect(requestSignal?.aborted).toBe(true);
  expect(sender.capture({ position: 3 })).toBeUndefined();
  gate.resolve();
  await sender.flush();
  expect(received).toEqual([1]);
});

test("a replacement plan has a fresh sequence while the old plan remains fenced", async () => {
  const gate = held();
  const received: [string, number][] = [];
  const old = createObservationSender<{ position: number }>(async (packet) => {
    received.push(["old", packet.seq]);
    await gate.promise;
  });
  old.capture({ position: 2 });
  old.stop();
  const current = createObservationSender<{ position: number }>(
    async (packet) => {
      received.push(["current", packet.seq]);
    },
  );
  current.capture({ position: 17 });
  await current.flush();
  gate.resolve();
  await old.flush();
  expect(received).toEqual([
    ["old", 1],
    ["current", 1],
  ]);
});

test("a resumed plan starts beyond the previous captured or server sequence", async () => {
  const received: number[] = [];
  const sender = createObservationSender<{ position: number }>(
    async (packet) => {
      received.push(packet.seq);
    },
    41,
  );
  sender.capture({ position: 23 });
  await sender.flush();
  expect(received).toEqual([42]);
});

test("invalid or exhausted sequence seeds cannot produce unsafe wire values", () => {
  for (const seed of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => createObservationSender(async () => {}, seed)).toThrow();
  const sender = createObservationSender(
    async () => {},
    Number.MAX_SAFE_INTEGER,
  );
  expect(() => sender.capture({})).toThrow("sequence exhausted");
});

test("a final packet is reserved beyond pending HTTP without sending and persists before dispatch", async () => {
  const order: string[] = [];
  const gate = held();
  const received: number[] = [];
  const sender = createObservationSender<{ position: number }>(
    async (packet) => {
      order.push(`send:${packet.seq}`);
      received.push(packet.seq);
      await gate.promise;
    },
    10,
    (seq) => order.push(`persist:${seq}`),
  );
  sender.capture({ position: 1 });
  sender.capture({ position: 2 });
  const final = sender.reserve({ position: 3 });
  expect(final).toEqual({ seq: 13, sample: { position: 3 } });
  expect(order).toEqual(["persist:11", "send:11", "persist:12", "persist:13"]);
  sender.stop();
  gate.resolve();
  await sender.flush();
  expect(received).toEqual([11]);
});
