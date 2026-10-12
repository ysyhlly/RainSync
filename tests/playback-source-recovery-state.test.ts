import { afterEach, expect, it, vi } from "vitest";
import { createPlaybackSourceRecoveryState } from "../apps/web/src/features/playback/playback-source-recovery-state";

afterEach(() => vi.unstubAllGlobals());

const facts = (owner: ReturnType<typeof createPlaybackSourceRecoveryState>) => [
  owner.pending,
  owner.failed,
  owner.end,
  owner.recovering,
];

it("constructs passively without allocating a wait or acquiring runtime inputs", () => {
  const allocation = vi.fn(() => {
    throw new Error("no wait was admitted");
  });
  vi.stubGlobal("AbortController", allocation);
  const owner = createPlaybackSourceRecoveryState();
  expect(facts(owner)).toEqual([false, false, undefined, false]);
  expect(allocation).not.toHaveBeenCalled();
});

it("keeps admission with runtime and releases only the exact current wait", () => {
  const owner = createPlaybackSourceRecoveryState();
  const first = owner.beginWait();
  const second = owner.beginWait();
  expect(second).not.toBe(first);
  expect(first.signal.aborted).toBe(false);
  owner.finishWait(first);
  expect(owner.pending).toBe(true);
  first.abort();
  expect(owner.pending).toBe(true);
  expect(second.signal.aborted).toBe(false);
  owner.finishWait(second);
  expect(owner.pending).toBe(false);
});

// Candidate-only contracts supplement the original-runtime caller traces.
// In particular, these reentrant writes do not claim a naturally reachable
// combination of current session facts or a new successor-safety guarantee.
it.each([
  {
    method: "retireSource" as const,
    during: [true, true, 10, true],
    after: [false, false, undefined, false],
  },
  {
    method: "restartSourceRecovery" as const,
    during: [true, true, 10, true],
    after: [false, false, undefined, true],
  },
  {
    method: "resetSeek" as const,
    during: [true, false, undefined, false],
    after: [false, true, 77, true],
  },
  {
    method: "invalidateClock" as const,
    during: [true, true, 10, true],
    after: [false, false, 77, true],
  },
])("preserves $method ordering through synchronous abort reentry", (input) => {
  const owner = createPlaybackSourceRecoveryState();
  const first = owner.beginWait();
  owner.failWait();
  owner.completeAt(10);
  owner.beginRecovery();
  let successor: AbortController | undefined;
  first.signal.addEventListener(
    "abort",
    () => {
      expect(facts(owner)).toEqual(input.during);
      successor = owner.beginWait();
      owner.failWait();
      owner.completeAt(77);
      owner.beginRecovery();
    },
    { once: true },
  );
  owner[input.method]();
  expect(first.signal.aborted).toBe(true);
  expect(successor).toBeDefined();
  expect(successor!.signal.aborted).toBe(false);
  expect(facts(owner)).toEqual(input.after);
});

function finiteSourceRecoveryContracts(
  owner: ReturnType<typeof createPlaybackSourceRecoveryState>,
) {
  // @ts-expect-error Construction has no context or authority dependency.
  createPlaybackSourceRecoveryState({});
  // @ts-expect-error Facts are live readonly properties.
  owner.pending = false;
  // @ts-expect-error Failure writes use the finite transition.
  owner.failed = true;
  // @ts-expect-error End changes use the finite transition.
  owner.end = 0;
  // @ts-expect-error Recovery changes use the finite transition.
  owner.recovering = true;
  // @ts-expect-error The raw controller is not exposed as shared state.
  owner.wait;
  // @ts-expect-error No plan or grant authority is present.
  owner.plan;
  // @ts-expect-error No readiness request API is present.
  owner.readReadiness();
  // @ts-expect-error No media capability is present.
  owner.video;
  // @ts-expect-error No mutable snapshot or generic setter is present.
  owner.setState({});
  // @ts-expect-error Only the original controller identifies a finally release.
  owner.finishWait({});
  const controller: AbortController = owner.beginWait();
  const result: void = owner.finishWait(controller);
  void result;
}
void finiteSourceRecoveryContracts;
