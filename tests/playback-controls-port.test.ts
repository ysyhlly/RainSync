import { expect, it, vi } from "vitest";
import { computed, readonly, ref, watch } from "vue";
import type { RoomState } from "../packages/protocol";
import {
  createPlaybackControlsPort,
  type PlaybackControlsPort,
} from "../apps/web/src/features/playback/playback-controls-port";
import { createRoomCommands } from "../apps/web/src/features/rooms/commands/room-commands";
import { createRoomScopePort } from "../apps/web/src/features/rooms/commands/room-scope";
import type { RoomPermission } from "../apps/web/src/shared/api/types";
import type { PlaybackPreparationState } from "../apps/web/src/features/playback/playback-preparation";
import type { createRoomPlaybackFacade } from "../apps/web/src/features/rooms/projection/playback-view";

function setup() {
  const state = ref<RoomState | null>({
    room_id: "room",
    revision: 1,
    media_id: "movie",
    media_generation: 1,
    playback_status: "paused",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: "owner",
    duration_ms: 120000,
    clock_epoch: "clock",
  });
  const connected = ref(true),
    active = ref(true),
    controlEpoch = ref<string | undefined>("control");
  const permissions = new Set<RoomPermission>([
    "play",
    "pause",
    "seek",
    "set_rate",
  ]);
  const can = (permission: RoomPermission) =>
    active.value && permissions.has(permission);
  const position = ref(10),
    dragging = ref(false),
    duration = ref(120);
  const preparation = ref<PlaybackPreparationState>({ phase: "idle" });
  const send = vi.fn((_payload: unknown) => true);
  const commands = createRoomCommands({
    api: vi.fn().mockResolvedValue({}),
    scope: createRoomScopePort(() =>
      state.value
        ? {
            identity: 1,
            room: state.value.room_id,
            roomGeneration: 1,
            connectionGeneration: 1,
          }
        : undefined,
    ),
    read: () => ({
      room: null,
      state: state.value,
      controlEpoch: controlEpoch.value,
    }),
    connected: () => connected.value,
    can,
    canManage: () => false,
    send,
    accept: () => false,
    connect: vi.fn(),
  });
  const volume = vi.fn(),
    muted = vi.fn();
  const seek = (event: Event) => {
    position.value = Number((event.target as HTMLInputElement).value);
    dragging.value = false;
    commands.send("SEEK", { position_ms: position.value * 1000 });
  };
  const port = createPlaybackControlsPort({
    timeline: { state: readonly(state), connected: readonly(connected), can },
    playback: {
      duration: readonly(duration),
      position,
      dragging,
      live: computed(() => !!state.value?.live),
      preparation: readonly(preparation),
      loadingStage: readonly(ref("playing" as const)),
      setLocalVolume: volume,
      setLocalMuted: muted,
    },
    commands: {
      play: () => commands.send("PLAY"),
      pause: () => commands.send("PAUSE"),
      setRate: (rate) => commands.send("SET_RATE", { rate }),
      seek,
    },
  });
  return {
    port,
    state,
    connected,
    active,
    controlEpoch,
    permissions,
    position,
    dragging,
    duration,
    preparation,
    send,
    volume,
    muted,
    seek,
  };
}
const eventAt = (value: string) => ({ target: { value } }) as unknown as Event;

it("controls keep live views and preserve the original seek draft/commit order", () => {
  const s = setup(),
    order: string[] = [];
  const stops = [
    watch(s.position, (value) => order.push(`position:${value}`), {
      flush: "sync",
    }),
    watch(s.dragging, (value) => order.push(`dragging:${value}`), {
      flush: "sync",
    }),
  ];
  try {
    expect(s.port.seek).toBe(s.seek);
    s.send.mockImplementation(() => {
      order.push(`send:${s.position.value}:${s.dragging.value}`);
      return true;
    });
    s.port.setDragging(true);
    s.port.previewSeek(15);
    expect(order).toEqual(["dragging:true", "position:15"]);
    order.length = 0;
    s.port.seek(eventAt("20"));
    expect(order).toEqual(["position:20", "dragging:false", "send:20:false"]);
    expect(s.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "SEEK",
        payload: { position_ms: 20000 },
        media_generation: 1,
        expected_revision: 1,
        control_epoch: "control",
      }),
    );
    s.duration.value = 90;
    s.preparation.value = { phase: "cancelled" };
    expect(s.port.duration).toBe(90);
    expect(s.port.position).toBe(20);
    expect(s.port.preparationPhase).toBe("cancelled");
  } finally {
    stops.forEach((stop) => stop());
  }
});

