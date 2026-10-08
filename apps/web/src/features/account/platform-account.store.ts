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
import { createAccountRequestSlot } from "./account-request-slot";
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
  const api = platformAccountApi(session.api);
  const youtube = createYoutubeAccountStore(session);
  const biliWork = createAccountRequestSlot({
    epoch: () => session.epoch,
    cached: (force) => (force ? undefined : status.value),
    read: api.status,
    accept,
    timeoutMs: 30000,
    busyMessage: "平台账号操作尚未确认，请稍后刷新状态",
  });
  const shortWork = {
    douyin: createShortWork("douyin"),
    tiktok: createShortWork("tiktok"),
  };
  function createShortWork(provider: ShortPlatformProvider) {
    return createAccountRequestSlot({
      epoch: () => session.epoch,
      cached: () => shortStatuses.value[provider],
      read: (signal) =>
        shortPlatformAccountApi(session.api, provider).status(signal),
      accept: (value) => acceptShort(provider, value),
      timeoutMs: 20000,
      busyMessage: "平台账号操作尚未确认，请稍后刷新状态",
    });
  }
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
  const refresh = biliWork.refresh;
  function unlink() {
    return biliWork.mutate(api.unlink, accept);
  }
  function checkLogin(external?: AbortSignal) {
    const observed = status.value;
    if (!observed) return Promise.reject(new StaleIdentity());
    return biliWork.mutate(
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
  function refreshShort(
    provider: ShortPlatformProvider,
    force = false,
  ): Promise<ShortPlatformAccountStatus> {
    return shortWork[provider].refresh(force);
  }
  function mutateShort(
    provider: ShortPlatformProvider,
    expectedRevision: string | null,
    action: (signal: AbortSignal) => Promise<ShortPlatformAccountStatus>,
    external?: AbortSignal,
  ) {
    return shortWork[provider].mutate(
      action,
      (value) => acceptShort(provider, value),
      external,
      () => {
        const cached = shortStatuses.value[provider];
        if (!cached || cached.revision !== expectedRevision)
          throw new StaleIdentity();
      },
    );
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
      biliWork.retire();
      status.value = undefined;
      lastCheck.value = undefined;
      ++change.value;
      shortWork.douyin.retire();
      shortWork.tiktok.retire();
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
