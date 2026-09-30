export type ObservationPacket<T> = Readonly<{
  seq: number;
  sample: Readonly<T>;
}>;

// A sender belongs to one immutable playback plan. Its caller captures actual
// video data, including the cumulative fact that a real playing event occurred.
// Sequence numbers describe capture order, never HTTP arrival order.
export function createObservationSender<T extends object>(
  send: (packet: ObservationPacket<T>, signal: AbortSignal) => Promise<void>,
  initialSeq = 0,
  captured?: (seq: number) => void,
) {
  if (!Number.isSafeInteger(initialSeq) || initialSeq < 0)
    throw new Error("Invalid playback observation sequence");
  let seq = initialSeq;
  let active = true;
  let pending: ObservationPacket<T> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let failure: unknown;

  async function drain() {
    while (active && pending) {
      const packet = pending;
      pending = undefined;
      const request = new AbortController();
      controller = request;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await send(packet, request.signal);
          failure = undefined;
          break;
        } catch (error) {
          if (!active || request.signal.aborted) break;
          failure = error;
          // Prefer fresh captured data to retrying a superseded position.
          if (pending || attempt === 1) break;
        }
      }
      if (controller === request) controller = undefined;
    }
  }

  function start() {
    if (running || !active || !pending) return;
    running = drain().finally(() => {
      running = undefined;
      if (active && pending) start();
    });
  }

  function reserve(sample: T): ObservationPacket<T> | undefined {
    if (!active) return;
    if (seq === Number.MAX_SAFE_INTEGER)
      throw new Error("Playback observation sequence exhausted");
    const packet = Object.freeze({
      seq: ++seq,
      sample: Object.freeze(structuredClone(sample)),
    });
    captured?.(seq);
    return packet;
  }

  return {
    // The final DELETE carries this packet atomically with closure, without
    // creating a second POST that can race against that DELETE.
    reserve,
    capture(sample: T): number | undefined {
      const packet = reserve(sample);
      if (!packet) return;
      pending = packet;
      start();
      return seq;
    },
    async flush() {
      start();
      while (running) await running;
    },
    stop() {
      active = false;
      pending = undefined;
      controller?.abort();
    },
    get failure() {
      return failure;
    },
  };
}
