import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import {
  guestRoomPath,
  parseGuestInvitation,
} from "../apps/web/src/features/auth/guest-session";
import { useRegistrationPolicy } from "../apps/web/src/features/auth/registration-policy";
import { useAction } from "../apps/web/src/shared/use-action";
import { validateNickname } from "../apps/web/src/features/auth/account-rules";
import {
  authenticationLocation,
  safeRedirect,
} from "../apps/web/src/app/navigation";
import { RequestFailure } from "../apps/web/src/errors";
import { clearInvitation } from "../apps/web/src/features/auth/invitation-intent";
const room = "00000000-0000-4000-8000-000000000001",
  otherRoom = "00000000-0000-4000-8000-000000000002";
const registered = {
  id: "registered",
  username: "registered",
  admin: true,
  csrf: "registered",
};
const guest = () => ({
  id: "guest-one",
  username: "guest-one",
  admin: false,
  csrf: "guest-csrf",
  guest: true,
  guest_room_id: room,
  guest_expires_at: Date.now() + 7200000,
  display_name: "客人",
});
const validToken = "a".repeat(64);
const origin = "https://rainsync.example.test";
const dispose: (() => void)[] = [];
afterEach(() => {
  dispose.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function session() {
  setActivePinia(createPinia());
  return useSession();
}
function panel(enabled = true) {
  const s = session();
  s.api = vi.fn(async () => ({
    registration_mode: "invite_only",
    guests_enabled: enabled,
  })) as any;
  const replace = vi.fn();
  vi.stubGlobal("window", { location: { origin } });
  const p = mountSetup(
    new URL("../apps/web/src/features/auth/LoginPanel.vue", import.meta.url),
    {
      useSession,
      clearInvitation,
      useRegistrationPolicy,
      useAction,
      guestRoomPath,
      parseGuestInvitation,
      validateNickname,
      authenticationLocation,
      safeRedirect,
      RequestFailure,
      useRouter: () => ({ replace }),
      useRoute: () => ({ query: { redirect: "/library" } }),
      Notice: {},
    },
  );
  dispose.push(p.unmount);
  return { ...p, c: p.controls, s, replace };
}
async function ready(p: ReturnType<typeof panel>) {
  await vi.waitFor(() => expect(p.c.policyLoading.value).toBe(false));
}

it("parses existing JSON invitations and same-origin room URLs without fetching", () => {
  expect(
    parseGuestInvitation(
      JSON.stringify({
        room_id: room,
        token: ` ${validToken} `,
        role: "viewer",
      }),
      origin,
    ),
  ).toEqual({ room_id: room, token: validToken });
  expect(
    parseGuestInvitation(`/rooms/${room}?invite=${validToken}`, origin),
  ).toEqual({
    room_id: room,
    token: validToken,
  });
  expect(
    parseGuestInvitation(`${origin}/rooms/${room}?token=${validToken}`, origin),
  ).toEqual({ room_id: room, token: validToken });
});
it.each([
  "https://outside.test/rooms/00000000-0000-4000-8000-000000000001?token=x",
  "//outside.test/rooms/x?token=x",
  "javascript:alert(1)",
  "/rooms/not-a-uuid?token=x",
  `/rooms/${room}`,
  `/rooms/${room}?token=a&token=b`,
  JSON.stringify({ room_id: room }),
  JSON.stringify({ room_id: room, token: {} }),
  "just a token",
])("rejects unsafe or incomplete guest invitation %s", (value) => {
  expect(() => parseGuestInvitation(value, origin)).toThrow();
});
it("guest store creates one scoped session and validates subsequent /me before accepting it", async () => {
  const s = session(),
    identity = guest();
  const fetch = vi.fn(async (url: string) => Response.json(identity));
  vi.stubGlobal("fetch", fetch);
  const user = await s.guest(room, "private-token", " 客人 ");
  expect(user.guest).toBe(true);
  expect(guestRoomPath(user)).toBe(`/rooms/${room}`);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/v1/rooms/${room}/guest-session`,
    "/api/v1/auth/me",
  ]);
  const init = fetch.mock.calls[0][1] as any;
  expect(JSON.parse(init.body)).toEqual({
    token: "private-token",
    display_name: "客人",
  });
  expect(init.credentials).toBe("same-origin");
});
it("existing registered session cannot be replaced by guest entry", async () => {
  const s = session();
  s.accept(registered);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(s.guest(room, "token", "")).rejects.toThrow("当前已有登录");
  expect(s.user?.id).toBe(registered.id);
  expect(fetch).not.toHaveBeenCalled();
});
it("a pending normal login cannot be interrupted by guest entry", async () => {
  const s = session(),
    pending = deferred<Response>();
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("/auth/login") ? pending.promise : Response.json(registered),
  );
  vi.stubGlobal("fetch", fetch);
  const login = s.login("registered", "password");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await expect(s.guest(room, "token", "")).rejects.toThrow();
  pending.resolve(Response.json({ csrf: registered.csrf }));
  await login;
  expect(s.user?.id).toBe(registered.id);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each(["room", "kind", "expiry", "admin"])(
  "rejects malformed or mismatched %s guest identity",
  async (kind) => {
    const s = session(),
      identity = guest();
    const me = {
      ...identity,
      ...(kind === "room"
        ? { guest_room_id: otherRoom }
        : kind === "kind"
          ? { guest: false }
          : kind === "expiry"
            ? { guest_expires_at: 1 }
            : { admin: true }),
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(identity))
        .mockResolvedValueOnce(Response.json(me)),
    );
    await expect(s.guest(room, "token", "")).rejects.toThrow();
    expect(s.user).toBeNull();
  },
);
it("/me restore retains guest room and expiry, while malformed metadata cannot become an admin", async () => {
  const s = session(),
    identity = guest();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(identity)),
  );
  await s.restore();
  expect(s.user?.guest).toBe(true);
  expect(s.user?.guest_expires_at).toBe(identity.guest_expires_at);
  expect(() =>
    s.accept({
      ...registered,
      guest: true,
      guest_room_id: room,
      guest_expires_at: Date.now() + 1000,
    }),
  ).toThrow();
  expect(s.user?.guest).toBe(true);
});
it("guest entry requires loaded enabled policy, validates invite, and suppresses duplicate submissions", async () => {
  const p = panel();
  await ready(p);
  const pending = deferred<any>();
  p.s.guest = vi.fn(() => pending.promise);
  p.c.guestInvite.value = JSON.stringify({
    room_id: room,
    token: validToken,
  });
  p.c.guestName.value = "客人";
  const first = p.c.submitGuest();
  await p.c.submitGuest();
  expect(p.s.guest).toHaveBeenCalledOnce();
  pending.resolve(guest());
  await first;
  expect(p.replace).toHaveBeenCalledWith(`/rooms/${room}`);
  expect(p.c.guestInvite.value).toBe("");
  expect(p.c.guestName.value).toBe("");
});
it("disabled guest entry and registered session never call guest mutation", async () => {
  const p = panel(false);
  await ready(p);
  p.s.guest = vi.fn();
  p.c.guestInvite.value = JSON.stringify({ room_id: room, token: validToken });
  await p.c.submitGuest();
  expect(p.s.guest).not.toHaveBeenCalled();
  p.c.policy.value.guests_enabled = true;
  p.s.accept(registered);
  await p.c.submitGuest();
  expect(p.s.guest).not.toHaveBeenCalled();
});
it("unknown guest response stops retries and recovers the current session with read only", async () => {
  const p = panel();
  await ready(p);
  p.s.guest = vi.fn(async () => {
    throw Error("network");
  });
  p.s.load = vi.fn(async () => guest() as any);
  p.c.guestInvite.value = JSON.stringify({
    room_id: room,
    token: validToken,
  });
  await p.c.submitGuest();
  expect(p.c.guestUncertain.value).toBe(true);
  await p.c.submitGuest();
  expect(p.s.guest).toHaveBeenCalledOnce();
  await p.c.recoverGuest();
  expect(p.s.load).toHaveBeenCalledOnce();
  expect(p.replace).toHaveBeenCalledWith(`/rooms/${room}`);
});
it("permission denial refreshes policy, reports a safe failure, and does not reuse invitation", async () => {
  const p = panel();
  await ready(p);
  p.s.guest = vi.fn(async () => {
    throw new RequestFailure({ error: "forbidden" });
  });
  p.c.guestInvite.value = JSON.stringify({
    room_id: room,
    token: validToken,
  });
  await p.c.submitGuest();
  expect(p.c.guestError.value).toContain("非定向观看邀请");
  expect(p.c.error.value).toBe("");
  expect(p.c.guestOpen.value).toBe(true);
  expect(p.s.api).toHaveBeenCalledTimes(2);
  expect(p.replace).not.toHaveBeenCalled();
});
it("guest unmount clears invitation and fences late success navigation", async () => {
  const p = panel();
  await ready(p);
  const pending = deferred<any>();
  p.s.guest = vi.fn(() => pending.promise);
  p.c.guestInvite.value = JSON.stringify({
    room_id: room,
    token: validToken,
  });
  const entering = p.c.submitGuest();
  p.unmount();
  pending.resolve(guest());
  await entering;
  expect(p.c.guestInvite.value).toBe("");
  expect(p.replace).not.toHaveBeenCalled();
});
it("guest confinement routes only to allowed room and hides general navigation in shell", () => {
  expect(guestRoomPath(guest())).toBe(`/rooms/${room}`);
  expect(guestRoomPath(registered)).toBeUndefined();
  expect(
    guestRoomPath({ guest: true, guest_room_id: "../admin" }),
  ).toBeUndefined();
  const router = readFileSync(
    new URL("../apps/web/src/app/router.ts", import.meta.url),
    "utf8",
  );
  expect(router).toContain(
    "if (guestHome && to.path !== guestHome) return guestHome",
  );
  const shell = readFileSync(
    new URL("../apps/web/src/app/AppShell.vue", import.meta.url),
    "utf8",
  );
  expect(shell).toContain('v-if="!session.user.guest"');
  expect(shell).toContain('v-if="session.user && !session.user.guest"');
  expect(shell).toContain("受限访客 · 仅当前房间");
});

it.each([
  "DATABASE_ERROR",
  "COMMIT_FAILED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "REQUEST_TIMEOUT",
])(
  "uncertain %s guest failure requires read-only reconciliation",
  async (code) => {
    const p = panel();
    await ready(p);
    p.s.guest = vi.fn(async () => {
      throw new RequestFailure({ error: { code } });
    });
    p.c.guestInvite.value = JSON.stringify({
      room_id: room,
      token: validToken,
    });
    await p.c.submitGuest();
    await p.c.submitGuest();
    expect(p.c.guestUncertain.value).toBe(true);
    expect(p.s.guest).toHaveBeenCalledOnce();
  },
);
it("expired guest cookie requires explicit logout, without silently consuming another invite", async () => {
  const p = panel();
  await ready(p);
  p.s.guest = vi.fn(async () => {
    throw new RequestFailure({ error: "already_authenticated" });
  });
  p.s.load = vi.fn(async () => {
    throw new RequestFailure({ error: "session_expired" });
  });
  p.s.logout = vi.fn(async () => {});
  p.c.guestInvite.value = JSON.stringify({ room_id: room, token: validToken });
  await p.c.submitGuest();
  expect(p.c.guestNeedsLogout.value).toBe(true);
  await p.c.submitGuest();
  expect(p.s.guest).toHaveBeenCalledOnce();
  expect(p.s.logout).not.toHaveBeenCalled();
  await p.c.clearOldGuestSession();
  expect(p.s.logout).toHaveBeenCalledOnce();
  expect(p.c.guestNeedsLogout.value).toBe(false);
  expect(p.s.guest).toHaveBeenCalledOnce();
  expect(p.c.guestInvite.value).toContain(validToken);
});
it("revoked guest policy reports current availability without exposing private server text", async () => {
  const p = panel();
  await ready(p);
  p.s.guest = vi.fn(async () => {
    throw new RequestFailure({
      error: {
        code: "GUEST_ACCESS_DISABLED",
        message: "private-server-detail",
      },
    });
  });
  p.c.guestInvite.value = JSON.stringify({ room_id: room, token: validToken });
  await p.c.submitGuest();
  expect(p.c.guestError.value).toContain("暂时无法通过此邀请进入");
  expect(p.c.guestError.value).not.toContain("private-server-detail");
  expect(p.c.error.value).toBe("");
  expect(p.c.guestOpen.value).toBe(true);
});

it("old-guest cleanup preserves a registered account that appeared in another tab", async () => {
  const p = panel();
  await ready(p);
  p.c.guestNeedsLogout.value = true;
  p.s.load = vi.fn(async () => {
    p.s.accept(registered);
    return p.s.user!;
  });
  p.s.logout = vi.fn();
  await p.c.clearOldGuestSession();
  expect(p.s.logout).not.toHaveBeenCalled();
  expect(p.s.user?.id).toBe(registered.id);
  expect(p.replace).toHaveBeenCalledWith("/library");
});

it("renders explicit logout recovery separately from uncertain read-only recovery", () => {
  const page = readFileSync(
    new URL("../apps/web/src/features/auth/LoginPanel.vue", import.meta.url),
    "utf8",
  );
  expect(page).toMatch(
    /v-else-if="guestNeedsLogout"[\s\S]*?@click="clearOldGuestSession"[\s\S]*?退出旧访客会话/,
  );
  expect(page).toMatch(/v-else[^>]*@click="recoverGuest"/);
});
