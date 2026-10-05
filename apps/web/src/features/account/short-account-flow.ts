import type {
  ShortPlatformAccountStatus,
  ShortPlatformProvider,
} from "./platform-account.api";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateShortAccountStatus(
  value: ShortPlatformAccountStatus,
  provider: ShortPlatformProvider,
): ShortPlatformAccountStatus {
  if (
    !value ||
    value.provider !== provider ||
    !["connected", "expired", "revoked"].includes(value.state) ||
    (value.id !== null &&
      (typeof value.id !== "string" || !uuid.test(value.id))) ||
    (value.revision !== null &&
      (typeof value.revision !== "string" || !/^\d+$/.test(value.revision))) ||
    (value.id === null) !== (value.revision === null) ||
    value.login_method !== "cookie_import" ||
    value.qr_available !== false ||
    !["unverified", "none"].includes(value.verification) ||
    (value.credential_expires_at !== null &&
      (!Number.isSafeInteger(value.credential_expires_at) ||
        value.credential_expires_at <= 0)) ||
    (value.state === "connected" &&
      (!value.id || !value.revision || value.verification !== "unverified")) ||
    (value.state === "revoked" && value.verification !== "none")
  )
    throw Error("平台账号状态响应不完整");
  return {
    id: value.id,
    provider: value.provider,
    revision: value.revision,
    state: value.state,
    login_method: value.login_method,
    qr_available: value.qr_available,
    verification: value.verification,
    credential_expires_at: value.credential_expires_at,
  };
}

export interface ShortAccountFlowState {
  phase: "idle" | "submitting" | "stored" | "uncertain" | "invalid";
}

export function shortAccountCookieFields(
  provider: ShortPlatformProvider,
): string[] {
  return [
    "sessionid",
    "sessionid_ss",
    "sid_tt",
    "sid_guard",
    "uid_tt",
    "uid_tt_ss",
    "sid_ucp_v1",
    "ssid_ucp_v1",
    "passport_csrf_token",
    "passport_csrf_token_default",
    "ttwid",
    ...(provider === "douyin"
      ? ["passport_auth_status", "passport_auth_status_ss"]
      : ["tt_csrf_token", "tt_chain_token"]),
  ];
}
/** Usability check only. The server's independent parser remains authoritative. */
export function validShortAccountCookieInput(
  cookie: string,
  provider: ShortPlatformProvider,
): boolean {
  if (!cookie || cookie.length > 8192 || /[^\x20-\x7e]/.test(cookie))
    return false;
  const names = new Set<string>(),
    allowed = new Set(shortAccountCookieFields(provider));
  let session = false;
  const pairs = cookie.split(";");
  if (
    pairs.length > 32 ||
    pairs.map((pair) => pair.trim()).join("; ").length > 8192
  )
    return false;
  for (const raw of pairs) {
    const pair = raw.trim(),
      split = pair.indexOf("=");
    if (split <= 0) return false;
    const name = pair.slice(0, split),
      value = pair.slice(split + 1);
    if (
      !allowed.has(name) ||
      names.has(name) ||
      !value ||
      value.length > 2048 ||
      /[\s,\\\"]/.test(value)
    )
      return false;
    names.add(name);
    if (["sessionid", "sessionid_ss", "sid_tt"].includes(name)) {
      if (value.length < 16) return false;
      session = true;
    }
  }
  return session;
}

/** Single-use submission; the caller clears the input synchronously before PUT.
 * No retry retains credentials, and closed/old identity responses stay inert. */
export function createShortAccountFlow(options: {
  provider: ShortPlatformProvider;
  current: () => boolean;
  submit: (
    cookie: string,
    revision: string | null,
    signal: AbortSignal,
  ) => Promise<ShortPlatformAccountStatus>;
  clearSecret: () => void;
  change: (state: ShortAccountFlowState) => void;
}) {
  let closed = false,
    busy = false;
  const controller = new AbortController();
  const current = () =>
    !closed && !controller.signal.aborted && options.current();
  async function submit(
    cookie: string,
    revision: string | null,
    consent: boolean,
  ) {
    if (!current() || busy || !consent || !cookie.trim()) return;
    busy = true;
    options.clearSecret();
    if (!validShortAccountCookieInput(cookie, options.provider)) {
      cookie = "";
      busy = false;
      options.change({ phase: "invalid" });
      return;
    }
    options.change({ phase: "submitting" });
    try {
      const value = await options.submit(cookie, revision, controller.signal);
      cookie = "";
      if (!current()) return;
      validateShortAccountStatus(value, options.provider);
      options.change({
        phase: value.state === "connected" ? "stored" : "uncertain",
      });
    } catch {
      // Never surface service error text that could echo a session credential.
      if (current()) options.change({ phase: "uncertain" });
    } finally {
      cookie = "";
      busy = false;
    }
  }
  function close() {
    closed = true;
    controller.abort();
    options.clearSecret();
  }
  return { submit, close };
}
