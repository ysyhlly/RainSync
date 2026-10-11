import type { ApiClient } from "../../shared/api/client";
import { responseRecord, responseMember } from "../../shared/api/response";
import type { PlatformAccountStatus } from "./platform-account.api";
import { validatePlatformAccountStatus } from "./platform-account-check";
export interface BilibiliRenewalStatus {
  account: PlatformAccountStatus;
  method: "web_cookie_refresh";
  supported: true;
  enabled: boolean;
  state:
    | "disabled"
    | "scheduled"
    | "running"
    | "uncertain"
    | "reauthorization_required";
  next_refresh_at: number | null;
  enable_requires: "new_consented_qr_login";
}
// The panel fences identity, serial and abort before parsing either receipt.
export const bilibiliRenewalApi = (api: ApiClient) => ({
  status: (signal?: AbortSignal) =>
    api<unknown>(
      "/platform-accounts/bilibili/renewal",
      "GET",
      undefined,
      signal,
    ),
  disable: (revision: string | null, signal?: AbortSignal) =>
    api<unknown>(
      "/platform-accounts/bilibili/renewal",
      "PUT",
      { expected_revision: revision, enabled: false },
      signal,
    ),
});
export function validateBilibiliRenewal(v: unknown): BilibiliRenewalStatus {
  if (!responseRecord(v)) throw Error("自动续期状态不完整");
  const account = validatePlatformAccountStatus(v.account);
  if (
    v.method !== "web_cookie_refresh" ||
    v.supported !== true ||
    typeof v.enabled !== "boolean" ||
    !responseMember(v.state, [
      "disabled",
      "scheduled",
      "running",
      "uncertain",
      "reauthorization_required",
    ]) ||
    v.enable_requires !== "new_consented_qr_login" ||
    (v.next_refresh_at !== null &&
      (typeof v.next_refresh_at !== "number" ||
        !Number.isSafeInteger(v.next_refresh_at) ||
        v.next_refresh_at <= 0)) ||
    v.enabled !== ["scheduled", "running"].includes(v.state)
  )
    throw Error("自动续期状态不完整");
  return {
    account,
    method: v.method,
    supported: v.supported,
    enabled: v.enabled,
    state: v.state,
    next_refresh_at: v.next_refresh_at,
    enable_requires: v.enable_requires,
  };
}
