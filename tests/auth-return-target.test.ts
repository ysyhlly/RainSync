import {
  guestRoomPath,
  parseGuestInvitation,
} from "../apps/web/src/features/auth/guest-session";
import { ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mountSetup } from "./helpers/mount-setup";
import {
  authenticationLocation,
  safeRedirect,
} from "../apps/web/src/app/navigation";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useAction } from "../apps/web/src/shared/use-action";
import {
  validateAccount,
  validateNickname,
} from "../apps/web/src/features/auth/account-rules";
import { RequestFailure } from "../apps/web/src/errors";

afterEach(() => vi.unstubAllGlobals());
const identity = {
  id: "fixture",
  username: "fixture",
  admin: false,
  csrf: "fixture",
};
it("preserves path, query and hash while rejecting unsafe and authentication return targets", () => {
  const target = "/library?search=%E7%94%B5%E5%BD%B1#details";
  expect(safeRedirect(target)).toBe(target);
  expect(authenticationLocation("/register", target, true)).toEqual({
    path: "/register",
    query: { redirect: target, notice: "session-expired" },
  });
  for (const invalid of [
    undefined,
    [target],
    "https://outside.test",
    "//outside.test",
    "/\\outside.test",
    "/library?value=\\outside.test",
    "/%5coutside.test",
    "/%2foutside.test",
    "/login?redirect=/library",
    "/%6cogin",
    "/register#form",
    "/\noutside.test",
    "/%0aoutside.test",
    "/%bad",
  ]) {
    expect(safeRedirect(invalid)).toBe("/rooms");
  }
});
it("login and registration retain the same safe destination and expiry explanation across links", async () => {
  setActivePinia(createPinia());
  const session = useSession();
  const target = "/library?source=fixture#details";
  const route = { query: { redirect: target, notice: "session-expired" } };
  const replace = vi.fn();
  const shared = {
    guestRoomPath,
    parseGuestInvitation,
    validateNickname,
    useSession,
    useRegistrationPolicy: () => ({
      policy: ref({ registration_mode: "invite_only", guests_enabled: false }),
      loading: ref(false),
      error: ref(""),
      reload: vi.fn(),
    }),
    useRouter: () => ({ replace }),
    useRoute: () => route,
    safeRedirect,
    authenticationLocation,
    Notice: {},
    AppIcon: {},
    useAction,
    validateAccount,
    RequestFailure,
  };
  const login = mountSetup(
    new URL("../apps/web/src/features/auth/LoginPage.vue", import.meta.url),
    shared,
  );
  expect(login.controls.registration.value).toEqual(
    authenticationLocation("/register", target, true),
  );
  expect(login.controls.expired.value).toBe(true);
  session.login = vi.fn(async () => identity as any);
  login.controls.username.value = "fixture";
  login.controls.password.value = "synthetic-password";
  await login.controls.login();
  expect(replace).toHaveBeenLastCalledWith(target);
  expect(login.controls.password.value).toBe("");
  login.unmount();
  const registration = mountSetup(
    new URL("../apps/web/src/features/auth/RegisterPage.vue", import.meta.url),
    shared,
  );
  expect(registration.controls.loginLocation.value).toEqual(
    authenticationLocation("/login", target, true),
  );
  await registration.controls.complete();
  expect(replace).toHaveBeenLastCalledWith(target);
  registration.unmount();
});
it("distinguishes an anonymous first visit from a lost or expired session", async () => {
  setActivePinia(createPinia());
  const session = useSession();
  session.invalidate(new RequestFailure({ error: { code: "LOGIN_REQUIRED" } }));
  expect(session.expired).toBe(false);
  session.accept(identity);
  session.invalidate(new RequestFailure({ error: { code: "LOGIN_REQUIRED" } }));
  expect(session.expired).toBe(true);
  session.accept(identity);
  expect(session.expired).toBe(false);
  session.clear();
  session.invalidate(
    new RequestFailure({ error: { code: "SESSION_EXPIRED" } }),
  );
  expect(session.expired).toBe(true);
});
