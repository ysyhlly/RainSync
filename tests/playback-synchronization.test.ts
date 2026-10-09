import { expect, it, vi } from "vitest";
import { createPlaybackSynchronization } from "../apps/web/src/features/playback/playback-synchronization";
import type { createVodTickPolicy } from "../apps/web/src/features/playback/vod-tick-policy";
import type { createLiveTickPolicy } from "../apps/web/src/features/playback/live-tick-policy";

function setup() {
  const element = { pause: vi.fn(), playbackRate: 1 };
  const state = {
    element,
    plan: {},
    active: true,
    status: "playing",
    rate: 1,
    usable: true,
    revision: 0,
  };
  const clockUsable = vi.fn(() => state.usable);
  const rateSupported = vi.fn();
  const rateRejected = vi.fn();
  const owner = createPlaybackSynchronization({
    element: () => state.element,
    currentPlan: (plan) => plan === state.plan,
    active: () => state.active,
    status: () => state.status,
    rate: () => state.rate,
    captureRateScope: () => {
      const plan = state.plan,
        element = state.element,
        active = state.active;
      return () =>
        state.plan === plan && state.element === element && state.active === active;
    },
    clockUsable,
    clockRevision: () => state.revision,
    rateSupported,
    rateRejected,
  });
  owner.attachRateElement(element);
  return { owner, state, element, clockUsable, rateSupported, rateRejected };
}

it("does not read incomplete runtime assembly during construction", () => {
  const premature = vi.fn(() => {
    throw new Error("runtime is still assembling");
  });
  const owner = createPlaybackSynchronization({
    element: premature,
    currentPlan: premature,
    active: premature,
    status: premature,
    rate: premature,
    captureRateScope: premature,
    clockUsable: premature,
    clockRevision: premature,
    rateSupported: premature,
    rateRejected: premature,
  });
  expect(owner.pendingPlay).toBe(false);
  expect(owner.rateFacts).toBeUndefined();
  expect(premature).not.toHaveBeenCalled();
});

it("clock recovery retains the pending claim and failure latch while source retirement clears them", () => {
  const s = setup();
  s.state.rate = 1.5;
  expect(s.owner.ensureBaseRate()).toBe(true);
  s.owner.applyCorrection(1.575);
  const serial = s.owner.beginApply(false);
  const playing = s.owner.claimPlay();
  s.owner.failPlay();
  s.owner.invalidateClock();
  expect(s.element.playbackRate).toBe(1.5);
  expect(s.owner.pendingPlay).toBe(true);
  expect(s.owner.playFailed).toBe(true);
  expect(s.owner.afterPlay(s.state.plan, s.element, 0, serial)).toBe(false);
  expect(s.element.pause).not.toHaveBeenCalled();
  s.owner.invalidatePlayActions();
  expect(s.owner.pendingPlay).toBe(false);
  expect(s.owner.playFailed).toBe(false);
  s.owner.releasePlay(playing);
});

it("an old finally cannot release a successor play claim", () => {
  const s = setup();
  const first = s.owner.claimPlay();
  s.owner.invalidatePlayActions();
  s.owner.failPlay();
  const second = s.owner.claimPlay(true);
  expect(s.owner.playFailed).toBe(false);
  s.owner.releasePlay(first);
  expect(s.owner.pendingPlay).toBe(true);
  s.owner.releasePlay(second);
  expect(s.owner.pendingPlay).toBe(false);
});

it("a newer PAUSE wins on the same plan and element even through clock invalidation", () => {
  const s = setup();
  const serial = s.owner.beginApply(false);
  s.state.status = "paused";
  s.state.usable = false;
  ++s.state.revision;
  s.owner.invalidateClock();
  expect(s.owner.afterPlay(s.state.plan, s.element, 0, serial)).toBe(false);
  expect(s.element.pause).toHaveBeenCalledOnce();
  const plan = s.state.plan;
  s.state.plan = {};
  expect(s.owner.afterPlay(plan, s.element, 0, serial)).toBe(false);
  expect(s.element.pause).toHaveBeenCalledOnce();
  s.state.plan = plan;
  s.state.element = { pause: vi.fn(), playbackRate: 1 };
  expect(s.owner.afterPlay(plan, s.element, 0, serial)).toBe(false);
  expect(s.element.pause).toHaveBeenCalledOnce();
  expect(s.state.element.pause).not.toHaveBeenCalled();
});

