import { createCookieAccountFlow } from "./cookie-account-flow";
import type { YoutubePlatformAccountStatus } from "./platform-account.api";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateYoutubeAccountStatus(
  value: YoutubePlatformAccountStatus,
): YoutubePlatformAccountStatus {
  if (
    !value ||
    value.provider !== "youtube" ||
    !["connected", "expired", "revoked"].includes(value.state) ||
    (value.id !== null &&
      (typeof value.id !== "string" || !uuid.test(value.id))) ||
    (value.revision !== null &&
      (typeof value.revision !== "string" ||
        !/^[1-9]\d*$/.test(value.revision))) ||
    (value.id === null) !== (value.revision === null) ||
    value.login_method !== "netscape_cookie_import" ||
    value.qr_available !== false ||
    !["unverified", "none"].includes(value.verification) ||
    (value.state === "connected" &&
      (!value.id || value.verification !== "unverified")) ||
    (value.state !== "connected" && value.verification !== "none") ||
    (value.credential_expires_at !== null &&
      (!Number.isSafeInteger(value.credential_expires_at) ||
        value.credential_expires_at <= 0)) ||
    typeof value.account_import_available !== "boolean" ||
    value.availability_reason !==
      (value.account_import_available ? null : "server_opt_in_required")
  )
    throw Error("YouTube 会话状态响应不完整");
  return {
    id: value.id,
    provider: value.provider,
    revision: value.revision,
    state: value.state,
    login_method: value.login_method,
    qr_available: value.qr_available,
    verification: value.verification,
    credential_expires_at: value.credential_expires_at,
    account_import_available: value.account_import_available,
    availability_reason: value.availability_reason,
  };
}

export type YoutubeAccountPhase =
  "idle" | "submitting" | "stored" | "uncertain" | "invalid";
export function validYoutubeCookieFile(input: string) {
  return (
    input.length > 0 &&
    input.length <= 32768 &&
    // eslint-disable-next-line no-control-regex -- Deliberately reject unsafe control characters.
    !/[^\x09\x0a\x0d\x20-\x7e]/.test(input) &&
    /^# (?:Netscape )?HTTP Cookie File\r?\n/.test(input)
  );
}
/** The secret is cleared before the first request, never retained for retries. */
export function createYoutubeAccountFlow(options: {
  current: () => boolean;
  submit: (
    cookieFile: string,
    revision: string | null,
    signal: AbortSignal,
  ) => Promise<YoutubePlatformAccountStatus>;
  clearSecret: () => void;
  change: (phase: YoutubeAccountPhase) => void;
}) {
  return createCookieAccountFlow({
    ...options,
    hasInput: (secret) => !!secret,
    validateInput: validYoutubeCookieFile,
    validateStatus: validateYoutubeAccountStatus,
  });
}
