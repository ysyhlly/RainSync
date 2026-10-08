import { ref, readonly } from "vue";
import {
  PlaybackPlanGenerations,
  matchesPlanGeneration,
  hasUsablePlaybackTimeline,
} from "../../../../../packages/player-core";
import type {
  PlaybackPlan,
  PlaybackReadiness,
} from "../../../../../packages/protocol";
import {
  PlaybackRequests,
  PlaybackCancelled,
  PlaybackViewerOriginRequired,
} from "../../playback-request";
import { StaleIdentity, type ApiClient } from "../../shared/api/client";
import { RequestFailure } from "../../errors";
import { validNativePlatformPlan } from "./native-platform-intent";
import { liveRoomMatchesPlan } from "./native-live";
import { matchesDistributedPlaybackPlan } from "./distributed-playback-intent";
import {
  matchesLocalHlsLadderPlan,
  sameLocalHlsLadderRequest,
} from "./local-hls-ladder-intent";
import {
  matchesAdvancedPlaybackPlan,
  sameAdvancedPlaybackRequest,
} from "./advanced-playback-intent";
import { createPlaybackMaintenance } from "./playback-maintenance";
import type {
  CandidateDiscovery,
  PlaybackIdentityPort,
  PlaybackIdentitySnapshot,
  PlaybackIntent,
  RoomTimelinePort,
  StaticChildState,
} from "./playback-runtime-types";

const CANDIDATE_LIFETIME_MS = 5 * 60 * 1000;
const candidateExpiredError = "播放候选已失效，请重新加载播放";
export function checkCandidateLifetime(snapshot: CandidateDiscovery) {
  const startedAt =
    snapshot.upstream?.startedAt ?? snapshot.concrete?.startedAt;
  if (startedAt === undefined) return;
  const elapsed = performance.now() - startedAt;
  // This conservative local limit never authorizes a binding. The server's
  // original authority-clock expiry and current fences still decide prepare.
  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed >= CANDIDATE_LIFETIME_MS
  )
    throw new Error(candidateExpiredError);
}