it("checks action identity after a reentrant clock check invalidates it", () => {
  const s = setup();
  const serial = s.owner.beginApply(false);
  s.clockUsable.mockImplementationOnce(() => {
    s.owner.invalidateClock();
    return true;
  });
  expect(s.owner.afterPlay(s.state.plan, s.element, 0, serial)).toBe(false);
  expect(s.element.pause).not.toHaveBeenCalled();
  const next = s.owner.beginGesture();
  expect(s.owner.afterPlay(s.state.plan, s.element, 0, next)).toBe(true);
});

it("records a seek before room admission and lets only its own prepare consume it", () => {
  const s = setup();
  s.state.active = false;
  const requested = s.owner.seekRevision;
  s.owner.beginApply(true);
  s.owner.queueApply(true);
  expect(s.owner.seekRevision).toBe(requested + 1);
  s.owner.preparedSeek(requested);
  expect(s.owner.pendingForce).toBe(true);
  expect(s.owner.pendingUserSeek).toBe(true);
  s.owner.preparedSeek(s.owner.seekRevision);
  expect(s.owner.pendingForce).toBe(false);
  expect(s.owner.pendingUserSeek).toBe(false);
});

it("projects current tracker facts and proof without exposing rate mutation", () => {
  const s = setup();
  const facts = s.owner.rateFacts!;
  expect(Object.keys(facts).sort()).toEqual([
    "baseSupported",
    "fineUnsupported",
  ]);
  expect(facts).not.toHaveProperty("ensureBase");
  expect(s.owner.ensureBaseRate()).toBe(true);
  expect(facts.baseSupported).toBe(true);
  expect(s.owner.confirmedBaseRate).toBe(1);
  s.state.rate = 3;
  expect(s.owner.ensureBaseRate()).toBe(false);
  expect(facts.baseSupported).toBe(false);
  expect(s.owner.confirmedBaseRate).toBe(1);
  expect(s.owner.rejectedBaseRate).toBe(3);
  expect(s.rateRejected).toHaveBeenCalledOnce();
  s.owner.resetRates();
  expect(s.owner.confirmedBaseRate).toBeUndefined();
  expect(s.owner.rejectedBaseRate).toBeUndefined();
  expect(facts.baseSupported).toBe(false);
  expect(s.element.playbackRate).toBe(1);
});

it("keeps synchronous rate effects ahead of proof publication and later action checks", () => {
  const s = setup();
  let rate = 1;
  const effects: string[] = [];
  Object.defineProperty(s.element, "playbackRate", {
    get: () => rate,
    set: (value: number) => {
      rate = value;
      effects.push("rate event");
      s.owner.invalidatePlayActions();
    },
  });
  s.rateSupported.mockImplementation(() => {
    effects.push("proof published");
    expect(s.owner.pendingPlay).toBe(false);
    expect(s.owner.confirmedBaseRate).toBe(1.5);
  });
  const serial = s.owner.beginApply(false);
  s.owner.claimPlay();
  s.state.rate = 1.5;
  expect(s.owner.ensureBaseRate()).toBe(true);
  expect(effects).toEqual(["rate event", "proof published"]);
  expect(s.owner.afterPlay(s.state.plan, s.element, 0, serial)).toBe(false);
});

it("a recovery facts view retains the tracker selected when it was read", () => {
  const s = setup();
  expect(s.owner.ensureBaseRate()).toBe(true);
  const original = s.owner.rateFacts!;
  const replacement = { pause: vi.fn(), playbackRate: 1 };
  s.owner.attachRateElement(replacement);
  expect(s.owner.rateFacts).not.toBe(original);
  expect(original.baseSupported).toBe(true);
  expect(s.owner.rateFacts!.baseSupported).toBe(false);
  s.state.rate = 1.5;
  expect(s.owner.ensureBaseRate()).toBe(true);
  expect(replacement.playbackRate).toBe(1.5);
  expect(s.element.playbackRate).toBe(1);
});

function finiteSynchronizationPorts(
  context: Parameters<typeof createPlaybackSynchronization<object>>[0],
  owner: ReturnType<typeof createPlaybackSynchronization<object>>,
) {
  // @ts-expect-error No session request client belongs to synchronization.
  context.api;
  // @ts-expect-error Play promises remain with the application policy branches.
  context.element()?.play();
  // @ts-expect-error The owner has no source attachment capability.
  context.element()!.src = "/replacement";
  // @ts-expect-error Timeline seeks stay in the VOD/live policy branches.
  context.element()!.currentTime = 20;
  // @ts-expect-error Synchronization receives no mutable clock instance.
  context.clock.reset();
  // @ts-expect-error Pending action state is not a public writable mirror.
  owner.pendingPlay = false;
  // @ts-expect-error A projection cannot mutate rate support evidence.
  owner.rateFacts!.baseSupported = true;
  // @ts-expect-error Recovery gets facts, not the mutable rate tracker.
  owner.rateFacts!.reset();
  // @ts-expect-error No mutable Corrector escapes the shared owner.
  owner.corrector;
}
void finiteSynchronizationPorts;

