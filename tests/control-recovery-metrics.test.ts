import { expect, it, vi } from "vitest";
import {
  CONTROL_RECOVERY_MAX_MS,
  createControlRecoveryMetrics,
  type ControlRecoveryMetricsFence,
} from "../apps/web/src/features/rooms/control-recovery-metrics";

function fixture() {
  let monotonic = 100.4,
    wall = 10_000.4,
    foreground = true;
  let live: ControlRecoveryMetricsFence | undefined = {
    identity: {},
    generation: 1,
  };
  const meter = createControlRecoveryMetrics({
    current: () => live,
    foreground: () => foreground,
    now: () => monotonic,
    wallNow: () => wall,
  });
  const fence = () => live!;
  const advance = (ms: number) => {
    monotonic += ms;
    wall += ms;
  };
  const next = () => {
    live = { identity: live!.identity, generation: live!.generation + 1 };
    meter.beginAttempt(live);
    return live;
  };
  meter.beginAttempt(fence());
  return {
    meter,
    fence,
    advance,
    next,
    open: () => meter.opened(fence()),
    apply: (...args: [unknown?]) =>
      meter.snapshotApplied(fence(), args.length ? args[0] : 1),
    close: (recoverable = true) => meter.disconnected(fence(), recoverable),
    visibility: (value: boolean) => {
      foreground = value;
      meter.visibilityChanged(value);
    },
    replace: () => {
      live = { identity: {}, generation: 1 };
      meter.beginAttempt(live);
    },
    setLive: (value: ControlRecoveryMetricsFence | undefined) => {
      live = value;
    },
    clocks: (value: number, wallValue = value + 9_900) => {
      monotonic = value;
      wall = wallValue;
    },
  };
}

it("starts at the socket open callback and ends at state application with integer milliseconds", () => {
  const s = fixture();
  s.advance(900);
  s.open();
  s.advance(12.8);
  expect(s.apply()).toEqual({
    type: "CONTROL_RECOVERY_METRICS",
    version: 1,
    socket_open_to_state_applied_ms: 13,
    background: false,
  });
});

it("repeated begin/open and snapshots cannot reset a start or emit twice", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.meter.beginAttempt(s.fence());
  s.open();
  s.advance(20);
  expect(s.apply()?.socket_open_to_state_applied_ms).toBe(30);
  expect(s.apply()).toBeUndefined();
  s.advance(50);
  expect(s.apply()).toBeUndefined();
});

it.each([undefined, null, 0, 2, "1", true, { version: 1 }])(
  "an absent or unsupported marker %j never emits a new wire frame",
  (marker) => {
    const s = fixture();
    s.open();
    s.advance(10);
    expect(s.apply(marker)).toBeUndefined();
    expect(s.apply(1)).toBeUndefined();
  },
);

it("an accepted legacy snapshot establishes the baseline for a later negotiated recovery", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.apply(undefined);
  s.advance(30);
  s.close();
  s.advance(100);
  s.next();
  s.open();
  s.advance(20);
  expect(s.apply()).toMatchObject({
    socket_open_to_state_applied_ms: 20,
    disconnect_observed_to_state_applied_ms: 120,
  });
});

it("retains the earliest observed outage through unopened and opened failed attempts", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.apply();
  s.advance(20);
  s.close();
  s.advance(100);
  s.next();
  s.close();
  s.advance(200);
  s.next();
  s.open();
  s.advance(300);
  s.close();
  s.advance(400);
  s.next();
  s.open();
  s.advance(500);
  expect(s.apply()).toMatchObject({
    socket_open_to_state_applied_ms: 500,
    disconnect_observed_to_state_applied_ms: 1_500,
  });
  s.advance(5);
  s.close();
  s.next();
  s.open();
  s.advance(7);
  expect(s.apply()?.disconnect_observed_to_state_applied_ms).toBe(7);
});

it("failed initial joins and deliberate replacement do not invent an outage", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.close();
  s.advance(100);
  s.next();
  s.open();
  s.advance(20);
  expect(s.apply()?.disconnect_observed_to_state_applied_ms).toBeUndefined();
  s.advance(30);
  s.next();
  s.open();
  s.advance(40);
  expect(s.apply()).toMatchObject({ socket_open_to_state_applied_ms: 40 });
});

it("stale connection or room identities cannot open, recover, or clear the current outage", () => {
  const s = fixture(),
    first = s.fence();
  s.open();
  s.apply();
  s.close();
  s.advance(50);
  const second = s.next();
  s.meter.opened(first);
  s.meter.disconnected(first, false);
  expect(s.meter.snapshotApplied(first, 1)).toBeUndefined();
  s.open();
  s.advance(10);
  expect(s.apply()?.disconnect_observed_to_state_applied_ms).toBe(60);
  s.replace();
  s.meter.opened(second);
  expect(s.meter.snapshotApplied(second, 1)).toBeUndefined();
  s.open();
  s.advance(2);
  expect(s.apply()?.socket_open_to_state_applied_ms).toBe(2);
});

it("a lost current auth fence silently drops callbacks", () => {
  const s = fixture(),
    captured = s.fence();
  s.open();
  s.setLive(undefined);
  s.advance(5);
  expect(s.meter.snapshotApplied(captured, 1)).toBeUndefined();
  expect(() => s.meter.disconnected(captured, false)).not.toThrow();
});

