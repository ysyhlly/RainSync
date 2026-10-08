import type {
  PlatformAccountCheck,
  PlatformAccountStatus,
} from "./platform-account.api";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validatePlatformAccountStatus(
  value: PlatformAccountStatus,
): PlatformAccountStatus {
  if (
    !value ||
    value.provider !== "bilibili" ||
    !["connected", "expired", "revoked"].includes(value.state) ||
    (value.id !== null &&
      (typeof value.id !== "string" || !uuid.test(value.id))) ||
    (value.revision !== null &&
      (typeof value.revision !== "string" ||
        !/^[1-9]\d*$/.test(value.revision))) ||
    (value.id === null) !== (value.revision === null) ||
    (value.state === "connected" && value.id === null)
  )
    throw Error("平台账号状态响应不完整");
  return {
    id: value.id,
    provider: value.provider,
    revision: value.revision,
    state: value.state,
  };
}

export function validatePlatformAccountCheck(
  value: PlatformAccountCheck,
): PlatformAccountCheck {
  if (!value) throw Error("平台账号检查响应不完整");
  const account = validatePlatformAccountStatus(value.account);
  if (
    !["verified", "invalid", "unknown", "none"].includes(value.verification) ||
    value.renew_method !== "qr_login" ||
    (value.checked_at !== null &&
      (!Number.isSafeInteger(value.checked_at) || value.checked_at <= 0)) ||
    (value.verification === "none") !== (value.checked_at === null) ||
    (["verified", "unknown"].includes(value.verification) &&
      account.state !== "connected") ||
    (value.verification === "invalid" && account.state !== "expired") ||
    (value.verification === "none" && account.state === "connected")
  )
    throw Error("平台账号检查响应不完整");
  return {
    account,
    verification: value.verification,
    checked_at: value.checked_at,
    renew_method: value.renew_method,
  };
}

export function platformAccountCheckMessage(
  value: PlatformAccountCheck | undefined,
): string {
  switch (value?.verification) {
    case "verified":
      return "最近检查时平台登录有效，视频权限仍由平台决定";
    case "invalid":
      return "平台登录已失效，保存的会话已清除，请重新扫码连接";
    case "unknown":
      return "平台检查暂时无法确认，已保留原会话，请稍后重试";
    case "none":
      return "没有可检查的有效会话，请扫码连接";
    default:
      return "保存状态不代表平台登录仍有效，可主动检查登录状态";
  }
}
