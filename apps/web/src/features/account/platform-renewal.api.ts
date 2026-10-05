import type { ApiClient } from "../../shared/api/client";
import type { PlatformAccountStatus } from "./platform-account.api";
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
export const bilibiliRenewalApi = (api: ApiClient) => ({
  status: (signal?: AbortSignal) =>
    api<BilibiliRenewalStatus>(
      "/platform-accounts/bilibili/renewal",
      "GET",
      undefined,
      signal,
    ),
  disable: (revision: string | null, signal?: AbortSignal) =>
    api<BilibiliRenewalStatus>(
      "/platform-accounts/bilibili/renewal",
      "PUT",
      { expected_revision: revision, enabled: false },
      signal,
    ),
});
export function validateBilibiliRenewal(
  v: BilibiliRenewalStatus,
): BilibiliRenewalStatus {
  if (
    !v ||
    v.method !== "web_cookie_refresh" ||
    v.supported !== true ||
    v.account?.provider !== "bilibili" ||
    typeof v.enabled !== "boolean" ||
    ![
      "disabled",
      "scheduled",
      "running",
      "uncertain",
      "reauthorization_required",
    ].includes(v.state) ||
    v.enable_requires !== "new_consented_qr_login" ||
    (v.next_refresh_at !== null &&
      (!Number.isSafeInteger(v.next_refresh_at) || v.next_refresh_at <= 0)) ||
    v.enabled !== ["scheduled", "running"].includes(v.state)
  )
    throw Error("自动续期状态不完整");
  return {
    account: v.account,
    method: v.method,
    supported: v.supported,
    enabled: v.enabled,
    state: v.state,
    next_refresh_at: v.next_refresh_at,
    enable_requires: v.enable_requires,
  };
}
