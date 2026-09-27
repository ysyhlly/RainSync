import { defineStore } from "pinia";
import { ref } from "vue";
import { createApiClient, StaleIdentity } from "../../shared/api/client";
import type { Avatar, Identity, Profile } from "../../shared/api/types";
import { RequestFailure } from "../../errors";

type ServerIdentity = Pick<Identity, "id" | "username" | "admin" | "csrf"> &
  Partial<Profile>;
export const useSession = defineStore("session", () => {
  const user = ref<Identity | null>(null),
    epoch = ref(0),
    loaded = ref(false);
  let loadSerial = 0,
    profileRevision = 0;
  const startupError = ref("");
  let restoring: Promise<void> | undefined;
  async function restore() {
    if (loaded.value) return;
    if (restoring) return restoring;
    restoring = (async () => {
      startupError.value = "";
      try {
        await load();
      } catch (e) {
        if (!(
          e instanceof RequestFailure &&
          ["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(e.code)
        ))
          startupError.value = e instanceof Error ? e.message : String(e);
      } finally {
        loaded.value = true;
        restoring = undefined;
      }
    })();
    return restoring;
  }
  const api = createApiClient({
    identity: () => user.value,
    epoch: () => epoch.value,
    invalidate,
  });
  function clear() {
    ++epoch.value;
    ++loadSerial;
    user.value = null;
    loaded.value = true;
  }
  function invalidate(failure: RequestFailure) {
    if (["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(failure.code)) clear();
  }
  function accept(value: ServerIdentity) {
    if (!value?.id || !value.username || typeof value.csrf !== "string")
      throw new TypeError("登录响应不完整，请重新登录");
    if (value.id !== user.value?.id) {
      ++epoch.value;
      ++loadSerial;
    }
    user.value = {
      ...value,
      display_name: value.display_name || value.username,
      custom_display_name: value.custom_display_name ?? null,
      avatar_url: value.avatar_url ?? null,
      avatar_version: value.avatar_version ?? null,
    };
    loaded.value = true;
  }
  async function load() {
    const serial = ++loadSerial;
    const profileAtStart = profileRevision;
    const value = await api<ServerIdentity>("/auth/me");
    if (serial !== loadSerial) throw new StaleIdentity();
    if (profileAtStart !== profileRevision && user.value?.id === value.id) {
      value.display_name = user.value.display_name;
      value.custom_display_name = user.value.custom_display_name;
      value.avatar_url = user.value.avatar_url;
      value.avatar_version = user.value.avatar_version;
    }
    accept(value);
    return user.value!;
  }
  async function login(username: string, password: string) {
    clear();
    const current = epoch.value;
    await api<{ csrf: string }>("/auth/login", "POST", { username, password });
    if (current !== epoch.value) throw new StaleIdentity();
    return load();
  }
  async function logout() {
    await api("/auth/logout", "POST");
    clear();
  }
  function updateProfile(
    value:
      Profile | Avatar | Pick<Profile, "display_name" | "custom_display_name">,
    expectedId: string,
  ) {
    if (user.value?.id !== expectedId) throw new StaleIdentity();
    ++profileRevision;
    user.value = { ...user.value, ...value };
  }
  return {
    startupError,
    restore,
    user,
    epoch,
    loaded,
    api,
    load,
    accept,
    clear,
    invalidate,
    login,
    logout,
    updateProfile,
  };
});
