import { expect, it, vi } from "vitest";
import {
  createPlaybackGesture,
  type GesturePlaybackSelection,
  type GesturePlaybackTarget,
} from "../apps/web/src/features/playback/playback-gesture";

it("assembles the gesture action without reading unfinished runtime ports", () => {
  const premature = vi.fn(() => {
    throw new Error("runtime not assembled");
  });
  const action = createPlaybackGesture({
    active: premature,
    capture: premature,
    clockUsable: premature,
    clockRevision: premature,
    queueApply: premature,
    synchronization: {
      ensureBaseRate: premature,
      get pendingPlay() {
        return premature();
      },
      beginGesture: premature,
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
    isFailure: premature,
    interrupt: premature,
    clearInterruption: premature,
    observe: premature,
    reconcile: premature,
  });
  expect(action).toBeTypeOf("function");
  expect(action.name).toBe("enablePlayback");
  expect(premature).not.toHaveBeenCalled();
});

function finiteGesturePorts(
  context: Parameters<typeof createPlaybackGesture>[0],
  selection: GesturePlaybackSelection,
  target: GesturePlaybackTarget,
) {
  // @ts-expect-error The action receives no general request or grant authority.
  context.api;
  // @ts-expect-error The runtime/store does not cross this use-case boundary.
  context.runtime;
  // @ts-expect-error Automatic apply revisions retain their existing owner.
  context.synchronization.beginApply(true);
  // @ts-expect-error A gesture cannot replace the shared rate tracker.
  context.synchronization.resetRates();
  // @ts-expect-error Only the target adapter can supply raw afterPlay identity.
  context.synchronization.afterPlay;
  // @ts-expect-error Queueing here cannot add a room-wide seek intent.
  context.queueApply(true);
  // @ts-expect-error Success invokes only the preselected forced reconciliation.
  context.reconcile(false);
  // @ts-expect-error Failure categories are bounded to the existing gesture policy.
  context.isFailure({}, "UNOWNED_RETRY");
  // @ts-expect-error Admission facts cannot be overwritten by the policy.
  selection.failed = false;
  // @ts-expect-error The original raw element remains inside its adapter.
  target.element;
  // @ts-expect-error No session/plan data or retry identity escapes.
  target.session_id;
  // @ts-expect-error Raw media writes are replaced by finite effects.
  target.currentTime = 12;
  // @ts-expect-error Rate I/O remains under the existing readback owner.
  target.playbackRate = 2;
  // @ts-expect-error Latest-PAUSE authority stays in the afterPlay adapter.
  target.pause();
  // @ts-expect-error Source attachment is outside the gesture use case.
  target.src = "/replacement";
  // @ts-expect-error The target's selected actions cannot be replaced.
  target.play = () => Promise.resolve();
  context.blocked.value = true;
  target.align(undefined);
}
void finiteGesturePorts;
