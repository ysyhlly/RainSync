import { afterEach, expect, it, vi } from "vitest";
import { reactive, nextTick } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { useAction } from "../apps/web/src/shared/use-action";
import {
  parseRoomCleanupStatus,
  cleanupBlockerLabel,
} from "../apps/web/src/features/rooms/room-cleanup";
import { roomPermissionOptions } from "../apps/web/src/features/rooms/room-permissions";
const dispose: (() => void)[] = [];
afterEach(() => {
  dispose.splice(0).forEach((f) => f());
  vi.useRealTimers();
});
function accessPanel(api = vi.fn().mockResolvedValue([])) {
  const runtime = reactive({
    room: { id: "room-a", owner_id: "owner" },
    canManageRoom: true,
    roomActive: true,
    can: () => true,
  });
  const session = reactive({ epoch: 1, api });
  const panel = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomAccessPanel.vue",
      import.meta.url,
    ),
    {
      useRoomRuntime: () => runtime,
      useSession: () => session,
      useAction,
      roomPermissionOptions,
      AppDialog: {},
      Notice: {},
    },
  );
  dispose.push(panel.unmount);
  return { ...panel, runtime, session, api };
}
it("shows loading immediately and keeps the owner visible without allowing owner permission mutation", async () => {
  let resolve!: (value: unknown) => void;
  const api = vi.fn((path: string) =>
    path.endsWith("/members")
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve({ members: [] }),
  );
  const p = accessPanel(api);
  const pending = p.controls.show();
  expect(p.controls.open.value).toBe(true);
  expect(p.controls.loading.value).toBe(true);
  resolve([{ id: "owner", username: "owner", display_name: "房主" }]);
  await pending;
  expect(p.controls.members.value).toHaveLength(1);
  expect(p.controls.otherMembers.value).toEqual([]);
  p.controls.select("owner");
  expect(p.controls.selectedOwner.value).toBe(true);
  await p.controls.save();
  await p.controls.revoke();
  await p.controls.kick();
  expect(api.mock.calls.every((call) => !call[1] || call[1] === "GET")).toBe(
    true,
  );
});
it("does not show old-account members when a pending read finishes after an identity change", async () => {
  let resolve!: (value: unknown) => void;
  const api = vi.fn((path: string) =>
    path.endsWith("/members")
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve({ members: [] }),
  );
  const p = accessPanel(api);
  const pending = p.controls.show();
  p.session.epoch++;
  await nextTick();
  resolve([{ id: "old-member", display_name: "旧身份成员" }]);
  await pending;
  expect(p.controls.open.value).toBe(false);
  expect(p.controls.members.value).toEqual([]);
  expect(p.controls.loading.value).toBe(false);
});
it.each(["save", "revoke", "kick"])(
  "fences a late %s mutation receipt after account and room replacement",
  async (action) => {
    let finish!: (value: unknown) => void, mutationSignal!: AbortSignal;
    const api = vi.fn(
      (
        path: string,
        method?: string,
        _body?: unknown,
        signal?: AbortSignal,
      ) => {
        if (method === "PUT" || method === "DELETE") {
          mutationSignal = signal!;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return Promise.resolve(
          path.endsWith("/members")
            ? [
                { id: "owner", username: "owner", display_name: "房主" },
                { id: "viewer", username: "viewer", display_name: "观看者" },
              ]
            : { members: [] },
        );
      },
    );
    const p = accessPanel(api);
    await p.controls.show();
    p.controls.select("viewer");
    const pending = p.controls.run(() => p.controls[action]());
    expect(p.controls.busy.value).toBe(true);
    p.session.epoch++;
    p.runtime.room = { id: "room-b", owner_id: "owner" };
    p.controls.selected.value = "new-selection";
    const reads = api.mock.calls.length;
    expect(mutationSignal.aborted).toBe(true);
    finish({ ok: true });
    await pending;
    expect(api).toHaveBeenCalledTimes(reads);
    expect(p.controls.message.value).toBe("");
    expect(p.controls.error.value).toBe("");
    expect(p.controls.selected.value).toBe("new-selection");
    expect(p.controls.busy.value).toBe(false);
  },
);
it("labels current cleanup blocker codes in Chinese and falls back for unknown codes", () => {
  const fallback = "尚待确认释放的资源";
  const current = [
    "legacy_agent_drain_unconfirmed",
    "playback_preparation_drain_unconfirmed",
    "media_execution_drain_unconfirmed",
    "static_hls_capture_drain_unconfirmed",
    "agent_transfer_drain_unconfirmed",
    "upstream_operation_unconfirmed",
    "upstream_cleanup_failed",
    "legacy_upstream_cleanup_unconfirmed",
    "upstream_cleanup_pending",
    "playback_revocation_pending",
    "distributed_compute_drain_unconfirmed",
    "room_cleanup_locked",
    "room_cleanup_timeout",
    "room_cleanup_retry",
  ];
  for (const code of current) {
    const label = cleanupBlockerLabel(code);
    expect(label).not.toBe(fallback);
    expect(label).not.toBe(code);
  }
  expect(cleanupBlockerLabel("legacy_upstream")).toBe("上游播放会话");
  expect(cleanupBlockerLabel("not_a_real_blocker")).toBe(fallback);
});
it("preserves an unconfirmed cleanup barrier and defaults legacy retry capability to disabled", () => {
  const status = parseRoomCleanupStatus({
    lifecycle: "closing",
    cleanup: {
      attempts: 3,
      completed: false,
      blockers: ["legacy_upstream"],
      last_error: "unknown_receipt",
    },
  });
  expect(status.cleanup.completed).toBe(false);
  expect(status.cleanup.retryable).toBe(false);
  expect(cleanupBlockerLabel(status.cleanup.blockers[0])).toBe("上游播放会话");
  expect(() =>
    parseRoomCleanupStatus({
      lifecycle: "closed",
      cleanup: { attempts: -1, completed: true },
    }),
  ).toThrow();
  expect(() =>
    parseRoomCleanupStatus({
      lifecycle: "closing",
      cleanup: { attempts: 0, completed: false, blockers: [{}] },
    }),
  ).toThrow();
});
it("cancels polling and ignores a delayed cleanup response on unmount", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void, signal!: AbortSignal;
  const api = vi.fn((_path, _method, _body, passedSignal) => {
    signal = passedSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const runtime = reactive({
    room: { id: "room", lifecycle: "closing" },
    state: { revision: 5 },
    canManageRoom: true,
    refreshMetadata: vi.fn(),
  });
  const panel = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomCleanupPanel.vue",
      import.meta.url,
    ),
    {
      useRoomRuntime: () => runtime,
      useSession: () => ({ epoch: 1, api }),
      useAction,
      parseRoomCleanupStatus,
      cleanupBlockerLabel,
      Notice: {},
    },
  );
  dispose.push(panel.unmount);
  expect(signal.aborted).toBe(false);
  panel.unmount();
  dispose.pop();
  expect(signal.aborted).toBe(true);
  finish({ lifecycle: "closed", cleanup: { attempts: 1, completed: true } });
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(30000);
  expect(api).toHaveBeenCalledOnce();
  expect(runtime.refreshMetadata).not.toHaveBeenCalled();
});
it("reconciles authoritative lifecycle and revision when the terminal websocket event is absent", async () => {
  vi.useFakeTimers();
  const runtime = reactive({
    room: { id: "room", lifecycle: "closing", lifecycle_epoch: 2 },
    state: { revision: 8 },
    canManageRoom: true,
    refreshMetadata: vi.fn(),
    refreshLifecycle: vi.fn(async () => {
      runtime.room.lifecycle = "closed";
      runtime.state.revision = 9;
    }),
  });
  const api = vi
    .fn()
    .mockResolvedValue({
      lifecycle: "closed",
      lifecycle_epoch: 2,
      state: { revision: 9 },
      cleanup: { attempts: 1, completed: true },
    });
  const p = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomCleanupPanel.vue",
      import.meta.url,
    ),
    {
      useRoomRuntime: () => runtime,
      useSession: () => ({ epoch: 1, api }),
      useAction,
      parseRoomCleanupStatus,
      cleanupBlockerLabel,
      Notice: {},
    },
  );
  dispose.push(p.unmount);
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  expect(runtime.refreshLifecycle).toHaveBeenCalledOnce();
  expect(runtime.refreshMetadata).not.toHaveBeenCalled();
  expect(runtime.room.lifecycle).toBe("closed");
  expect(runtime.state.revision).toBe(9);
  await vi.advanceTimersByTimeAsync(10000);
  expect(api).toHaveBeenCalledOnce();
});
it("does not revive cleanup polling when a pending retry finishes after unmount", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const runtime = reactive({
    room: { id: "room", lifecycle: "closing", lifecycle_epoch: 2 },
    state: { revision: 8 },
    canManageRoom: true,
    refreshLifecycle: vi.fn(),
  });
  const api = vi.fn((_path, method) =>
    method === "POST"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({
          lifecycle: "closing",
          cleanup: { attempts: 1, completed: false, retryable: true },
        }),
  );
  const p = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomCleanupPanel.vue",
      import.meta.url,
    ),
    {
      useRoomRuntime: () => runtime,
      useSession: () => ({ epoch: 1, api }),
      useAction,
      parseRoomCleanupStatus,
      cleanupBlockerLabel,
      Notice: {},
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  const pending = p.controls.run(p.controls.retry);
  p.unmount();
  finish({ cleanup: { scheduled: true } });
  await pending;
  await vi.advanceTimersByTimeAsync(30000);
  expect(api).toHaveBeenCalledTimes(2);
  expect(p.controls.message.value).toBe("");
  expect(runtime.refreshLifecycle).not.toHaveBeenCalled();
});