function finiteVodTickPorts(
  context: Parameters<typeof createVodTickPolicy>[0],
  input: Parameters<ReturnType<typeof createVodTickPolicy>>,
) {
  // @ts-expect-error Periodic correction has no general request client.
  context.api;
  // @ts-expect-error The policy cannot allocate a separate action generation.
  context.synchronization.beginApply(false);
  // @ts-expect-error The shared play claim remains owned by reconciliation.
  context.synchronization.claimPlay();
  // @ts-expect-error The policy cannot replace the shared owner's operations.
  context.synchronization.resetCorrection = () => {};
  // @ts-expect-error Loading facts are not a second mutable state owner.
  context.generationPending = false;
  // @ts-expect-error Only the existing play owner changes the gesture gate.
  context.blocked.value = false;
  // @ts-expect-error A clock snapshot is not mutable clock authority.
  context.clock.reset();
  // @ts-expect-error The selected room timeline is readonly.
  input[0].playback_rate = 2;
  // @ts-expect-error Periodic correction cannot attach a source.
  input[1].src = "/replacement";
  // @ts-expect-error Play promises remain in the existing runtime branches.
  input[1].play();
  // @ts-expect-error Rate writes belong to the existing synchronization owner.
  input[1].playbackRate = 2;
  // @ts-expect-error Periodic correction does not receive session/grant identity.
  input[2].session_id;
  input[1].currentTime = 10;
  context.position.value = 10;
}
void finiteVodTickPorts;

type LiveTickFactory = typeof createLiveTickPolicy<
  Readonly<{ playback_status: string }>,
  object
>;
function finiteLiveTickPorts(
  context: Parameters<LiveTickFactory>[0],
  input: Parameters<ReturnType<LiveTickFactory>>,
) {
  // @ts-expect-error Periodic live convergence has no general request client.
  context.api;
  // @ts-expect-error The live tick cannot claim another play action.
  context.synchronization.claimPlay();
  // @ts-expect-error Decoder-edge policy, not the tick, owns rate operations.
  context.synchronization.ensureBaseRate();
  // @ts-expect-error A tick cannot reset the terminal episode.
  context.terminalEnd = false;
  // @ts-expect-error Existing recovery owns edge-seeking state.
  context.needsEdge = true;
  // @ts-expect-error Only the existing bounded state-change failure is accepted.
  context.fail(input[2], "UNOWNED_RETRY");
  // @ts-expect-error The tick has no room-wide seek authority.
  context.apply(true, true);
  // @ts-expect-error The selected playback status is readonly.
  input[0].playback_status = "playing";
  // @ts-expect-error The tick cannot seek the video itself.
  input[1].currentTime = 10;
  // @ts-expect-error The tick cannot play the video itself.
  input[1].play();
  // @ts-expect-error Rate writes stay with the shared synchronization owner.
  input[1].playbackRate = 2;
  // @ts-expect-error Plan identity is opaque to the periodic policy.
  input[2].session_id;
}
void finiteLiveTickPorts;

it("preserves current outer proof after a synchronous clock restoration attempt", () => {
  let actual = 1;
  let reenter = true;
  const events: string[] = [];
  let owner!: ReturnType<typeof createPlaybackSynchronization<object>>;
  const element = {
    pause: vi.fn(),
    get playbackRate() {
      return actual;
    },
    set playbackRate(value: number) {
      actual = value;
      if (reenter) {
        reenter = false;
        events.push("rate effect");
        owner.invalidateClock();
      }
    },
  };
  const context = {
    element: () => element,
    currentPlan: () => true,
    active: () => true,
    status: () => "playing",
    rate: () => 1.5,
    clockUsable: () => true,
    clockRevision: () => 0,
    captureRateScope: () => () => true,
    rateSupported: () => {
      events.push("supported");
    },
    rateRejected: () => {
      events.push("rejected");
    },
  };
  owner = createPlaybackSynchronization(context);
  owner.attachRateElement(element);
  owner.claimPlay();
  expect(owner.ensureBaseRate()).toBe(true);
  expect(events).toEqual(["rate effect", "rejected", "supported"]);
  expect(owner.rateFacts!.baseSupported).toBe(true);
  expect(owner.confirmedBaseRate).toBe(1.5);
  expect(owner.rejectedBaseRate).toBeUndefined();
  expect(owner.pendingPlay).toBe(true);
});

