import type { Ref } from "vue";
import type { PlaybackPlan } from "../../../../../packages/protocol";
import type { PlaybackIntent, RoomTimelinePort } from "./playback-runtime-types";
import { validNativeLiveDeliveryUrl } from "./native-live";
import { ignoreBodyCancellation } from "./playback-runtime-utils";
type LiveWindowBudget = {
  scope: string;
  consumed: boolean;
  probed: boolean;
  parent?: PlaybackPlan;
  replacement?: PlaybackPlan;
  resumedAt?: number;
  resumedPosition?: number;
};
export function createLiveWindowRecovery(ctx: {
  intent: () => PlaybackIntent | undefined;
  terminalEnd: () => boolean;
  scope: () => string | undefined;
  currentPlan: (plan: PlaybackPlan) => boolean;
  currentIntent: (intent: PlaybackIntent) => boolean;
  clearRefresh: () => void;
  needsEdge: () => void;
  error: Ref<string>;
  connected: RoomTimelinePort["connected"];
  state: RoomTimelinePort["state"];
  video: Ref<HTMLVideoElement | undefined>;
  foreground: () => boolean;
  fail: (plan: PlaybackPlan, code: string) => void;
  load: () => Promise<void> | undefined;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const {
    scope: liveWindowScope,
    currentPlan,
    currentIntent: candidateIntentCurrent,
    error,
    connected,
    state,
    video,
    foreground,
    fail: failNativeLive,
    run,
  } = ctx;
  const beginLoad = () => ctx.load();
  let liveWindowRecovery: LiveWindowBudget | undefined;
  let liveWindowProbe: AbortController | undefined;
  let liveWindowProgressStop: (() => void) | undefined;
  function recoverExpiredLiveWindow(p: PlaybackPlan): boolean {
    const playbackIntent = ctx.intent();
    const scope = liveWindowScope();
    if (
      ctx.terminalEnd() ||
      !scope ||
      !playbackIntent ||
      !currentPlan(p) ||
      !candidateIntentCurrent(playbackIntent) ||
      liveWindowRecovery?.scope !== scope ||
      liveWindowRecovery.consumed
    )
      return false;
    // Claim before any asynchronous cleanup so duplicate/stale loader callbacks
    // cannot allocate another generation. No broadcast import or room mutation.
    liveWindowRecovery.consumed = true;
    liveWindowRecovery.parent = p;
    ctx.clearRefresh();
    ctx.needsEdge();
    error.value = "";
    const loading = beginLoad();
    if (loading) void run(() => loading);
    return true;
  }

  function bindLiveWindowProgress(p: PlaybackPlan, el: HTMLVideoElement) {
    liveWindowProgressStop?.();
    liveWindowProgressStop = undefined;
    const budget = liveWindowRecovery,
      scope = liveWindowScope();
    if (
      !p.native_platform?.live ||
      !budget?.consumed ||
      budget.scope !== scope ||
      !budget.parent ||
      p.session_id === budget.parent.session_id ||
      (p.plan_generation ?? 0) <= (budget.parent.plan_generation ?? 0)
    )
      return;
    budget.replacement = p;
    budget.resumedAt = budget.resumedPosition = undefined;
    const current = () =>
      liveWindowRecovery === budget &&
      budget.replacement === p &&
      currentPlan(p) &&
      liveWindowScope() === scope &&
      connected.value &&
      foreground() &&
      state.value?.playback_status === "playing" &&
      !el.paused &&
      !el.seeking &&
      !el.ended &&
      el.readyState >= 2 &&
      Number.isFinite(el.currentTime);
    const playing = () => {
      if (!current()) return;
      budget.resumedAt = performance.now();
      budget.resumedPosition = el.currentTime;
    };
    const progress = () => {
      if (
        !current() ||
        budget.resumedAt === undefined ||
        budget.resumedPosition === undefined
      )
        return;
      const elapsed = (performance.now() - budget.resumedAt) / 1000;
      const advanced = el.currentTime - budget.resumedPosition;
      // A seek/jump or a prepare response does not certify resumed decoding.
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 1 ||
        advanced < 0.5 ||
        advanced > elapsed * 1.25 + 0.25
      )
        return;
      budget.consumed = budget.probed = false;
      budget.parent = budget.replacement = undefined;
      budget.resumedAt = budget.resumedPosition = undefined;
      liveWindowProgressStop?.();
      liveWindowProgressStop = undefined;
    };
    el.addEventListener("playing", playing);
    el.addEventListener("timeupdate", progress);
    liveWindowProgressStop = () => {
      el.removeEventListener("playing", playing);
      el.removeEventListener("timeupdate", progress);
    };
  }

  async function probeExpiredNativeLiveWindow(p: PlaybackPlan) {
    const playbackIntent = ctx.intent(),
      scope = liveWindowScope(),
      budget = liveWindowRecovery;
    const current = () =>
      !ctx.terminalEnd() &&
      !!scope &&
      !!playbackIntent &&
      currentPlan(p) &&
      candidateIntentCurrent(playbackIntent) &&
      liveWindowScope() === scope &&
      liveWindowRecovery === budget;
    if (!current()) return;
    if (liveWindowProbe) return; // Duplicate native errors share the one pending probe.
    if (
      !budget ||
      budget.scope !== scope ||
      budget.consumed ||
      budget.probed ||
      !validNativeLiveDeliveryUrl(
        p.playback_url,
        p.session_id,
        location.origin,
        true,
        p.native_platform!.live!.version,
      )
    ) {
      failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
      return;
    }
    budget.probed = true;
    ctx.clearRefresh();
    video.value?.pause();
    const controller = new AbortController();
    liveWindowProbe = controller;
    const startedWall = Date.now(),
      startedMono = performance.now();
    const expired = () =>
      Date.now() - startedWall >= 2500 ||
      performance.now() - startedMono >= 2500 ||
      Date.now() < startedWall ||
      performance.now() < startedMono;
    const timeout = setTimeout(() => controller.abort(), 2500);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("native_live_probe_aborted")),
        { once: true },
      );
    });
    try {
      const response = await Promise.race([
        fetch(p.playback_url, {
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        }),
        aborted,
      ]);
      if (!current()) return;
      if (controller.signal.aborted || expired()) {
        failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
        return;
      }
      if (
        response.status !== 409 ||
        !response.headers.get("content-type")?.startsWith("application/json") ||
        (response.url &&
          !validNativeLiveDeliveryUrl(
            response.url,
            p.session_id,
            location.origin,
            true,
            p.native_platform!.live!.version,
          )) ||
        Number(response.headers.get("content-length") ?? 0) > 16384 ||
        !response.body
      ) {
        void response.body?.cancel().catch(ignoreBodyCancellation);
        failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
        return;
      }
      const reader = response.body.getReader();
      const bytes = new Uint8Array(16384);
      let size = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (!current()) return;
          if (controller.signal.aborted || expired()) {
            failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
            return;
          }
          if (chunk.done) break;
          if (size + chunk.value.byteLength > bytes.byteLength) {
            controller.abort();
            throw new Error("oversized_live_error");
          }
          bytes.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
      } finally {
        void reader.cancel().catch(ignoreBodyCancellation);
      }
      const code = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)))
        ?.error?.code;
      if (
        current() &&
        !expired() &&
        code === "NATIVE_LIVE_WINDOW_EXPIRED" &&
        recoverExpiredLiveWindow(p)
      )
        return;
      if (current()) failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
    } catch {
      if (current()) failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
    } finally {
      clearTimeout(timeout);
      if (liveWindowProbe === controller) liveWindowProbe = undefined;
    }
  }
  function retire() {
    liveWindowProbe?.abort();
    liveWindowProbe = undefined;
    liveWindowProgressStop?.();
    liveWindowProgressStop = undefined;
  }
  function beginScope(scope: string | undefined, newIntent: boolean) {
    if (newIntent || liveWindowRecovery?.scope !== scope)
      liveWindowRecovery = scope
        ? { scope, consumed: false, probed: false }
        : undefined;
    retire();
  }
  return {
    recoverExpiredLiveWindow,
    bindLiveWindowProgress,
    probeExpiredNativeLiveWindow,
    retire,
    beginScope,
  };
}
