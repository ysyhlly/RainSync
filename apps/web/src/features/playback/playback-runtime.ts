import { ref, nextTick, onScopeDispose, type Ref } from "vue";
import Hls from "hls.js";
import { detectCapabilities } from "../../../../../packages/player-core";
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
} from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import {
  PlaybackCancelled,
  PlaybackRequests,
  waitPlaybackReady,
} from "../../playback-request";
import type { useSession } from "../auth/session.store";

export function createPlaybackRuntime(ctx: {
  session: ReturnType<typeof useSession>;
  state: Ref<RoomState | null>;
  connected: Ref<boolean>;
  clock: Clock;
  error: Ref<string>;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const { session, state, connected, clock, error, run } = ctx;
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
    generationWait: AbortController | undefined,
    generationWaitFailed = false,
    generatedEnd: number | undefined;
  const corrector = new Corrector();
  let playbackRequests: PlaybackRequests | undefined;
  let playbackUser: string | undefined;
  let playbackEpoch: number | undefined;
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
  function readReadiness(
    id: string,
    signal: AbortSignal,
    relativePosition = 0,
  ) {
    return session.api<PlaybackReadiness>(
      `/playback-sessions/${id}?relative_position_ms=${encodeURIComponent(relativePosition)}`,
      "GET",
      undefined,
      signal,
    );
  }
  async function stopPlayback() {
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
      video.value.onloadedmetadata = null;
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
    const cancellation = (
      previous
        ? previous.stop()
        : session.user
          ? requests().stop()
          : Promise.resolve()
    ).catch((e) => {
      if (!(e instanceof StaleIdentity)) throw e;
    });
    await Promise.all([
      cancellation,
      old
        ? session
            .api(
              `/playback-sessions/${old.session_id}`,
              "DELETE",
              undefined,
              AbortSignal.timeout(5000),
            )
            .catch(() => {})
        : Promise.resolve(),
    ]);
  }
  async function loadMedia() {
    const s = state.value;
    if (!s?.media_id) return;
    if (!clock.ready) {
      clockAction = "load";
      return;
    }
    const serial = ++loadSerial;
    try {
      await stopPlayback();
      await nextTick();
      if (serial !== loadSerial || !video.value) return;
      if (!clock.ready) {
        clockAction = "load";
        return;
      }
      const request: PlaybackRequest = {
        room_id: s.room_id,
        media_generation: s.media_generation,
        mode: mode.value,
        audio_index: audioIndex.value ?? null,
        position_ms: target(s, clock.now()),
        capabilities: detectCapabilities(
          video.value,
          Hls.isSupported() ? window.MediaSource : undefined,
        ),
      };
      waiting.value = true;
      const p = await requests().prepare(request, () =>
        target(state.value ?? s, clock.now()),
      );
      if (serial !== loadSerial) {
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
      if (serial !== loadSerial) return;
      applySubtitles();
      const el = video.value;
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
      const recover = () => {
        if (
          serial !== loadSerial ||
          plan !== p ||
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
          plan !== p ||
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
          if (serial === loadSerial && data.fatal) {
            if (data.response?.code === 409 && recover()) return;
            recoveringHls = false;
            error.value = "媒体加载失败：" + data.details;
            waiting.value = false;
          }
        });
      };
      if (mse) attachHls();
      else el.src = p.playback_url;
      el.onloadedmetadata = () => {
        if (serial !== loadSerial) return;
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
          ),
        p.session_id,
        controller.signal,
      );
      if (controller.signal.aborted || plan !== p)
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
        hls.stopLoad();
        hls.config.startPosition = position;
        hls.loadSource(p.playback_url);
        hls.startLoad(position);
      } else if (video.value) {
        const url = new URL(p.playback_url, location.href);
        url.hash = `t=${position}`;
        video.value.src = url.href;
        video.value.load();
      }
    } catch (e) {
      if (controller.signal.aborted || plan !== p)
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
    const s = state.value,
      el = video.value;
    if (!s || !el || !plan || el.readyState < 1) return;
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
          blocked.value = false;
        } catch {
          blocked.value = true;
        }
    } else el.pause();
  }
  async function enablePlayback() {
    if (video.value) {
      await video.value.play();
      blocked.value = false;
      await applyState(true);
    }
  }
  function tick() {
    const s = state.value,
      el = video.value;
    if (!s || !el || !plan) return;
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
  const renewTimer = setInterval(() => {
    const current = plan?.session_id;
    if (current)
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