it.each(["supported", "rejected"])(
  "a %s callback cannot let an old restore read or publish through a successor",
  (outcome) => {
    const s = setup();
    let actual = 1,
      reads = 0,
      successorReads = -1;
    const writes: number[] = [];
    Object.defineProperty(s.element, "playbackRate", {
      get: () => {
        ++reads;
        return actual;
      },
      set: (value: number) => {
        writes.push(value);
        actual = outcome === "rejected" ? 1 : value;
      },
    });
    const callback = outcome === "supported" ? s.rateSupported : s.rateRejected;
    callback.mockImplementationOnce(() => {
      s.state.plan = {};
      s.owner.resetRates();
      s.state.rate = actual = 2;
      expect(s.owner.ensureBaseRate()).toBe(true);
      successorReads = reads;
    });
    s.state.rate = 1.5;
    expect(s.owner.restoreBaseRate()).toBeUndefined();
    expect(reads).toBe(successorReads);
    expect(writes).toEqual([1.5]);
    expect(s.owner.rateFacts!.baseSupported).toBe(true);
    expect(s.owner.confirmedBaseRate).toBe(2);
    expect(s.owner.rejectedBaseRate).toBeUndefined();
  },
);

it("a plan change during rate I/O is silent without resetting successor state", () => {
  const s = setup();
  let actual = 1;
  Object.defineProperty(s.element, "playbackRate", {
    get: () => actual,
    set: (value: number) => {
      actual = value;
      s.state.plan = {};
    },
  });
  s.state.rate = 1.5;
  expect(s.owner.ensureBaseRate()).toBeUndefined();
  expect(s.owner.rateFacts!.baseSupported).toBe(false);
  expect(s.owner.confirmedBaseRate).toBeUndefined();
  expect(s.owner.rejectedBaseRate).toBeUndefined();
  expect(s.rateSupported).not.toHaveBeenCalled();
  expect(s.rateRejected).not.toHaveBeenCalled();
});

it("a replacement tracker retains its own successful rate after an old setter resumes", () => {
  const s = setup();
  let actual = 1;
  const replacement = { playbackRate: 2, pause: vi.fn() };
  Object.defineProperty(s.element, "playbackRate", {
    get: () => actual,
    set: (value: number) => {
      actual = value;
      s.state.element = replacement;
      s.owner.attachRateElement(replacement);
      s.state.rate = 2;
      expect(s.owner.ensureBaseRate()).toBe(true);
    },
  });
  s.state.rate = 1.5;
  expect(s.owner.ensureBaseRate()).toBeUndefined();
  expect(s.owner.rateFacts!.baseSupported).toBe(true);
  expect(s.owner.confirmedBaseRate).toBe(2);
  expect(s.owner.rejectedBaseRate).toBeUndefined();
  expect(replacement.playbackRate).toBe(2);
  expect(s.rateRejected).not.toHaveBeenCalled();
  expect(s.rateSupported).toHaveBeenCalledOnce();
});

it("unsupported publication reports callback retirement before a caller continues", () => {
  const s = setup();
  s.state.rate = 3;
  expect(s.owner.ensureBaseRate()).toBe(false);
  s.rateRejected.mockImplementationOnce(() => {
    s.owner.resetRates();
    s.state.plan = {};
    s.state.rate = 1;
    expect(s.owner.ensureBaseRate()).toBe(true);
  });
  expect(s.owner.reportUnsupportedRate()).toBeUndefined();
  expect(s.owner.confirmedBaseRate).toBe(1);
  expect(s.owner.rejectedBaseRate).toBeUndefined();
  expect(s.owner.rateFacts!.baseSupported).toBe(true);
});

it("current no-tracker and no-rate operations are explicit non-retired no-ops", () => {
  let rate: number | undefined = 1;
  const scope = vi.fn(() => () => true);
  const published = vi.fn();
  const element = { pause: vi.fn(), playbackRate: 1 };
  const owner = createPlaybackSynchronization({
    element: () => element,
    currentPlan: () => true,
    active: () => true,
    status: () => "playing",
    rate: () => rate,
    captureRateScope: scope,
    clockUsable: () => true,
    clockRevision: () => 0,
    rateSupported: published,
    rateRejected: published,
  });
  for (const attached of [false, true]) {
    if (attached) {
      owner.attachRateElement(element);
      rate = undefined;
    }
    expect(owner.ensureBaseRate()).toBe(false);
    expect(owner.restoreBaseRate()).toBe(false);
    expect(owner.applyCorrection(1.05)).toBe(false);
    expect(owner.reportUnsupportedRate()).toBe(false);
  }
  expect(scope).not.toHaveBeenCalled();
  expect(published).not.toHaveBeenCalled();
});
