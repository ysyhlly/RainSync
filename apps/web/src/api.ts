import { defineStore } from "pinia";
import { ref } from "vue";
import { RequestFailure } from "./errors";
export const useSession = defineStore("session", () => {
  const user = ref<{
    id: string;
    username: string;
    admin: boolean;
    csrf: string;
  } | null>(null);
  async function api(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const identity = user.value;
    const response = await fetch("/api/v1" + path, {
      method,
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(user.value ? { "x-csrf-token": user.value.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => {
      // A successful status with a truncated JSON body is an uncertain result,
      // not a successful null plan. The playback caller retries its same key.
      if (response.ok) throw new TypeError("服务器响应不完整，请稍后重试");
      return null;
    });
    if (!response.ok) {
      const failure = new RequestFailure(value);
      if (identity === user.value) invalidate(failure);
      throw failure;
    }
    return value;
  }
  function invalidate(failure: RequestFailure) {
    if (["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(failure.code))
      user.value = null;
  }
  async function load() {
    user.value = await api("/auth/me");
  }
  return { user, api, load, invalidate };
});
