/** Compile with tests/tsconfig.response-boundaries.json; Vitest alone does not check types. */
import type { ApiClient } from "../../apps/web/src/shared/api/client";
import {
  platformAccountApi,
  shortPlatformAccountApi,
  youtubePlatformAccountApi,
  type PlatformAccountStatus,
  type PlatformAccountCheck,
  type PlatformLogin,
  type ShortPlatformAccountStatus,
  type YoutubePlatformAccountStatus,
} from "../../apps/web/src/features/account/platform-account.api";
import { usePlatformAccount } from "../../apps/web/src/features/account/platform-account.store";
import {
  validatePlatformAccountStatus,
  validatePlatformAccountCheck,
} from "../../apps/web/src/features/account/platform-account-check";
import {
  validateShortAccountStatus,
  createShortAccountFlow,
} from "../../apps/web/src/features/account/short-account-flow";
import {
  validateYoutubeAccountStatus,
  createYoutubeAccountFlow,
} from "../../apps/web/src/features/account/youtube-account-flow";
import {
  checkedSettings,
  type AdminSettingsSnapshot,
} from "../../apps/web/src/features/admin/admin-settings";

import {
  bilibiliRenewalApi,
  validateBilibiliRenewal,
  type BilibiliRenewalStatus,
} from "../../apps/web/src/features/account/platform-renewal.api";
import {
  platformOAuthApi,
  type OAuthStatus,
  type OAuthLogin,
} from "../../apps/web/src/features/account/platform-oauth.api";
import {
  validateOAuthStatus,
  validateOAuthLogin,
  createOAuthFlow,
} from "../../apps/web/src/features/account/platform-oauth-flow";
import { createPlatformLoginFlow } from "../../apps/web/src/features/account/platform-login-flow";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type Bili = ReturnType<typeof platformAccountApi>;
type Short = ReturnType<typeof shortPlatformAccountApi>;
type Youtube = ReturnType<typeof youtubePlatformAccountApi>;
type Store = ReturnType<typeof usePlatformAccount>;
type Renewal = ReturnType<typeof bilibiliRenewalApi>;
type OAuth = ReturnType<typeof platformOAuthApi>;
type Result<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;
export type UnknownTransportReceipts = [
  Assert<Equal<Result<Bili["start"]>, unknown>>,
  Assert<Equal<Result<Bili["poll"]>, unknown>>,
  Assert<Equal<Result<Bili["cancel"]>, unknown>>,
  Assert<Equal<Result<Renewal["status"]>, unknown>>,
  Assert<Equal<Result<Renewal["disable"]>, unknown>>,
  Assert<Equal<Result<OAuth["status"]>, unknown>>,
  Assert<Equal<Result<OAuth["start"]>, unknown>>,
  Assert<Equal<Result<OAuth["read"]>, unknown>>,
  Assert<Equal<Result<OAuth["poll"]>, unknown>>,
  Assert<Equal<Result<OAuth["cancel"]>, unknown>>,
  Assert<Equal<Result<OAuth["disableRenewal"]>, unknown>>,
  Assert<Equal<Result<OAuth["unlink"]>, unknown>>,
  Assert<Equal<Result<Bili["status"]>, unknown>>,
  Assert<Equal<Result<Bili["check"]>, unknown>>,
  Assert<Equal<Result<Bili["unlink"]>, unknown>>,
  Assert<Equal<Result<Short["status"]>, unknown>>,
  Assert<Equal<Result<Short["importCredential"]>, unknown>>,
  Assert<Equal<Result<Short["unlink"]>, unknown>>,
  Assert<Equal<Result<Youtube["status"]>, unknown>>,
  Assert<Equal<Result<Youtube["importCredential"]>, unknown>>,
  Assert<Equal<Result<Youtube["unlink"]>, unknown>>,
];
export type ParsedStoreReceipts = [
  Assert<Equal<Result<Store["refresh"]>, PlatformAccountStatus>>,
  Assert<Equal<Result<Store["unlink"]>, PlatformAccountStatus>>,
  Assert<Equal<Result<Store["checkLogin"]>, PlatformAccountCheck>>,
  Assert<Equal<Result<Store["refreshShort"]>, ShortPlatformAccountStatus>>,
  Assert<Equal<Result<Store["importShort"]>, ShortPlatformAccountStatus>>,
  Assert<Equal<Result<Store["unlinkShort"]>, ShortPlatformAccountStatus>>,
  Assert<Equal<Result<Store["refreshYoutube"]>, YoutubePlatformAccountStatus>>,
  Assert<Equal<Result<Store["importYoutube"]>, YoutubePlatformAccountStatus>>,
  Assert<Equal<Result<Store["unlinkYoutube"]>, YoutubePlatformAccountStatus>>,
];
export async function checkedConsumers(api: ApiClient, raw: unknown) {
  const status: PlatformAccountStatus = validatePlatformAccountStatus(raw);
  const check: PlatformAccountCheck = validatePlatformAccountCheck(raw);
  const short: ShortPlatformAccountStatus = validateShortAccountStatus(
    raw,
    "douyin",
  );
  const youtube: YoutubePlatformAccountStatus =
    validateYoutubeAccountStatus(raw);
  const settings: AdminSettingsSnapshot = checkedSettings(raw);
  // @ts-expect-error A successful transport response is not a validated DTO.
  const unchecked: PlatformAccountStatus =
    await platformAccountApi(api).status();
  // @ts-expect-error Check data must pass its complete existing parser.
  const uncheckedCheck: PlatformAccountCheck =
    await platformAccountApi(api).check(null);
  // @ts-expect-error Credential mutation receipts are not trusted because PUT succeeded.
  const uncheckedShort: ShortPlatformAccountStatus =
    await shortPlatformAccountApi(api, "douyin").importCredential(
      "synthetic",
      null,
    );
  // @ts-expect-error YouTube also requires its own parser, including availability fields.
  const uncheckedYoutube: YoutubePlatformAccountStatus =
    await youtubePlatformAccountApi(api).unlink(null);
  // @ts-expect-error Admin receipts need checkedSettings before access to their revision.
  const uncheckedSettings: AdminSettingsSnapshot =
    await api<unknown>("/admin/settings");
  createShortAccountFlow({
    provider: "douyin",
    current: () => true,
    submit: async () => raw,
    clearSecret() {},
    change() {},
  });
  createYoutubeAccountFlow({
    current: () => true,
    submit: async () => raw,
    clearSecret() {},
    change() {},
  });
  return {
    status,
    check,
    short,
    youtube,
    settings,
    unchecked,
    uncheckedCheck,
    uncheckedShort,
    uncheckedYoutube,
    uncheckedSettings,
  };
}

