import { computed, ref, onScopeDispose, watch, type Ref } from "vue";
import { createPlaybackRuntime } from "../features/playback/playback-runtime";
import type {
  PlaybackIdentityPort,
  PlaybackIdentitySnapshot,
  PlaybackRuntimeContext,
} from "../features/playback/playback-runtime-types";
import type { RuntimeErrorNotice } from "../features/playback/room-notice";

/** Adapt the exact-login epoch without exposing account/session mutation. */
export function createPlaybackIdentityPort(
  read: () => PlaybackIdentitySnapshot,
  invalidate: PlaybackIdentityPort["invalidate"],
): PlaybackIdentityPort {
  return {
    current: () => Object.freeze(read()),
    invalidate,
    // Session changes advance epoch synchronously, before changing user fields.
    // Watching that authority avoids a second cleanup for the same login change.
    subscribeInvalidation: (listener) =>
      watch(() => read().epoch, listener, { flush: "sync" }),
  };
}

/** Compose the playback owner with the room's compatibility presentation. */
export function createViewingRuntime(
  context: PlaybackRuntimeContext,
  room: {
    error: Ref<string>;
    busy: Readonly<Ref<boolean>>;
    identityInvalidated: () => void;
  },
) {
  const playback = createPlaybackRuntime(context);
  const stopIdentity = context.identity.subscribeInvalidation(
    room.identityInvalidated,
  );
  onScopeDispose(stopIdentity);

  let revision = 0;
  const roomRevision = refRevision(room.error);
  const playbackRevision = refRevision(playback.playbackError);
  function refRevision(value: Ref<string>) {
    const version = ref(0);
    watch(
      value,
      () => {
        version.value = ++revision;
      },
      { flush: "sync" },
    );
    return version;
  }
  const errorNotice = computed<RuntimeErrorNotice | undefined>(() => {
    const roomMessage = room.error.value,
      playbackMessage = playback.playbackError.value;
    if (!roomMessage && !playbackMessage) return;
    const owner =
      playbackMessage &&
      (!roomMessage || playbackRevision.value > roomRevision.value)
        ? "playback"
        : "room";
    return Object.freeze({
      owner,
      revision: owner === "room" ? roomRevision.value : playbackRevision.value,
      message: owner === "room" ? roomMessage : playbackMessage,
    });
  });
  function dismissError(notice: RuntimeErrorNotice | undefined) {
    const current = errorNotice.value;
    if (
      !notice ||
      !current ||
      notice.owner !== current.owner ||
      notice.revision !== current.revision ||
      notice.message !== current.message
    )
      return;
    if (notice.owner === "room") room.error.value = "";
    else playback.playbackError.value = "";
  }
  const error = computed({
    get: () => errorNotice.value?.message ?? "",
    set: (message: string) => {
      if (message) room.error.value = message;
      else dismissError(errorNotice.value);
    },
  });
  const busy = computed(() => room.busy.value || playback.playbackBusy.value);
  return { playback, error, busy, errorNotice, dismissError };
}
