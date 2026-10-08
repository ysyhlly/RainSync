import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { usePlatformAccount } from "../apps/web/src/features/account/platform-account.store";
import {
  youtubePlatformAccountApi,
  type YoutubePlatformAccountStatus,
} from "../apps/web/src/features/account/platform-account.api";
import {
  createYoutubeAccountFlow,
  validateYoutubeAccountStatus,
  validYoutubeCookieFile,
} from "../apps/web/src/features/account/youtube-account-flow";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const secret =
  "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-session-only\n.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tsynthetic-login-only\n";
function status(
  revision: string | null = null,
  state: YoutubePlatformAccountStatus["state"] = "revoked",
): YoutubePlatformAccountStatus {
  return {
    id: revision ? id(1) : null,
    provider: "youtube",
    revision,
    state,
    login_method: "netscape_cookie_import",
    qr_available: false,
    verification: state === "connected" ? "unverified" : "none",
    credential_expires_at: null,
    account_import_available: true,
    availability_reason: null,
  };
}
function setup(api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: id(8),
    username: "viewer",
    csrf: "csrf-a",
    admin: false,
  });
  session.api = api;
  return { session, account: usePlatformAccount() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
afterEach(() => vi.restoreAllMocks());

it("YouTube import is distinct from short cookies, explicit and exact-revision bound", async () => {
  const api = vi.fn(async () => status());
  const account = youtubePlatformAccountApi(api as any);
  await account.status();
  await account.importCredential(secret, "3");
  await account.unlink("4");
  expect(api.mock.calls.map((call) => call.slice(0, 3))).toEqual([
    ["/platform-accounts/youtube", "GET", undefined],
    [
      "/platform-accounts/youtube/credential",
      "PUT",
      { cookie_file: secret, consent_to_store: true, expected_revision: "3" },
    ],
    ["/platform-accounts/youtube", "DELETE", { expected_revision: "4" }],
  ]);
});
it("status preserves truthful disabled state and discards unknown secret fields", () => {
  const disabled = {
    ...status(),
    account_import_available: false,
    availability_reason: "server_opt_in_required" as const,
  };
  expect(
    validateYoutubeAccountStatus({ ...disabled, cookie_file: secret } as any),
  ).toEqual(disabled);
  for (const value of [
    { ...status(), provider: "douyin" },
    { ...status(), login_method: "cookie_import" },
    { ...status(), state: "connected" },
    { ...status("3", "connected"), verification: "verified" },
    { ...status(), account_import_available: false },
    { ...status(), qr_available: true },
    { ...status("3", "connected"), credential_expires_at: NaN },
  ])
    expect(() => validateYoutubeAccountStatus(value as any)).toThrow();
});
it("flow clears before request, sends once and keeps closed responses inert", async () => {
  const response = deferred<YoutubePlatformAccountStatus>();
  const phases: string[] = [],
    order: string[] = [];
  const submit = vi.fn(async () => {
    order.push("submit");
    return response.promise;
  });
  const flow = createYoutubeAccountFlow({
    current: () => true,
    submit,
    clearSecret: () => order.push("clear"),
    change: (p) => phases.push(p),
  });
  const work = flow.submit(secret, null, true);
  await flow.submit(secret, null, true);
  expect(order.slice(0, 2)).toEqual(["clear", "submit"]);
  expect(submit).toHaveBeenCalledTimes(1);
  flow.close();
  response.resolve(status("2", "connected"));
  await work;
  expect(phases).toEqual(["submitting"]);
  expect(submit.mock.calls[0]?.[2].aborted).toBe(true);
});
it("consent and format failures never submit or echo provider text", async () => {
  expect(validYoutubeCookieFile(secret)).toBe(true);
  expect(validYoutubeCookieFile("SID=synthetic-only")).toBe(false);
  const submit = vi.fn(async () => {
      throw Error(secret);
    }),
    phases: string[] = [];
  const flow = createYoutubeAccountFlow({
    current: () => true,
    submit,
    clearSecret: () => {},
    change: (p) => phases.push(p),
  });
  await flow.submit(secret, null, false);
  await flow.submit("invalid", null, true);
  expect(submit).not.toHaveBeenCalled();
  expect(phases).toEqual(["invalid"]);
  await flow.submit(secret, null, true);
  expect(phases.at(-1)).toBe("uncertain");
});
it("vault store fences late reads, repeated mutations and stale revisions", async () => {
  const old = deferred<YoutubePlatformAccountStatus>();
  let reads = 0;
  const api = vi.fn(async (_path: string, method: string) =>
    method === "GET"
      ? ++reads === 1
        ? status()
        : old.promise
      : status("2", "connected"),
  );
  const { account } = setup(api);
  await account.refreshYoutube();
  const read = account.refreshYoutube(true),
    rejected = expect(read).rejects.toThrow();
  const imported = account.importYoutube(secret, null);
  await expect(account.unlinkYoutube(null)).rejects.toThrow();
  await imported;
  old.resolve(status());
  await rejected;
  expect(account.youtubeStatus).toEqual(status("2", "connected"));
  expect(account.youtubeChange).toBe(1);
  await expect(account.importYoutube(secret, null)).rejects.toThrow();
});
it("old-identity and cancelled mutations cannot publish saved credentials", async () => {
  for (const cancel of [false, true]) {
    const response = deferred<YoutubePlatformAccountStatus>();
    const api = vi.fn(async (_path: string, method: string) =>
      method === "GET" ? status() : response.promise,
    );
    const { session, account } = setup(api);
    await account.refreshYoutube();
    const controller = new AbortController();
    const work = account.importYoutube(secret, null, controller.signal);
    const rejected = expect(work).rejects.toThrow();
    await Promise.resolve();
    if (cancel) controller.abort();
    else session.clear();
    response.resolve(status("2", "connected"));
    await rejected;
    expect(account.youtubeStatus).toEqual(cancel ? status() : undefined);
  }
});
