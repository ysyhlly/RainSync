import { RequestFailure } from "../../errors";
import type { Method } from "./types";
export class StaleIdentity extends Error {
  constructor() {
    super("登录身份已变化，请重新操作");
    this.name = "StaleIdentity";
  }
}
export interface AuthContext {
  identity(): { csrf: string } | null;
  epoch(): number;
  invalidate(failure: RequestFailure): void;
}
export function createApiClient(auth: AuthContext) {
  return async function api<T = unknown>(
    path: string,
    method: Method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    extraHeaders?: HeadersInit,
  ): Promise<T> {
    const epoch = auth.epoch(),
      identity = auth.identity();
    const binary = body instanceof Blob;
    const headers = new Headers(extraHeaders);
    headers.set(
      "Content-Type",
      binary ? body.type || "application/octet-stream" : "application/json",
    );
    if (identity) headers.set("x-csrf-token", identity.csrf);
    const response = await fetch("/api/v1" + path, {
      method,
      signal,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body:
        body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
    const value = await response.json().catch(() => {
      if (response.ok)
        throw new TypeError("服务器响应不完整，请确认结果后重试");
      return null;
    });
    if (epoch !== auth.epoch()) throw new StaleIdentity();
    if (!response.ok) {
      const failure = new RequestFailure(value);
      auth.invalidate(failure);
      throw failure;
    }
    return value as T;
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
