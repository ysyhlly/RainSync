import type { PlaybackPlan, PlaybackRequest } from "../../../packages/protocol";
import { RequestFailure } from "./errors";

export class PlaybackCancelled extends Error {
  constructor() {
    super("播放准备已取消");
    this.name = "PlaybackCancelled";
  }
}
export class PlaybackTimeout extends Error {
  constructor() {
    super("播放准备超时，请重新发起播放");
    this.name = "PlaybackTimeout";
  }
}
function retryDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Retry uncertain results and transient preparation failures with one identity.
 * Each HTTP attempt gets 65s (server preparation: 45s, lease: 60s).
 * Transport failures and preparation failures have separate budgets of three.
 * 335s covers two uncertain waits plus three full attempts and retry delays. */
export async function requestPlayback(
  send: (
    request: PlaybackRequest,
    signal: AbortSignal,
  ) => Promise<PlaybackPlan>,
  input: PlaybackRequest,
  signal?: AbortSignal,
): Promise<PlaybackPlan> {
  const request = {
    ...input,
    idempotency_key: input.idempotency_key ?? crypto.randomUUID(),
  };
  const controller = new AbortController();
  const abort = () => controller.abort(new PlaybackCancelled());
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(
    () => controller.abort(new PlaybackTimeout()),
    335000,
  );
  let networkFailures = 0;
  let preparationFailures = 0;
  try {
    for (;;) {
      if (controller.signal.aborted) throw controller.signal.reason;
      try {
        const attempt = new AbortController();
        const cancel = () => attempt.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
        const deadline = setTimeout(
          () => attempt.abort(new PlaybackTimeout()),
          65000,
        );
        try {
          const plan = await send(request, attempt.signal);
          if (attempt.signal.aborted) throw attempt.signal.reason;
          return plan;
        } catch (error) {
          if (attempt.signal.aborted) throw attempt.signal.reason;
          throw error;
        } finally {
          clearTimeout(deadline);
          controller.signal.removeEventListener("abort", cancel);
        }
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const pending =
          error instanceof RequestFailure &&
          error.code === "PLAYBACK_REQUEST_IN_PROGRESS";
        const uncertain =
          error instanceof PlaybackTimeout ||
          error instanceof TypeError ||
          (error instanceof RequestFailure &&
            error.code === "INVALID_RESPONSE");
        const recoverable =
          error instanceof RequestFailure &&
          error.retryable &&
          [
            "PLAYBACK_REQUEST_INTERRUPTED",
            "SOURCE_PROBE_FAILED",
            "UPSTREAM_PLAYBACK_FAILED",
            "MEDIA_UNAVAILABLE",
            "SERVICE_UNAVAILABLE",
            "REQUEST_TIMEOUT",
            "UPSTREAM_FAILED",
            "PROBE_BUSY",
            "RATE_LIMITED",
            "AGENT_OFFLINE",
            "AGENT_TIMEOUT",
          ].includes(error.code);
        if (!pending) {
          if (uncertain) {
            if (++networkFailures >= 3) throw error;
          } else if (recoverable) {
            if (++preparationFailures >= 3) throw error;
          } else {
            throw error;
          }
        }
        await retryDelay(controller.signal);
      }
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** Keep cancellation identities until the server acknowledges revocation.
 * Tab storage survives refresh; it contains UUIDs only, never playback URLs. */
export class PlaybackRequests {
  private keys: Set<string>;
  private controller?: AbortController;
  private serial = 0;
  constructor(
    private send: (
      body: PlaybackRequest,
      signal: AbortSignal,
    ) => Promise<PlaybackPlan>,
    private cancel: (key: string, signal: AbortSignal) => Promise<unknown>,
    private storage: Pick<Storage, "getItem" | "setItem">,
    private storageKey: string,
  ) {
    const saved = JSON.parse(storage.getItem(storageKey) ?? "[]") as string[];
    this.keys = new Set(saved);
  }
  private save() {
    this.storage.setItem(this.storageKey, JSON.stringify([...this.keys]));
  }
  private async revoke(key: string) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5000);
    try {
      await this.cancel(key, timeout.signal);
      this.keys.delete(key);
      this.save();
    } finally {
      clearTimeout(timer);
    }
  }
  private async cleanup() {
    for (const key of [...this.keys]) await this.revoke(key);
  }
  async stop() {
    this.serial++;
    this.controller?.abort();
    await this.cleanup();
  }
  async prepare(input: PlaybackRequest): Promise<PlaybackPlan> {
    const serial = ++this.serial;
    this.controller?.abort();
    // Never consume another quota slot while an older result is uncertain.
    try {
      await this.cleanup();
    } catch (error) {
      if (serial !== this.serial) throw new PlaybackCancelled();
      throw error;
    }
    if (serial !== this.serial) throw new PlaybackCancelled();
    const key = input.idempotency_key ?? crypto.randomUUID();
    this.keys.add(key);
    this.save();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const plan = await requestPlayback(
        this.send,
        { ...input, idempotency_key: key },
        controller.signal,
      );
      if (serial !== this.serial) throw new PlaybackCancelled();
      return plan;
    } catch (error) {
      // Failed revocation remains in storage and blocks the next preparation.
      try {
        await this.revoke(key);
      } catch {
        if (serial !== this.serial || error instanceof PlaybackCancelled)
          throw new PlaybackCancelled();
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；旧播放请求尚待清理，恢复连接后重试`,
        );
      }
      if (serial !== this.serial || error instanceof PlaybackCancelled)
        throw new PlaybackCancelled();
      throw error;
    }
  }
}
