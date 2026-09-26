import type { PlaybackPlan, PlaybackRequest } from "../../../packages/protocol";
import { RequestFailure } from "./errors";

/** Retry uncertain results and transient preparation failures with one identity.
 * Both the client deadline and the server attempt limit bound recovery. */
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
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 65000);
  let networkFailures = 0;
  try {
    for (;;) {
      if (controller.signal.aborted)
        throw new Error("播放准备超时，请重新发起播放");
      try {
        return await send(request, controller.signal);
      } catch (error) {
        if (controller.signal.aborted)
          throw new Error("播放准备超时，请重新发起播放");
        const pending =
          error instanceof RequestFailure &&
          error.code === "PLAYBACK_REQUEST_IN_PROGRESS";
        const uncertain =
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
        if (!pending && (!(uncertain || recoverable) || ++networkFailures >= 3))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
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
    await this.cleanup();
    if (serial !== this.serial) throw new Error("播放准备已取消");
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
      if (serial !== this.serial) throw new Error("播放准备已取消");
      return plan;
    } catch (error) {
      // Failed revocation remains in storage and blocks the next preparation.
      try {
        await this.revoke(key);
      } catch {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；旧播放请求尚待清理，恢复连接后重试`,
        );
      }
      throw error;
    }
  }
}
