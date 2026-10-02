import type {
  PlaybackPlan,
  PlaybackRequest,
  PlaybackReadiness,
} from "../../../packages/protocol";
import { RequestFailure } from "./errors";
import {
  matchesPlanGeneration,
  matchesUpstreamProfilePlan,
} from "../../../packages/player-core";

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
          if (
            !matchesPlanGeneration(
              request.plan_generation,
              plan.plan_generation,
            )
          )
            throw new RequestFailure({
              error: { code: "STALE_PLAYBACK_PLAN" },
            });
          if (
            !matchesUpstreamProfilePlan(
              request.upstream_profile_report,
              plan.upstream_profile,
              plan.delivery_mode,
              plan.transport,
            )
          )
            throw new RequestFailure({
              error: { code: "STALE_CAPABILITY_REPORT" },
            });
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
            "MEDIA_QUEUE_FULL",
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

export async function waitPlaybackReady(
  read: (id: string, signal: AbortSignal) => Promise<PlaybackReadiness>,
  id: string,
  signal: AbortSignal,
  planGeneration?: number,
): Promise<PlaybackReadiness> {
  const controller = new AbortController();
  const abort = () => controller.abort(new PlaybackCancelled());
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new PlaybackTimeout()),
    180000,
  );
  let failures = 0;
  try {
    for (;;) {
      if (controller.signal.aborted) throw controller.signal.reason;
      try {
        const result = await read(id, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!matchesPlanGeneration(planGeneration, result.plan_generation))
          throw new RequestFailure({ error: { code: "STALE_PLAYBACK_PLAN" } });
        if (
          result.session_id !== id ||
          !["queued", "preparing", "ready"].includes(result.status)
        )
          throw new RequestFailure({ error: { code: "INVALID_RESPONSE" } });
        if (result.status === "ready") return result;
        failures = 0;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (
          !(
            error instanceof TypeError ||
            (error instanceof RequestFailure &&
              [
                "SERVICE_UNAVAILABLE",
                "DATABASE_ERROR",
                "REQUEST_TIMEOUT",
                "RATE_LIMITED",
              ].includes(error.code))
          ) ||
          ++failures >= 3
        )
          throw error;
      }
      await retryDelay(controller.signal);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** Keep cancellation identities until the server acknowledges revocation.
 * Tab storage survives refresh; it contains UUIDs only, never playback URLs. */
export class PlaybackRequests {
  private keys: Set<string>;
  private controller?: AbortController;
  private serial = 0;
  private finalization: Promise<void> = Promise.resolve();
  private completed?: { key: string; plan: PlaybackPlan };
  private continuation?: {
    parentKey: string;
    finish: () => Promise<void>;
  };
  constructor(
    private send: (
      body: PlaybackRequest,
      signal: AbortSignal,
    ) => Promise<PlaybackPlan>,
    private cancel: (key: string, signal: AbortSignal) => Promise<unknown>,
    private storage: Pick<Storage, "getItem" | "setItem">,
    private storageKey: string,
    private readiness?: (
      id: string,
      signal: AbortSignal,
      relativePosition?: number,
      planGeneration?: number,
    ) => Promise<PlaybackReadiness>,
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
  private async cleanup(except?: string) {
    if (this.continuation && except !== this.continuation.parentKey)
      await this.continuation.finish();
    await this.finalization;
    for (const key of [...this.keys])
      if (key !== except) await this.revoke(key);
  }
  async stop(beforeCleanup?: () => Promise<void>) {
    this.serial++;
    this.controller?.abort();
    this.completed = undefined;
    // Snapshot before the barrier: a late DELETE must not revoke a successor.
    const keys = [...this.keys];
    const continuation = this.continuation;
    // A continuation's new key must be cancelled immediately, even while its
    // old final DELETE is blocked. That tombstone fences a late claim POST.
    const immediate = continuation
      ? Promise.all(
          keys
            .filter((key) => key !== continuation.parentKey)
            .map((key) => this.revoke(key)),
        )
      : Promise.resolve();
    const finishParent = continuation?.finish() ?? Promise.resolve();
    const finalization = beforeCleanup
      ? this.finalization.then(beforeCleanup)
      : this.finalization;
    // Successor preparations and repeated stops must also wait for the final
    // grant sample, before any key cancellation can close the same grant.
    this.finalization = finalization.catch(() => {});
    await Promise.all([immediate, finishParent, finalization]);
    if (!continuation) for (const key of keys) await this.revoke(key);
  }
  async prepare(
    input: PlaybackRequest,
    position?: () => number,
  ): Promise<PlaybackPlan> {
    const serial = ++this.serial;
    this.controller?.abort();
    this.completed = undefined;
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
      if (plan.rebuild_on_seek && this.readiness)
        await waitPlaybackReady(
          (id, signal) =>
            this.readiness!(
              id,
              signal,
              Math.max(
                0,
                (position?.() ?? input.position_ms) - plan.timeline_origin_ms,
              ),
              plan.plan_generation,
            ),
          plan.session_id,
          controller.signal,
          plan.plan_generation,
        );
      if (serial !== this.serial) throw new PlaybackCancelled();
      this.completed = { key, plan };
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

  /** Atomically replace an opted-in live HTTP file through the server's claim.
   * The parent stays in cleanup storage until final DELETE then key revocation.
   * Its final sample is also in the immutable POST, before server retirement. */
  async prepareContinuation(
    input: PlaybackRequest,
    finalizeParent: () => Promise<void>,
    position?: () => number,
  ): Promise<PlaybackPlan> {
    const parent = this.completed;
    if (
      !parent ||
      parent.plan.http_file_fallback_version !== 1 ||
      parent.plan.delivery_mode !== "direct" ||
      parent.plan.transport !== "progressive" ||
      !parent.plan.decoder_fallback_modes?.includes("transcode") ||
      input.http_file_fallback_version !== 1 ||
      input.mode !== "transcode" ||
      input.http_file_fallback?.parent_session_id !== parent.plan.session_id ||
      input.idempotency_key === parent.key ||
      !this.keys.has(parent.key) ||
      this.continuation
    ) {
      await this.stop(finalizeParent);
      throw new RequestFailure({ error: { code: "SOURCE_VERSION_REQUIRED" } });
    }
    const serial = ++this.serial;
    this.controller?.abort();
    this.completed = undefined;
    let finishing: Promise<void> | undefined;
    const continuation = {
      parentKey: parent.key,
      finish: () => {
        if (!finishing) {
          finishing = this.finalization
            .then(finalizeParent)
            .then(() => this.revoke(parent.key))
            .finally(() => {
              if (this.continuation === continuation)
                this.continuation = undefined;
            });
          this.finalization = finishing.catch(() => {});
        }
        return finishing;
      },
    };
    this.continuation = continuation;
    const key = input.idempotency_key ?? crypto.randomUUID();
    let recorded = false;
    try {
      await this.cleanup(parent.key);
      if (serial !== this.serial) throw new PlaybackCancelled();
      // Persist before the first POST; Stop can cancel even an unclaimed key.
      this.keys.add(key);
      recorded = true;
      this.save();
      const controller = new AbortController();
      this.controller = controller;
      const plan = await requestPlayback(
        this.send,
        { ...input, idempotency_key: key },
        controller.signal,
      );
      if (serial !== this.serial) throw new PlaybackCancelled();
      await continuation.finish();
      if (serial !== this.serial) throw new PlaybackCancelled();
      if (plan.rebuild_on_seek && this.readiness)
        await waitPlaybackReady(
          (id, signal) =>
            this.readiness!(
              id,
              signal,
              Math.max(
                0,
                (position?.() ?? input.position_ms) - plan.timeline_origin_ms,
              ),
              plan.plan_generation,
            ),
          plan.session_id,
          controller.signal,
          plan.plan_generation,
        );
      if (serial !== this.serial) throw new PlaybackCancelled();
      // A successor is never a root, even if a malformed response says it is.
      this.completed = undefined;
      return plan;
    } catch (error) {
      // Start child cancellation before potentially slow parent finalization.
      const cleanup = await Promise.allSettled([
        recorded ? this.revoke(key) : Promise.resolve(),
        continuation.finish(),
      ]);
      if (serial !== this.serial || error instanceof PlaybackCancelled)
        throw new PlaybackCancelled();
      if (cleanup.some((result) => result.status === "rejected"))
        throw new Error("播放续接已停止；旧播放请求尚待清理，恢复连接后重试");
      throw error;
    }
  }
}
