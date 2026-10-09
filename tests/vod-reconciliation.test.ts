import { expect, it, vi } from "vitest";
import {
  createVodReconciliation,
  type VodReconciliationSelection,
} from "../apps/web/src/features/playback/vod-reconciliation";

type Context = Parameters<typeof createVodReconciliation>[0];

it("assembles automatic VOD reconciliation without reading unfinished ports", () => {
  const premature = vi.fn(() => {
    throw new Error("runtime not assembled");
  });
  const context = new Proxy({} as Context, { get: premature });
  const action = createVodReconciliation(context);
  expect(action).toBeTypeOf("function");
  expect(action.name).toBe("reconcileVod");
  expect(premature).not.toHaveBeenCalled();
});

it("passes opaque original inputs once to capture inside the existing async boundary", async () => {
  const failure = new Error("synthetic capture failure");
  const readInput = vi.fn(() => {
    throw new Error("opaque input was read");
  });
  const room = new Proxy({}, { get: readInput });
  const element = new Proxy({}, { get: readInput });
  const plan = new Proxy({}, { get: readInput });
  const capture = vi.fn(
    (s: unknown, el: unknown, p: unknown, serial: number) => {
      expect(s).toBe(room);
      expect(el).toBe(element);
      expect(p).toBe(plan);
      expect(serial).toBe(17);
      throw failure;
    },
  );
  const unexpected = vi.fn(() => {
    throw new Error("policy proceeded after capture failed");
  });
  const context = new Proxy({} as Context, {
    get: (_value, key) => (key === "capture" ? capture : unexpected()),
  });
  const action = createVodReconciliation(context);
  let result: Promise<void> | undefined;
  expect(() => {
    result = action(room, element, plan, 17, true, false);
  }).not.toThrow();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(readInput).not.toHaveBeenCalled();
  expect(unexpected).not.toHaveBeenCalled();
  await expect(result).rejects.toBe(failure);
});

function finiteVodPorts(
  context: Context,
  selected: VodReconciliationSelection,
) {
  // @ts-expect-error There is no generic API or endpoint authority.
  context.api;
  // @ts-expect-error The broad runtime/store stays outside the policy.
  context.runtime;
  // @ts-expect-error Readiness reads are bound to the selected original plan.
  context.readReadiness;
  // @ts-expect-error A fixed automatic load cannot select another intent origin.
  context.prepare("user_intent");
  // @ts-expect-error Fallback cannot choose candidates, a continuation or a SID.
  context.fallback(["candidate"]);
  // @ts-expect-error Admission owns the existing apply serial.
  context.synchronization.beginApply(true);
  // @ts-expect-error The policy cannot reset the shared rate tracker.
  context.synchronization.resetRates();
  // @ts-expect-error Source invalidation retains its existing owner.
  context.synchronization.invalidatePlayActions();
  // @ts-expect-error Exact plan/element identity remains inside the adapter.
  context.synchronization.afterPlay;
  // @ts-expect-error Generated state is live and readonly, never a mirrored owner.
  context.generated.pending = false;
  // @ts-expect-error No controller or generic abort authority crosses the port.
  context.generated.abort();
  // @ts-expect-error Notice effects are bounded to the original policy messages.
  context.notice.error = "new error";
  // @ts-expect-error Original room state is a readonly view.
  selected.state.playback_rate = 2;
  // @ts-expect-error Live state is also readonly within the selected room view.
  selected.state.live!.broadcast_id = "replacement";
  // @ts-expect-error No full plan/session identity escapes.
  selected.plan.session_id;
  // @ts-expect-error Profile presence is a scalar fact, not the whole profile.
  selected.plan.upstream_profile;
  // @ts-expect-error Timeline identity cannot be replaced.
  selected.plan.timeline_origin_ms = 0;
  // @ts-expect-error There is no raw element or source access.
  selected.media.element;
  // @ts-expect-error Media facts are readonly; writes use the finite effect.
  selected.media.currentTime = 3;
  // @ts-expect-error Room rate/readback remains in synchronization.
  selected.media.playbackRate = 2;
  // @ts-expect-error Attachment and grant replacement is not policy authority.
  selected.media.src = "/replacement";
  // @ts-expect-error The selected invocation's effects cannot be replaced.
  selected.media.play = () => Promise.resolve();
  // @ts-expect-error Generated wait cannot substitute a successor SID or plan.
  selected.waitForGenerated("session-2");
  // @ts-expect-error Only the original two play-failure categories are available.
  context.playFailureIs({}, "UNOWNED_RETRY");
  context.generated.resetSeek();
  context.queueApply(true, false);
  context.synchronization.queueApply(true);
  selected.media.seek(3);
  selected.media.afterPlay(1);
}
void finiteVodPorts;

function opaqueVodInputs<RoomInput, ElementInput, PlanInput>(
  context: Parameters<
    typeof createVodReconciliation<RoomInput, ElementInput, PlanInput>
  >[0],
  room: RoomInput,
  element: ElementInput,
  plan: PlanInput,
) {
  // @ts-expect-error Raw dispatcher inputs are opaque inside the generic policy.
  room.playback_status;
  // @ts-expect-error The policy cannot act on the opaque original element.
  element.play();
  // @ts-expect-error It cannot read the raw plan rather than the finite view.
  plan.timeline_origin_ms;
  context.capture(room, element, plan, 1);
}
void opaqueVodInputs;
