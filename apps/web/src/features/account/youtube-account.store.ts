import { ref } from "vue";
import type { useSession } from "../auth/session.store";
import { StaleIdentity } from "../../shared/api/client";
import {
  youtubePlatformAccountApi,
  type YoutubePlatformAccountStatus,
} from "./platform-account.api";
import { validateYoutubeAccountStatus } from "./youtube-account-flow";

export function createYoutubeAccountStore(
  session: ReturnType<typeof useSession>,
) {
  const status = ref<YoutubePlatformAccountStatus>(),
    change = ref(0);
  let serial = 0,
    controller = new AbortController(),
    pending: Promise<YoutubePlatformAccountStatus> | undefined,
    mutation: Promise<YoutubePlatformAccountStatus> | undefined;
  const api = youtubePlatformAccountApi(session.api);
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
  function retire() {
    ++serial;
    controller.abort();
    controller = new AbortController();
    pending = mutation = undefined;
  }
  function reset() {
    retire();
    status.value = undefined;
    ++change.value;
  }
  function refresh(force = false): Promise<YoutubePlatformAccountStatus> {
    if (mutation) {
      const epoch = session.epoch;
      return mutation
        .catch(() => undefined)
        .then(() => {
          if (session.epoch !== epoch) throw new StaleIdentity();
          return refresh(force);
        });
    }
    if (pending) return pending;
    if (!force && status.value) return Promise.resolve(status.value);
    const epoch = session.epoch,
      generation = serial,
      signal = controller.signal;
    const request = api
      .status(signal)
      .then((value) => {
        if (epoch !== session.epoch || generation !== serial || signal.aborted)
          throw new StaleIdentity();
        return accept(value);
      })
      .finally(() => {
        if (pending === request) pending = undefined;
      });
    pending = request;
    return request;
  }
  function mutate(
    expectedRevision: string | null,
    action: (signal: AbortSignal) => Promise<YoutubePlatformAccountStatus>,
    external?: AbortSignal,
  ) {
    if (mutation)
      return Promise.reject(Error("YouTube 会话操作尚未确认，请刷新状态"));
    if (!status.value || status.value.revision !== expectedRevision)
      return Promise.reject(new StaleIdentity());
    retire();
    const epoch = session.epoch,
      generation = serial,
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(20000),
        ...(external ? [external] : []),
      ]);
    const request = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action(signal);
      })
      .then((value) => {
        if (epoch !== session.epoch || generation !== serial || signal.aborted)
          throw new StaleIdentity();
        return accept(value);
      })
      .finally(() => {
        if (mutation === request) mutation = undefined;
      });
    mutation = request;
    return request;
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
