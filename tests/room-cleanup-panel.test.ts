import { nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSetup } from "./helpers/mount-setup";
import { useAction } from "../apps/web/src/shared/use-action";
import {
  cleanupBlockerLabel,
  parseRoomCleanupStatus,
  type RoomCleanupStatus,
} from "../apps/web/src/features/rooms/room-cleanup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function cleanupStatus(attempts = 1): RoomCleanupStatus {
  return {
    lifecycle: "closing",
    cleanup: {
      attempts,
      completed: false,
      blockers: ["executions"],
      last_error: null,
      lease_active: false,
      retryable: true,
    },
  };
}

const dispose: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.useRealTimers();
});

function panel() {
  const requests: (ReturnType<typeof deferred<unknown>> & {
    path: string;
    method: string;
    body: unknown;
    signal?: AbortSignal;
  })[] = [];
  // Intentionally allow replies after abort, as a transport can already have
  // queued a response. The real setup must enforce its own identity checks.
  const api = vi.fn(
    (path: string, method: string, body: unknown, signal?: AbortSignal) => {
      const request = { ...deferred<unknown>(), path, method, body, signal };
      requests.push(request);
      return request.promise;
    },
  );
  const room = reactive({
    room: {
      id: "room-a",
      lifecycle: "closing",
      lifecycle_epoch: 7,
      title: "Original title",
    },
    state: { revision: 41 },
    canManageRoom: true,
    refreshLifecycle: vi.fn(async () => {}),
  });
  const session = reactive({ epoch: 3, api });
  const mounted = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomCleanupPanel.vue",
      import.meta.url,
    ),
    {
      useRoomRuntime: () => room,
      useSession: () => session,
      useAction,
      parseRoomCleanupStatus,
      cleanupBlockerLabel,
      Notice: {},
    },
  );
  dispose.push(mounted.unmount);
  return { ...mounted, room, session, api, requests };
}

type Panel = ReturnType<typeof panel>;

async function finishRead(p: Panel, index: number, value = cleanupStatus()) {
  const request = p.requests[index];
  expect(request.method).toBe("GET");
  request.resolve(value);
  await request.promise;
  await nextTick();
}

async function replacePolledRoom(p: Panel) {
  p.room.room = { ...p.room.room, title: "Refreshed title" };
  p.room.state = { revision: p.room.state.revision + 1 };
  await nextTick();
}

async function successfulRetry(p: Panel) {
  const index = p.requests.length;
  const running = p.controls.run(p.controls.retry);
  expect(p.requests[index].method).toBe("POST");
  p.requests[index].resolve({ cleanup: { scheduled: true } });
  await p.requests[index].promise;
  await nextTick();
  await finishRead(p, index + 1, cleanupStatus(2));
  await running;
}

it("keeps an in-flight lifecycle read across equivalent room snapshots", async () => {
  const p = panel();
  const request = p.requests[0];
  expect(p.controls.loading.value).toBe(true);
  await replacePolledRoom(p);
  await replacePolledRoom(p);
  expect(request.signal?.aborted).toBe(false);
  expect(p.controls.loading.value).toBe(true);
  expect(p.api).toHaveBeenCalledTimes(1);

  await finishRead(p, 0);
  expect(p.controls.status.value).toEqual(cleanupStatus());
  expect(p.controls.loading.value).toBe(false);
});

it("keeps a pending retry busy and preserves progress across equivalent room snapshots", async () => {
  const p = panel();
  await finishRead(p, 0);
  const status = p.controls.status.value;
  const running = p.controls.run(p.controls.retry);
  expect(p.controls.busy.value).toBe(true);
  expect(p.requests[1]).toMatchObject({
    path: "/rooms/room-a/cleanup/retry",
    method: "POST",
    body: { expected_revision: 41 },
  });

  await replacePolledRoom(p);
  expect(p.controls.busy.value).toBe(true);
  expect(p.controls.status.value).toBe(status);
  expect(p.controls.loading.value).toBe(false);
  expect(p.api).toHaveBeenCalledTimes(2);

  p.requests[1].resolve({ cleanup: { scheduled: true } });
  await p.requests[1].promise;
  await nextTick();
  expect(p.controls.message.value).toContain("已重新安排清理");
  expect(p.controls.busy.value).toBe(true);
  expect(p.controls.loading.value).toBe(true);
  const refresh = p.requests[2];
  await replacePolledRoom(p);
  expect(refresh.signal?.aborted).toBe(false);
  expect(p.controls.busy.value).toBe(true);
  expect(p.controls.message.value).toContain("已重新安排清理");
  expect(p.api).toHaveBeenCalledTimes(3);

  await finishRead(p, 2, cleanupStatus(2));
  await running;
  expect(p.controls.busy.value).toBe(false);
  expect(p.controls.status.value.cleanup.attempts).toBe(2);
});

