import {
  guestRoomPath,
  parseGuestInvitation,
} from "../apps/web/src/features/auth/guest-session";
import { ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, shallowRef } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useAction } from "../apps/web/src/shared/use-action";
import {
  authenticationLocation,
  safeRedirect,
} from "../apps/web/src/app/navigation";
import {
  validateAccount,
  validateNickname,
} from "../apps/web/src/features/auth/account-rules";
import { RequestFailure } from "../apps/web/src/errors";

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function auth(file: "LoginPage" | "RegisterPage") {
  setActivePinia(createPinia());
  const session = useSession();
  const replace = vi.fn();
  const focus = vi.fn();
  const getElementById = vi.fn(() => ({ focus }));
  vi.stubGlobal("document", { getElementById });
  const page = mountSetup(
    new URL(`../apps/web/src/features/auth/${file}.vue`, import.meta.url),
    {
      guestRoomPath,
      parseGuestInvitation,
      validateNickname,
      useSession,
      useRegistrationPolicy: () => ({
        policy: ref({
          registration_mode: "invite_only",
          guests_enabled: false,
        }),
        loading: ref(false),
        error: ref(""),
        reload: vi.fn(),
      }),
      useAction,
      useRouter: () => ({ replace }),
      useRoute: () => ({
        query: { redirect: "/rooms/fixture?invite=token#confirm" },
      }),
      authenticationLocation,
      safeRedirect,
      validateAccount,
      RequestFailure,
      Notice: {},
      AppIcon: {},
    },
  );
  dispose.push(page.unmount);
  return { ...page, session, replace, focus, getElementById };
}
it("login prevents a repeated submit while preserving password spaces and the return destination", async () => {
  const p = auth("LoginPage");
  const request = deferred<any>();
  p.session.login = vi.fn(() => request.promise);
  p.controls.username.value = "fixture";
  p.controls.password.value = " pass 12";
  const first = p.controls.submitLogin();
  await p.controls.submitLogin();
  expect(p.session.login).toHaveBeenCalledOnce();
  expect(p.session.login).toHaveBeenCalledWith(
    "fixture",
    " pass 12",
    expect.any(AbortSignal),
  );
  expect(p.controls.busy.value).toBe(true);
  request.resolve({ username: "fixture" });
  await first;
  expect(p.controls.busy.value).toBe(false);
  expect(p.controls.password.value).toBe("");
  expect(p.replace).toHaveBeenCalledWith("/rooms/fixture?invite=token#confirm");
});
it("login input changes clear a stale failure and leaving aborts the current attempt", async () => {
  const p = auth("LoginPage");
  p.controls.error.value = "old failure";
  p.controls.username.value = "new-user";
  await nextTick();
  expect(p.controls.error.value).toBe("");
  const request = deferred<any>();
  p.session.login = vi.fn(() => request.promise);
  p.controls.password.value = "fixture-password";
  const first = p.controls.submitLogin();
  const signal = (p.session.login as any).mock.calls[0][2] as AbortSignal;
  p.unmount();
  expect(signal.aborted).toBe(true);
  expect(p.controls.password.value).toBe("");
  request.resolve({ username: "new-user" });
  await first;
  expect(p.replace).not.toHaveBeenCalled();
});
it("an invalid invitation is linked to its field and clears when that field changes", async () => {
  const p = auth("RegisterPage");
  p.session.api = vi.fn().mockRejectedValue(
    new RequestFailure({
      error: {
        code: "REGISTRATION_INVITE_INVALID",
        message: "邀请码无效",
      },
    }),
  );
  await p.controls.validate();
  expect(p.controls.step.value).toBe(1);
  expect(p.controls.fieldError.value).toEqual({
    field: "code",
    message: "邀请码无效",
  });
  expect(p.getElementById).toHaveBeenLastCalledWith("register-code");
  expect(p.focus).toHaveBeenCalledOnce();
  p.controls.code.value = "RS-REPLACEMENT";
  await nextTick();
  expect(p.controls.fieldError.value).toBeNull();
  expect(p.controls.error.value).toBe("");
});
it("returning to invitation entry clears password drafts but cannot reopen an uncertain registration", async () => {
  const p = auth("RegisterPage");
  p.controls.step.value = 2;
  p.controls.code.value = "RS-EXISTING";
  p.controls.password.value = "synthetic-password";
  p.controls.confirm.value = "synthetic-password";
  p.controls.error.value = "old field error";
  await p.controls.changeInvite();
  expect(p.controls.step.value).toBe(1);
  expect(p.controls.password.value).toBe("");
  expect(p.controls.confirm.value).toBe("");
  expect(p.controls.code.value).toBe("RS-EXISTING");
  expect(p.controls.error.value).toBe("");
  p.controls.step.value = 2;
  p.controls.uncertain.value = true;
  await p.controls.changeInvite();
  expect(p.controls.step.value).toBe(2);
});
async function profile() {
  setActivePinia(createPinia());
  const session = useSession();
  const identity = {
    id: "fixture",
    username: "fixture",
    admin: false,
    csrf: "fixture",
    display_name: "Original",
    custom_display_name: "Original",
    avatar_url: null,
    avatar_version: null,
  };
  session.accept(identity);
  session.api = vi.fn().mockResolvedValue(identity);
  const focus = vi.fn();
  const getElementById = vi.fn(() => ({ focus }));
  vi.stubGlobal("document", { getElementById });
  const page = mountSetup(
    new URL(
      "../apps/web/src/features/account/ProfilePage.vue",
      import.meta.url,
    ),
    {
      shallowRef,
      guestRoomPath,
      parseGuestInvitation,
      validateNickname,
      useSession,
      useRegistrationPolicy: () => ({
        policy: ref({
          registration_mode: "invite_only",
          guests_enabled: false,
        }),
        loading: ref(false),
        error: ref(""),
        reload: vi.fn(),
      }),
      useAction,
      RequestFailure,
      UserAvatar: {},
      Notice: {},
      AppDialog: {},
      AppIcon: {},
      PlatformAccountPanel: {},
      AccountExitPanel: {},
      ShortPlatformAccountPanel: {},
      YoutubePlatformAccountPanel: {},
      AvatarCropDialog: {},
      decodeAvatar: vi.fn(),
    },
  );
  dispose.push(page.unmount);
  await vi.waitFor(() => expect(page.controls.loaded.value).toBe(true));
  return { ...page, session, identity, focus, getElementById };
}
it("profile nickname validation focuses the editable field without sending a write", async () => {
  const p = await profile();
  p.controls.nickname.value = "😀".repeat(51);
  await p.controls.submitName();
  expect(p.session.api).toHaveBeenCalledOnce();
  expect(p.controls.nameError.value).toContain("50");
  expect(p.controls.busy.value).toBe(false);
  expect(p.getElementById).toHaveBeenLastCalledWith("profile-nickname");
  expect(p.focus).toHaveBeenCalledOnce();
  p.controls.nickname.value = "Corrected";
  expect(p.controls.nameError.value).toBe("");
});
it("profile nickname feedback tracks saved changes and repeated submit sends only one PATCH", async () => {
  const p = await profile();
  expect(p.controls.nameChanged.value).toBe(false);
  p.controls.nickname.value = "Updated";
  expect(p.controls.nameChanged.value).toBe(true);
  const request = deferred<any>();
  p.session.api = vi.fn(() => request.promise);
  const first = p.controls.submitName();
  await p.controls.submitName();
  expect(p.session.api).toHaveBeenCalledOnce();
  expect(p.session.api).toHaveBeenCalledWith("/users/me/profile", "PATCH", {
    display_name: "Updated",
  });
  request.resolve({
    ...p.identity,
    display_name: "Updated",
    custom_display_name: "Updated",
  });
  await first;
  expect(p.controls.nameChanged.value).toBe(false);
  expect(p.controls.message.value).toBe("昵称已保存");
  expect(p.session.user?.avatar_url).toBeNull();
  p.controls.nickname.value = "Another draft";
  expect(p.controls.message.value).toBe("");
  expect(p.controls.nameChanged.value).toBe(true);
});