it("a new room identity owns its own clock boundaries", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.replace();
  s.clocks(1, 1);
  s.open();
  s.advance(2);
  expect(s.apply()).toMatchObject({ socket_open_to_state_applied_ms: 2 });
});

it("a close callback fences later open and snapshot callbacks on that socket", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.close();
  s.open();
  expect(s.apply()).toBeUndefined();
});

it("fatal stop and reset drop pending outage before a successor attempt", () => {
  const s = fixture();
  s.open();
  s.apply();
  s.close();
  s.advance(10);
  s.next();
  s.open();
  s.close(false);
  s.next();
  s.open();
  s.advance(3);
  expect(s.apply()?.disconnect_observed_to_state_applied_ms).toBeUndefined();
  s.close();
  s.meter.reset();
  s.next();
  s.open();
  s.advance(4);
  expect(s.apply()?.disconnect_observed_to_state_applied_ms).toBeUndefined();
});

it("disposal is permanent and produces no final packet", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.meter.dispose();
  expect(s.apply()).toBeUndefined();
  s.next();
  s.open();
  s.advance(20);
  expect(s.apply()).toBeUndefined();
});

it("background time stays in the callback interval even after foreground resumes", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.visibility(false);
  s.advance(100);
  s.visibility(true);
  s.advance(20);
  expect(s.apply()).toMatchObject({
    socket_open_to_state_applied_ms: 130,
    background: true,
  });
});

it("background during reconnect backoff is retained independently of the final socket", () => {
  const s = fixture();
  s.open();
  s.apply();
  s.close();
  s.advance(10);
  s.visibility(false);
  s.advance(100);
  s.visibility(true);
  s.next();
  s.open();
  s.advance(20);
  expect(s.apply()).toMatchObject({
    socket_open_to_state_applied_ms: 20,
    disconnect_observed_to_state_applied_ms: 130,
    background: true,
  });
});

it("being hidden only before the socket opens does not fabricate a background interval", () => {
  const s = fixture();
  s.visibility(false);
  s.advance(100);
  s.visibility(true);
  s.open();
  s.advance(10);
  expect(s.apply()?.background).toBe(false);
});

it.each([NaN, Infinity, -1, 50, CONTROL_RECOVERY_MAX_MS + 101])(
  "invalid, backwards, or over-horizon monotonic time %j drops measurement",
  (value) => {
    const s = fixture();
    s.open();
    s.clocks(value);
    expect(s.apply()).toBeUndefined();
  },
);

it("accepts the exact duration horizon without resetting or clamping it", () => {
  const s = fixture();
  s.open();
  s.advance(CONTROL_RECOVERY_MAX_MS);
  expect(s.apply()?.socket_open_to_state_applied_ms).toBe(
    CONTROL_RECOVERY_MAX_MS,
  );
});

it("a suspended monotonic clock or wall-clock jump discards the whole sample", () => {
  const s = fixture();
  s.open();
  s.clocks(110.4, 30_010.4);
  expect(s.apply()).toBeUndefined();
});

it("a discontinuous older outage also discards an otherwise valid socket interval", () => {
  const s = fixture();
  s.open();
  s.apply();
  s.close();
  s.clocks(110.4, 30_010.4);
  s.next();
  s.open();
  s.advance(10);
  expect(s.apply()).toBeUndefined();
});

it("an observed clock reversal during a failed retry cannot disappear from outage coverage", () => {
  const s = fixture();
  s.open();
  s.apply();
  s.close();
  s.advance(100);
  s.next();
  s.open();
  s.clocks(150.4, 10_150.4);
  s.close();
  s.clocks(300.4, 10_200.4);
  s.next();
  s.open();
  s.advance(10);
  expect(s.apply()?.disconnect_observed_to_state_applied_ms).toBeUndefined();
});

it("persisted page restore drops timing while keeping control application independent", () => {
  const s = fixture();
  s.open();
  s.advance(10);
  s.meter.suspended();
  expect(s.apply()).toBeUndefined();
  s.close();
  s.next();
  s.open();
  s.advance(3);
  expect(s.apply()?.disconnect_observed_to_state_applied_ms).toBe(3);
});

it("throwing environment callbacks do not escape into control work", () => {
  const fence = { identity: {}, generation: 1 };
  const meter = createControlRecoveryMetrics({
    current: () => fence,
    foreground: () => {
      throw Error("gone");
    },
    now: () => 1,
    wallNow: () => 1,
  });
  expect(() => {
    meter.beginAttempt(fence);
    meter.opened(fence);
  }).not.toThrow();
  expect(meter.snapshotApplied(fence, 1)).toBeUndefined();
  const gone = createControlRecoveryMetrics({
    current: () => {
      throw Error("gone");
    },
    foreground: () => true,
  });
  expect(() => gone.beginAttempt(fence)).not.toThrow();
});

it("the pure helper creates no timers or persistent queue", () => {
  const timeout = vi.spyOn(globalThis, "setTimeout"),
    interval = vi.spyOn(globalThis, "setInterval");
  try {
    const s = fixture();
    s.open();
    s.advance(100);
    s.apply();
    s.close();
    s.meter.dispose();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
    interval.mockRestore();
  }
});
