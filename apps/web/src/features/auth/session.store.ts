import { defineStore } from "pinia";
import { ref } from "vue";
import { createApiClient, StaleIdentity } from "../../shared/api/client";
import type { Avatar, Identity, Profile } from "../../shared/api/types";
import { guestRoomPath } from "./guest-session";
import { RequestFailure } from "../../errors";

type ServerIdentity = Pick<Identity, "id" | "username" | "admin" | "csrf"> &
  Partial<Profile> &
  Partial<Pick<Identity, "guest" | "guest_room_id" | "guest_expires_at">>;
export class RegistrationConfirmationRequired extends Error {
  constructor(
    readonly receipt: Pick<Identity, "id" | "username">,
    cause: unknown,
  ) {
    super("账号已创建，登录状态尚未确认，请使用刚设置的账号登录确认", {
      cause,
    });
    this.name = "RegistrationConfirmationRequired";
  }
}
export const useSession = defineStore("session", () => {
  const user = ref<Identity | null>(null),
    epoch = ref(0),
    loaded = ref(false);
  let loadSerial = 0,
    profileRevision = 0;
  const startupError = ref("");
  const expired = ref(false);
  let restoring: Promise<void> | undefined;
  let authentication: Promise<unknown> | undefined;
  let authenticationController: AbortController | undefined;
  // Cookie mutations must finish (including abort) before their successor is
  // sent. Epoch checks alone cannot stop the browser applying Set-Cookie.
  function authenticate<T>(
    action: (signal: AbortSignal) => Promise<T>,
    external?: AbortSignal,
  ): Promise<T> {
    const previous = authentication;
    authenticationController?.abort(new StaleIdentity());
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20000),
      ...(external ? [external] : []),
    ]);
    const work = Promise.resolve().then(async () => {
      await previous?.catch(() => {});
      signal.throwIfAborted();
      return action(signal);
    });
    const completion = work.finally(() => {
      if (authentication === completion) {
        authentication = undefined;
        authenticationController = undefined;
      }
    });
    authenticationController = controller;
    authentication = completion;
    return completion;
  }
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
    expired.value = false;
  }
  function invalidate(failure: RequestFailure) {
    if (["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(failure.code)) {
      const hadIdentity = !!user.value;
      clear();
      expired.value = hadIdentity || failure.code === "SESSION_EXPIRED";
    }
  }
  function accept(value: ServerIdentity) {
    if (!value?.id || !value.username || typeof value.csrf !== "string")
      throw new TypeError("登录响应不完整，请重新登录");
    if (value.guest !== undefined && typeof value.guest !== "boolean")
      throw new TypeError("访客登录响应不完整，请重新进入");
    if (
      value.guest === true &&
      (!guestRoomPath(value) ||
        value.admin ||
        !Number.isSafeInteger(value.guest_expires_at) ||
        value.guest_expires_at! <= Date.now())
    )
      throw new TypeError("访客登录响应不完整或已过期，请重新进入");
    if (
      value.guest !== true &&
      (value.guest_room_id != null || value.guest_expires_at != null)
    )
      throw new TypeError("登录身份类型不一致，请重新登录");
    if (
      value.id !== user.value?.id ||
      !!value.guest !== !!user.value?.guest ||
      value.guest_room_id !== user.value?.guest_room_id
    ) {
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
    expired.value = false;
  }
  async function readIdentity(
    signal?: AbortSignal,
    expected?: {
      username: string;
      csrf: string;
      id?: string;
      guestRoom?: string;
    },
  ) {
    const serial = ++loadSerial;
    const profileAtStart = profileRevision;
    const value = await api<ServerIdentity>(
      "/auth/me",
      "GET",
      undefined,
      signal,
    );
    signal?.throwIfAborted();
    if (serial !== loadSerial) throw new StaleIdentity();
    if (
      expected &&
      (value.username !== expected.username ||
        value.csrf !== expected.csrf ||
        (expected.id && value.id !== expected.id) ||
        (expected.guestRoom &&
          (value.guest !== true || value.guest_room_id !== expected.guestRoom)))
    )
      throw new StaleIdentity();
    if (profileAtStart !== profileRevision && user.value?.id === value.id) {
      value.display_name = user.value.display_name;
      value.custom_display_name = user.value.custom_display_name;
      value.avatar_url = user.value.avatar_url;
      value.avatar_version = user.value.avatar_version;
    }
    accept(value);
    return user.value!;
  }
  async function load() {
    while (authentication) await authentication.catch(() => {});
    return readIdentity();
  }
  function login(username: string, password: string, signal?: AbortSignal) {
    return authenticate(async (active) => {
      clear();
      const result = await api<{ csrf: string }>(
        "/auth/login",
        "POST",
        { username, password },
        active,
      );
      active.throwIfAborted();
      return readIdentity(active, { username, csrf: result.csrf });
    }, signal);
  }
  function register(
    input: {
      code?: string;
      username: string;
      password: string;
      display_name?: string;
    },
    signal?: AbortSignal,
  ) {
    return authenticate(async (active) => {
      clear();
      const result = await api<ServerIdentity>(
        "/auth/register",
        "POST",
        input,
        active,
      );
      if (!result?.id || result.username !== input.username)
        throw new TypeError("注册响应不完整，请先确认账号创建结果");
      try {
        active.throwIfAborted();
        return await readIdentity(active, {
          username: input.username,
          csrf: result.csrf,
          id: result.id,
        });
      } catch (cause) {
        // A failed identity read cannot turn a committed signup back into a
        // safely retryable creation. Keep its identity receipt without logging in.
        throw new RegistrationConfirmationRequired(
          { id: result.id, username: result.username },
          cause,
        );
      }
    }, signal);
  }
  function guest(
    roomId: string,
    token: string,
    displayName: string,
    signal?: AbortSignal,
  ) {
    if (user.value || authentication)
      return Promise.reject(
        new Error(
          "当前已有登录或正在登录，请先完成或退出该账号，再进入访客会话。",
        ),
      );
    return authenticate(async (active) => {
      if (user.value) throw new Error("当前已登录，请先退出该账号。");
      clear();
      const result = await api<ServerIdentity>(
        `/rooms/${encodeURIComponent(roomId)}/guest-session`,
        "POST",
        {
          token,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        },
        active,
      );
      active.throwIfAborted();
      if (result.guest !== true || result.guest_room_id !== roomId)
        throw new TypeError("访客会话范围不匹配，请重新确认登录状态。");
      return readIdentity(active, {
        username: result.username,
        csrf: result.csrf,
        id: result.id,
        guestRoom: roomId,
      });
    }, signal);
  }
  function logout() {
    return authenticate(async (active) => {
      await api("/auth/logout", "POST", undefined, active);
      active.throwIfAborted();
      clear();
    });
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
    expired,
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
    register,
    logout,
    guest,
    updateProfile,
  };
});
