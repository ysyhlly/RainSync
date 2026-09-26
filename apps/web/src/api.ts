import { defineStore } from "pinia";
import { ref } from "vue";
export const useSession = defineStore("session", () => {
  const user = ref<{
    id: string;
    username: string;
    admin: boolean;
    csrf: string;
  } | null>(null);
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch("/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user.value ? { "x-csrf-token": user.value.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "请求失败");
    return value;
  }
  async function load() {
    user.value = await api("/auth/me");
  }
  return { user, api, load };
});
