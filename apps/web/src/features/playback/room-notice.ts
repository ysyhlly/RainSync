import { computed, watch, type Ref } from "vue";
import {
  playbackFailureOwnsNotice,
  type PlaybackPreparationState,
} from "./playback-preparation";

export type RuntimeErrorNotice = Readonly<{
  owner: "room" | "playback";
  revision: number;
  message: string;
}>;
type RoomNoticeRuntime = {
  error: string;
  errorNotice?: RuntimeErrorNotice;
  dismissError?: (notice: RuntimeErrorNotice | undefined) => void;
  preparation?: PlaybackPreparationState;
};

/** One presentation of the current error, not a new error store or queue. */
export function useRoomNotice(
  runtime: RoomNoticeRuntime,
  actionError?: Ref<string>,
) {
  let runtimeRevision = 0;
  let actionRevision = 0;
  watch(
    () => runtime.errorNotice ?? runtime.error,
    () => ++runtimeRevision,
    { flush: "sync" },
  );
  if (actionError)
    watch(actionError, () => ++actionRevision, { flush: "sync" });

  return computed(() => {
    const source = actionError?.value ? "action" : "runtime";
    const message = source === "action" ? actionError!.value : runtime.error;
    if (!message) return;
    if (
      source === "runtime" &&
      (!runtime.errorNotice || runtime.errorNotice.owner === "playback") &&
      runtime.preparation?.phase === "failed" &&
      playbackFailureOwnsNotice(runtime.preparation.failure, message)
    )
      return;

    const revision = source === "action" ? actionRevision : runtimeRevision;
    const runtimeNotice = runtime.errorNotice;
    return {
      source,
      message,
      key: `${source}:${revision}`,
      // Bind this snapshot's callback in the rendered notice. A stale close
      // must neither clear a newer message nor the other, currently hidden source.
      dismiss() {
        if (source === "action") {
          if (actionRevision === revision && actionError?.value === message)
            actionError.value = "";
        } else if (runtimeRevision === revision && runtime.error === message) {
          if (runtime.dismissError) runtime.dismissError(runtimeNotice);
          else runtime.error = "";
        }
      },
    };
  });
}
