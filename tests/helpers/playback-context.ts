import type { Ref } from "vue";
import { createPlaybackIdentityPort } from "../../apps/web/src/app/viewing-runtime";
import type { ApiClient } from "../../apps/web/src/shared/api/client";
import type {
  PlaybackRuntimeContext,
  RoomTimelinePort,
} from "../../apps/web/src/features/playback/playback-runtime-types";

/** Adapt controlled test inputs to the same finite ports used by the app. */
export function playbackTestContext(
  input: Omit<
    PlaybackRuntimeContext,
    "identity" | "api" | "timeline" | "commands"
  > & {
    session: {
      user?: { id: string } | null;
      epoch: number;
      api: ApiClient;
      invalidate?: PlaybackRuntimeContext["identity"]["invalidate"];
    };
    state: RoomTimelinePort["state"];
    connected: Readonly<Ref<boolean>>;
    active?: Readonly<Ref<boolean>>;
    clock: RoomTimelinePort["clock"];
    checkClock?: () => void;
    ended?: (position: number) => void;
  },
): PlaybackRuntimeContext {
  const {
    session,
    state,
    connected,
    active,
    clock,
    checkClock,
    ended,
    ...options
  } = input;
  return {
    ...options,
    identity: createPlaybackIdentityPort(
      () => ({ userId: session.user?.id, epoch: session.epoch }),
      (failure) => session.invalidate?.(failure),
    ),
    api: <T>(...args: Parameters<ApiClient>) => session.api<T>(...args),
    timeline: { state, connected, active, clock, checkClock },
    commands: { ended },
  };
}
