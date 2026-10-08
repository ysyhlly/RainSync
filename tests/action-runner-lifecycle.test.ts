import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { effectScope } from "vue";
import { useAction } from "../apps/web/src/shared/use-action";
import { actionErrorMessage } from "../apps/web/src/shared/action-error";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { PlaybackCancelled } from "../apps/web/src/playback-request";
import { StaleIdentity } from "../apps/web/src/shared/api/client";

const disposals: (() => void)[] = [];
afterEach(() => {
  disposals
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
function pageAction() {
  const scope = effectScope();
  disposals.push(() => scope.stop());
  return { action: scope.run(() => useAction())!, scope };
}
function roomAction() {
  vi.useFakeTimers();
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  disposals.push(() => disposePinia(pinia));
  const session = useSession();
  session.accept({
    id: "fixture-user",
    username: "fixture",
    admin: false,
    csrf: "fixture-login",
  });
  session.api = vi.fn(async () => ({})) as any;
  return { action: useRoomRuntime(), session };
}

it("pure error formatting preserves Error messages and non-Error coercion", () => {
  expect(actionErrorMessage(Error("fixture"))).toBe("fixture");
  expect(actionErrorMessage("fixture string")).toBe("fixture string");
  expect(actionErrorMessage(null)).toBe("null");
  expect(actionErrorMessage({ toString: () => "fixture object" })).toBe(
    "fixture object",
  );
});

it("page busy tracks the latest action while room busy tracks every pending action", async () => {
  const page = pageAction().action,
    room = roomAction().action;
  const oldPage = deferred(),
    newPage = deferred(),
    oldRoom = deferred(),
    newRoom = deferred();
  const firstPage = page.run(() => oldPage.promise),
    lastPage = page.run(() => newPage.promise);
  const firstRoom = room.run(() => oldRoom.promise),
    lastRoom = room.run(() => newRoom.promise);
  newPage.resolve();
  newRoom.resolve();
  await Promise.all([lastPage, lastRoom]);
  expect(page.busy.value).toBe(false);
  expect(room.busy).toBe(true);
  oldPage.reject(Error("stale page error"));
  oldRoom.reject(Error("stale room error"));
  await Promise.all([firstPage, firstRoom]);
  expect(page.error.value).toBe("");
  expect(room.error).toBe("");
  expect(room.busy).toBe(false);
});

it("page scope disposal and AbortError suppression stay local to the page runner", async () => {
  const { action: page, scope } = pageAction();
  const room = roomAction().action;
  const abort = new DOMException("fixture abort", "AbortError");
  await page.run(async () => {
    throw abort;
  });
  await room.run(async () => {
    throw abort;
  });
  expect(page.error.value).toBe("");
  expect(room.error).toBe("fixture abort");
  const pending = deferred();
  const running = page.run(() => pending.promise);
  scope.stop();
  pending.reject(Error("unmounted error"));
  await running;
  expect(page.error.value).toBe("");
  expect(page.busy.value).toBe(true); // Disposed scope no longer publishes state.
});

it("room preserves existing errors only on request and keeps playback cancellation silent", async () => {
  const room = roomAction().action;
  room.error = "existing room error";
  await room.run(async () => {}, true);
  expect(room.error).toBe("existing room error");
  await room.run(async () => {
    throw new PlaybackCancelled();
  });
  expect(room.error).toBe("");
  await room.run(async () => {
    throw new StaleIdentity();
  });
  expect(room.error).toBe("");
  await room.run(async () => {
    throw { toString: () => "fixture room error" };
  });
  expect(room.error).toBe("fixture room error");
});

it("room leave retires old actions without letting their finalizers clear newer busy state", async () => {
  const room = roomAction().action;
  const old = deferred(),
    current = deferred();
  const first = room.run(() => old.promise);
  await room.leave();
  expect(room.busy).toBe(false);
  const second = room.run(() => current.promise);
  old.reject(Error("old-room failure"));
  await first;
  expect(room.error).toBe("");
  expect(room.busy).toBe(true);
  current.resolve();
  await second;
  expect(room.busy).toBe(false);
});

it("room identity changes suppress failures from the old exact session", async () => {
  const { action: room, session } = roomAction();
  const old = deferred();
  const running = room.run(() => old.promise);
  session.clear();
  old.reject(Error("old-login failure"));
  await running;
  expect(room.error).toBe("");
  expect(room.busy).toBe(false);
});
