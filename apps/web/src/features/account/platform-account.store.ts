import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useSession } from "../auth/session.store";
import { StaleIdentity } from "../../shared/api/client";
import {
  platformAccountApi,
  shortPlatformAccountApi,
  type PlatformAccountStatus,
  type PlatformAccountCheck,
  type ShortPlatformAccountStatus,
  type ShortPlatformProvider,
} from "./platform-account.api";
import { validateShortAccountStatus } from "./short-account-flow";
import {
  validatePlatformAccountStatus,
  validatePlatformAccountCheck,
} from "./platform-account-check";
import { createYoutubeAccountStore } from "./youtube-account.store";
export const usePlatformAccount = defineStore("platform-account", () => {
  const session = useSession(),
    status = ref<PlatformAccountStatus>(),
    lastCheck = ref<PlatformAccountCheck>(),
    change = ref(0);
  const shortStatuses = ref<
      Partial<Record<ShortPlatformProvider, ShortPlatformAccountStatus>>
    >({}),
    shortChanges = ref<Record<ShortPlatformProvider, number>>({
      douyin: 0,
      tiktok: 0,
    });
  const shortWork: Record<
    ShortPlatformProvider,
    {
      serial: number;
      controller: AbortController;
      pending?: Promise<ShortPlatformAccountStatus>;
      mutation?: Promise<ShortPlatformAccountStatus>;
    }
  > = {
    douyin: { serial: 0, controller: new AbortController() },
    tiktok: { serial: 0, controller: new AbortController() },
  };
  let pending: Promise<PlatformAccountStatus> | undefined,
    mutation: Promise<PlatformAccountStatus | PlatformAccountCheck> | undefined,
    controller = new AbortController(),
    serial = 0;
  const api = platformAccountApi(session.api);
  const youtube = createYoutubeAccountStore(session);
  function accept(value: PlatformAccountStatus) {
    value = validatePlatformAccountStatus(value);
    const old = status.value;
    status.value = value;
    if (
      old &&
      (old.id !== value.id ||
        old.revision !== value.revision ||
        old.state !== value.state)
    ) {
      lastCheck.value = undefined;
      ++change.value;
    }
    return value;
  }
  function refresh(force = false): Promise<PlatformAccountStatus> {
    if (mutation) {
      const epoch = session.epoch;
      return mutation
        .catch(() => undefined)
        .then(() => {
          if (epoch !== session.epoch) throw new StaleIdentity();
          return refresh(force);
        });
    }
    if (pending) return pending;
    if (!force && status.value) return Promise.resolve(status.value);
    const epoch = session.epoch,
      generation = serial,
      signal = controller.signal;
    const work = api
      .status(signal)
      .then((value) => {
        if (epoch !== session.epoch || generation !== serial || signal.aborted)
          throw new StaleIdentity();
        return accept(value);
      })
      .finally(() => {
        if (pending === work) pending = undefined;
      });
    pending = work;
    return work;
  }
  function mutateBili<T extends PlatformAccountStatus | PlatformAccountCheck>(
    action: (signal: AbortSignal) => Promise<T>,
    publish: (value: T) => T,
    external?: AbortSignal,
  ): Promise<T> {
    if (mutation)
      return Promise.reject(Error("平台账号操作尚未确认，请稍后刷新状态"));
    ++serial;
    controller.abort();
    controller = new AbortController();
    pending = undefined;
    const epoch = session.epoch,
      generation = serial,
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(30000),
        ...(external ? [external] : []),
      ]);
    const request = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action(signal);
      })
      .then((value) => {
        if (session.epoch !== epoch || generation !== serial || signal.aborted)
          throw new StaleIdentity();
        return publish(value);
      })
      .finally(() => {
        if (mutation === request) mutation = undefined;
      });
    mutation = request;
    return request;
  }
  function unlink() {
    return mutateBili(api.unlink, accept);
  }
  function checkLogin(external?: AbortSignal) {
    const observed = status.value;
    if (!observed) return Promise.reject(new StaleIdentity());
    return mutateBili(
      (signal) => api.check(observed.revision, signal),
      (value) => {
        value = validatePlatformAccountCheck(value);
        if (
          value.account.id !== observed.id ||
          (value.verification !== "invalid" &&
            value.verification !== "none" &&
            value.account.revision !== observed.revision)
        )
          throw new StaleIdentity();
        if (
          value.verification === "invalid" &&
          (observed.revision === null ||
            value.account.revision !==
              (BigInt(observed.revision) + 1n).toString())
        )
          throw new StaleIdentity();
        accept(value.account);
        lastCheck.value = value;
        return value;
      },
      external,
    );
  }
  function acceptShort(
    provider: ShortPlatformProvider,
    value: ShortPlatformAccountStatus,
  ) {
    value = validateShortAccountStatus(value, provider);
    const previous = shortStatuses.value[provider];
    shortStatuses.value = { ...shortStatuses.value, [provider]: value };
    if (
      previous &&
      (previous.id !== value.id ||
        previous.revision !== value.revision ||
        previous.state !== value.state ||
        previous.credential_expires_at !== value.credential_expires_at)
    )
      shortChanges.value = {
        ...shortChanges.value,
        [provider]: shortChanges.value[provider] + 1,
      };
    return value;
  }
  function retireShort(provider: ShortPlatformProvider) {
    const work = shortWork[provider];
    ++work.serial;
    work.controller.abort();
    work.controller = new AbortController();
    work.pending = undefined;
    work.mutation = undefined;
    return work;
  }
  function refreshShort(
    provider: ShortPlatformProvider,
    force = false,
  ): Promise<ShortPlatformAccountStatus> {
    const work = shortWork[provider];
    if (work.mutation) {
      const epoch = session.epoch;
      return work.mutation
        .catch(() => undefined)
        .then(() => {
          if (epoch !== session.epoch) throw new StaleIdentity();
          return refreshShort(provider, force);
        });
    }
    if (work.pending) return work.pending;
    const cached = shortStatuses.value[provider];
    if (!force && cached) return Promise.resolve(cached);
    const epoch = session.epoch,
      serial = work.serial,
      signal = work.controller.signal;
    const request = shortPlatformAccountApi(session.api, provider)
      .status(signal)
      .then((value) => {
        if (session.epoch !== epoch || work.serial !== serial || signal.aborted)
          throw new StaleIdentity();
        return acceptShort(provider, value);
      })
      .finally(() => {
        if (work.pending === request) work.pending = undefined;
      });
    work.pending = request;
    return request;
  }
  function mutateShort(
    provider: ShortPlatformProvider,
    expectedRevision: string | null,
    action: (signal: AbortSignal) => Promise<ShortPlatformAccountStatus>,
    external?: AbortSignal,
  ) {
    if (shortWork[provider].mutation)
      return Promise.reject(Error("平台账号操作尚未确认，请稍后刷新状态"));
    const cached = shortStatuses.value[provider];
    if (!cached || cached.revision !== expectedRevision)
      return Promise.reject(new StaleIdentity());
    const work = retireShort(provider),
      epoch = session.epoch,
      serial = work.serial;
    const signal = AbortSignal.any([
      work.controller.signal,
      AbortSignal.timeout(20000),
      ...(external ? [external] : []),
    ]);
    const request = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action(signal);
      })
      .then((value) => {
        if (session.epoch !== epoch || work.serial !== serial || signal.aborted)
          throw new StaleIdentity();
        return acceptShort(provider, value);
      })
      .finally(() => {
        if (work.mutation === request) work.mutation = undefined;
      });
    work.mutation = request;
    return request;
  }
  function importShort(
    provider: ShortPlatformProvider,
    cookie: string,
    expectedRevision: string | null,
    signal?: AbortSignal,
  ) {
    return mutateShort(
      provider,
      expectedRevision,
      (combined) =>
        shortPlatformAccountApi(session.api, provider).importCredential(
          cookie,
          expectedRevision,
          combined,
        ),
      signal,
    );
  }
  function unlinkShort(
    provider: ShortPlatformProvider,
    expectedRevision: string | null,
  ) {
    return mutateShort(provider, expectedRevision, (signal) =>
      shortPlatformAccountApi(session.api, provider).unlink(
        expectedRevision,
        signal,
      ),
    );
  }
  watch(
    [() => session.epoch, () => session.user?.id, () => session.user?.csrf],
    () => {
      controller.abort();
      controller = new AbortController();
      ++serial;
      pending = undefined;
      mutation = undefined;
      status.value = undefined;
      lastCheck.value = undefined;
      ++change.value;
      retireShort("douyin");
      retireShort("tiktok");
      shortStatuses.value = {};
      youtube.reset();
      shortChanges.value = {
        douyin: shortChanges.value.douyin + 1,
        tiktok: shortChanges.value.tiktok + 1,
      };
    },
    { flush: "sync" },
  );
  return {
    status,
    lastCheck,
    change,
    refresh,
    unlink,
    checkLogin,
    shortStatuses,
    shortChanges,
    refreshShort,
    importShort,
    unlinkShort,
    youtubeStatus: youtube.status,
    youtubeChange: youtube.change,
    refreshYoutube: youtube.refresh,
    importYoutube: youtube.importCredential,
    unlinkYoutube: youtube.unlink,
  };
});
