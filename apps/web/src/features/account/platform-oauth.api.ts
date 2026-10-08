import type { ApiClient } from "../../shared/api/client";
import type { ShortPlatformProvider } from "./platform-account.api";
export interface OAuthStatus {
  provider: ShortPlatformProvider;
  id: string | null;
  revision: string | null;
  state: "connected" | "expired" | "revoked";
  available: boolean;
  missing_prerequisites: string[];
  authorization_kind: "official_oauth";
  playback_session: false;
  authorization_mode: "web" | "qr";
  scopes: string[];
  access_expires_at: number | null;
  refresh_expires_at: number | null;
  auto_renew: boolean;
  renewal_state:
    | "disabled"
    | "scheduled"
    | "running"
    | "uncertain"
    | "reauthorization_required";
  next_refresh_at: number | null;
}
export interface OAuthLogin {
  id: string;
  provider: ShortPlatformProvider;
  status: "pending" | "confirmed" | "expired" | "failed";
  mode: "web" | "qr";
  stage: "waiting" | "scanned" | null;
  authorization_url: string | null;
  qr_payload: string | null;
  expires_at: number;
  next_poll_at: number;
  server_time: number;
}
export const platformOAuthApi = (
  api: ApiClient,
  provider: ShortPlatformProvider,
) => {
  if (!["douyin", "tiktok"].includes(provider)) throw Error("不支持此平台");
  const path = `/platform-accounts/${provider}/oauth`;
  return {
    status: (signal?: AbortSignal) =>
      api<OAuthStatus>(path, "GET", undefined, signal),
    start: (
      id: string,
      revision: string | null,
      renew: boolean,
      signal?: AbortSignal,
    ) =>
      api<OAuthLogin>(
        `${path}/login`,
        "POST",
        {
          idempotency_key: id,
          expected_revision: revision,
          consent_to_store: true,
          consent_to_renew: renew,
        },
        signal,
      ),
    read: (id: string, signal?: AbortSignal) =>
      api<OAuthLogin>(
        `${path}/login/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        signal,
      ),
    poll: (id: string, signal?: AbortSignal) =>
      api<OAuthLogin>(
        `${path}/login/${encodeURIComponent(id)}/poll`,
        "POST",
        undefined,
        signal,
      ),
    cancel: (id: string) =>
      api<OAuthLogin>(
        `${path}/login/${encodeURIComponent(id)}`,
        "DELETE",
        undefined,
        AbortSignal.timeout(10000),
      ),
    disableRenewal: (revision: string | null, signal?: AbortSignal) =>
      api<OAuthStatus>(
        `${path}/renewal`,
        "PUT",
        { expected_revision: revision, enabled: false },
        signal,
      ),
    unlink: (revision: string | null, signal?: AbortSignal) =>
      api<OAuthStatus>(path, "DELETE", { expected_revision: revision }, signal),
  };
};
export const oauthPrerequisiteLabels: Record<string, string> = {
  approved_developer_application: "审核通过的开放平台应用",
  server_client_key: "服务器端 Client Key",
  server_client_secret_file: "服务器安全密钥文件",
  registered_https_callback: "平台注册的完整 HTTPS 回调地址",
  approved_identity_scope: "审核通过的用户资料授权范围",
};
