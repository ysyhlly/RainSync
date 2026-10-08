import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { effect, stop } from "vue";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { usePlatformAccount } from "../apps/web/src/features/account/platform-account.store";
import { StaleIdentity } from "../apps/web/src/shared/api/client";

const providers = ["bilibili", "douyin", "tiktok", "youtube"] as const;
type Provider = (typeof providers)[number];
const disposals: (() => void)[] = [];
const id = "00000000-0000-0000-0000-000000000001";
function status(provider: Provider, revision = "1", state = "connected") {
  const account = { id, provider, revision, state };
  if (provider === "bilibili") return account;
  return {
    ...account,
    login_method:
      provider === "youtube" ? "netscape_cookie_import" : "cookie_import",
    qr_available: false,
    verification: state === "connected" ? "unverified" : "none",
    credential_expires_at: null,
    ...(provider === "youtube"
      ? { account_import_available: true, availability_reason: null }
      : {}),
  };
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 12; ++i) await Promise.resolve();
}
function setup(api: any) {
  const pinia = createPinia();
  setActivePinia(pinia);
  disposals.push(() => disposePinia(pinia));
  const session = useSession();
  session.accept({
    id,
    username: "fixture",
    admin: false,
    csrf: "fixture-login",
  });
  session.api = api;
  const account = usePlatformAccount();
  function select(provider: Provider) {
    return {
      refresh: (force = false) =>
        provider === "bilibili"
          ? account.refresh(force)
          : provider === "youtube"
            ? account.refreshYoutube(force)
            : account.refreshShort(provider, force),
      unlink: (revision = "1") =>
        provider === "bilibili"
          ? account.unlink()
          : provider === "youtube"
            ? account.unlinkYoutube(revision)
            : account.unlinkShort(provider, revision),
      status: () =>
        provider === "bilibili"
          ? account.status
          : provider === "youtube"
            ? account.youtubeStatus
            : account.shortStatuses[provider],
    };
  }
  return { account, session, select };
}
afterEach(() => {
  disposals
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

it.each(providers)(
  "%s coalesces refreshes and preserves a newer pending read after identity retirement",
  async (provider) => {
    const old = deferred(),
      current = deferred();
    const api = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValue(current.promise);
    const { session, select } = setup(api);
    const work = select(provider);
    const first = work.refresh(),
      joined = work.refresh(true);
    const rejected = Promise.all([
      expect(first).rejects.toBeInstanceOf(StaleIdentity),
      expect(joined).rejects.toBeInstanceOf(StaleIdentity),
    ]);
    expect(api).toHaveBeenCalledTimes(1);
    session.clear();
    const fresh = work.refresh();
    old.resolve(status(provider));
    await rejected;
    const freshJoined = work.refresh(true);
    expect(api).toHaveBeenCalledTimes(2);
    current.resolve(status(provider, "2"));
    await Promise.all([fresh, freshJoined]);
    expect(work.status()).toEqual(status(provider, "2"));
    await work.refresh();
    expect(api).toHaveBeenCalledTimes(2);
  },
);

it.each(providers)(
  "%s waits for failed mutation settlement before issuing a forced refresh",
  async (provider) => {
    const response = deferred();
    const api = vi.fn(async (_path: string, method: string) =>
      method === "DELETE" ? response.promise : status(provider),
    );
    const { select } = setup(api);
    const work = select(provider);
    await work.refresh();
    const mutation = work.unlink();
    const rejected = expect(mutation).rejects.toThrow("fixture failure");
    const refresh = work.refresh(true);
    await settle();
    expect(
      api.mock.calls.filter(([, method]) => method === "GET"),
    ).toHaveLength(1);
    await expect(work.unlink("wrong revision")).rejects.toThrow(
      provider === "youtube"
        ? "YouTube 会话操作尚未确认"
        : "平台账号操作尚未确认",
    );
    response.reject(Error("fixture failure"));
    await rejected;
    await refresh;
    expect(
      api.mock.calls.filter(([, method]) => method === "GET"),
    ).toHaveLength(2);
    expect(work.status()).toEqual(status(provider));
  },
);

it("all provider slots mutate independently and retain their own timeouts", async () => {
  const timeoutControllers: {
    milliseconds: number;
    controller: AbortController;
  }[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    timeoutControllers.push({ milliseconds, controller });
    return controller.signal;
  });
  const responses = Object.fromEntries(
    providers.map((provider) => [provider, deferred()]),
  );
  const signals = new Map<Provider, AbortSignal>();
  const api = vi.fn(
    async (
      path: string,
      method: string,
      _body: unknown,
      signal: AbortSignal,
    ) => {
      const provider = path.split("/")[2] as Provider;
      if (method === "DELETE") {
        signals.set(provider, signal);
        return responses[provider].promise;
      }
      return status(provider);
    },
  );
  const { select } = setup(api);
  await Promise.all(providers.map((provider) => select(provider).refresh()));
  const mutations = providers.map((provider) => select(provider).unlink());
  const rejected = expect(mutations[0]).rejects.toBeInstanceOf(StaleIdentity);
  await settle();
  expect(signals.size).toBe(4);
  expect(timeoutControllers.map(({ milliseconds }) => milliseconds)).toEqual([
    30000, 20000, 20000, 20000,
  ]);
  timeoutControllers[0].controller.abort();
  expect(signals.get("bilibili")?.aborted).toBe(true);
  for (const provider of providers.slice(1))
    expect(signals.get(provider)?.aborted).toBe(false);
  for (const provider of providers)
    responses[provider].resolve(status(provider, "2", "revoked"));
  await rejected;
  await Promise.all(mutations.slice(1));
  expect(select("bilibili").status()).toEqual(status("bilibili"));
  for (const provider of providers.slice(1))
    expect(select(provider).status()).toEqual(status(provider, "2", "revoked"));
});

it.each(["douyin", "tiktok", "youtube"] as const)(
  "%s rejects stale revision before retiring a valid pending read",
  async (provider) => {
    const response = deferred();
    let signal!: AbortSignal;
    const api = vi
      .fn()
      .mockResolvedValueOnce(status(provider))
      .mockImplementation(
        (
          _path: string,
          _method: string,
          _body: unknown,
          value: AbortSignal,
        ) => {
          signal = value;
          return response.promise;
        },
      );
    const { select } = setup(api);
    const work = select(provider);
    await work.refresh();
    const refreshing = work.refresh(true);
    await expect(work.unlink("0")).rejects.toBeInstanceOf(StaleIdentity);
    expect(signal.aborted).toBe(false);
    const joined = work.refresh(true);
    expect(api).toHaveBeenCalledTimes(2);
    response.resolve(status(provider, "2"));
    await Promise.all([refreshing, joined]);
    expect(work.status()).toEqual(status(provider, "2"));
  },
);

it("an old mutation cannot unlock or refresh a replacement identity's in-flight mutation", async () => {
  const old = deferred(),
    current = deferred();
  let mutations = 0;
  const api = vi.fn(async (_path: string, method: string) =>
    method === "DELETE"
      ? ++mutations === 1
        ? old.promise
        : current.promise
      : status("youtube"),
  );
  const { session, select } = setup(api);
  const work = select("youtube");
  await work.refresh();
  const first = work.unlink();
  const oldRejected = expect(first).rejects.toBeInstanceOf(StaleIdentity);
  const waiting = work.refresh(true);
  const waitingRejected = expect(waiting).rejects.toBeInstanceOf(StaleIdentity);
  await settle();
  session.clear();
  await work.refresh();
  const second = work.unlink();
  await settle();
  old.resolve(status("youtube", "2", "revoked"));
  await Promise.all([oldRejected, waitingRejected]);
  await expect(work.unlink()).rejects.toThrow("操作尚未确认");
  expect(api.mock.calls.filter(([, method]) => method === "GET")).toHaveLength(
    2,
  );
  current.resolve(status("youtube", "3", "revoked"));
  await second;
  expect(work.status()).toEqual(status("youtube", "3", "revoked"));
});

it("YouTube change notifications still include availability-only changes", async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce(status("youtube"))
    .mockResolvedValueOnce({
      ...status("youtube"),
      account_import_available: false,
      availability_reason: "server_opt_in_required",
    });
  const { account } = setup(api);
  await account.refreshYoutube();
  expect(account.youtubeChange).toBe(0);
  await account.refreshYoutube(true);
  expect(account.youtubeChange).toBe(1);
  expect(account.youtubeStatus?.availability_reason).toBe(
    "server_opt_in_required",
  );
});

it.each(providers)(
  "%s preserves which cached refs a forced refresh observes",
  async (provider) => {
    const api = vi.fn(async () => status(provider));
    const { select } = setup(api);
    const scheduler = vi.fn();
    let pending!: Promise<unknown>;
    const runner = effect(
      () => {
        pending = select(provider).refresh(true);
      },
      { scheduler },
    );
    try {
      await pending;
      expect(scheduler).toHaveBeenCalledTimes(
        provider === "bilibili" || provider === "youtube" ? 0 : 1,
      );
    } finally {
      stop(runner);
    }
  },
);