it("does not erase a retry failure when polling replaces the room object", async () => {
  const p = panel();
  await finishRead(p, 0);
  const status = p.controls.status.value;
  const running = p.controls.run(p.controls.retry);
  p.requests[1].reject(Error("retry offline"));
  await running;
  expect(p.controls.error.value).toBe("retry offline");

  await replacePolledRoom(p);
  expect(p.controls.error.value).toBe("retry offline");
  expect(p.controls.status.value).toBe(status);
  expect(p.controls.busy.value).toBe(false);
  expect(p.api).toHaveBeenCalledTimes(2);
});

it("does not erase a lifecycle read failure when polling replaces the room object", async () => {
  const p = panel();
  p.requests[0].reject(Error("lifecycle offline"));
  await p.requests[0].promise.catch(() => {});
  await nextTick();
  expect(p.controls.loadError.value).toBe("lifecycle offline");

  await replacePolledRoom(p);
  expect(p.controls.loadError.value).toBe("lifecycle offline");
  expect(p.controls.loading.value).toBe(false);
  expect(p.api).toHaveBeenCalledTimes(1);
});

it("preserves completed retry feedback and the scheduled poll across equivalent snapshots", async () => {
  const p = panel();
  await finishRead(p, 0);
  await successfulRetry(p);
  const message = p.controls.message.value;
  expect(message).toContain("已重新安排清理");
  await replacePolledRoom(p);
  expect(p.controls.message.value).toBe(message);
  expect(p.controls.status.value.cleanup.attempts).toBe(2);
  expect(p.api).toHaveBeenCalledTimes(3);

  vi.advanceTimersByTime(2999);
  expect(p.api).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(1);
  expect(p.api).toHaveBeenCalledTimes(4);
  await finishRead(p, 3, cleanupStatus(3));
  expect(p.controls.message.value).toBe(message);
});

const identityChanges = [
  {
    name: "room ID",
    change: (p: Panel) => {
      p.room.room = { ...p.room.room, id: "room-b" };
    },
  },
  {
    name: "lifecycle epoch",
    change: (p: Panel) => {
      p.room.room.lifecycle_epoch++;
    },
  },
  {
    name: "lifecycle state",
    change: (p: Panel) => {
      p.room.room.lifecycle = "closed";
    },
  },
  {
    name: "session epoch",
    change: (p: Panel) => {
      p.session.epoch++;
    },
  },
];

describe.each(identityChanges)("when $name changes", ({ change }) => {
  it("resets progress and feedback, aborts the old read, and ignores its late terminal response", async () => {
    const p = panel();
    await finishRead(p, 0);
    await successfulRetry(p);
    expect(p.controls.message.value).toContain("已重新安排清理");
    const oldReadIndex = p.requests.length;
    const reading = p.controls.refresh();
    const oldRead = p.requests[oldReadIndex];

    change(p);
    await nextTick();
    expect(oldRead.signal?.aborted).toBe(true);
    expect(p.controls.status.value).toBeUndefined();
    expect(p.controls.message.value).toBe("");
    expect(p.controls.error.value).toBe("");
    expect(p.controls.loadError.value).toBe("");
    expect(p.controls.busy.value).toBe(false);
    const stillClosing = p.room.room.lifecycle === "closing";
    expect(p.controls.loading.value).toBe(stillClosing);
    expect(p.requests).toHaveLength(oldReadIndex + (stillClosing ? 2 : 1));

    // Resolve the stale read before the replacement read: it must neither
    // reconcile a terminal lifecycle nor clear the replacement's loading flag.
    oldRead.resolve({
      ...cleanupStatus(99),
      lifecycle: "closed",
    });
    await reading;
    expect(p.controls.status.value).toBeUndefined();
    expect(p.controls.loading.value).toBe(stillClosing);
    expect(p.room.refreshLifecycle).not.toHaveBeenCalled();
    if (stillClosing) {
      expect(p.requests[oldReadIndex + 1].path).toBe(
        `/rooms/${p.room.room.id}/lifecycle`,
      );
      await finishRead(p, oldReadIndex + 1, cleanupStatus(4));
      expect(p.controls.status.value.cleanup.attempts).toBe(4);
    }
  });

  it.each(["success", "failure"])(
    "resets a pending retry and ignores its late %s",
    async (outcome) => {
      const p = panel();
      await finishRead(p, 0);
      const running = p.controls.run(p.controls.retry);
      const oldRetry = p.requests[1];
      expect(p.controls.busy.value).toBe(true);

      change(p);
      await nextTick();
      expect(p.controls.busy.value).toBe(false);
      expect(p.controls.status.value).toBeUndefined();
      const stillClosing = p.room.room.lifecycle === "closing";
      if (stillClosing) await finishRead(p, 2, cleanupStatus(4));
      const status = p.controls.status.value;
      const requestCount = p.requests.length;

      if (outcome === "success")
        oldRetry.resolve({ cleanup: { scheduled: true } });
      else oldRetry.reject(Error("stale retry failure"));
      await running;
      expect(p.controls.status.value).toBe(status);
      expect(p.controls.error.value).toBe("");
      expect(p.controls.message.value).toBe("");
      expect(p.controls.busy.value).toBe(false);
      expect(p.requests).toHaveLength(requestCount);
    },
  );
});
