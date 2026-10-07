import { afterEach, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import * as timeline from "../apps/web/src/features/rooms/timeline-chat";
import * as viewState from "../apps/web/src/features/rooms/timeline-view-state";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  let fail = true;
  const api = vi.fn(async (path: string) => {
    if (fail) {
      fail = false;
      throw new Error("Temporary timeline read failure");
    }
    if (path.endsWith("/current"))
      return {
        activity: null,
        can_moderate: false,
        can_assign_moderator: false,
      };
    if (path.endsWith("/activities")) return { items: [] };
    throw new Error(`Unexpected request ${path}`);
  });
  const runtime = reactive({
    room: { id: "room" },
    connected: true,
    roomActive: true,
    state: { media_id: "movie", media_generation: 1 },
    position: 0,
    messages: [] as { id: string; body: string; deleted?: boolean }[],
    lastChatDeletion: undefined as string | undefined,
  });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const panel = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/TimelineChatPanel.vue",
      import.meta.url,
    ),
    {
      document,
      useRoomRuntime: () => runtime,
      useSession: () => ({ epoch: 1, api }),
      ...timeline,
      ...viewState,
    },
    { visible: true },
  );
  cleanup.push(panel.unmount);
  return { ...panel, api, runtime, document };
}

it("only deletion changes tombstone the timeline window; ordinary chat edits do not rebuild it", async () => {
  const p = fixture();
  const message = { id: "comment", body: "original", deleted: false };
  p.controls.comments.value = [message];
  p.runtime.messages = [{ ...message }];
  await nextTick();
  const window = p.controls.comments.value;
  p.runtime.messages[0].body = "ordinary edit";
  p.runtime.messages.push({ id: "new-chat", body: "hello" });
  await nextTick();
  expect(p.controls.comments.value).toBe(window);
  p.runtime.messages[0].deleted = true;
  await nextTick();
  expect(p.controls.comments.value[0]).toMatchObject({
    deleted: true,
    body: "",
  });
  const deletedWindow = p.controls.comments.value;
  p.runtime.lastChatDeletion = "comment";
  await nextTick();
  expect(p.controls.comments.value).toBe(deletedWindow);
});

it("unmount aborts a pending history read and removes visibility listeners without reviving polling", async () => {
  const p = fixture();
  let signal!: AbortSignal, finish!: (value: unknown) => void;
  p.api.mockImplementation((_path, _method, _body, requestSignal) => {
    signal = requestSignal!;
    return new Promise((resolve) => (finish = resolve)) as any;
  });
  p.controls.selected.value = "activity";
  await nextTick();
  expect(signal.aborted).toBe(false);
  p.unmount();
  expect(signal.aborted).toBe(true);
  p.document.hidden = true;
  p.document.dispatchEvent(new Event("visibilitychange"));
  expect(p.controls.pageVisible.value).toBe(true);
  finish({ items: [], next_before: null, next_after: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(p.controls.comments.value).toEqual([]);
});

it("clears a transient read error when the scheduled refresh succeeds", async () => {
  const p = fixture();
  p.controls.opened.value = true;
  await nextTick();
  await Promise.resolve();
  expect(p.controls.displayError.value).toBe("Temporary timeline read failure");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(p.controls.refreshError.value).toBe("");
  expect(p.controls.displayError.value).toBe("");
  const calls = p.api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3_000);
  expect(p.api.mock.calls.length).toBe(calls + 2);
});

it("a recovered read does not clear an unresolved message or moderation error", async () => {
  const p = fixture();
  p.controls.opened.value = true;
  await nextTick();
  await Promise.resolve();
  p.controls.error.value = "Message send result still unconfirmed";
  await vi.advanceTimersByTimeAsync(10_000);
  expect(p.controls.refreshError.value).toBe("");
  expect(p.controls.error.value).toBe("Message send result still unconfirmed");
  expect(p.controls.displayError.value).toBe(
    "Message send result still unconfirmed",
  );
});

it("recovers a failed selected-activity read without hiding an older-page failure", async () => {
  const p = fixture();
  const activity = {
    id: "00000000-0000-4000-8000-000000000001",
    media_id: "00000000-0000-4000-8000-000000000020",
    media_generation: 1,
    lifecycle_epoch: 1,
    versioned: true,
  };
  let messagesFail = true;
  p.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/current"))
      return {
        activity,
        can_moderate: false,
        can_assign_moderator: false,
      } as any;
    if (path.endsWith("/activities")) return { items: [activity] } as any;
    if (path.includes("/messages?")) {
      if (messagesFail) throw new Error("Selected activity read failed");
      return { items: [], next_before: null, next_after: null } as any;
    }
    if (path.includes("/reactions?"))
      return { items: [], server_now_ms: Date.now() } as any;
    throw new Error(`Unexpected request ${path}`);
  });
  p.controls.opened.value = true;
  await nextTick();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.controls.selectionError.value).toBe("Selected activity read failed");
  messagesFail = false;
  p.controls.olderError.value = "Older page still needs retry";
  await vi.advanceTimersByTimeAsync(10_000);
  expect(p.controls.selectionError.value).toBe("");
  expect(p.controls.refreshError.value).toBe("");
  expect(p.controls.displayError.value).toBe("Older page still needs retry");
});
