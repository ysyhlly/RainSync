import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  createApiClient,
  StaleIdentity,
} from "../apps/web/src/shared/api/client";
import { useSession } from "../apps/web/src/features/auth/session.store";

afterEach(() => vi.unstubAllGlobals());
it("late auth refresh cannot revert separately saved nickname or avatar", async () => {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept(user("a"));
  const response = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const request = session.load();
  session.updateProfile(
    { display_name: "新的昵称", custom_display_name: "新的昵称" },
    "a",
  );
  session.updateProfile(
    { avatar_url: "/new-avatar", avatar_version: "new" },
    "a",
  );
  response.resolve(
    Response.json({
      ...user("a"),
      display_name: "旧昵称",
      avatar_url: null,
      avatar_version: null,
    }),
  );
  await request;
  expect(session.user?.display_name).toBe("新的昵称");
  expect(session.user?.avatar_version).toBe("new");
});
const user = (id: string) => ({ id, username: id, admin: false, csrf: id });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

it("ignores old identity successes and 401 without logging out a new identity", async () => {
  let epoch = 0;
  const invalidate = vi.fn();
  const first = deferred<Response>(),
    second = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise),
  );
  const api = createApiClient({
    identity: () => user("a"),
    epoch: () => epoch,
    invalidate,
  });
  const a = api("/rooms").catch((e) => e),
    b = api("/sources").catch((e) => e);
  epoch++;
  first.resolve(Response.json([{ id: "private-old-room" }]));
  second.resolve(
    Response.json({ error: { code: "SESSION_EXPIRED" } }, { status: 401 }),
  );
  expect(await a).toBeInstanceOf(StaleIdentity);
  expect(await b).toBeInstanceOf(StaleIdentity);
  expect(invalidate).not.toHaveBeenCalled();
});
it("treats truncated success as uncertain and sends binary bodies without JSON encoding", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("{broken", { status: 201 }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const api = createApiClient({
    identity: () => user("a"),
    epoch: () => 0,
    invalidate: vi.fn(),
  });
  await expect(api("/auth/register", "POST", {})).rejects.toThrow("响应不完整");
  const body = new Blob(["pixels"], { type: "image/png" });
  await api("/users/me/avatar", "PUT", body, undefined, {
    "If-Match": '"none"',
  });
  expect(fetch.mock.calls[1][1].body).toBe(body);
  expect(new Headers(fetch.mock.calls[1][1].headers).get("Content-Type")).toBe(
    "image/png",
  );
  expect(new Headers(fetch.mock.calls[1][1].headers).get("x-csrf-token")).toBe(
    "a",
  );
  expect(fetch.mock.calls[1][1].credentials).toBe("same-origin");
});
it("rejects old me responses after an explicit identity change", async () => {
  setActivePinia(createPinia());
  const s = useSession();
  const response = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const loading = s.load().catch((e) => e);
  s.accept(user("new"));
  response.resolve(Response.json(user("old")));
  expect(await loading).toBeInstanceOf(StaleIdentity);
  expect(s.user?.id).toBe("new");
});
it("keeps profile refreshes in the same identity epoch and invalidates actual expiry", async () => {
  setActivePinia(createPinia());
  const s = useSession();
  s.accept(user("a"));
  const epoch = s.epoch;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ...user("a"), display_name: "昵称" }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: "SESSION_EXPIRED" } }, { status: 401 }),
      ),
  );
  await s.load();
  expect(s.epoch).toBe(epoch);
  expect(s.user?.display_name).toBe("昵称");
  await expect(s.api("/rooms")).rejects.toMatchObject({
    code: "SESSION_EXPIRED",
  });
  expect(s.user).toBeNull();
  expect(s.epoch).toBeGreaterThan(epoch);
});

it("does not accept a login whose actual cookie session belongs to another account", async () => {
  setActivePinia(createPinia());
  const s = useSession();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf: "bob" }))
      .mockResolvedValueOnce(Response.json(user("alice"))),
  );
  await expect(s.login("bob", "password-b")).rejects.toThrow();
  expect(s.user).toBeNull();
});

it("serializes cookie writes until an aborted earlier login has settled", async () => {
  setActivePinia(createPinia());
  const s = useSession();
  const old = deferred<Response>();
  let oldSignal: AbortSignal | undefined;
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/login")) {
        const name = JSON.parse(String(init?.body)).username;
        requests.push(name);
        if (name === "alice") {
          oldSignal = init?.signal ?? undefined;
          return old.promise;
        }
        return Response.json({ csrf: "bob" });
      }
      return Response.json(user("bob"));
    }),
  );
  const first = s.login("alice", "password-a").catch((e) => e);
  await vi.waitFor(() => expect(requests).toEqual(["alice"]));
  const second = s.login("bob", "password-b");
  await Promise.resolve();
  const serialized = requests.length === 1;
  const aborted = oldSignal?.aborted;
  old.resolve(Response.json({ csrf: "alice" }));
  await first;
  await second;
  expect(serialized).toBe(true);
  expect(aborted).toBe(true);
  expect(requests).toEqual(["alice", "bob"]);
  expect(s.user?.username).toBe("bob");
});
