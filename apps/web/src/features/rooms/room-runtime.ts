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

export const useRoomRuntime = defineStore("room-runtime", () => {
  const session = useSession(),
    catalog = useMediaCatalog();
  const error = ref(""),
    busy = ref(false),
    room = ref<Room | null>(null),
    state = ref<RoomState | null>(null),
    connected = ref(false),
    connectionStopped = ref(false);
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
  function refreshMetadata() {
    const id = state.value?.media_id;
    if (id) void catalog.ensure(id, true).catch(() => {});
  }
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
  const playback = createPlaybackRuntime({
    session,
    state,
    connected,
    clock,
    error,
    run,
  });
  const { video, position, waiting, blocked, applyState, loadMedia } = playback;
  const owner = computed(
    () =>
      !!state.value &&
      (state.value.controller_user_id === session.user?.id ||
        !!session.user?.admin),
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
      const v = JSON.parse(event.data);
      if (typeof v.control_epoch?.id === "string")
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
        if (old && old.clock_epoch !== next.clock_epoch) {
          clock.reset();
          sampleClock();
        }
        state.value = next;
        if (!old || old.media_generation !== next.media_generation) {
          playback.mediaChanged();
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
  async function makeInvite() {
    if (!room.value) throw Error("请先进入房间");
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
    const selected = room.value!.id,
      serial = roomSerial;
    await session.api(`/rooms/${selected}/playlist`, "POST", {
      media_id: id,
    });
    const items = await session.api<QueueItem[]>(`/rooms/${selected}/playlist`);
    if (serial === roomSerial) playlist.value = items;
  }
  function sendChat() {
    if (!chat.value.trim() || !connected.value || chatPending.value) return;
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
    const selected = room.value?.id,
      serial = roomSerial;
    if (!selected) return;
    await session.api("/rooms/" + selected + "/playlist/" + id, "DELETE");
    const rows = await session.api<QueueItem[]>(
      "/rooms/" + selected + "/playlist",
    );
    if (serial === roomSerial) playlist.value = rows;
  }
  function seek(event: Event) {
    position.value = Number((event.target as HTMLInputElement).value);
    playback.dragging.value = false;
    send("SEEK", { position_ms: position.value * 1000 });
  }
  const statusTimer = setInterval(() => {
    if (clock.ready && connected.value && state.value && video.value)
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
      void run(() => applyState(true));
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
    messages,
    playlist,
    chat,
    chatPending,
    chatFailed,
    error,
    busy,
    owner,
    currentTitle,
    remember,
    enter,
    leave,
    connect,
    send,
    sendChat,
    choose,
    addQueue,
    removeQueue,
    makeInvite,
    revokeInvite,
    seek,
    run,
    ...playback,
  };
});
