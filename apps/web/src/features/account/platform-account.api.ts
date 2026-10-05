import type { ApiClient } from "../../shared/api/client";
export interface PlatformAccountStatus {
  id: string | null;
  provider: "bilibili";
  revision: string | null;
  state: "connected" | "expired" | "revoked";
}
export interface PlatformAccountCheck {
  account: PlatformAccountStatus;
  verification: "verified" | "invalid" | "unknown" | "none";
  checked_at: number | null;
  renew_method: "qr_login";
}
export type ShortPlatformProvider = "douyin" | "tiktok";
/** A stored session is not a verified platform login. No secret is returned. */
export interface ShortPlatformAccountStatus {
  id: string | null;
  provider: ShortPlatformProvider;
  revision: string | null;
  state: "connected" | "expired" | "revoked";
  login_method: "cookie_import";
  qr_available: false;
  verification: "unverified" | "none";
  credential_expires_at: number | null;
}
export interface YoutubePlatformAccountStatus {
  id: string | null;
  provider: "youtube";
  revision: string | null;
  state: "connected" | "expired" | "revoked";
  login_method: "netscape_cookie_import";
  qr_available: false;
  verification: "unverified" | "none";
  credential_expires_at: number | null;
  account_import_available: boolean;
  availability_reason: "server_opt_in_required" | null;
}
export interface PlatformLogin {
  id: string;
  provider: "bilibili";
  status: "pending" | "confirmed" | "expired" | "failed";
  stage: "waiting" | "scanned" | null;
  qr_payload: string | null;
  expires_at: number;
  next_poll_at: number;
  server_time: number;
}
const path = "/platform-accounts/bilibili";
export const platformAccountApi = (api: ApiClient) => ({
  status: (signal?: AbortSignal) =>
    api<PlatformAccountStatus>(path, "GET", undefined, signal),
  check: (expectedRevision: string | null, signal?: AbortSignal) =>
    api<PlatformAccountCheck>(
      `${path}/check`,
      "POST",
      { expected_revision: expectedRevision },
      signal,
    ),
  start: (key: string, signal?: AbortSignal, consentToRenew = false) =>
    api<PlatformLogin>(
      `${path}/login`,
      "POST",
      {
        idempotency_key: key,
        consent_to_store: true,
        ...(consentToRenew ? { consent_to_renew: true } : {}),
      },
      signal,
    ),
  poll: (id: string, signal?: AbortSignal) =>
    api<PlatformLogin>(
      `${path}/login/${encodeURIComponent(id)}/poll`,
      "POST",
      undefined,
      signal,
    ),
  cancel: (id: string) =>
    api<PlatformLogin>(
      `${path}/login/${encodeURIComponent(id)}`,
      "DELETE",
      undefined,
      AbortSignal.timeout(10000),
    ),
  unlink: (signal?: AbortSignal) =>
    api<PlatformAccountStatus>(path, "DELETE", undefined, signal),
});

export const shortPlatformAccountApi = (
  api: ApiClient,
  provider: ShortPlatformProvider,
) => {
  if (provider !== "douyin" && provider !== "tiktok")
    throw Error("不支持此平台账号");
  const path = `/platform-accounts/${provider}`;
  return {
    status: (signal?: AbortSignal) =>
      api<ShortPlatformAccountStatus>(path, "GET", undefined, signal),
    importCredential: (
      cookie: string,
      expectedRevision: string | null,
      signal?: AbortSignal,
    ) =>
      api<ShortPlatformAccountStatus>(
        `${path}/credential`,
        "PUT",
        { cookie, consent_to_store: true, expected_revision: expectedRevision },
        signal,
      ),
    unlink: (expectedRevision: string | null, signal?: AbortSignal) =>
      api<ShortPlatformAccountStatus>(
        path,
        "DELETE",
        { expected_revision: expectedRevision },
        signal,
      ),
  };
};

export const youtubePlatformAccountApi = (api: ApiClient) => {
  const path = "/platform-accounts/youtube";
  return {
    status: (signal?: AbortSignal) =>
      api<YoutubePlatformAccountStatus>(path, "GET", undefined, signal),
    importCredential: (
      cookieFile: string,
      expectedRevision: string | null,
      signal?: AbortSignal,
    ) =>
      api<YoutubePlatformAccountStatus>(
        `${path}/credential`,
        "PUT",
        {
          cookie_file: cookieFile,
          consent_to_store: true,
          expected_revision: expectedRevision,
        },
        signal,
      ),
    unlink: (expectedRevision: string | null, signal?: AbortSignal) =>
      api<YoutubePlatformAccountStatus>(
        path,
        "DELETE",
        { expected_revision: expectedRevision },
        signal,
      ),
  };
};