export function createPlaybackSessionController(ctx: {
  identity: Pick<PlaybackIdentityPort, "current">;
  api: ApiClient;
  timeline: Pick<RoomTimelinePort, "state" | "active">;
  storage: () => Pick<Storage, "getItem" | "setItem">;
  origin: () => string;
  intentCurrent: (intent: PlaybackIntent) => boolean;
  retryStaticChild: StaticChildState["retry"];
  prepared: (plan: PlaybackPlan) => void;
  readiness: (value: PlaybackReadiness) => void;
}) {
  const { identity: viewer, api } = ctx;
  const { state } = ctx.timeline;
  const roomIsActive = () => ctx.timeline.active?.value !== false;
  const candidateIntentCurrent = ctx.intentCurrent;
  let activeIntent: PlaybackIntent | undefined;
  let plan: PlaybackPlan | undefined;
  let planIdentity: PlaybackIdentitySnapshot | undefined;
  let planGenerations = new PlaybackPlanGenerations();
  let playbackRequests: PlaybackRequests | undefined;
  let playbackUser: string | undefined;
  let playbackEpoch: number | undefined;
  let preparing: { intent: PlaybackIntent; key?: string } | undefined;
  const requestOwners = new Map<string, PlaybackIntent>();
  const sessionOwners = new Map<
    string,
    { intent: PlaybackIntent; key: string }
  >();
  function forgetKey(key: string) {
    requestOwners.delete(key);
    for (const [sid, entry] of sessionOwners)
      if (entry.key === key) sessionOwners.delete(sid);
  }
  async function prepareOwned<T>(operation: () => Promise<T>): Promise<T> {
    if (!activeIntent || !candidateIntentCurrent(activeIntent))
      throw new PlaybackCancelled();
    const binding: NonNullable<typeof preparing> = { intent: activeIntent };
    preparing = binding;
    try {
      return await operation();
    } catch (failure) {
      if (
        failure instanceof PlaybackViewerOriginRequired &&
        binding.key &&
        requestOwners.get(binding.key) === binding.intent
      )
        forgetKey(binding.key);
      throw failure;
    } finally {
      if (preparing === binding) preparing = undefined;
    }
  }
  const sessionId = ref<string | null>(null);
  const matchesIdentity = (identity: PlaybackIdentitySnapshot) =>
    viewer.current().epoch === identity.epoch &&
    viewer.current().userId === identity.userId;
  function requireIdentity(identity: PlaybackIdentitySnapshot) {
    if (!matchesIdentity(identity)) throw new StaleIdentity();
  }
  const currentPlan = (value: PlaybackPlan) =>
    plan === value &&
    !!planIdentity &&
    matchesIdentity(planIdentity) &&
    planGenerations.current(value) &&
    (!value.native_platform?.live ||
      (!!state.value && liveRoomMatchesPlan(state.value, value)));
  function requests() {
    const user = viewer.current().userId!;
    const epoch = viewer.current().epoch;
    if (!playbackRequests || playbackUser !== user || playbackEpoch !== epoch) {
      playbackUser = user;
      playbackEpoch = epoch;
      for (const [key, owner] of requestOwners)
        if (owner.user !== user || owner.epoch !== epoch) forgetKey(key);
      const managerIdentity = Object.freeze({ userId: user, epoch });
      playbackRequests = new PlaybackRequests(
        (body, signal) => {
          requireIdentity(managerIdentity);
          const key = body.idempotency_key;
          const owner = key
            ? (requestOwners.get(key) ?? preparing?.intent)
            : preparing?.intent;
          if (!owner || !candidateIntentCurrent(owner))
            throw new PlaybackCancelled();
          // Bind the first emitted key to its intent; retries never borrow
          // source facts from a successor selected before its POST begins.
          if (key && !requestOwners.has(key)) requestOwners.set(key, owner);
          if (key && preparing?.intent === owner) preparing.key = key;
          const provider = owner.nativeProvider;
          if (Object.hasOwn(body, "static_hls_fallback")) {
            const playbackIntent = owner;
            // Lost-response replay keeps the frozen child after parent detach,
            // but a replacement source, input, Stop or logout closes its fence.
            const replay = ctx.retryStaticChild({
              room_id: body.room_id,
              media_id: playbackIntent.mediaId,
              media_generation: body.media_generation,
              viewer_id: body.viewer_id ?? "",
              plan_generation: body.plan_generation ?? 0,
            });
            if (!replay || JSON.stringify(body) !== replay.body)
              throw new PlaybackCancelled();
          }
          if (body.upstream_profile_report) {
            const snapshot = owner.concreteCandidates;
            if (
              !snapshot?.upstream ||
              snapshot.upstream.report.binding !==
                body.upstream_profile_report.binding
            )
              throw new PlaybackCancelled();
            checkCandidateLifetime(snapshot);
          }
          if (body.local_hls_ladder) {
            const playbackIntent = owner,
              snapshot = playbackIntent.concreteCandidates;
            if (
              !snapshot?.concrete ||
              !sameLocalHlsLadderRequest(
                playbackIntent.ladder,
                body.local_hls_ladder,
              ) ||
              snapshot.report?.binding !== body.candidate_report?.binding
            )
              throw new PlaybackCancelled();
            checkCandidateLifetime(snapshot);
          }
          if (body.advanced_playback) {
            const playbackIntent = owner;
            const snapshot = playbackIntent.concreteCandidates;
            if (
              !snapshot?.concrete ||
              !sameAdvancedPlaybackRequest(
                playbackIntent.advanced,
                body.advanced_playback,
              ) ||
              snapshot.report?.binding !== body.candidate_report?.binding
            )
              throw new PlaybackCancelled();
            checkCandidateLifetime(snapshot);
          }
          return api<PlaybackPlan>(
            body.distributed_compute
              ? "/playback-sessions/distributed-compute"
              : body.native_platform
                ? body.native_platform.compatibility
                  ? "/playback-sessions/native-platform-compatibility"
                  : "/playback-sessions/native-platform"
                : body.local_hls_ladder
                  ? "/playback-sessions/local-hls-ladder"
                  : body.advanced_playback
                    ? "/playback-sessions/advanced-local"
                    : body.upstream_profile_report
                      ? "/playback-sessions/upstream-profile"
                      : body.http_file_fallback
                        ? "/playback-sessions/http-file-continuation"
                        : "/playback-sessions",
            "POST",
            body.upstream_profile_report ? structuredClone(body) : body,
            signal,
          ).then((result) => {
            // Check before readiness arithmetic, subtitle binding, seeking or
            // observations can consume an unproven/nonfinite scalar origin.
            if (
              body.native_platform
                ? !provider ||
                  !validNativePlatformPlan(
                    body,
                    result,
                    ctx.origin(),
                    provider,
                    state.value?.live?.broadcast_id,
                    owner.nativeCourse === true,
                  )
                : !!result.native_platform ||
                  result.transport === "dash" ||
                  !hasUsablePlaybackTimeline(result)
            )
              throw new RequestFailure({
                error: { code: "UNSUPPORTED_TIMELINE" },
              });
            if (!matchesDistributedPlaybackPlan(body, result))
              throw new RequestFailure({
                error: { code: "STALE_CAPABILITY_REPORT" },
              });
            if (
              !matchesLocalHlsLadderPlan(
                body.local_hls_ladder,
                result,
                ctx.origin(),
                owner.concreteCandidates?.concrete?.candidates.local_hls_ladder,
              )
            )
              throw new RequestFailure({
                error: { code: "STALE_CAPABILITY_REPORT" },
              });
            if (!matchesAdvancedPlaybackPlan(body.advanced_playback, result))
              throw new RequestFailure({
                error: { code: "STALE_CAPABILITY_REPORT" },
              });
            const owned =
              key &&
              requestOwners.get(key) === owner &&
              matchesIdentity(managerIdentity) &&
              matchesPlanGeneration(
                body.plan_generation,
                result.plan_generation,
              );
            if (owned)
              sessionOwners.set(result.session_id, { intent: owner, key });
            if (
              owned &&
              !signal.aborted &&
              roomIsActive() &&
              activeIntent === owner &&
              candidateIntentCurrent(owner) &&
              result.plan_generation !== undefined
            )
              ctx.prepared(result);
            return result;
          });
        },
        (key, signal) => {
          requireIdentity(managerIdentity);
          return api(
            "/playback-requests/" + key,
            "DELETE",
            undefined,
            signal,
          ).then((receipt) => {
            forgetKey(key);
            return receipt;
          });
        },
        ctx.storage(),
        `rainsync:playback:${user}`,
        (...args) => readReadinessFor(managerIdentity, ...args),
        () => (state.value?.playback_status === "playing" ? 4000 : 0),
      );
    }
    return playbackRequests;
  }
  async function readReadinessFor(
    identity: PlaybackIdentitySnapshot,
    id: string,
    signal: AbortSignal,
    relativePosition = 0,
    planGeneration?: number,
    currentRelativePosition?: () => number,
  ): Promise<PlaybackReadiness> {
    requireIdentity(identity);
    const owner = sessionOwners.get(id)?.intent;
    if (!owner || !candidateIntentCurrent(owner)) throw new PlaybackCancelled();
    let readiness = await api<PlaybackReadiness>(
      `/playback-sessions/${id}?relative_position_ms=${encodeURIComponent(relativePosition)}${planGeneration === undefined ? "" : `&plan_generation=${planGeneration}`}`,
      "GET",
      undefined,
      signal,
    );
    requireIdentity(identity);
    if (!candidateIntentCurrent(owner)) throw new PlaybackCancelled();
    if (
      readiness.session_id !== id ||
      !matchesPlanGeneration(planGeneration, readiness.plan_generation)
    )
      throw new RequestFailure({ error: { code: "STALE_PLAYBACK_PLAN" } });
    // A running EVENT prefix needs one whole segment ahead of the room clock.
    // Network time can consume that lead. Recheck the current target after the
    // response, not only the position sent in the request. Complete/legacy
    // responses and a paused room still need no forward lead.
    if (
      state.value?.playback_status === "playing" &&
      readiness.status === "ready" &&
      readiness.complete === false &&
      readiness.available_until_ms != null &&
      Number.isFinite(readiness.available_until_ms) &&
      readiness.available_until_ms -
        (currentRelativePosition?.() ?? relativePosition) <
        4_000
    ) {
      readiness = { ...readiness, status: "preparing" };
    }
    if (
      !signal.aborted &&
      roomIsActive() &&
      activeIntent === owner &&
      matchesIdentity(identity)
    )
      ctx.readiness(readiness);
    return readiness;
  }

  function captureSessionStop(
    value: PlaybackPlan,
    identity: PlaybackIdentitySnapshot,
  ) {
    const sessionId = value.session_id;
    const owner = Object.freeze({ ...identity });
    return async (finalObservation?: unknown) => {
      requireIdentity(owner);
      return api(
        `/playback-sessions/${sessionId}`,
        "DELETE",
        finalObservation,
        AbortSignal.timeout(5000),
      );
    };
  }
  function retirePlan() {
    const old = plan;
    const identity = planIdentity;
    plan = undefined;
    planIdentity = undefined;
    sessionId.value = null;
    return old && identity
      ? { plan: old, stop: captureSessionStop(old, identity) }
      : undefined;
  }
  return {
    sessionId: readonly(sessionId),
    intent: () => activeIntent,
    plan: () => plan,
    adoptIntent(value: PlaybackIntent) {
      activeIntent = value;
    },
    clearIntent() {
      activeIntent = undefined;
      preparing = undefined;
    },
    nextPlan: () => planGenerations.next(),
    nextPlanWhen: (...args: Parameters<PlaybackPlanGenerations["nextWhen"]>) =>
      planGenerations.nextWhen(...args),
    planGenerationCurrent: (value: PlaybackPlan) =>
      planGenerations.current(value),
    rotateViewerOrigin(failure: unknown, intent: PlaybackIntent) {
      if (
        !(failure instanceof PlaybackViewerOriginRequired) ||
        plan ||
        activeIntent !== intent ||
        intent.originRecoveryUsed ||
        !candidateIntentCurrent(intent)
      )
        return false;
      intent.originRecoveryUsed = true;
      planGenerations = new PlaybackPlanGenerations();
      return true;
    },
    currentPlan,
    adoptPlan(value: PlaybackPlan, intent: PlaybackIntent) {
      if (
        activeIntent !== intent ||
        sessionOwners.get(value.session_id)?.intent !== intent ||
        !candidateIntentCurrent(intent) ||
        !planGenerations.current(value)
      )
        throw new PlaybackCancelled();
      planIdentity = Object.freeze({
        userId: intent.user,
        epoch: intent.epoch,
      });
      requireIdentity(planIdentity);
      plan = value;
    },
    publishSession(value: PlaybackPlan) {
      if (currentPlan(value)) sessionId.value = value.session_id;
    },
    retirePlan,
    captureSessionStop,
    captureRequests() {
      const manager = playbackRequests;
      return manager ? { stop: manager.stop.bind(manager) } : undefined;
    },
    allocateIdempotencyKey: () => requests().allocateIdempotencyKey(),
    prepare: (...args: Parameters<PlaybackRequests["prepare"]>) =>
      prepareOwned(() => requests().prepare(...args)),
    prepareContinuation: (
      ...args: Parameters<PlaybackRequests["prepareContinuation"]>
    ) => prepareOwned(() => requests().prepareContinuation(...args)),
    prepareStaticHlsChild: (
      ...args: Parameters<PlaybackRequests["prepareStaticHlsChild"]>
    ) => prepareOwned(() => requests().prepareStaticHlsChild(...args)),
    stop: (beforeCleanup?: () => Promise<void>) =>
      requests().stop(beforeCleanup),
    readReadiness(
      ...args: [
        id: string,
        signal: AbortSignal,
        relativePosition?: number,
        planGeneration?: number,
        currentRelativePosition?: () => number,
      ]
    ) {
      if (!plan || !planIdentity || plan.session_id !== args[0])
        throw new PlaybackCancelled();
      return readReadinessFor(planIdentity, ...args);
    },
    startMaintenance(
      effects: Pick<
        Parameters<typeof createPlaybackMaintenance>[0],
        | "tick"
        | "observe"
        | "sample"
        | "visibilityChanged"
        | "reload"
        | "expired"
      >,
    ) {
      return createPlaybackMaintenance({
        ...effects,
        plan: () => plan,
        active: roomIsActive,
        currentPlan,
        epoch: () => viewer.current().epoch,
        renew: async (current) => {
          // currentPlan checks the captured exact-login identity synchronously.
          if (!currentPlan(current) || current.native_platform)
            throw new PlaybackCancelled();
          return api(`/playback-sessions/${current.session_id}`, "POST");
        },
      });
    },
  };
}
