import { shallowRef } from "vue";
import type { RuntimeErrorNotice } from "../../apps/web/src/features/playback/room-notice";

/** A single mock owner with occurrence snapshots, never a global close shim. */
export function withNoticeOwner<T extends { error: string }>(
  runtime: T,
  owner: RuntimeErrorNotice["owner"] = "playback",
): T & {
  readonly errorNotice: RuntimeErrorNotice | undefined;
  dismissError: (notice: RuntimeErrorNotice | undefined) => void;
} {
  let message = runtime.error, revision = 0;
  const snapshot = shallowRef<RuntimeErrorNotice | undefined>(
    message ? Object.freeze({ owner, revision, message }) : undefined,
  );
  Object.defineProperty(runtime, "error", {
    configurable: true, enumerable: true,
    get: () => message,
    set(next: string) {
      if (next === message) return;
      message = next;
      ++revision;
      snapshot.value = message ? Object.freeze({ owner, revision, message }) : undefined;
    },
  });
  Object.defineProperty(runtime, "errorNotice", {
    configurable: true, enumerable: true,
    get: () => snapshot.value,
  });
  const dismissError = (notice: RuntimeErrorNotice | undefined) => {
    if (notice?.owner === owner && notice.revision === revision && notice.message === message)
      runtime.error = "";
  };
  return Object.assign(runtime, { dismissError }) as T & {
    readonly errorNotice: RuntimeErrorNotice | undefined;
    dismissError: typeof dismissError;
  };
}
