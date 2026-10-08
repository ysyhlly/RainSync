import { ref } from "vue";
import type { useSession } from "../auth/session.store";
import { StaleIdentity } from "../../shared/api/client";
import {
  youtubePlatformAccountApi,
  type YoutubePlatformAccountStatus,
} from "./platform-account.api";
import { validateYoutubeAccountStatus } from "./youtube-account-flow";
import { createAccountRequestSlot } from "./account-request-slot";

export function createYoutubeAccountStore(
  session: ReturnType<typeof useSession>,
) {
  const status = ref<YoutubePlatformAccountStatus>(),
    change = ref(0);
  const api = youtubePlatformAccountApi(session.api);
  const work = createAccountRequestSlot({
    epoch: () => session.epoch,
    cached: (force) => (force ? undefined : status.value),
    read: api.status,
    accept,
    timeoutMs: 20000,
    busyMessage: "YouTube 会话操作尚未确认，请刷新状态",
  });
  function accept(value: YoutubePlatformAccountStatus) {
    value = validateYoutubeAccountStatus(value);
    const previous = status.value;
    status.value = value;
    if (
      previous &&
      (previous.id !== value.id ||
        previous.revision !== value.revision ||
        previous.state !== value.state ||
        previous.credential_expires_at !== value.credential_expires_at ||
        previous.account_import_available !== value.account_import_available)
    )
      ++change.value;
    return value;
  }
  function reset() {
    work.retire();
    status.value = undefined;
    ++change.value;
  }
  const refresh = work.refresh;
  function mutate(
    expectedRevision: string | null,
    action: (signal: AbortSignal) => Promise<YoutubePlatformAccountStatus>,
    external?: AbortSignal,
  ) {
    return work.mutate(action, accept, external, () => {
      if (!status.value || status.value.revision !== expectedRevision)
        throw new StaleIdentity();
    });
  }
  const importCredential = (
    secret: string,
    expected: string | null,
    signal?: AbortSignal,
  ) =>
    mutate(
      expected,
      (combined) => api.importCredential(secret, expected, combined),
      signal,
    );
  const unlink = (expected: string | null) =>
    mutate(expected, (signal) => api.unlink(expected, signal));
  return { status, change, refresh, importCredential, unlink, reset };
}