/** This function is typechecked, never executed: no requests or authorization occur. */
export async function checkedAdditionalConsumers(api: ApiClient, raw: unknown) {
  const renewal: BilibiliRenewalStatus = validateBilibiliRenewal(raw);
  const status: OAuthStatus = validateOAuthStatus(raw, "douyin");
  const login: OAuthLogin = validateOAuthLogin(
    raw,
    "douyin",
    "00000000-0000-4000-8000-000000000001",
  );
  // @ts-expect-error Raw qrStart receipt is not a validated DTO.
  const qrStart: PlatformLogin =
    await platformAccountApi(api).start("synthetic");
  // @ts-expect-error Raw qrPoll receipt is not a validated DTO.
  const qrPoll: PlatformLogin = await platformAccountApi(api).poll("synthetic");
  // @ts-expect-error Raw qrCancel receipt is not a validated DTO.
  const qrCancel: PlatformLogin =
    await platformAccountApi(api).cancel("synthetic");
  // @ts-expect-error Raw renewalStatus receipt is not a validated DTO.
  const renewalStatus: BilibiliRenewalStatus =
    await bilibiliRenewalApi(api).status();
  // @ts-expect-error Raw renewalDisable receipt is not a validated DTO.
  const renewalDisable: BilibiliRenewalStatus =
    await bilibiliRenewalApi(api).disable(null);
  // @ts-expect-error Raw oauthStatus receipt is not a validated DTO.
  const oauthStatus: OAuthStatus = await platformOAuthApi(
    api,
    "douyin",
  ).status();
  // @ts-expect-error Raw oauthStart receipt is not a validated DTO.
  const oauthStart: OAuthLogin = await platformOAuthApi(api, "douyin").start(
    "synthetic",
    null,
    false,
  );
  // @ts-expect-error Raw oauthRead receipt is not a validated DTO.
  const oauthRead: OAuthLogin = await platformOAuthApi(api, "douyin").read(
    "synthetic",
  );
  // @ts-expect-error Raw oauthPoll receipt is not a validated DTO.
  const oauthPoll: OAuthLogin = await platformOAuthApi(api, "douyin").poll(
    "synthetic",
  );
  // @ts-expect-error Raw oauthCancel receipt is not a validated DTO.
  const oauthCancel: OAuthLogin = await platformOAuthApi(api, "douyin").cancel(
    "synthetic",
  );
  // @ts-expect-error Raw oauthDisable receipt is not a validated DTO.
  const oauthDisable: OAuthStatus = await platformOAuthApi(
    api,
    "douyin",
  ).disableRenewal(null);
  // @ts-expect-error Raw oauthUnlink receipt is not a validated DTO.
  const oauthUnlink: OAuthStatus = await platformOAuthApi(api, "douyin").unlink(
    null,
  );
  createPlatformLoginFlow({
    current: () => true,
    start: async () => raw,
    poll: async () => raw,
    cancel: async () => raw,
    change() {},
    confirmed() {},
  });
  createOAuthFlow({
    provider: "douyin",
    current: () => true,
    start: async () => raw,
    read: async () => raw,
    poll: async () => raw,
    cancel: async () => raw,
    change() {},
    confirmed() {},
  });
  return {
    renewal,
    status,
    login,
    qrStart,
    qrPoll,
    qrCancel,
    renewalStatus,
    renewalDisable,
    oauthStatus,
    oauthStart,
    oauthRead,
    oauthPoll,
    oauthCancel,
    oauthDisable,
    oauthUnlink,
  };
}
