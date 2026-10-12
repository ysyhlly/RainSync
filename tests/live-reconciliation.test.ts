import { expect, it, vi } from "vitest";
import {
  createLiveReconciliation,
  type LiveReconciliationTarget,
} from "../apps/web/src/features/playback/live-reconciliation";

it("assembles automatic live reconciliation without reading unfinished runtime ports", () => {
  const premature = vi.fn(() => {
    throw new Error("runtime not assembled");
  });
  const action = createLiveReconciliation({
    synchronization: {
      resetCorrection: premature,
      ensureBaseRate: premature,
      restoreBaseRate: premature,
      clearPendingApply: premature,
      get pendingPlay() {
        return premature();
      },
      get playFailed() {
        return premature();
      },
      claimPlay: premature,
      failPlay: premature,
      releasePlay: premature,
    },
    blocked: {
      get value() {
        return premature();
      },
      set value(_value: boolean) {
        premature();
      },
    },
    foreground: premature,
    clockRevision: premature,
    isPermissionDenied: premature,
    interrupt: premature,
  });
  expect(action).toBeTypeOf("function");
  expect(action.name).toBe("reconcileLive");
  expect(premature).not.toHaveBeenCalled();
});

function finiteLivePorts(
  context: Parameters<typeof createLiveReconciliation>[0],
  target: LiveReconciliationTarget,
) {
  // @ts-expect-error The selected live policy cannot issue any API request.
  context.api;
  // @ts-expect-error Runtime/store authority stays outside this policy.
  context.runtime;
  // @ts-expect-error Preparation/readiness is not a live-policy callback.
  context.readReadiness;
  // @ts-expect-error The admission dispatcher owns the existing apply revision.
  context.synchronization.beginApply(true);
  // @ts-expect-error Live reconciliation cannot introduce a gesture revision.
  context.synchronization.beginGesture();
  // @ts-expect-error One shared rate tracker remains with synchronization.
  context.synchronization.resetRates();
  // @ts-expect-error No new source-retirement or timer authority is passed in.
  context.synchronization.invalidatePlayActions();
  // @ts-expect-error Raw selected plan/element/serial are private to the adapter.
  context.synchronization.afterPlay;
  // @ts-expect-error There is no calibrated VOD clock gate in this policy.
  context.clockUsable();
  // @ts-expect-error The original permanent element does not escape.
  target.element;
  // @ts-expect-error Grants and replacement are outside this policy.
  target.session_id;
  // @ts-expect-error Raw media actuation is not exposed.
  target.currentTime = 3;
  // @ts-expect-error Rate proof and readback remain in the existing owner.
  target.playbackRate = 2;
  // @ts-expect-error Source attachment is not a live reconciliation action.
  target.src = "/replacement";
  // @ts-expect-error Facts cannot be replaced or mirrored in the policy.
  target.needsEdge = true;
  // @ts-expect-error Runtime supplies only this invocation's selected operation.
  target.play = () => Promise.resolve();
  target.requireEdge();
  target.align(12);
  target.afterPlay(1);
  context.blocked.value = false;
}
void finiteLivePorts;
