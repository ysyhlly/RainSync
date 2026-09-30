import { ref, computed, watch, onScopeDispose } from "vue";
import { defineStore } from "pinia";
import {
  Clock,
  reconnectDelay,
  target,
} from "../../../../../packages/sync-engine";
import type { RoomState } from "../../../../../packages/protocol";
import type {
  Room,
  RoomMember,
  RoomLifecycle,
  Message,
  QueueItem,
  RoomInvitation,
  Media,
} from "../../shared/api/types";
import { RequestFailure, stopsReconnect } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import { PlaybackCancelled } from "../../playback-request";
import { useMediaCatalog } from "../library/media-catalog.store";
import { useSession } from "../auth/session.store";
import { createPlaybackRuntime } from "../playback/playback-runtime";
import { lifecycleLabels } from "./room-lifecycle";
import {
  PresenceState,
  readPresenceSnapshot,
  type OnlineSnapshot,
} from "./presence-state";

export const useRoomRuntime = defineStore("room-runtime", () => {
  const session = useSession(),
    catalog = useMediaCatalog();
  const error = ref(""),
    busy = ref(false),
    room = ref<Room | null>(null),
    state = ref<RoomState | null>(null),
    connected = ref(false),
    connectionStopped = ref(false);
  const presence = ref<OnlineSnapshot>(),
    presenceNames = ref<Record<string, string>>({});
  const presenceState = new PresenceState();
  let namesRequest = 0,
    namesPending = false;
  function clearPresence() {
    presenceState.begin("");
    presence.value = undefined;
  }
  async function refreshPresenceNames(serial: number) {
    const selected = room.value?.id;
    if (
      !selected ||
      namesPending ||
      !presence.value?.members.some(
        (member) => !presenceNames.value[member.userId],
      )
    )
      return;
    namesPending = true;
    const request = ++namesRequest;
    try {
      const members = await session.api<RoomMember[]>(
        `/rooms/${selected}/members`,
      );
      if (
        request !== namesRequest ||
        serial !== connectionSerial ||
        room.value?.id !== selected
      )
        return;
      presenceNames.value = Object.fromEntries(
        members
          .slice(0, 80)
          .map((member) => [member.id, member.display_name || member.username]),
      );
    } catch {
      /* Names are optional; membership never establishes online status. */
    } finally {
      if (request === namesRequest) namesPending = false;
    }
  }
  const messages = ref<Message[]>([]),
    playlist = ref<QueueItem[]>([]),
    chat = ref("");
  const remember = catalog.remember;
  const currentTitle = computed(() =>
    state.value?.media_id
      ? (catalog.records[state.value.media_id]?.title ?? "正在播放")
      : "尚未选择影片",
  );
  watch(
    () => state.value?.media_id,
    (id) => {
      if (id) void catalog.ensure(id, true).catch(() => {});
    },
  );
  let metadataRefresh = 0;
  function refreshMetadata() {
    const serial = ++metadataRefresh,
      identity = session.epoch;
    const ids = [
      ...new Set(
        [
          state.value?.media_id,
          ...playlist.value.map((item) => item.media_id),
        ].filter((id): id is string => !!id),
      ),
    ];
    // Keep large queues bounded without changing playback or broadcasting aliases.
    const work = async () => {
      while (
        ids.length &&
        serial === metadataRefresh &&
        identity === session.epoch
      ) {
        const id = ids.shift()!;
        await catalog.ensure(id, true).catch(() => {});
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, ids.length) }, work));
  }
  watch(
    () => playlist.value.map((item) => item.media_id).join(","),
    refreshMetadata,
  );
  window.addEventListener("focus", refreshMetadata);
  onScopeDispose(() => window.removeEventListener("focus", refreshMetadata));
  const clock = new Clock();
  let socket: WebSocket | undefined,
    retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0,
    connectionSerial = 0,
    roomSerial = 0,
    controlEpoch: string | undefined;
  let pendingChat: { id: string; body: string } | undefined;
  let chatTimer: ReturnType<typeof setTimeout> | undefined;
  const chatPending = ref(false),
    chatFailed = ref(false);
  const clockSamples = new Set<ReturnType<typeof setTimeout>>();
  const roomActive = computed(
    () => !!room.value && (room.value.lifecycle ?? "active") === "active",
  );
  const lifecycleLabel = computed(
    () => lifecycleLabels[room.value?.lifecycle ?? "active"],
  );
  const cleanupError = ref("");
  const playback = createPlaybackRuntime({
    session,
    state,
    connected,
    active: roomActive,
    clock,
    error,
    run,
    ended: (position_ms) => send("END_MEDIA", { position_ms }),
  });
  const { video, position, waiting, blocked, applyState, loadMedia } = playback;
  const owner = computed(
    () =>
      roomActive.value &&
      !!state.value &&
      (state.value.controller_user_id === session.user?.id ||
        !!session.user?.admin),
  );
  const canManageRoom = computed(
    () =>
      !!room.value &&
      (room.value.owner_id === session.user?.id || !!session.user?.admin),
  );
  let actionSerial = 0;
  async function run(action: () => Promise<void>) {
    const serial = ++actionSerial;
    error.value = "";
    busy.value = true;
    try {
      await action();
    } catch (e) {
      if (
        serial === actionSerial &&
        !(e instanceof PlaybackCancelled) &&
        !(e instanceof StaleIdentity)
      )
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (serial === actionSerial) busy.value = false;
    }
  }
  async function leave() {
    clearPresence();
    presenceNames.value = {};
    ++namesRequest;
    namesPending = false;
    ++roomSerial;
    ++connectionSerial;
    clearTimeout(retry);
    clockSamples.forEach(clearTimeout);
    clockSamples.clear();
    socket?.close();
    socket = undefined;
    connected.value = false;
    connectionStopped.value = false;
    controlEpoch = undefined;
    room.value = null;
    cleanupError.value = "";
    state.value = null;
    playlist.value = [];
    messages.value = [];
    pendingChat = undefined;
    clearTimeout(chatTimer);
    chatPending.value = false;
    chatFailed.value = false;
    chat.value = "";
    clock.reset();
    await playback.reset();
  }
  watch(
    () => session.user?.id,
    (id) => {
      catalog.reset();
      if (id) error.value = "";
      void leave().catch(() => {});
    },
  );
  async function enter(r: Room) {
    if (room.value?.id === r.id) return;
    const cleanup = leave(),
      serial = roomSerial;
    await cleanup;
    if (serial !== roomSerial) return;
    room.value = r;
    connect();
    const items = await session.api<QueueItem[]>(
      "/rooms/" + r.id + "/playlist",
    );
    if (serial === roomSerial) playlist.value = items;
  }
  async function catchUpChat(id: string, serial: number) {
    const before = [...messages.value];
    const recovered: Message[] = [];
    let after = before.at(-1)?.id;
    do {
      const history = await session.api<Message[]>(
        `/rooms/${id}/messages${after ? `?after=${after}` : ""}`,
      );
      if (serial !== connectionSerial || room.value?.id !== id) return;
      recovered.push(...history);
      messages.value = [
        ...new Map(
          [...before, ...recovered, ...messages.value].map((m) => [m.id, m]),
        ).values(),
      ];
      if (history.length < 100) return;
      after = history.at(-1)?.id;
    } while (after);
  }
  function connect() {
    clearPresence();
    ++namesRequest;
    namesPending = false;
    controlEpoch = undefined;
    clockSamples.forEach(clearTimeout);
    clockSamples.clear();
    clearTimeout(retry);
    connectionSerial++;
    const serial = connectionSerial;
    let retryAllowed = true;
    socket?.close();
    connected.value = false;
    connectionStopped.value = false;
    if (!room.value) return;
    const selected = room.value.id;
    const presenceGeneration = presenceState.begin(selected);
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws`,
    );
    clock.reset();
    socket.onopen = () => {
      if (serial !== connectionSerial) return;
      connected.value = true;
      attempt = 0;
      socket!.send(
        JSON.stringify({
          type: "RESUME",
          presence_version: 1,
          room_id: selected,
          revision: state.value?.revision ?? 0,
          clock_epoch: state.value?.clock_epoch,
        }),
      );
      if (pendingChat) {
        chatPending.value = false;
        chatFailed.value = true;
      }
      void catchUpChat(selected, serial).catch((e) => {
        if (serial === connectionSerial)
          error.value = e instanceof Error ? e.message : String(e);
      });
      for (let i = 0; i < 8; i++) {
        const timer = setTimeout(() => {
          clockSamples.delete(timer);
          if (serial === connectionSerial) sampleClock();
        }, i * 150);
        clockSamples.add(timer);
      }
    };
    socket.onclose = async () => {
      if (serial !== connectionSerial) return;
      presenceState.end(presenceGeneration);
      presence.value = undefined;
      clearTimeout(chatTimer);
      chatPending.value = false;
      chatFailed.value = !!pendingChat;
      connected.value = false;
      if (retryAllowed) {
        // Browsers do not expose a rejected upgrade's HTTP status. Check the
        // login session before reconnecting so expired cookies cannot loop.
        try {
          await session.load();
        } catch (failure) {
          if (serial !== connectionSerial) {
            if (
              !session.user &&
              failure instanceof RequestFailure &&
              ["SESSION_EXPIRED", "LOGIN_REQUIRED"].includes(failure.code)
            )
              error.value = failure.message;
            return;
          }
          if (failure instanceof RequestFailure && stopsReconnect(failure)) {
            retryAllowed = false;
            error.value = failure.message;
          }
        }
      }
      if (serial !== connectionSerial) return;
      connectionStopped.value = !retryAllowed;
      if (retryAllowed) retry = setTimeout(connect, reconnectDelay(attempt++));
    };
    socket.onmessage = (event) => {
      if (serial !== connectionSerial) return;
      let v;
      try {
        v = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!v || typeof v !== "object") return;
      if (
        v.type === "PRESENCE_SNAPSHOT" ||
        (v.type === "SNAPSHOT" &&
          typeof v.presence_connection_id === "string" &&
          v.presence)
      ) {
        const snapshot = readPresenceSnapshot(
          v.type === "PRESENCE_SNAPSHOT" ? v : v.presence,
        );
        if (snapshot) {
          const result =
            v.type === "PRESENCE_SNAPSHOT"
              ? presenceState.accept(presenceGeneration, snapshot)
              : presenceState.bind(
                  presenceGeneration,
                  v.presence_connection_id,
                  snapshot,
                );
          if (result === "resync") {
            connect();
            return;
          }
          if (result === "applied") {
            presence.value = presenceState.current;
            void refreshPresenceNames(serial);
          }
        }
        if (v.type === "PRESENCE_SNAPSHOT") return;
      }
      if (!v.state && typeof v.control_epoch?.id === "string")
        controlEpoch = v.control_epoch.id;
      if (v.type === "CLOCK_SYNC_REPLY") {
        if (clock.sample(v.t1, v.t2, v.t3, performance.now()))
          playback.onClockReady();
        return;
      }
      if (v.type === "CHAT") {
        if (!messages.value.some((m) => m.id === v.id)) messages.value.push(v);
        if (pendingChat && v.client_message_id === pendingChat.id) {
          clearTimeout(chatTimer);
          if (chat.value === pendingChat.body) chat.value = "";
          pendingChat = undefined;
          chatPending.value = false;
          chatFailed.value = false;
        }
        return;
      }
      if (v.type === "ERROR") {
        const failure = new RequestFailure(v);
        session.invalidate(failure);
        clearTimeout(chatTimer);
        chatPending.value = false;
        chatFailed.value = !!pendingChat;
        error.value = failure.message;
        if (stopsReconnect(failure)) {
          clearPresence();
          retryAllowed = false;
          socket?.close();
          if (failure.code === "NOT_A_MEMBER") void leave();
        }
      }
      if (v.state) {
        const old = state.value;
        const next = v.state as RoomState;
        if (
          old &&
          old.clock_epoch === next.clock_epoch &&
          next.revision < old.revision
        )
          return;
        if (next.room_id !== room.value?.id) return;
        if (
          v.type !== "SNAPSHOT" &&
          (!old ||
            old.clock_epoch !== next.clock_epoch ||
            next.revision > old.revision + 1)
        ) {
          // Full state on an EVENT/ACK does not recover missed ownership or
          // lifecycle metadata. Fence controls and request the existing RESUME
          // snapshot before applying another revision or playback side effect.
          if (retryAllowed) connect();
          return;
        }
        if (typeof v.owner_id === "string") room.value.owner_id = v.owner_id;
        const wasActive = roomActive.value;
        if (
          typeof v.lifecycle === "string" &&
          ["active", "closing", "closed", "archived"].includes(v.lifecycle)
        ) {
          room.value.lifecycle = v.lifecycle;
          room.value.lifecycle_epoch = v.lifecycle_epoch;
        }
        if (v.control_epoch === null || !roomActive.value)
          controlEpoch = undefined;
        else if (typeof v.control_epoch?.id === "string")
          controlEpoch = v.control_epoch.id;
        if (old && old.clock_epoch !== next.clock_epoch) {
          clock.reset();
          sampleClock();
        }
        state.value = next;
        if (!roomActive.value) {
          clearTimeout(chatTimer);
          chatPending.value = false;
          chatFailed.value = false;
          pendingChat = undefined;
          if (wasActive || !old) void playback.reset().catch(() => {});
          return;
        }
        if (
          !wasActive ||
          !old ||
          old.media_generation !== next.media_generation
        ) {
          playback.mediaChanged();
          const serial = roomSerial,
            selected = next.room_id;
          void session
            .api<QueueItem[]>(`/rooms/${selected}/playlist`)
            .then((items) => {
              if (serial === roomSerial) playlist.value = items;
            })
            .catch(() => {});
        } else if (v.action?.type === "SEEK")
          void run(() => applyState(true, true));
        else {
          const serial = roomSerial;
          void applyState().catch((e) => {
            if (serial === roomSerial && !(e instanceof PlaybackCancelled))
              error.value = e instanceof Error ? e.message : String(e);
          });
        }
      }
    };
  }
  function sampleClock() {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({ type: "CLOCK_SYNC", t1: performance.now() }),
      );
  }
  function send(type: string, payload?: unknown) {
    if (!connected.value || !owner.value || !state.value || !controlEpoch)
      return;
    socket?.send(
      JSON.stringify({
        protocol_version: 1,
        type,
        payload,
        room_id: state.value.room_id,
        command_id: crypto.randomUUID(),
        control_epoch: controlEpoch,
        expected_revision: state.value.revision,
        media_generation: state.value.media_generation,
      }),
    );
  }
  async function choose(id: string) {
    send("CHANGE_MEDIA", { media_id: id });
  }
  async function transferOwnership(ownerId: string) {
    const current = state.value,
      serial = roomSerial;
    if (!current || !canManageRoom.value || !roomActive.value)
      throw Error("当前无法转让房间");
    const result = await session.api<{ owner_id: string; state: RoomState }>(
      `/rooms/${current.room_id}/owner`,
      "POST",
      { owner_id: ownerId, expected_revision: current.revision },
    );
    if (
      serial !== roomSerial ||
      room.value?.id !== result.state.room_id ||
      (state.value && state.value.revision > result.state.revision)
    )
      return;
    room.value.owner_id = result.owner_id;
    state.value = result.state;
  }
  async function makeInvite() {
    if (!room.value || !roomActive.value) throw Error("房间当前未开放");
    return session.api<RoomInvitation>(
      "/rooms/" + room.value.id + "/invites",
      "POST",
    );
  }
  async function revokeInvite(invite: RoomInvitation) {
    await session.api(
      "/rooms/" +
        invite.room_id +
        "/invites/" +
        encodeURIComponent(invite.token),
      "DELETE",
    );
  }
  async function addQueue(id: string) {
    if (!roomActive.value) throw Error("房间当前未开放");
    const selected = room.value!.id,
      serial = roomSerial;
    await session.api(`/rooms/${selected}/playlist`, "POST", {
      media_id: id,
    });
    const items = await session.api<QueueItem[]>(`/rooms/${selected}/playlist`);
    if (serial === roomSerial) playlist.value = items;
  }
  function sendChat() {
    if (
      !roomActive.value ||
      !chat.value.trim() ||
      !connected.value ||
      chatPending.value
    )
      return;
    if ([...chat.value].length > 2000) {
      error.value = "聊天消息不能超过 2000 个字符";
      return;
    }
    if (!pendingChat || pendingChat.body !== chat.value)
      pendingChat = { id: crypto.randomUUID(), body: chat.value };
    chatPending.value = true;
    chatFailed.value = false;
    clearTimeout(chatTimer);
    const id = pendingChat.id,
      serial = roomSerial;
    chatTimer = setTimeout(() => {
      if (serial !== roomSerial || pendingChat?.id !== id) return;
      chatPending.value = false;
      chatFailed.value = true;
    }, 10000);
    socket?.send(
      JSON.stringify({
        type: "CHAT",
        body: chat.value,
        client_message_id: pendingChat.id,
      }),
    );
  }
  async function removeQueue(id: string) {
    if (!roomActive.value) throw Error("房间当前未开放");
    const selected = room.value?.id,
      serial = roomSerial;
    if (!selected) return;
    await session.api("/rooms/" + selected + "/playlist/" + id, "DELETE");
    const rows = await session.api<QueueItem[]>(
      "/rooms/" + selected + "/playlist",
    );
    if (serial === roomSerial) playlist.value = rows;
  }
  type LifecycleView = {
    lifecycle: RoomLifecycle;
    lifecycle_epoch: number;
    owner_id: string;
    state: RoomState;
    cleanup?: {
      attempts: number;
      last_error: string | null;
      completed: boolean;
    } | null;
  };
  function acceptLifecycle(value: LifecycleView, serial: number) {
    if (
      serial !== roomSerial ||
      value.state.room_id !== room.value?.id ||
      (state.value &&
        state.value.clock_epoch === value.state.clock_epoch &&
        state.value.revision > value.state.revision)
    )
      return false;
    room.value.lifecycle = value.lifecycle;
    room.value.lifecycle_epoch = value.lifecycle_epoch;
    room.value.owner_id = value.owner_id;
    state.value = value.state;
    cleanupError.value = value.cleanup?.last_error
      ? "清理尚未完成，服务端将继续重试。"
      : "";
    if (!roomActive.value) {
      controlEpoch = undefined;
      clearTimeout(chatTimer);
      chatPending.value = false;
      chatFailed.value = false;
      pendingChat = undefined;
      void playback.reset().catch(() => {});
    }
    return true;
  }
  async function refreshLifecycle() {
    const selected = room.value?.id,
      serial = roomSerial;
    if (!selected) return;
    const value = await session.api<LifecycleView>(
      `/rooms/${selected}/lifecycle`,
    );
    acceptLifecycle(value, serial);
  }
  async function changeLifecycle(action: "close" | "reopen" | "archive") {
    const current = state.value,
      serial = roomSerial;
    if (!current || !canManageRoom.value) throw Error("当前无法管理房间");
    try {
      const value = await session.api<LifecycleView>(
        `/rooms/${current.room_id}/${action}`,
        "POST",
        { expected_revision: current.revision },
      );
      if (acceptLifecycle(value, serial) && action === "reopen") connect();
    } catch (failure) {
      if (
        serial === roomSerial &&
        failure instanceof RequestFailure &&
        ["REVISION_CONFLICT", "ROOM_LIFECYCLE_CONFLICT"].includes(failure.code)
      ) {
        await refreshLifecycle().catch(() => {});
      }
      throw failure;
    }
  }
  function seek(event: Event) {
    position.value = Number((event.target as HTMLInputElement).value);
    playback.dragging.value = false;
    send("SEEK", { position_ms: position.value * 1000 });
  }
  const statusTimer = setInterval(() => {
    if (room.value?.lifecycle === "closing")
      void refreshLifecycle().catch(() => {});
    if (
      roomActive.value &&
      clock.ready &&
      connected.value &&
      state.value &&
      video.value
    )
      socket?.send(
        JSON.stringify({
          type: "CLIENT_STATUS",
          status: {
            buffering: waiting.value || blocked.value,
            drift_ms: target(state.value, clock.now()) - position.value * 1000,
          },
        }),
      );
  }, 5000);
  const clockTimer = setInterval(sampleClock, 30000);
  function wake() {
    if (document.visibilityState === "visible") {
      sampleClock();
      if (roomActive.value) void run(() => applyState(true));
    }
  }
  document.addEventListener("visibilitychange", wake);
  onScopeDispose(() => {
    clearInterval(statusTimer);
    clearInterval(clockTimer);
    document.removeEventListener("visibilitychange", wake);
    void leave().catch(() => {});
  });
  return {
    room,
    state,
    connected,
    connectionStopped,
    presence,
    presenceNames,
    messages,
    playlist,
    chat,
    chatPending,
    chatFailed,
    error,
    busy,
    owner,
    canManageRoom,
    roomActive,
    lifecycleLabel,
    cleanupError,
    refreshLifecycle,
    changeLifecycle,
    currentTitle,
    refreshMetadata,
    remember,
    enter,
    leave,
    connect,
    send,
    sendChat,
    choose,
    transferOwnership,
    addQueue,
    removeQueue,
    makeInvite,
    revokeInvite,
    seek,
    run,
    ...playback,
  };
});
