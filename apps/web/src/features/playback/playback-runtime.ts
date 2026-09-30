import { ref, nextTick, onScopeDispose, type Ref } from "vue";
import Hls from "hls.js";
import {
  detectCapabilities,
  detectCapabilitiesAsync,
  detectCandidateReport,
  PlaybackPlanGenerations,
  matchesPlanGeneration,
} from "../../../../../packages/player-core";
import {
  Corrector,
  target,
  type Clock,
} from "../../../../../packages/sync-engine";
import type {
  RoomState,
  PlaybackPlan,
  PlaybackRequest,
  PlaybackReadiness,
  PlaybackCandidateSet,
} from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import {
  PlaybackCancelled,
  PlaybackRequests,
  waitPlaybackReady,
} from "../../playback-request";
import type { useSession } from "../auth/session.store";
import { bindPlaybackObservations } from "./observation-binding";

export function createPlaybackRuntime(ctx: {
  session: ReturnType<typeof useSession>;
  state: Ref<RoomState | null>;
  connected: Ref<boolean>;
  active?: Ref<boolean>;
  clock: Clock;
  error: Ref<string>;
  run: (action: () => Promise<void>) => Promise<void>;
  ended?: (positionMs: number) => void;
}) {
  const { session, state, connected, clock, error, run } = ctx;
  const roomIsActive = () => ctx.active?.value !== false;
  const video = ref<HTMLVideoElement>(),
    waiting = ref(false),
    blocked = ref(false),
    dragging = ref(false),
    mode = ref("auto");
  const tracks = ref<PlaybackPlan["audio_tracks"]>([]),
    subtitles = ref<PlaybackPlan["subtitle_tracks"]>([]),
    audioIndex = ref<number | undefined>(),
    subtitleIndex = ref<number | undefined>();
  const duration = ref(0),
    position = ref(0),
    sessionId = ref<string | null>(null);
  let hls: Hls | undefined,
    plan: PlaybackPlan | undefined,
    loadSerial = 0,
    clockAction: "load" | "apply" | undefined;
  let recoveringHls = false,
    firstFrameTimer: ReturnType<typeof setTimeout> | undefined,
    capabilityProbe: AbortController | undefined,
    generationWait: AbortController | undefined,
    generationWaitFailed = false,
    generatedEnd: number | undefined;
  const corrector = new Corrector();
  const planGenerations = new PlaybackPlanGenerations();
  const currentPlan = (p: PlaybackPlan) =>
    plan === p && planGenerations.current(p);
  let playbackRequests: PlaybackRequests | undefined;
  let playbackUser: string | undefined;
  let playbackEpoch: number | undefined;
  let observations: ReturnType<typeof bindPlaybackObservations> | undefined;
  let checkingEnd = false,
    endAttempt = -Infinity;
  async function completed() {
    const p = plan,
      el = video.value,
      s = state.value;
    if (
      !roomIsActive() ||
      !p ||
      !el?.ended ||
      !s ||
      !connected.value ||
      s.playback_status !== "playing" ||
      p.media_generation !== s.media_generation ||
      checkingEnd ||
      performance.now() - endAttempt < 2000
    )
      return;
    checkingEnd = true;
    endAttempt = performance.now();
    try {
      // A generated HLS prefix ending is not the end of the film.
      if (p.rebuild_on_seek) {
        const readiness = await readReadiness(
          p.session_id,
          AbortSignal.timeout(5000),
          0,
          p.plan_generation,
        );
        if (
          !currentPlan(p) ||
          state.value?.media_generation !== p.media_generation
        )
          return;
        if (!readiness.complete) {
          await waitForGenerated(p);
          return;
        }
      }
      if (
        currentPlan(p) &&
        roomIsActive() &&
        el.ended &&
        state.value?.playback_status === "playing"
      ) {
        observations?.completed();
        ctx.ended?.(el.currentTime * 1000 + p.timeline_origin_ms);
      }
    } catch (failure) {
      if (currentPlan(p))
        error.value =
          failure instanceof Error ? failure.message : String(failure);
    } finally {
      checkingEnd = false;
    }
  }
  function requests() {
    const user = session.user!.id;
    const epoch = session.epoch;
    if (!playbackRequests || playbackUser !== user || playbackEpoch !== epoch) {
      playbackUser = user;
      playbackEpoch = epoch;
      playbackRequests = new PlaybackRequests(
        (body, signal) => {
          if (session.epoch !== epoch) throw new StaleIdentity();
          return session.api<PlaybackPlan>(
            "/playback-sessions",
            "POST",
            body,
            signal,
          );
        },
        (key, signal) => {
          if (session.epoch !== epoch) throw new StaleIdentity();
          return session.api(
            "/playback-requests/" + key,
            "DELETE",
            undefined,
            signal,
          );
        },
        sessionStorage,
        `rainsync:playback:${user}`,
        readReadiness,
      );
    }
    return playbackRequests;
  }
  async function readReadiness(
    id: string,
    signal: AbortSignal,
    relativePosition = 0,
    planGeneration?: number,
  ): Promise<PlaybackReadiness> {
    const readiness = await session.api<PlaybackReadiness>(
      `/playback-sessions/${id}?relative_position_ms=${encodeURIComponent(relativePosition)}${planGeneration === undefined ? "" : `&plan_generation=${planGeneration}`}`,
      "GET",
      undefined,
      signal,
    );
    if (
      readiness.session_id !== id ||
      !matchesPlanGeneration(planGeneration, readiness.plan_generation)
    )
      throw new RequestFailure({ error: { code: "STALE_PLAYBACK_PLAN" } });
    // A running EVENT prefix needs one whole segment ahead of the room clock.
    // Keep polling the real position; a complete or legacy response needs no lead.
    if (
      state.value?.playback_status === "playing" &&
      readiness.status === "ready" &&
      readiness.complete === false &&
      readiness.available_until_ms != null &&
      Number.isFinite(readiness.available_until_ms) &&
      readiness.available_until_ms - relativePosition < 4_000
    ) {
      return { ...readiness, status: "preparing" };
    }
    return readiness;
  }
  async function stopPlayback() {
    // Capture the old element before teardown changes its time or identity.
    const finalObservation = observations?.stop();
    observations = undefined;
    clearTimeout(firstFrameTimer);
    firstFrameTimer = undefined;
    capabilityProbe?.abort();
    capabilityProbe = undefined;
    generationWait?.abort();
    generationWait = undefined;
    generationWaitFailed = false;
    generatedEnd = undefined;
    recoveringHls = false;
    const old = plan;
    plan = undefined;
    sessionId.value = null;
    if (video.value) {
      video.value.onerror = null;
      video.value.onended = null;
      video.value.onloadedmetadata = null;
      video.value.onloadeddata = null;
    }
    hls?.destroy();
    hls = undefined;
    if (video.value) {
      video.value.pause();
      video.value.removeAttribute("src");
      video.value.load();
    }
    // Capture and cancel this operation before the first asynchronous wait.
    // A late session DELETE must never call stop() on a newer preparation.
    const previous = playbackRequests;
    const deletePrevious = async () => {
      if (old)
        await session
          .api(
            `/playback-sessions/${old.session_id}`,
            "DELETE",
            finalObservation,
            AbortSignal.timeout(5000),
          )
          .catch(() => {});
    };
    // The final sample and Stop commit together before key cancellation can
    // close the grant. Preparing work is still aborted synchronously in stop().
    const beforeCleanup = finalObservation ? deletePrevious : undefined;
    const cancellation = (
      previous
        ? previous.stop(beforeCleanup)
        : session.user
          ? requests().stop(beforeCleanup)
          : Promise.resolve()
    ).catch((e) => {
      if (!(e instanceof StaleIdentity)) throw e;
    });
    await Promise.all([
      cancellation,
      beforeCleanup ? Promise.resolve() : deletePrevious(),
    ]);
  }
  async function loadMedia(failedCandidates: string[] = []) {
    if (!roomIsActive()) return;
    const s = state.value;
    if (!s?.media_id) return;
    if (!clock.ready) {
      clockAction = "load";
      return;
    }
    const serial = ++loadSerial;
    const intent = planGenerations.next();
    try {
      await stopPlayback();
      await nextTick();
      if (serial !== loadSerial || !roomIsActive() || !video.value) return;
      if (!clock.ready) {
        clockAction = "load";
        return;
      }
      const element = video.value;
      const identity = session.epoch;
      waiting.value = true;
      const probe = new AbortController();
      capabilityProbe = probe;
      let candidateSet: PlaybackCandidateSet | undefined;
      try {
        candidateSet = await session.api<PlaybackCandidateSet>(
          "/playback-candidates",
          "POST",
          {
            room_id: s.room_id,
            media_generation: s.media_generation,
            audio_index: audioIndex.value ?? null,
            position_ms: target(s, clock.now()),
          },
          AbortSignal.any([probe.signal, AbortSignal.timeout(40000)]),
        );
      } catch (failure) {
        if (
          !(failure instanceof RequestFailure) ||
          !["NOT_FOUND", "METHOD_NOT_ALLOWED"].includes(failure.code)
        )
          throw failure;
      }
      const mseProbe = Hls.isSupported() ? Hls.getMediaSource() : undefined;
      const decoder =
        typeof navigator === "undefined"
          ? undefined
          : navigator.mediaCapabilities;
      const candidateReport = candidateSet
        ? await detectCandidateReport(element, candidateSet, mseProbe, decoder)
        : undefined;
      if (candidateReport)
        candidateReport.excluded_candidates = [...failedCandidates];
      const capabilities = candidateReport
        ? detectCapabilities(element, mseProbe)
        : await detectCapabilitiesAsync(element, mseProbe, decoder);
      // Capability probing is optional asynchronous work. Never start a session
      // for an old identity, element or media after a newer load/reset wins.
      if (
        serial !== loadSerial ||
        session.epoch !== identity ||
        !roomIsActive() ||
        probe.signal.aborted ||
        video.value !== element ||
        state.value?.room_id !== s.room_id ||
        state.value?.media_generation !== s.media_generation
      )
        return;
      if (!clock.ready) {
        waiting.value = false;
        clockAction = "load";
        return;
      }
      const request: PlaybackRequest = {
        ...intent,
        room_id: s.room_id,
        media_generation: s.media_generation,
        mode: mode.value,
        audio_index: audioIndex.value ?? null,
        position_ms: target(s, clock.now()),
        capabilities,
        ...(candidateReport ? { candidate_report: candidateReport } : {}),
        observation_version: 1,
      };
      waiting.value = true;
      const p = await requests().prepare(request, () =>
        target(state.value ?? s, clock.now()),
      );
      if (
        serial !== loadSerial ||
        !roomIsActive() ||
        session.epoch !== identity ||
        video.value !== element ||
        state.value?.room_id !== s.room_id ||
        state.value?.media_generation !== s.media_generation ||
        !planGenerations.current(p)
      ) {
        await session.api(`/playback-sessions/${p.session_id}`, "DELETE");
        return;
      }
      plan = p;
      sessionId.value = p.session_id;
      tracks.value = p.audio_tracks;
      subtitles.value = p.subtitle_tracks;
      if (!p.subtitle_tracks.some((t) => t.index === subtitleIndex.value))
        subtitleIndex.value = undefined;
      await nextTick();
      if (serial !== loadSerial || !currentPlan(p)) return;
      applySubtitles();
      const el = video.value;
      if (p.observation_version === 1) {
        const user = session.user!.id;
        const epoch = session.epoch;
        observations = bindPlaybackObservations({
          element: el,
          plan: p,
          current: () =>
            currentPlan(p) &&
            roomIsActive() &&
            serial === loadSerial &&
            video.value === el &&
            session.user?.id === user &&
            session.epoch === epoch &&
            state.value?.room_id === s.room_id &&
            state.value?.media_generation === p.media_generation,
          finalCurrent: () =>
            plan === p &&
            video.value === el &&
            session.user?.id === user &&
            session.epoch === epoch,
          send: async (body, signal) => {
            if (session.epoch !== epoch) throw new StaleIdentity();
            await session.api(
              `/playback-sessions/${p.session_id}/observations`,
              "POST",
              body,
              signal,
            );
          },
          storage: sessionStorage,
          storageKey: `rainsync:observation:${user}:${p.session_id}`,
        });
      }
      endAttempt = -Infinity;
      el.onended = () => {
        void completed();
      };
      waiting.value = true;
      let recoveries = 0;
      let mse =
        p.transport === "hls" &&
        !el.canPlayType("application/vnd.apple.mpegurl") &&
        Hls.isSupported();
      const playbackPosition = () =>
        Math.max(
          0,
          (target(state.value!, clock.now()) - p.timeline_origin_ms) / 1000,
        );
      const retryDecode = () => {
        const candidate = p.selected_candidate_id;
        if (
          serial !== loadSerial ||
          !currentPlan(p) ||
          !roomIsActive() ||
          mode.value !== "auto" ||
          !candidate ||
          !candidateReport ||
          failedCandidates.includes(candidate) ||
          failedCandidates.length >= 2
        )
          return false;
        // Only real decoder failures may move to another route. Authorization,
        // network errors and ordinary timeouts never trigger extra transcoding.
        void run(() => loadMedia([...failedCandidates, candidate]));
        return true;
      };
      const recover = () => {
        if (
          serial !== loadSerial ||
          !roomIsActive() ||
          !currentPlan(p) ||
          !state.value ||
          recoveries >= 3
        )
          return false;
        recoveries++;
        generationWait?.abort();
        generationWait = undefined;
        generationWaitFailed = false;
        generatedEnd = undefined;
        recoveringHls = true;
        waiting.value = true;
        const position = playbackPosition();
        if (mse && hls) {
          hls.stopLoad();
          hls.config.startPosition = position;
          hls.loadSource(p.playback_url);
          hls.startLoad(position);
        } else {
          // Native media errors do not expose the failing HTTP status. Retry the
          // unfenced entry with a bounded cache-busting URL and room-time fragment.
          const url = new URL(p.playback_url, location.href);
          url.searchParams.set("recovery", String(recoveries));
          url.hash = `t=${position}`;
          el.src = url.href;
          el.load();
        }
        return true;
      };
      el.onerror = () => {
        // load() during teardown and queued events from a previous resource are
        // not failures of this plan. A real media error belongs to the active URL.
        if (
          serial !== loadSerial ||
          !roomIsActive() ||
          !currentPlan(p) ||
          video.value !== el ||
          !el.getAttribute("src") ||
          !el.error ||
          el.error.code === 1
        )
          return;
        if (p.transport === "hls" && !mse) {
          if (
            (el.error.code === 3 || el.error.code === 4) &&
            Hls.isSupported()
          ) {
            // A native decoder/parser failure can be transport-specific. Try MSE
            // once, with this same authorized plan and the current room position.
            mse = true;
            generationWait?.abort();
            generationWait = undefined;
            generationWaitFailed = false;
            generatedEnd = undefined;
            recoveringHls = true;
            waiting.value = true;
            el.pause();
            el.removeAttribute("src");
            el.load();
            attachHls();
            return;
          }
          if (recover()) return;
        }
        if ((el.error.code === 3 || el.error.code === 4) && retryDecode())
          return;
        recoveringHls = false;
        error.value =
          el.error.code === 2
            ? "媒体加载中断，请检查连接后重新加载"
            : "无法播放此格式，可切换兼容转码后重载";
        waiting.value = false;
      };
      const attachHls = () => {
        hls = new Hls({
          startPosition: playbackPosition(),
          maxBufferLength: 20,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
        });
        hls.loadSource(p.playback_url);
        hls.attachMedia(el);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (
            serial === loadSerial &&
            currentPlan(p) &&
            roomIsActive() &&
            data.fatal
          ) {
            if (data.response?.code === 409 && recover()) return;
            if (data.type === "mediaError" && retryDecode()) return;
            recoveringHls = false;
            error.value = "媒体加载失败：" + data.details;
            waiting.value = false;
          }
        });
      };
      if (mse) attachHls();
      else el.src = p.playback_url;
      if (p.selected_candidate_id) {
        firstFrameTimer = setTimeout(() => {
          if (serial !== loadSerial || !currentPlan(p) || el.readyState >= 2)
            return;
          waiting.value = false;
          error.value = "首帧等待超时，请检查连接或重新加载播放";
        }, 20000);
        el.onloadeddata = () => {
          if (serial !== loadSerial || !currentPlan(p) || el.readyState < 2)
            return;
          clearTimeout(firstFrameTimer);
          firstFrameTimer = undefined;
        };
      }
      el.onloadedmetadata = () => {
        if (serial !== loadSerial || !currentPlan(p)) return;
        applySubtitles();
        duration.value = p.duration_ms ? p.duration_ms / 1000 : el.duration;
        void run(() => applyState(true));
      };
    } catch (e) {
      if (serial !== loadSerial || e instanceof PlaybackCancelled) return;
      waiting.value = false;
      throw e;
    }
  }
  function applySubtitles() {
    if (!video.value) return;
    for (const element of Array.from(video.value.querySelectorAll("track"))) {
      element.track.mode =
        subtitleIndex.value !== undefined &&
        Number(element.dataset.index) === subtitleIndex.value
          ? "showing"
          : "disabled";
    }
  }
  async function waitForGenerated(p: PlaybackPlan) {
    if (generationWait || generationWaitFailed) return;
    const controller = new AbortController();
    generationWait = controller;
    waiting.value = true;
    video.value?.pause();
    try {
      const ready = await waitPlaybackReady(
        (id, signal) =>
          readReadiness(
            id,
            signal,
            Math.max(
              0,
              target(state.value!, clock.now()) - p.timeline_origin_ms,
            ),
            p.plan_generation,
          ),
        p.session_id,
        controller.signal,
        p.plan_generation,
      );
      if (controller.signal.aborted || !currentPlan(p) || !roomIsActive())
        throw new PlaybackCancelled();
      if (ready.complete && ready.available_until_ms != null)
        generatedEnd = ready.available_until_ms / 1000;
      const position = Math.min(
        generatedEnd ?? Infinity,
        Math.max(
          0,
          (target(state.value!, clock.now()) - p.timeline_origin_ms) / 1000,
        ),
      );
      recoveringHls = true;
      if (hls) {
        // The same attempt grows through EVENT polling. Retain its MSE buffers;
        // applyState seeks once the local manifest covers the room position.
        hls.startLoad(position);
      } else if (video.value) {
        const url = new URL(p.playback_url, location.href);
        url.hash = `t=${position}`;
        video.value.src = url.href;
        video.value.load();
      }
    } catch (e) {
      if (controller.signal.aborted || !currentPlan(p) || !roomIsActive())
        throw new PlaybackCancelled();
      generationWaitFailed = true;
      waiting.value = false;
      throw e;
    } finally {
      if (generationWait === controller) generationWait = undefined;
    }
  }
  function availableRange(el: HTMLVideoElement): TimeRanges {
    // Native EVENT playback can expose decoded buffers before seekable ranges.
    // Requiring seekable first can deadlock a paused recovery before play().
    return el.seekable.length ? el.seekable : el.buffered;
  }
  async function applyState(force = false, userSeek = false) {
    if (!roomIsActive()) return;
    const s = state.value,
      el = video.value;
    if (!s || !el || !plan || el.readyState < 1) return;
    const p = plan;
    if (!currentPlan(p)) return;
    if (el.ended && s.playback_status === "playing" && !userSeek) {
      void completed();
      return;
    }
    if (!clock.ready) {
      clockAction ??= "apply";
      return;
    }
    if (userSeek) {
      generationWaitFailed = false;
      generatedEnd = undefined;
      recoveringHls = false;
    }
    const relative = (target(s, clock.now()) - plan.timeline_origin_ms) / 1000;
    const expected = Math.min(generatedEnd ?? Infinity, Math.max(0, relative));
    if (userSeek && generationWait) {
      generationWait.abort();
      generationWait = undefined;
    }
    if (generationWait || generationWaitFailed) return;
    const range = availableRange(el);
    const end = range.length ? range.end(range.length - 1) : el.duration;
    if (
      plan.rebuild_on_seek &&
      !userSeek &&
      !recoveringHls &&
      generatedEnd === undefined &&
      Number.isFinite(end) &&
      expected > end + 0.1
    ) {
      await waitForGenerated(plan);
      return;
    }
    if (recoveringHls) {
      // A replacement EVENT playlist may still be growing toward the room time.
      // Waiting here must not create another playback session or jump to its edge.
      const seekable = Array.from({ length: range.length }, (_, i) => i).some(
        (i) => expected >= range.start(i) && expected <= range.end(i),
      );
      if (
        !seekable &&
        (!Number.isFinite(el.duration) || expected > el.duration)
      )
        return;
      recoveringHls = false;
    }
    if (
      force &&
      plan.rebuild_on_seek &&
      (relative < -0.5 ||
        (userSeek && Number.isFinite(end) && expected > end + 0.1))
    ) {
      await loadMedia();
      return;
    }
    if (force || s.playback_status !== "playing") {
      if (Math.abs(el.currentTime - expected) > 0.15) el.currentTime = expected;
    }
    if (s.playback_status === "playing") {
      if (el.paused)
        try {
          await el.play();
          if (!currentPlan(p) || !roomIsActive() || video.value !== el) return;
          blocked.value = false;
        } catch {
          if (!currentPlan(p) || !roomIsActive() || video.value !== el) return;
          blocked.value = true;
        }
    } else el.pause();
  }
  async function enablePlayback() {
    if (!roomIsActive()) return;
    const p = plan,
      el = video.value;
    if (p && el && currentPlan(p)) {
      try {
        await el.play();
      } catch (failure) {
        if (!currentPlan(p) || !roomIsActive() || video.value !== el) return;
        throw failure;
      }
      if (!currentPlan(p) || !roomIsActive() || video.value !== el) return;
      blocked.value = false;
      await applyState(true);
    }
  }
  function tick() {
    if (!roomIsActive()) return;
    const s = state.value,
      el = video.value;
    if (!s || !el || !plan) return;
    if (el.ended) {
      void completed();
      return;
    }
    if (generationWait || generationWaitFailed) return;
    if (recoveringHls) {
      void run(() => applyState(true));
      return;
    }
    if (!dragging.value)
      position.value = el.currentTime + plan.timeline_origin_ms / 1000;
    if (!clock.ready || !connected.value || s.playback_status !== "playing")
      return;
    const expected = Math.min(
      generatedEnd ?? Infinity,
      (target(s, clock.now()) - plan.timeline_origin_ms) / 1000,
    );
    const range = availableRange(el);
    const end = range.length ? range.end(range.length - 1) : el.duration;
    if (
      plan.rebuild_on_seek &&
      generatedEnd === undefined &&
      Number.isFinite(end) &&
      expected > end + 0.1
    ) {
      void run(() => applyState(true));
      return;
    }
    const adjustment = corrector.step(
      (expected - el.currentTime) * 1000,
      s.playback_rate,
      performance.now(),
      waiting.value || el.seeking || blocked.value || el.readyState < 2,
    );
    el.playbackRate = adjustment.rate;
    if (adjustment.seek) {
      if (
        plan.rebuild_on_seek &&
        (expected < -0.5 || expected > el.duration + 1)
      ) {
        if (expected < -0.5) void run(loadMedia);
        else void run(() => applyState(true));
      } else el.currentTime = Math.max(0, expected);
    }
  }
  function onClockReady() {
    if (!roomIsActive()) return;
    if (clockAction) {
      const action = clockAction;
      clockAction = undefined;
      void run(action === "load" ? loadMedia : () => applyState(true));
    }
  }
  function mediaChanged() {
    corrector.reset();
    audioIndex.value = undefined;
    subtitleIndex.value = undefined;
    void run(loadMedia);
  }
  async function reset() {
    ++loadSerial;
    clockAction = undefined;
    dragging.value = false;
    tracks.value = [];
    subtitles.value = [];
    waiting.value = false;
    blocked.value = false;
    duration.value = 0;
    position.value = 0;
    await stopPlayback();
  }
  function resetClockAction() {
    clockAction = undefined;
  }
  function attach(element: HTMLVideoElement) {
    if (video.value === element) return;
    if (video.value) throw new Error("播放器已绑定；需先显式停止");
    video.value = element;
  }
  const timer = setInterval(tick, 500);
  const observationTimer = setInterval(() => observations?.progress(), 5000);
  const renewTimer = setInterval(() => {
    const current = plan?.session_id;
    if (current && roomIsActive())
      void session
        .api(`/playback-sessions/${current}`, "POST")
        .catch((failure) => {
          if (
            plan?.session_id === current &&
            failure instanceof RequestFailure &&
            ["INVALID_PLAYBACK_SESSION", "SESSION_EXPIRED"].includes(
              failure.code,
            )
          )
            error.value = "播放会话已失效，请重新加载";
        });
  }, 600000);
  onScopeDispose(() => {
    clearInterval(timer);
    clearInterval(observationTimer);
    clearInterval(renewTimer);
    void reset().catch(() => {});
  });
  return {
    video,
    waiting,
    blocked,
    dragging,
    mode,
    tracks,
    subtitles,
    audioIndex,
    subtitleIndex,
    duration,
    position,
    sessionId,
    loadMedia,
    applyState,
    enablePlayback,
    applySubtitles,
    reset,
    onClockReady,
    mediaChanged,
    resetClockAction,
    attach,
  };
}