it("captured controls recheck current status, permissions, connection and control epoch", () => {
  const s = setup(),
    toggle = s.port.togglePlayback,
    rate = s.port.setRate;
  expect(toggle()).toBe(true);
  expect(s.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "PLAY" }),
  );
  s.state.value!.playback_status = "playing";
  expect(toggle()).toBe(true);
  expect(s.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "PAUSE" }),
  );
  s.send.mockClear();
  s.permissions.delete("pause");
  expect(toggle()).toBe(false);
  s.permissions.add("pause");
  s.connected.value = false;
  expect(toggle()).toBe(false);
  expect(rate(1.5)).toBe(false);
  s.connected.value = true;
  s.controlEpoch.value = undefined;
  expect(toggle()).toBe(false);
  s.controlEpoch.value = "replacement-control";
  s.active.value = false;
  expect(toggle()).toBe(false);
  s.active.value = true;
  s.state.value = null;
  expect(toggle()).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
});

it("the existing command owner still rejects live seek and non-unit rates", () => {
  const s = setup();
  const seek = s.port.seek,
    rate = s.port.setRate;
  s.state.value!.live = {
    version: 1,
    broadcast_id: "12:34:1700000000",
    sync_mode: "live_edge_control",
  };
  seek(eventAt("90"));
  expect(rate(1.5)).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.port.live).toBe(true);
  expect(rate(1)).toBe(true);
  expect(s.send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "SET_RATE",
      payload: { rate: 1 },
      live_version: 1,
    }),
  );
});

it("local audio delegates synchronously without room permission or connection", () => {
  const s = setup();
  s.connected.value = false;
  s.active.value = false;
  s.permissions.clear();
  s.port.setLocalVolume(0.35);
  s.port.setLocalMuted(true);
  expect(s.volume).toHaveBeenCalledExactlyOnceWith(0.35);
  expect(s.muted).toHaveBeenCalledExactlyOnceWith(true);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.port).not.toHaveProperty("video");
  expect(s.port).not.toHaveProperty("send");
});

function finiteControls(
  port: PlaybackControlsPort,
  context: Parameters<typeof createPlaybackControlsPort>[0],
  page: ReturnType<typeof createRoomPlaybackFacade>,
) {
  // @ts-expect-error No media element is exposed to the control strip.
  port.video.src = "/replacement";
  // @ts-expect-error No full Pinia store or mutation API is exposed.
  port.$patch({ state: null });
  // @ts-expect-error No general request API is exposed.
  port.api("/playback-sessions", "POST");
  // @ts-expect-error The view cannot mutate room rate.
  port.state!.playback_rate = 2;
  // @ts-expect-error Draft edits use explicit actions over the existing owner.
  port.position = 25;
  // @ts-expect-error Playback session identity is outside these controls.
  port.sessionId;
  // @ts-expect-error Room management permissions are outside these controls.
  port.can("delete_room");
  // @ts-expect-error Generic commands cannot be issued by the control strip.
  port.send("CHANGE_MEDIA");
  // @ts-expect-error Owner runners are not a UI capability.
  port.runPlayback(async () => {});
  // @ts-expect-error The facade factory cannot replace room projection.
  context.timeline.state.value = null;
  // @ts-expect-error Audio delegates do not expose an element to the facade.
  context.playback.video;
  // @ts-expect-error The retired raw-video compatibility alias stays private.
  page.video;
  // @ts-expect-error New owner methods are exposed only through their finite port.
  page.setLocalVolume;
}
void finiteControls;
