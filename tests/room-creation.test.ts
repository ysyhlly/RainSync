import { expect, it, vi } from "vitest";
import { createRoomSubmission } from "../apps/web/src/features/rooms/room-creation";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
import { createApiClient } from "../apps/web/src/shared/api/client";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as Storage;
}

it("creates UUID request keys when the browser only provides getRandomValues", async () => {
  const random = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues: random });
  try {
    const create = vi.fn().mockResolvedValue({ id: "room" });
    await createRoomSubmission(create, () => "user", memoryStorage)("A");
    expect(create.mock.calls[0][1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reuses the request key after an uncertain network failure", async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValue({ id: "original" });
  const submit = createRoomSubmission(create, () => "user", memoryStorage);
  await expect(submit("电影夜")).rejects.toThrow("response lost");
  await expect(submit("电影夜")).resolves.toEqual({ id: "original" });
  expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
});

it("restores an uncertain attempt after a page reload and clears a confirmed result", async () => {
  const store = memoryStorage();
  const create = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("response incomplete"))
    .mockResolvedValue({ id: "original" });
  await expect(
    createRoomSubmission(
      create,
      () => "user",
      () => store,
    )("A"),
  ).rejects.toThrow("response incomplete");
  const reload = createRoomSubmission(
    create,
    () => "user",
    () => store,
  );
  await reload("A");
  expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
  await reload("A");
  expect(create.mock.calls[2][1]).not.toBe(create.mock.calls[1][1]);
  expect(store.getItem("rainsync:room-creation:user")).toBeNull();
});

it("uses new keys for edited names and isolates attempts by account", async () => {
  let user = "a";
  const create = vi.fn().mockRejectedValue(new TypeError("offline"));
  const submit = createRoomSubmission(create, () => user, memoryStorage);
  await expect(submit("A")).rejects.toThrow();
  await expect(submit("B")).rejects.toThrow();
  user = "b";
  await expect(submit("B")).rejects.toThrow();
  expect(new Set(create.mock.calls.map((call) => call[1])).size).toBe(3);
});

it("retains the in-memory request key when browser storage is unavailable", async () => {
  const create = vi.fn().mockRejectedValue(new TypeError("offline"));
  const submit = createRoomSubmission(
    create,
    () => "user",
    () => {
      throw new DOMException("disabled");
    },
  );
  await expect(submit("A")).rejects.toThrow("offline");
  await expect(submit("A")).rejects.toThrow("offline");
  expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
});

it("does not discard a newer uncertain attempt when an older response arrives", async () => {
  const store = memoryStorage();
  let resolveOld!: (value: { id: string }) => void;
  const create = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveOld = done;
        }),
    )
    .mockRejectedValue(new TypeError("offline"));
  const submit = createRoomSubmission(
    create,
    () => "user",
    () => store,
  );
  const first = submit("A");
  await expect(submit("B")).rejects.toThrow("offline");
  resolveOld({ id: "old" });
  await first;
  const reload = createRoomSubmission(
    create,
    () => "user",
    () => store,
  );
  await expect(reload("B")).rejects.toThrow("offline");
  expect(create.mock.calls[1][1]).toBe(create.mock.calls[2][1]);
});

it("rejects a completed response after an account switch without clearing its retry key", async () => {
  const store = memoryStorage();
  let user = "a",
    complete!: (value: { id: string }) => void;
  const create = vi.fn(
    () =>
      new Promise<{ id: string }>((done) => {
        complete = done;
      }),
  );
  const submit = createRoomSubmission(
    create,
    () => user,
    () => store,
  );
  const pending = submit("A");
  user = "b";
  complete({ id: "a-room" });
  await expect(pending).rejects.toThrow("登录身份已变化");
  expect(store.getItem("rainsync:room-creation:a")).not.toBeNull();
});

it("sends the stable key with the exact name and CSRF token through the actual API client", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "room" }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const api = createApiClient({
      identity: () => ({ csrf: "csrf" }),
      epoch: () => 1,
      invalidate: () => {},
    });
    await roomsApi(api).create(" A ", "attempt-key");
    const [path, request] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/rooms");
    expect(request.headers.get("Idempotency-Key")).toBe("attempt-key");
    expect(request.headers.get("x-csrf-token")).toBe("csrf");
    expect(JSON.parse(request.body)).toEqual({ name: " A " });
  } finally {
    vi.unstubAllGlobals();
  }
});