it("keeps polling until a failed terminal-state reconciliation is recovered", async () => {
  vi.useFakeTimers();
  const runtime = reactive({
    room: { id: "room", lifecycle: "closing", lifecycle_epoch: 2 },
    state: { revision: 8 },
    canManageRoom: true,
    refreshLifecycle: vi
      .fn()
      .mockRejectedValueOnce(Error("终态读取暂不可用"))
      .mockImplementation(async () => {
        runtime.room.lifecycle = "closed";
        runtime.state.revision = 9;
      }),
  });
  const api = vi
    .fn()
    .mockResolvedValue({
      lifecycle: "closed",
      cleanup: { attempts: 1, completed: true },
    });
  const p = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomCleanupPanel.vue",
      import.meta.url,
    ),
    {
      useRoomRuntime: () => runtime,
      useSession: () => ({ epoch: 1, api }),
      useAction,
      parseRoomCleanupStatus,
      cleanupBlockerLabel,
      Notice: {},
    },
  );
  dispose.push(p.unmount);
  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.room.lifecycle).toBe("closing");
  expect(p.controls.loadError.value).toBe("终态读取暂不可用");
  await vi.advanceTimersByTimeAsync(3000);
  expect(runtime.refreshLifecycle).toHaveBeenCalledTimes(2);
  expect(runtime.room.lifecycle).toBe("closed");
  expect(runtime.state.revision).toBe(9);
});
