import {
  guestRoomPath,
  parseGuestInvitation,
} from "../apps/web/src/features/auth/guest-session";
import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mountSetup } from "./helpers/mount-setup";
import {
  RegistrationConfirmationRequired,
  useSession,
} from "../apps/web/src/features/auth/session.store";
import {
  useRegistrationPolicy,
  checkedRegistrationPolicy,
  type RegistrationPolicy,
} from "../apps/web/src/features/auth/registration-policy";
import { useAction } from "../apps/web/src/shared/use-action";
import {
  validateAccount,
  validateNickname,
} from "../apps/web/src/features/auth/account-rules";
import {
  authenticationLocation,
  safeRedirect,
} from "../apps/web/src/app/navigation";
import { RequestFailure } from "../apps/web/src/errors";
import { clearInvitation } from "../apps/web/src/features/auth/invitation-intent";
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
function panel(
  mode: RegistrationPolicy["registration_mode"] = "open",
  api?: any,
  file = "RegisterPage",
) {
  setActivePinia(createPinia());
  const session = useSession(),
    replace = vi.fn(),
    focus = vi.fn();
  session.api =
    api ??
    vi.fn(async () => ({ registration_mode: mode, guests_enabled: false }));
  session.register = vi.fn(
    async () => ({ id: "new", username: "valid-user" }) as any,
  );
  vi.stubGlobal("document", { getElementById: () => ({ focus }) });
  const p = mountSetup(
    new URL(`../apps/web/src/features/auth/${file}.vue`, import.meta.url),
    {
      guestRoomPath,
      clearInvitation,
      parseGuestInvitation,
      validateNickname,
      RegistrationConfirmationRequired,
      useSession,
      useRegistrationPolicy,
      useAction,
      validateAccount,
      authenticationLocation,
      safeRedirect,
      RequestFailure,
      useRouter: () => ({ replace }),
      useRoute: () => ({
        query: { redirect: "/rooms/target?invite=room-token#confirm" },
      }),
      Notice: {},
      AppIcon: {},
    },
  );
  dispose.push(p.unmount);
  return { ...p, c: p.controls, session, replace };
}
async function ready(p: ReturnType<typeof panel>) {
  await vi.waitFor(() => expect(p.c.policyLoading.value).toBe(false));
}
function fill(p: ReturnType<typeof panel>) {
  p.c.username.value = "valid-user";
  p.c.password.value = p.c.confirm.value = " valid pass ";
  p.c.nickname.value = "昵称";
}
it.each([
  "DATABASE_ERROR",
  "COMMIT_FAILED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "INVALID_RESPONSE",
  "ALREADY_AUTHENTICATED",
])(
  "reconciles structured %s signup uncertainty without resubmitting or clearing the draft",
  async (code) => {
    const p = panel();
    await ready(p);
    fill(p);
    p.session.register = vi.fn(async () => {
      throw new RequestFailure({ error: { code } });
    });
    p.session.load = vi.fn(async () => {
      throw Error("temporarily unavailable");
    });
    await p.c.register();
    expect(p.c.uncertain.value).toBe(true);
    expect(p.c.password.value).toBe(" valid pass ");
    expect(p.c.username.value).toBe("valid-user");
    await p.c.register();
    expect(p.session.register).toHaveBeenCalledOnce();
    expect(p.session.load).toHaveBeenCalledOnce();
    expect(p.replace).not.toHaveBeenCalled();
  },
);
it("keeps a committed signup receipt and confirms the same account before leaving recovery", async () => {
  const p = panel();
  await ready(p);
  fill(p);
  const receipt = { id: "created-id", username: "valid-user" };
  p.session.register = vi.fn(async () => {
    throw new RegistrationConfirmationRequired(
      receipt,
      new RequestFailure({ error: { code: "SERVICE_UNAVAILABLE" } }),
    );
  });
  p.session.load = vi.fn(async () => {
    throw Error("temporarily unavailable");
  });
  await p.c.register();
  expect(p.c.registrationReceipt.value).toEqual(receipt);
  expect(p.c.uncertain.value).toBe(true);
  expect(p.c.error.value).toContain("账号已创建");
  p.session.load = vi.fn(
    async () => ({ ...receipt, id: "different-id" }) as any,
  );
  expect(await p.c.confirmSession()).toBe(false);
  expect(p.replace).not.toHaveBeenCalled();
  p.session.load = vi.fn(async () => receipt as any);
  await p.c.recover();
  expect(p.replace).toHaveBeenCalledWith(
    "/rooms/target?invite=room-token#confirm",
  );
  expect(p.c.password.value).toBe("");
  expect(p.c.registrationReceipt.value).toBeUndefined();
  expect(p.session.register).toHaveBeenCalledOnce();
});
it("open registration skips invite validation and omits code while preserving safe return", async () => {
  const p = panel();
  await ready(p);
  fill(p);
  p.c.code.value = "must-not-be-sent";
  expect(p.c.step.value).toBe(2);
  await p.c.validate();
  expect(p.session.api).toHaveBeenCalledOnce();
  await p.c.register();
  expect(p.session.register).toHaveBeenCalledWith(
    { username: "valid-user", password: " valid pass ", display_name: "昵称" },
    expect.any(AbortSignal),
  );
  expect(p.replace).toHaveBeenCalledWith(
    "/rooms/target?invite=room-token#confirm",
  );
  expect(p.c.password.value).toBe("");
});
it("invite-only mode preserves the validation step and code payload", async () => {
  const api = vi.fn(async (path: string) =>
    path.endsWith("policy")
      ? { registration_mode: "invite_only", guests_enabled: false }
      : { expires_at: 2000000000000 },
  );
  const p = panel("invite_only", api);
  await ready(p);
  fill(p);
  p.c.code.value = "RS-FIXTURE";
  await p.c.validate();
  expect(p.c.step.value).toBe(2);
  await p.c.register();
  expect(p.session.register).toHaveBeenCalledWith(
    expect.objectContaining({ code: "RS-FIXTURE" }),
    expect.any(AbortSignal),
  );
});
it("closed mode cannot validate or submit signup", async () => {
  const p = panel("closed");
  await ready(p);
  fill(p);
  await p.c.validate();
  await p.c.register();
  expect(p.session.register).not.toHaveBeenCalled();
  expect(p.session.api).toHaveBeenCalledOnce();
});
it("unknown, malformed or failed policy fails closed and can recover by retry", async () => {
  let fail = true;
  const p = panel(
    "open",
    vi.fn(async () =>
      fail
        ? { registration_mode: "open" }
        : { registration_mode: "open", guests_enabled: false },
    ),
  );
  fill(p);
  await p.c.register();
  expect(p.session.register).not.toHaveBeenCalled();
  await ready(p);
  expect(p.c.policy.value).toBeUndefined();
  expect(p.c.policyError.value).toContain("暂时无法");
  await p.c.register();
  expect(p.session.register).not.toHaveBeenCalled();
  fail = false;
  await p.c.reloadPolicy();
  fill(p);
  await p.c.register();
  expect(p.session.register).toHaveBeenCalledOnce();
});
it.each(["REGISTRATION_CLOSED", "REGISTRATION_INVITE_INVALID"])(
  "server %s refreshes changed policy and never retries the write",
  async (error) => {
    let count = 0;
    const p = panel(
      "open",
      vi.fn(async () => ({
        registration_mode:
          ++count === 1
            ? "open"
            : error === "REGISTRATION_CLOSED"
              ? "closed"
              : "invite_only",
        guests_enabled: false,
      })),
    );
    await ready(p);
    fill(p);
    p.session.register = vi.fn(async () => {
      throw new RequestFailure({
        error: { code: error, message: "方式已改变" },
      });
    });
    await p.c.register();
    expect(p.c.registrationMode.value).toBe(
      error === "REGISTRATION_CLOSED" ? "closed" : "invite_only",
    );
    expect(p.c.step.value).toBe(1);
    expect(p.c.password.value).toBe("");
    expect(p.session.register).toHaveBeenCalledOnce();
    expect(p.session.api).toHaveBeenCalledTimes(2);
    expect(p.replace).not.toHaveBeenCalled();
  },
);
it("late policy response after unmount never reopens signup and request is aborted", async () => {
  const pending = deferred<RegistrationPolicy>();
  const api = vi.fn(() => pending.promise);
  const p = panel("open", api);
  p.unmount();
  expect(api.mock.calls[0][3].aborted).toBe(true);
  pending.resolve({ registration_mode: "open", guests_enabled: true });
  await Promise.resolve();
  await Promise.resolve();
  expect(p.c.policy.value).toBeUndefined();
});
it("a newer policy read wins even if an aborted older mock returns open later", async () => {
  const pending = deferred<RegistrationPolicy>();
  let count = 0;
  const p = panel(
    "open",
    vi.fn(() =>
      ++count === 1
        ? pending.promise
        : Promise.resolve({
            registration_mode: "closed",
            guests_enabled: false,
          }),
    ),
  );
  await p.c.reloadPolicy();
  pending.resolve({ registration_mode: "open", guests_enabled: true });
  await Promise.resolve();
  expect(p.c.registrationMode.value).toBe("closed");
});
it("login remains available when public policy fails and registration link keeps original return", async () => {
  const p = panel(
    "open",
    vi.fn(async () => {
      throw Error("unavailable");
    }),
    "LoginPanel",
  );
  await ready(p);
  expect(p.c.registration.value).toEqual(
    authenticationLocation(
      "/register",
      "/rooms/target?invite=room-token#confirm",
      false,
    ),
  );
  p.session.login = vi.fn(async () => ({ username: "valid-user" }) as any);
  p.c.username.value = "valid-user";
  p.c.password.value = "password";
  await p.c.submitLogin();
  expect(p.session.login).toHaveBeenCalledOnce();
  expect(p.replace).toHaveBeenCalled();
});
it("public policy rejects arbitrary modes or nonboolean guest flags", () => {
  expect(() =>
    checkedRegistrationPolicy({
      registration_mode: "public",
      guests_enabled: true,
    } as any),
  ).toThrow();
  expect(() =>
    checkedRegistrationPolicy({
      registration_mode: "open",
      guests_enabled: "true",
    } as any),
  ).toThrow();
});
