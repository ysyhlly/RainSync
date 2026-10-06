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
  RoomPermission,
  RoomPermissionSnapshot,
  RoomInvitePolicy,
  Media,
} from "../../shared/api/types";
import { RequestFailure, stopsReconnect } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import { PlaybackCancelled } from "../../playback-request";
import { useMediaCatalog } from "../library/media-catalog.store";
import { useSession } from "../auth/session.store";
import { usePlatformAccount } from "../account/platform-account.store";
import { createPlaybackRuntime } from "../playback/playback-runtime";
import { lifecycleLabels } from "./room-lifecycle";
import { clientPlaybackStatus } from "./client-playback-status";
import {
  PresenceState,
  readPresenceSnapshot,
  type OnlineSnapshot,
} from "./presence-state";
import {
  createControlRecoveryMetrics,
  type ControlRecoveryMetricsFence,
} from "./control-recovery-metrics";

export const useRoomRuntime = defineStore("room-runtime", () => {
  const session = useSession(),
    catalog = useMediaCatalog(),
    platformAccount = usePlatformAccount();
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
  const lastChatDeletion = ref<string>();
  const deletedMessages = new Set<string>();
  const messages = ref<Message[]>([]),
    playlist = ref<QueueItem[]>([]),
    chat = ref("");
  const remember = catalog.remember;
  const currentTitle = computed(() =>
    state.value?.media_id
      ? (catalog.roomRecord(room.value?.id, state.value.media_id)?.title ??
        "正在播放")
      : "尚未选择影片",
  );
  watch(
    () => state.value?.media_id,
    (id) => {
      if (id && room.value)
        void catalog.ensureRoom(room.value.id, id, true).catch(() => {});
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
        if (room.value)
          await catalog.ensureRoom(room.value.id, id, true).catch(() => {});
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, ids.length) }, work));
  }
  watch(
    () => state.value?.media_generation,
    () => {
      catalog.clearRoom();
      refreshMetadata();
    },
    { flush: "sync" },
  );
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
  let recoveryIdentity: object | undefined,
    recoveryAuthEpoch = -1;
  const recovery = createControlRecoveryMetrics({
    current: () =>
      room.value && recoveryIdentity && recoveryAuthEpoch === session.epoch
        ? { identity: recoveryIdentity, generation: connectionSerial }
        : undefined,
    foreground: () => document.visibilityState !== "hidden",
  });
  let pendingChat: { id: string; body: string } | undefined;
  let chatTimer: ReturnType<typeof setTimeout> | undefined;
  const chatPending = ref(false),
    chatFailed = ref(false);
  const clockSamples = new Set<ReturnType<typeof setTimeout>>();
  let snapshotReady = false;
  let visibility = document.visibilityState;
  let lastClockCheck = { monotonic: performance.now(), wall: Date.now() };
  function clearClockSamples() {
    clockSamples.forEach(clearTimeout);
    clockSamples.clear();
  }
  function invalidateClock() {
    clearClockSamples();
    clock.reset();
    playback.onClockInvalidated();
    lastClockCheck = { monotonic: performance.now(), wall: Date.now() };
  }
  function calibrateClock() {
    invalidateClock();
    if (!snapshotReady || !connected.value || !roomActive.value) return;
    const serial = connectionSerial,
      revision = clock.revision;
    sampleClock();
    for (let i = 1; i < 8; i++) {
      const timer = setTimeout(() => {
        clockSamples.delete(timer);
        if (serial === connectionSerial && revision === clock.revision)
          sampleClock();
      }, i * 150);
      clockSamples.add(timer);
    }
  }
  function checkClockContinuity() {
    const now = { monotonic: performance.now(), wall: Date.now() },
      monotonicGap = now.monotonic - lastClockCheck.monotonic,
      wallGap = now.wall - lastClockCheck.wall;
    lastClockCheck = now;
    // performance.now() can stop on suspended systems. A long monotonic gap,
    // backwards clock, or a long wall gap absent from it is evidence to resample.
    if (
      roomActive.value &&
      document.visibilityState !== "hidden" &&
      (monotonicGap < 0 ||
        monotonicGap > 10000 ||
        (wallGap > 10000 && wallGap - monotonicGap > 5000))
    )
      calibrateClock();
  }
  const roomActive = computed(
    () => !!room.value && (room.value.lifecycle ?? "active") === "active",
  );
  const lifecycleLabel = computed(
    () => lifecycleLabels[room.value?.lifecycle ?? "active"],
  );
  const cleanupError = ref("");
  const playback = createPlaybackRuntime({
    staticHlsFallback: true,
    session,
    state,
    connected,
    active: roomActive,
    resolveMedia: (room, media) => catalog.ensureRoom(room, media),
    platformAccountChange: computed(() => platformAccount.change),
    youtubePlatformAccountChange: computed(() => platformAccount.youtubeChange),
    youtubePlatformAccountId: computed(() =>
      platformAccount.youtubeStatus?.state === "connected"
        ? (platformAccount.youtubeStatus.id ?? undefined)
        : undefined,
    ),
    shortPlatformAccountChanges: computed(() => platformAccount.shortChanges),
    shortPlatformAccountIds: computed(() =>
      Object.fromEntries(
        Object.entries(platformAccount.shortStatuses)
          .filter(([, value]) => value.state === "connected" && value.id)
          .map(([provider, value]) => [provider, value.id!]),
      ),
    ),
    clock,
    checkClock: checkClockContinuity,
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
  const delegatedPermissions = ref<RoomPermission[]>([]);
  const grantExpiresAt = ref<number | null>(null);
  function can(permission: RoomPermission) {
    return roomActive.value && (owner.value ||
      ((grantExpiresAt.value === null || grantExpiresAt.value > Date.now()) && delegatedPermissions.value.includes(permission)));
  }
  let permissionsRequest = 0;
  async function refreshPermissions() {
    const selected = room.value?.id, identity = session.epoch, request = ++permissionsRequest;
    if (!selected) return;
    try {
      const snapshot = await session.api<RoomPermissionSnapshot>(`/rooms/${selected}/permissions`);
      if (request !== permissionsRequest || room.value?.id !== selected || session.epoch !== identity) return;
      delegatedPermissions.value = snapshot.self_permissions;
      grantExpiresAt.value = snapshot.members.find((member) => member.user_id === session.user?.id)?.expires_at ?? null;
    } catch {
      if (request === permissionsRequest && room.value?.id === selected && session.epoch === identity) delegatedPermissions.value = [];
    }
  }
  const permissionRefresh = setInterval(() => { if (room.value) void refreshPermissions(); }, 30_000);
  onScopeDispose(() => clearInterval(permissionRefresh));
  const canManageRoom = computed(
    () =>
      !!room.value &&
      (room.value.owner_id === session.user?.id || !!session.user?.admin),
  );
  let actionSerial = 0;
  async function run(action: () => Promise<unknown>, preserveError = false) {
    const serial = ++actionSerial;
    if (!preserveError) error.value = "";
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
    catalog.clearRoom();
    recovery.reset();
    recoveryIdentity = undefined;
    clearPresence();
    presenceNames.value = {};
    ++namesRequest;
    namesPending = false;
    ++roomSerial;
    ++connectionSerial;
    clearTimeout(retry);
    snapshotReady = false;
    invalidateClock();
    socket?.close();
    socket = undefined;
    connected.value = false;
    connectionStopped.value = false;
    controlEpoch = undefined;
    room.value = null;
    ++permissionsRequest;
    delegatedPermissions.value = [];
    grantExpiresAt.value = null;
    cleanupError.value = "";
    state.value = null;
    playlist.value = [];
    messages.value = [];
    deletedMessages.clear();
    lastChatDeletion.value=undefined;
    pendingChat = undefined;
    clearTimeout(chatTimer);
    chatPending.value = false;
    chatFailed.value = false;
    chat.value = "";
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
    void refreshPermissions();
    recoveryIdentity = {};
    recoveryAuthEpoch = session.epoch;
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
      for(const m of history)if(m.deleted)deletedMessages.add(m.id);
      recovered.push(...history);
      messages.value = [
        ...new Map(
          [...before, ...recovered, ...messages.value].map((m) => [m.id, m]),
        ).values(),
      ].slice(-2000).map(m=>deletedMessages.has(m.id)?{...m,body:"",deleted:true}:m);
      if (history.length < 100) break;
      after = history.at(-1)?.id;
    } while (after);
    // Deletions during disconnection can affect messages before the forward
    // cursor. Revalidate only cached IDs in bounded same-room batches.
    const cached=messages.value.map(m=>m.id);
    for(let i=0;i<cached.length;i+=100){
      const history=await session.api<Message[]>(`/rooms/${id}/messages?check_ids=${cached.slice(i,i+100).join(",")}`);
      if(serial!==connectionSerial||room.value?.id!==id)return;
      for(const m of history)if(m.deleted)deletedMessages.add(m.id);
      messages.value=messages.value.map(m=>deletedMessages.has(m.id)?{...m,body:"",deleted:true}:m);
    }
  }
  function connect() {
    clearPresence();
    ++namesRequest;
    namesPending = false;
    controlEpoch = undefined;
    snapshotReady = false;
    invalidateClock();
    clearTimeout(retry);
    connectionSerial++;
    const serial = connectionSerial;
    let retryAllowed = true;
    socket?.close();
    connected.value = false;
    connectionStopped.value = false;
    if (!room.value) return;
    const selected = room.value.id;
    const recoveryFence: ControlRecoveryMetricsFence | undefined =
      recoveryIdentity && recoveryAuthEpoch === session.epoch
        ? { identity: recoveryIdentity, generation: serial }
        : undefined;
    if (recoveryFence) recovery.beginAttempt(recoveryFence);
    const presenceGeneration = presenceState.begin(selected);
    const connection = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws`,
    );
    socket = connection;
    socket.onopen = () => {
      if (serial !== connectionSerial) return;
      if (recoveryFence) recovery.opened(recoveryFence);
      connected.value = true;
      attempt = 0;
      socket!.send(
        JSON.stringify({
          type: "RESUME",
          presence_version: 1,
          control_recovery_metrics_version: 1,
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
    };
    socket.onclose = async () => {
      if (serial !== connectionSerial) return;
      if (recoveryFence) recovery.disconnected(recoveryFence, retryAllowed);
      presenceState.end(presenceGeneration);
      presence.value = undefined;
      clearTimeout(chatTimer);
      chatPending.value = false;
      chatFailed.value = !!pendingChat;
      connected.value = false;
      snapshotReady = false;
      invalidateClock();
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
            recovery.reset();
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
      if (v.type === "ROOM_PERMISSIONS_CHANGED") {
        if (v.user_id === session.user?.id) {
          delegatedPermissions.value = [];
          void refreshPermissions().then(() => { if (serial === connectionSerial) connect(); });
        }
        return;
      }
      if (v.type === "SNAPSHOT") void refreshPermissions();
      if (v.type === "CLOCK_SYNC_REPLY") {
        checkClockContinuity();
        if (
          connected.value &&
          snapshotReady &&
          state.value &&
          clock.acceptReply(v, state.value.clock_epoch, performance.now())
        )
          playback.onClockReady();
        return;
      }
      if (v.type === "CHAT_DELETED" && typeof v.id === "string") {
        deletedMessages.add(v.id);
        lastChatDeletion.value=v.id;
        messages.value = messages.value.map((m) => m.id === v.id ? { ...m, body: "", deleted: true } : m);
        return;
      }
      if (v.type === "CHAT") {
        if(v.deleted===true)deletedMessages.add(v.id);
        if(deletedMessages.has(v.id)){v.body="";v.deleted=true;}
        const index=messages.value.findIndex(m=>m.id===v.id);
        if(index<0)messages.value=[...messages.value,v].slice(-2000);
        else if(v.deleted===true)messages.value[index]={...messages.value[index],body:"",deleted:true};
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
          recovery.reset();
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
          (!snapshotReady ||
            !old ||
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
        const needsCalibration =
          !snapshotReady || old?.clock_epoch !== next.clock_epoch;
        snapshotReady = true;
        state.value = next;
        if (v.type === "SNAPSHOT" && recoveryFence) {
          // State/owner/lifecycle/control epoch are now applied. Calibration and
          // media work are independent; telemetry cannot delay either of them.
          try {
            const sample = recovery.snapshotApplied(
              recoveryFence,
              v.control_recovery_metrics_version,
            );
            if (
              sample &&
              retryAllowed &&
              serial === connectionSerial &&
              recoveryIdentity === recoveryFence.identity &&
              recoveryAuthEpoch === session.epoch &&
              room.value?.id === selected &&
              connected.value &&
              socket === connection &&
              connection.readyState === WebSocket.OPEN
            ) {
              const payload = JSON.stringify(sample);
              // Best effort once: a busy/closing socket drops measurement.
              if (
                Number.isSafeInteger(connection.bufferedAmount) &&
                connection.bufferedAmount >= 0 &&
                connection.bufferedAmount + payload.length <= 65_536
              )
                connection.send(payload);
            }
          } catch {
            /* Optional measurement must never change control recovery. */
          }
        }
        if (needsCalibration) calibrateClock();
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
          old.media_generation !== next.media_generation ||
          old.live?.broadcast_id !== next.live?.broadcast_id
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
          void run(() => applyState(true, true), true);
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
    if (
      !snapshotReady ||
      !connected.value ||
      !state.value ||
      !roomActive.value ||
      document.visibilityState === "hidden" ||
      socket?.readyState !== WebSocket.OPEN
    )
      return;
    const t1 = clock.registerRequest(
      state.value.clock_epoch,
      performance.now(),
    );
    if (t1 !== undefined) {
      try {
        socket.send(JSON.stringify({ type: "CLOCK_SYNC", t1 }));
      } catch {
        // An upgrade can close between readyState and send; reconnect will
        // invalidate the pending request. Sampling never stops local playback.
      }
    }
  }
  function send(type: string, payload?: unknown) {
    const permission: RoomPermission = ({ PLAY: "play", PAUSE: "pause", SEEK: "seek", SET_RATE: "set_rate", CHANGE_MEDIA: "change_media", END_MEDIA: "change_media" } as const)[type as "PLAY" | "PAUSE" | "SEEK" | "SET_RATE" | "CHANGE_MEDIA" | "END_MEDIA"];
    if (!connected.value || !can(permission) || !state.value || !controlEpoch)
      return false;
    if (
      state.value.live &&
      (type === "SEEK" ||
        type === "END_MEDIA" ||
        (type === "SET_RATE" && (payload as { rate?: number })?.rate !== 1))
    )
      return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(
      JSON.stringify({
        ...(state.value.live || type === "CHANGE_MEDIA" || type === "END_MEDIA"
          ? { live_version: 1 }
          : {}),
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
    return true;
  }
  async function choose(id: string) {
    return send("CHANGE_MEDIA", { media_id: id });
  }
  async function transferOwnership(ownerId: string) {
    const current = state.value,
      serial = roomSerial;
    if (!current || !canManageRoom.value)
      throw Error("当前无法转让房间");
    const result = await session.api<{ owner_id: string; state: RoomState }>(
      `/rooms/${current.room_id}/owner`,
      "POST",
      { owner_id: ownerId, expected_revision: current.revision },
    );
    if (
      serial !== roomSerial ||
      room.value?.id !== result.state.room_id ||
      (state.value &&
        state.value.clock_epoch === result.state.clock_epoch &&
        state.value.revision > result.state.revision)
    )
      return;
    room.value.owner_id = result.owner_id;
    acceptHttpState(result.state);
  }
  async function makeInvite(policy?: RoomInvitePolicy) {
    if (!room.value || !roomActive.value) throw Error("房间当前未开放");
    return session.api<RoomInvitation>(
      "/rooms/" + room.value.id + "/invites",
      "POST",
      policy,
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
  function acceptHttpState(next: RoomState) {
    const epochChanged = state.value?.clock_epoch !== next.clock_epoch;
    state.value = next;
    if (epochChanged) {
      snapshotReady = false;
      // A newer HTTP epoch must be confirmed by this socket's RESUME snapshot
      // before any calibration or controls can use it.
      if (connected.value && roomActive.value) connect();
      else invalidateClock();
    }
  }
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
    acceptHttpState(value.state);
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
    checkClockContinuity();
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
          status: clientPlaybackStatus(
            state.value,
            clock.now(),
            position.value,
            waiting.value || blocked.value,
          ),
        }),
      );
  }, 5000);
  const clockTimer = setInterval(() => {
    checkClockContinuity();
    sampleClock();
  }, 30000);
  function wake() {
    recovery.visibilityChanged(document.visibilityState !== "hidden");
    const previous = visibility;
    visibility = document.visibilityState;
    if (previous !== visibility)
      lastClockCheck = { monotonic: performance.now(), wall: Date.now() };
    if (previous === "hidden" && visibility === "visible") calibrateClock();
  }
  function pageShown(event: PageTransitionEvent) {
    if (event.persisted) {
      recovery.suspended();
      calibrateClock();
    }
  }
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("pageshow", pageShown);
  onScopeDispose(() => {
    recovery.dispose();
    clearInterval(statusTimer);
    clearInterval(clockTimer);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("pageshow", pageShown);
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
    lastChatDeletion,
    playlist,
    chat,
    chatPending,
    chatFailed,
    error,
    busy,
    owner,
    canManageRoom,
    can,
    refreshPermissions,
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
