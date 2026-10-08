import { ref, type DeepReadonly } from "vue";
import { Clock, reconnectDelay } from "../../../../../../packages/sync-engine";
import { RequestFailure, stopsReconnect } from "../../../errors";
import {
  createControlRecoveryMetrics,
  type ControlRecoveryMetricsFence,
} from "../control-recovery-metrics";
import {
  roomProjectionActive,
  type RoomProjection,
} from "../projection/room-projection";

export type RoomFrame = Record<string, unknown>;
export type RoomConnection = Readonly<{
  generation: number;
  room: string;
  identity: number;
}>;

export type RoomTransportObservation = DeepReadonly<
  Pick<RoomProjection, "room" | "state" | "snapshotReady">
>;

type TransportOptions = {
  read: () => RoomTransportObservation;
  identity: () => number;
  restoreSession: () => Promise<unknown>;
  onSessionFailure: (failure: unknown, stale: boolean) => void;
  onBegin: (connection: RoomConnection) => void;
  onOpen: (connection: RoomConnection) => void;
  onClose: (connection: RoomConnection) => void;
  onFrame: (frame: RoomFrame, connection: RoomConnection) => void;
  onClockInvalidated: () => void;
  onClockReady: () => void;
  onWake: () => void;
};

/** Owns physical connections, reconnects and sampling. Never projects room data. */
export function createRoomTransport(options: TransportOptions) {
  const clock = new Clock(),
    connected = ref(false),
    connectionStopped = ref(false);
  let generation = 0,
    attempt = 0,
    socket: WebSocket | undefined,
    retry: ReturnType<typeof setTimeout> | undefined;
  let currentConnection:
    | {
        scope: RoomConnection;
        retryAllowed: boolean;
        recovery?: ControlRecoveryMetricsFence;
      }
    | undefined;
  let recoveryIdentity: object | undefined,
    recoveryAuthEpoch = -1;
  const recovery = createControlRecoveryMetrics({
    current: () =>
      options.read().room &&
      recoveryIdentity &&
      recoveryAuthEpoch === options.identity()
        ? { identity: recoveryIdentity, generation }
        : undefined,
    foreground: () => document.visibilityState !== "hidden",
  });
  const samples = new Set<ReturnType<typeof setTimeout>>();
  let visibility = document.visibilityState;
  let lastClockCheck = { monotonic: performance.now(), wall: Date.now() };
  function current(scope: RoomConnection) {
    return (
      scope === currentConnection?.scope &&
      scope.generation === generation &&
      scope.identity === options.identity() &&
      scope.room === options.read().room?.id
    );
  }
  function invalidateClock() {
    samples.forEach(clearTimeout);
    samples.clear();
    clock.reset();
    options.onClockInvalidated();
    lastClockCheck = { monotonic: performance.now(), wall: Date.now() };
  }
  function sampleClock() {
    const value = options.read();
    if (
      !value.snapshotReady ||
      !connected.value ||
      !value.state ||
      !roomProjectionActive(value) ||
      document.visibilityState === "hidden" ||
      socket?.readyState !== WebSocket.OPEN
    )
      return;
    const t1 = clock.registerRequest(
      value.state.clock_epoch,
      performance.now(),
    );
    if (t1 === undefined) return;
    try {
      socket.send(JSON.stringify({ type: "CLOCK_SYNC", t1 }));
    } catch {
      // Reconnect invalidates a request if the socket closes during send.
    }
  }
  function calibrateClock() {
    invalidateClock();
    const value = options.read();
    if (
      !value.snapshotReady ||
      !connected.value ||
      !roomProjectionActive(value)
    )
      return;
    const serial = generation,
      revision = clock.revision;
    sampleClock();
    for (let i = 1; i < 8; i++) {
      const timer = setTimeout(() => {
        samples.delete(timer);
        if (serial === generation && revision === clock.revision) sampleClock();
      }, i * 150);
      samples.add(timer);
    }
  }
  function checkClockContinuity() {
    const now = { monotonic: performance.now(), wall: Date.now() },
      monotonicGap = now.monotonic - lastClockCheck.monotonic,
      wallGap = now.wall - lastClockCheck.wall;
    lastClockCheck = now;
    if (
      roomProjectionActive(options.read()) &&
      document.visibilityState !== "hidden" &&
      (monotonicGap < 0 ||
        monotonicGap > 10000 ||
        (wallGap > 10000 && wallGap - monotonicGap > 5000))
    )
      calibrateClock();
  }
  function connect() {
    clearTimeout(retry);
    ++generation;
    const room = options.read().room;
    const previous = socket;
    socket = undefined;
    connected.value = false;
    connectionStopped.value = false;
    currentConnection = undefined;
    if (!room) {
      invalidateClock();
      previous?.close();
      return;
    }
    const scope = Object.freeze({
      generation,
      room: room.id,
      identity: options.identity(),
    });
    if (!recoveryIdentity || recoveryAuthEpoch !== scope.identity) {
      recoveryIdentity = {};
      recoveryAuthEpoch = scope.identity;
    }
    const recoveryFence = { identity: recoveryIdentity, generation };
    const owner = { scope, retryAllowed: true, recovery: recoveryFence };
    currentConnection = owner;
    options.onBegin(scope);
    invalidateClock();
    previous?.close();
    recovery.beginAttempt(recoveryFence);
    const connection = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws`,
    );
    socket = connection;
    connection.onopen = () => {
      if (!current(scope)) return;
      recovery.opened(recoveryFence);
      connected.value = true;
      attempt = 0;
      const state = options.read().state;
      connection.send(
        JSON.stringify({
          type: "RESUME",
          presence_version: 1,
          control_recovery_metrics_version: 1,
          room_id: scope.room,
          revision: state?.revision ?? 0,
          clock_epoch: state?.clock_epoch,
        }),
      );
      options.onOpen(scope);
    };
    connection.onclose = async () => {
      if (!current(scope)) return;
      recovery.disconnected(recoveryFence, owner.retryAllowed);
      connected.value = false;
      options.onClose(scope);
      invalidateClock();
      if (owner.retryAllowed) {
        // Browsers hide failed-upgrade status. Verify the session before retry.
        try {
          await options.restoreSession();
        } catch (failure) {
          if (!current(scope)) {
            options.onSessionFailure(failure, true);
            return;
          }
          if (failure instanceof RequestFailure && stopsReconnect(failure)) {
            owner.retryAllowed = false;
            recovery.reset();
            options.onSessionFailure(failure, false);
          }
        }
      }
      if (!current(scope)) return;
      connectionStopped.value = !owner.retryAllowed;
      if (owner.retryAllowed)
        retry = setTimeout(connect, reconnectDelay(attempt++));
    };
    connection.onmessage = (event) => {
      if (!current(scope)) return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!value || typeof value !== "object") return;
      const frame = value as RoomFrame;
      if (frame.type === "CLOCK_SYNC_REPLY") {
        checkClockContinuity();
        const projection = options.read();
        const { t1, t2, t3, clock_epoch } = frame;
        if (
          connected.value &&
          projection.snapshotReady &&
          projection.state &&
          typeof t1 === "number" &&
          typeof t2 === "number" &&
          typeof t3 === "number" &&
          typeof clock_epoch === "string" &&
          clock.acceptReply(
            { t1, t2, t3, clock_epoch },
            projection.state.clock_epoch,
            performance.now(),
          )
        )
          options.onClockReady();
        return;
      }
      options.onFrame(frame, scope);
    };
  }
  function snapshotApplied(
    scope: RoomConnection | undefined,
    metricsVersion: unknown,
  ) {
    const owner = currentConnection,
      connection = socket;
    if (!scope || !owner?.recovery || !current(scope)) return;
    try {
      const sample = recovery.snapshotApplied(owner.recovery, metricsVersion);
      if (
        !sample ||
        !owner.retryAllowed ||
        !connected.value ||
        !connection ||
        connection.readyState !== WebSocket.OPEN
      )
        return;
      const payload = JSON.stringify(sample);
      if (
        Number.isSafeInteger(connection.bufferedAmount) &&
        connection.bufferedAmount >= 0 &&
        connection.bufferedAmount + payload.length <= 65_536
      )
        connection.send(payload);
    } catch {
      // Optional telemetry cannot delay projection, calibration or media work.
    }
  }
  function send(payload: unknown) {
    if (!connected.value || !socket || socket.readyState !== WebSocket.OPEN)
      return false;
    socket.send(JSON.stringify(payload));
    return true;
  }
  function stop() {
    if (currentConnection) currentConnection.retryAllowed = false;
    recovery.reset();
    clearTimeout(retry);
    socket?.close();
  }
  function reset() {
    ++generation;
    currentConnection = undefined;
    recovery.reset();
    recoveryIdentity = undefined;
    clearTimeout(retry);
    connected.value = false;
    connectionStopped.value = false;
    invalidateClock();
    socket?.close();
    socket = undefined;
  }
  function wake() {
    recovery.visibilityChanged(document.visibilityState !== "hidden");
    const previous = visibility;
    visibility = document.visibilityState;
    if (previous !== visibility)
      lastClockCheck = { monotonic: performance.now(), wall: Date.now() };
    if (previous === "hidden" && visibility === "visible") {
      calibrateClock();
      options.onWake();
    }
  }
  function pageShown(event: PageTransitionEvent) {
    if (event.persisted) {
      recovery.suspended();
      calibrateClock();
      options.onWake();
    }
  }
  const timer = setInterval(() => {
    checkClockContinuity();
    sampleClock();
  }, 30000);
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("pageshow", pageShown);
  function dispose() {
    recovery.dispose();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("pageshow", pageShown);
  }
  return {
    clock,
    connected,
    connectionStopped,
    generation: () => generation,
    current,
    connect,
    resume: () => {
      if (currentConnection?.retryAllowed) connect();
    },
    reset,
    stop,
    send,
    snapshotApplied,
    invalidateClock,
    calibrateClock,
    checkClockContinuity,
    dispose,
  };
}
