import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, reactive, ref, nextTick } from "vue";
import { readFileSync } from "node:fs";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useAction } from "../apps/web/src/shared/use-action";
import { useTransientMessage } from "../apps/web/src/shared/use-transient-message";
import {
  parseGuestInvitation,
  buildRoomInvitationLink,
  guestRoomPath,
} from "../apps/web/src/features/auth/guest-session";
import {
  clearInvitation,
  rememberInvitation,
  pendingInvitation,
} from "../apps/web/src/features/auth/invitation-intent";
import { validateNickname } from "../apps/web/src/features/auth/account-rules";
import { useRegistrationPolicy } from "../apps/web/src/features/auth/registration-policy";
import {
  authenticationLocation,
  safeRedirect,
} from "../apps/web/src/app/navigation";
import {
  initializeTheme,
  setThemePreference,
  themePreference,
} from "../apps/web/src/app/theme";
import { RequestFailure } from "../apps/web/src/errors";
const room = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64),
  origin = "https://rainsync.example.test";
const dispose: (() => void)[] = [];
afterEach(() => {
  dispose.splice(0).forEach((stop) => stop());
  clearInvitation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("shares a complete same-origin invitation without sending its capability in the request URL", () => {
  const link = buildRoomInvitationLink({ room_id: room, token }, origin);
  const url = new URL(link);
  expect(url.pathname).toBe(`/invite/${room}`);
  expect(url.search).toBe("");
  expect(url.hash).toBe(`#token=${token}`);
  expect(parseGuestInvitation(link, origin)).toEqual({ room_id: room, token });
  expect(() =>
    parseGuestInvitation(link.replace(origin, "https://outside.test"), origin),
  ).toThrow();
  expect(() =>
    parseGuestInvitation(link + `&token=${token}`, origin),
  ).toThrow();
  expect(() =>
    parseGuestInvitation(link.replace("#", `?token=${token}#`), origin),
  ).toThrow();
});
function invitationPage() {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "member",
    username: "member",
    admin: false,
    csrf: "csrf",
  });
  const route = reactive({
    fullPath: `/invite/${room}#token=${token}`,
    hash: `#token=${token}`,
    query: {} as Record<string, string>,
    params: { roomId: room },
  });
  const replace = vi.fn();
  vi.stubGlobal("window", { location: { origin } });
  const p = mountSetup(
    new URL(
      "../apps/web/src/features/auth/InvitationPage.vue",
      import.meta.url,
    ),
    {
      useSession,
      useAction,
      parseGuestInvitation,
      rememberInvitation,
      pendingInvitation,
      clearInvitation,
      RequestFailure,
      useRoute: () => route,
      useRouter: () => ({ replace }),
      LoginPanel: {},
      Notice: {},
    },
  );
  dispose.push(p.unmount);
  return { ...p, session, route, replace };
}
it("an admitted registered viewer joins only after confirmation and removes the capability from history", async () => {
  const p = invitationPage();
  p.session.api = vi.fn().mockResolvedValue({});
  expect(p.session.api).not.toHaveBeenCalled();
  await p.controls.join();
  expect(p.session.api).toHaveBeenCalledWith(
    `/rooms/${room}/join`,
    "POST",
    { token },
    expect.any(AbortSignal),
  );
  expect(p.replace).toHaveBeenCalledWith(`/rooms/${room}`);
  expect(pendingInvitation(room)).toBeNull();
});
it.each(["INVALID_INVITE", "FORBIDDEN"])(
  "a revoked or expired invitation rejection (%s) keeps the error and never navigates into the room",
  async (code) => {
    const p = invitationPage();
    p.session.api = vi
      .fn()
      .mockRejectedValue(new RequestFailure({ error: { code } }));
    await p.controls.join();
    expect(p.controls.error.value).not.toBe("");
    expect(p.replace).not.toHaveBeenCalled();
    expect(pendingInvitation(room)).toBeNull();
  },
);
it("an incomplete or explicitly invalid link never uses a different saved room invitation", async () => {
  const p = invitationPage();
  p.route.params.roomId = "22222222-2222-4222-8222-222222222222";
  p.route.fullPath = `/invite/${p.route.params.roomId}`;
  p.route.hash = "";
  p.session.api = vi.fn();
  await p.controls.join();
  expect(p.controls.invitation.value).toBeNull();
  expect(p.session.api).not.toHaveBeenCalled();
  p.route.params.roomId = room;
  p.route.fullPath = `/invite/${room}#token=invalid`;
  p.route.hash = "#token=invalid";
  await p.controls.join();
  expect(p.controls.invitation.value).toBeNull();
  expect(p.session.api).not.toHaveBeenCalled();
});
it("changing invitation pages aborts and fences an earlier pending join", async () => {
  const p = invitationPage();
  let finish!: (value: unknown) => void;
  p.session.api = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  ) as any;
  const joining = p.controls.join();
  const signal = (p.session.api as any).mock.calls[0][3] as AbortSignal;
  const nextRoom = "22222222-2222-4222-8222-222222222222";
  p.route.params.roomId = nextRoom;
  p.route.fullPath = `/invite/${nextRoom}#token=${token}`;
  await nextTick();
  expect(signal.aborted).toBe(true);
  finish({});
  await joining;
  expect(p.replace).not.toHaveBeenCalled();
  expect(pendingInvitation(nextRoom)).toEqual({ room_id: nextRoom, token });
});
function loginPage(props: Record<string, unknown> = {}) {
  setActivePinia(createPinia());
  const session = useSession();
  session.api = vi.fn(async () => ({
    registration_mode: "open",
    guests_enabled: true,
  })) as any;
  vi.stubGlobal("document", { getElementById: () => ({ focus: vi.fn() }) });
  vi.stubGlobal("window", { location: { origin } });
  const p = mountSetup(
    new URL("../apps/web/src/features/auth/LoginPanel.vue", import.meta.url),
    {
      useSession,
      useAction,
      useRegistrationPolicy,
      guestRoomPath,
      parseGuestInvitation,
      validateNickname,
      clearInvitation,
      authenticationLocation,
      safeRedirect,
      RequestFailure,
      useRoute: () => ({ query: {} }),
      useRouter: () => ({ replace: vi.fn() }),
      Notice: {},
    },
    props,
  );
  dispose.push(p.unmount);
  return { ...p, session };
}
it("empty account and guest submissions show local Chinese validation without sending mutations", async () => {
  const p = loginPage();
  p.session.login = vi.fn();
  p.session.guest = vi.fn();
  await vi.waitFor(() => expect(p.controls.policyLoading.value).toBe(false));
  await p.controls.submitLogin();
  expect(p.controls.loginField.value).toBe("username");
  expect(p.controls.error.value).toBe("请填写登录账号。");
  expect(p.session.login).not.toHaveBeenCalled();
  p.controls.error.value = "";
  await p.controls.submitGuest();
  expect(p.controls.guestError.value).toContain("请粘贴");
  expect(p.controls.guestOpen.value).toBe(true);
  expect(p.controls.error.value).toBe("");
  expect(p.session.guest).not.toHaveBeenCalled();
});
it("landing opens the guest section and keeps tokens out of the signup redirect query", () => {
  const p = loginPage({
    invitation: { room_id: room, token },
    returnPath: `/invite/${room}#token=${token}`,
  });
  expect(p.controls.guestOpen.value).toBe(true);
  expect(parseGuestInvitation(p.controls.guestInvite.value, origin)).toEqual({
    room_id: room,
    token,
  });
  expect(p.controls.registration.value.query.redirect).toBe(`/invite/${room}`);
  expect(JSON.stringify(p.controls.registration.value)).not.toContain(token);
});
it("success notices expire, replacement notices get a new timeout, and errors remain visible", () => {
  vi.useFakeTimers();
  const scope = effectScope();
  const action = scope.run(useAction)!;
  action.error.value = "persistent failure";
  action.message.value = "first";
  vi.advanceTimersByTime(4000);
  action.message.value = "second";
  vi.advanceTimersByTime(4000);
  expect(action.message.value).toBe("second");
  vi.advanceTimersByTime(1000);
  expect(action.message.value).toBe("");
  expect(action.error.value).toBe("persistent failure");
  action.message.value = "dismiss";
  action.dismissMessage();
  expect(action.message.value).toBe("");
  scope.stop();
});
it("transient feedback cleanup cancels its timer when the page goes away", () => {
  vi.useFakeTimers();
  const message = ref("done"),
    scope = effectScope();
  scope.run(() => useTransientMessage(message));
  scope.stop();
  vi.advanceTimersByTime(10000);
  expect(message.value).toBe("done");
});
it("saved light/dark choices override system changes, while system mode follows them", () => {
  const dataset: Record<string, string> = {},
    listeners: Record<string, () => void> = {};
  const media = {
    matches: true,
    addEventListener: (_: string, callback: () => void) => {
      listeners.media = callback;
    },
    removeEventListener: vi.fn(),
  };
  const store = new Map([["rainsync.theme", "system"]]);
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("window", {
    matchMedia: () => media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k),
    setItem: (k: string, v: string) => store.set(k, v),
  });
  dispose.push(initializeTheme());
  expect(dataset.theme).toBe("dark");
  setThemePreference("light");
  media.matches = true;
  listeners.media!();
  expect(dataset.theme).toBe("light");
  expect(store.get("rainsync.theme")).toBe("light");
  setThemePreference("system");
  media.matches = false;
  listeners.media!();
  expect(dataset.theme).toBe("light");
  media.matches = true;
  listeners.media!();
  expect(dataset.theme).toBe("dark");
  expect(themePreference.value).toBe("system");
});
function luminance(hex: string) {
  const rgb = hex.replace("#", "");
  const full =
    rgb.length === 3
      ? rgb
          .split("")
          .map((c) => c + c)
          .join("")
      : rgb;
  const channels = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
it("both themes meet AA for primary buttons, hover labels and auxiliary text", () => {
  const css = readFileSync(
    new URL("../apps/web/src/styles/tokens.css", import.meta.url),
    "utf8",
  );
  const blocks = [
    css.split(':root[data-theme="dark"]')[0]!,
    css.split(':root[data-theme="dark"]')[1]!,
  ];
  for (const block of blocks) {
    const value = (name: string) =>
      block.match(new RegExp(`--${name}:\\s*(#[a-f0-9]+)`, "i"))![1]!;
    const contrast = (a: string, b: string) => {
      const x = luminance(value(a)),
        y = luminance(value(b));
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    expect(contrast("text-on-accent", "accent")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("text-on-accent", "accent-hover")).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast("text-secondary", "surface-panel")).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast("text-secondary", "surface-canvas")).toBeGreaterThanOrEqual(
      4.5,
    );
  }
});
