import {
  ref,
  shallowRef,
  computed,
  readonly,
  watch,
  onScopeDispose,
} from "vue";
import { defineStore } from "pinia";
import type { RoomState } from "../../../../../packages/protocol";
import type {
  Room,
  RoomMember,
  Message,
  RoomPermission,
} from "../../shared/api/types";
import { RequestFailure, stopsReconnect } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import { PlaybackCancelled } from "../../playback-request";
import { reportFrontendError } from "../../app/global-errors";
import { actionErrorMessage } from "../../shared/action-error";
import { useMediaCatalog } from "../library/media-catalog.store";
import { useSession } from "../auth/session.store";
import { usePlatformAccount } from "../account/platform-account.store";
import {
  createPlaybackIdentityPort,
  createViewingRuntime,
} from "../../app/viewing-runtime";
import { lifecycleLabels } from "./room-lifecycle";
import {
  isPlaybackController,
  readRoomPermissionGrant,
  hasRoomPermission,
  canManageRoom as hasRoomManagementAuthority,
} from "./room-permissions";
import { clientPlaybackStatus } from "./client-playback-status";
import {
  PresenceState,
  readPresenceSnapshot,
  type OnlineSnapshot,
} from "./presence-state";
import {
  emptyRoomProjection,
  beginRoomConnection,
  projectRoomFrame,
  projectRoomHttp,
  roomProjectionActive,
  type RoomProjectionResult,
  type RoomStateFrame,
} from "./projection/room-projection";
import { createRoomPlaybackFacade } from "./projection/playback-view";
import { createPlaybackControlsPort } from "../playback/playback-controls-port";
import {
  createRoomTransport,
  type RoomConnection,
  type RoomFrame,
} from "./transport/room-transport";
import { createRoomScopePort } from "./commands/room-scope";
import { createRoomQueue } from "./commands/room-queue";
import { createRoomChat } from "./commands/room-chat";
import { createRoomCommands } from "./commands/room-commands";

/** Compatibility composition only: projection, transport and commands own their state. */
export const useRoomRuntime = defineStore("room-runtime", () => {
  const session = useSession(),
    catalog = useMediaCatalog(),
    platformAccount = usePlatformAccount();
  const error = ref(""),
    busy = ref(false);
  const projection = ref(emptyRoomProjection());
  // These setters retain the old Pinia test/consumer surface. Production writes
  // publish a complete projection; playback receives only readonly observations.
  const room = computed({
    get: () => projection.value.room,
    set: (room: Room | null) => {
      projection.value = { ...projection.value, room };
    },
  });
  const state = computed({
    get: () => projection.value.state,
    set: (state: RoomState | null) => {
      projection.value = { ...projection.value, state };
    },
  });
  const cleanupError = computed({
    get: () => projection.value.cleanupError,
    set: (cleanupError: string) => {
      projection.value = { ...projection.value, cleanupError };
    },
  });
  const roomActive = computed(() => roomProjectionActive(projection.value));
  const lifecycleLabel = computed(
    () => lifecycleLabels[room.value?.lifecycle ?? "active"],
  );
  let roomSerial = 0,
    namesRequest = 0,
    namesPending = false,
    presenceGeneration = 0;
  const presence = ref<OnlineSnapshot>(),
    presenceNames = ref<Record<string, string>>({});
  const presenceState = new PresenceState();
  function clearPresence() {
    presenceState.begin("");
    presence.value = undefined;
  }
  async function refreshPresenceNames(connection: RoomConnection) {
    if (
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
        `/rooms/${connection.room}/members`,
      );
      if (request !== namesRequest || !transport.current(connection)) return;
      presenceNames.value = Object.fromEntries(
        members
          .slice(0, 80)
          .map((member) => [member.id, member.display_name || member.username]),
      );
    } catch {
      // Names are optional; membership never establishes online status.
    } finally {
      if (request === namesRequest) namesPending = false;
    }
  }
  const transport = createRoomTransport({
    read: () => projection.value,
    identity: () => session.epoch,
    restoreSession: () => session.load(),
    onSessionFailure: (failure, stale) => {
      if (
        failure instanceof RequestFailure &&
        (!stale ||
          (!session.user &&
            ["SESSION_EXPIRED", "LOGIN_REQUIRED"].includes(failure.code)))
      )
        error.value = failure.message;
    },
    onBegin: (connection) => {
      projection.value = beginRoomConnection(projection.value);
      clearPresence();
      ++namesRequest;
      namesPending = false;
      presenceGeneration = presenceState.begin(connection.room);
      queue.connectionChanged();
    },
    onOpen: (connection) => {
      chatCommands.disconnected();
      void chatCommands.catchUp().catch((failure) => {
        if (transport.current(connection))
          error.value =
            failure instanceof Error ? failure.message : String(failure);
      });
    },
    onClose: () => {
      projection.value = beginRoomConnection(projection.value);
      presenceState.end(presenceGeneration);
      presence.value = undefined;
      chatCommands.disconnected();
    },
    onFrame: receiveFrame,
    onClockInvalidated: () => playback.onClockInvalidated(),
    onClockReady: () => playback.onClockReady(),
    onWake: () => queue.invalidate(),
  });
  const { clock, connected, connectionStopped, checkClockContinuity } =
    transport;
  const requestScope = createRoomScopePort(() =>
    room.value
      ? {
          identity: session.epoch,
          room: room.value.id,
          roomGeneration: roomSerial,
          connectionGeneration: transport.generation(),
        }
      : undefined,
  );
  const queue = createRoomQueue({
    api: (...args) => session.api(...args),
    scope: requestScope,
    active: () => roomActive.value,
  });
  const {
    playlist,
    playlistLoaded,
    playlistLoading,
    playlistError,
    queueNotice,
    queuePendingCount,
    queuePending,
    queueReceipt,
    refresh: refreshPlaylist,
    invalidate: invalidatePlaylist,
    add: addQueue,
    remove: removeQueue,
  } = queue;
  const chatCommands = createRoomChat({
    api: (...args) => session.api(...args),
    scope: requestScope,
    active: () => roomActive.value,
    connected: () => connected.value,
    send: transport.send,
    error: (message) => {
      error.value = message;
    },
  });
  const {
    messages,
    lastChatDeletion,
    chat,
    chatPending,
    chatFailed,
    send: sendChat,
  } = chatCommands;
  const commands = createRoomCommands({
    api: (...args) => session.api(...args),
    scope: requestScope,
    read: () => projection.value,
    connected: () => connected.value,
    can,
    canManage: () => canManageRoom.value,
    send: transport.send,
    connect: transport.connect,
    accept: (input, scope) => {
      if (!requestScope.current(scope)) return false;
      return applyProjection(
        projectRoomHttp(projection.value, input, connected.value),
      );
    },
  });
  const remember = catalog.remember;
  function retainMetadataFallback() {
    // Missing/temporarily unavailable metadata keeps the current safe title.
    // Playback loading has its own request and error boundary.
  }
  function retainPlaylistError() {
    // refreshPlaylist already records its error for the queue retry control.
    // A failed read must never turn a committed edit into a repeatable mutation.
  }
  function reportCleanupFailure(failure: unknown) {
    reportFrontendError(failure, { source: "promise" });
  }
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
        void catalog
          .ensureRoom(room.value.id, id, true)
          .catch(retainMetadataFallback);
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
          await catalog
            .ensureRoom(room.value.id, id, true)
            .catch(retainMetadataFallback);
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
  function focus() {
    refreshMetadata();
    invalidatePlaylist();
  }
  window.addEventListener("focus", focus);
  onScopeDispose(() => window.removeEventListener("focus", focus));
  const viewing = createViewingRuntime(
    {
      staticHlsFallback: true,
      identity: createPlaybackIdentityPort(
        () => ({ userId: session.user?.id, epoch: session.epoch }),
        (failure) => session.invalidate(failure),
      ),
      api: (...args) => session.api(...args),
      timeline: {
        state: readonly(state),
        connected: readonly(connected),
        active: roomActive,
        clock: Object.freeze({
          get ready() {
            return clock.ready;
          },
          get revision() {
            return clock.revision;
          },
          now: () => clock.now(),
        }),
        checkClock: checkClockContinuity,
      },
      commands: {
        ended: (position_ms) => commands.send("END_MEDIA", { position_ms }),
      },
      resolveMedia: (room, media) => catalog.ensureRoom(room, media),
      platformAccountChange: computed(() => platformAccount.change),
      youtubePlatformAccountChange: computed(
        () => platformAccount.youtubeChange,
      ),
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
    },
    {
      error,
      busy,
      identityInvalidated: () => {
        catalog.reset();
        void leave().catch(reportCleanupFailure);
      },
    },
  );
  const playback = viewing.playback;
  // The epoch is invalidated before session.user changes. Keep the original
  // login-only notice clearing rule without scheduling another room cleanup.
  watch(
    () => session.user?.id,
    (id) => {
      if (id) error.value = "";
    },
    { flush: "sync" },
  );
  const { video, position, waiting, blocked } = playback;
  const owner = computed(() =>
    isPlaybackController(roomActive.value, state.value, session.user),
  );
  const permissionIdentity = () => `${session.epoch}:${!!session.user?.admin}`;
  const noDelegation = () => ({
    permissions: [] as readonly RoomPermission[],
    expiresAt: null as number | null,
    identity: permissionIdentity(),
  });
  const permissionGrant = shallowRef(noDelegation());
  function can(permission: RoomPermission) {
    const grant = permissionGrant.value;
    return hasRoomPermission(permission, {
      active: roomActive.value,
      controller: owner.value,
      user: session.user,
      delegated:
        grant.identity === permissionIdentity() ? grant.permissions : [],
      expiresAt: grant.expiresAt,
    });
  }
  let permissionsRequest = 0;
  async function refreshPermissions() {
    const scope = requestScope.capture(),
      identity = permissionIdentity(),
      request = ++permissionsRequest;
    if (!scope) return;
    const current = () =>
      request === permissionsRequest &&
      requestScope.current(scope) &&
      permissionIdentity() === identity;
    try {
      const snapshot = await session.api<unknown>(
        `/rooms/${scope.room}/permissions`,
      );
      if (!current()) return;
      permissionGrant.value = {
        ...readRoomPermissionGrant(snapshot, session.user?.id),
        identity,
      };
    } catch {
      // Unsupported, malformed and failed snapshots deny delegation as one value.
      if (current()) permissionGrant.value = noDelegation();
    }
  }
  const permissionRefresh = setInterval(() => {
    if (room.value) void refreshPermissions();
  }, 30_000);
  onScopeDispose(() => clearInterval(permissionRefresh));
  const canManageRoom = computed(() =>
    hasRoomManagementAuthority(room.value, session.user),
  );
  let actionSerial = 0;
  const pendingActions = new Set<object>();
  async function run(action: () => Promise<unknown>, preserveError = false) {
    const serial = ++actionSerial,
      identity = session.epoch,
      token = {};
    pendingActions.add(token);
    if (!preserveError) error.value = "";
    busy.value = true;
    try {
      await action();
    } catch (e) {
      if (
        serial === actionSerial &&
        identity === session.epoch &&
        !(e instanceof PlaybackCancelled) &&
        !(e instanceof StaleIdentity)
      )
        error.value = actionErrorMessage(e);
    } finally {
      pendingActions.delete(token);
      busy.value = pendingActions.size > 0;
    }
  }
  async function leave() {
    // Retire every old callback synchronously, before remote playback cleanup.
    ++roomSerial;
    ++actionSerial;
    ++permissionsRequest;
    ++namesRequest;
    namesPending = false;
    pendingActions.clear();
    busy.value = false;
    projection.value = emptyRoomProjection();
    permissionGrant.value = noDelegation();
    catalog.clearRoom();
    clearPresence();
    presenceNames.value = {};
    transport.reset();
    queue.reset();
    chatCommands.reset();
    await playback.reset();
  }
  async function enter(selected: Room) {
    if (room.value?.id === selected.id) {
      if (queue.pending() && !playlistLoaded.value) return queue.pending();
      await queue.pending()?.catch(retainPlaylistError);
      if (room.value?.id === selected.id) await refreshPlaylist();
      return;
    }
    const cleanup = leave(),
      serial = roomSerial;
    await cleanup;
    if (serial !== roomSerial) return;
    projection.value = { ...projection.value, room: selected };
    transport.connect();
    void refreshPermissions();
    await refreshPlaylist();
  }
  function applyProjection(
    result: RoomProjectionResult,
    connection?: RoomConnection,
  ) {
    projection.value = result.value;
    for (const effect of result.effects) {
      switch (effect.type) {
        case "resume":
          transport.resume();
          break;
        case "invalidate-clock":
          transport.invalidateClock();
          break;
        case "calibrate-clock":
          transport.calibrateClock();
          break;
        case "refresh-playlist":
          queue.invalidate();
          break;
        case "snapshot-applied":
          transport.snapshotApplied(connection, effect.metricsVersion);
          break;
        case "clear-chat":
          chatCommands.clearPending();
          break;
        case "reset-playback":
          void playback.reset().catch(reportCleanupFailure);
          break;
        case "media-changed":
          playback.mediaChanged();
          break;
        case "apply-playback":
          if (effect.seek) void playback.applyRoomState(true, true);
          else void playback.applyRoomState();
          break;
      }
    }
    return result.accepted;
  }
  function receiveFrame(value: RoomFrame, connection: RoomConnection) {
    if (
      value.type === "PRESENCE_SNAPSHOT" ||
      (value.type === "SNAPSHOT" &&
        typeof value.presence_connection_id === "string" &&
        value.presence)
    ) {
      const snapshot = readPresenceSnapshot(
        value.type === "PRESENCE_SNAPSHOT" ? value : value.presence,
      );
      if (snapshot) {
        const result =
          value.type === "PRESENCE_SNAPSHOT"
            ? presenceState.accept(presenceGeneration, snapshot)
            : presenceState.bind(
                presenceGeneration,
                value.presence_connection_id as string,
                snapshot,
              );
        if (result === "resync") {
          transport.connect();
          return;
        }
        if (result === "applied") {
          presence.value = presenceState.current;
          void refreshPresenceNames(connection);
        }
      }
      if (value.type === "PRESENCE_SNAPSHOT") return;
    }
    const control = value.control_epoch as { id?: unknown } | null | undefined;
    if (!value.state && typeof control?.id === "string")
      projection.value = { ...projection.value, controlEpoch: control.id };
    if (value.type === "PLAYLIST_CHANGED") {
      if (value.room_id === undefined || value.room_id === connection.room)
        queue.invalidate();
      return;
    }
    if (value.type === "ROOM_PERMISSIONS_CHANGED") {
      if (value.user_id === session.user?.id) {
        permissionGrant.value = noDelegation();
        void refreshPermissions().then(() => {
          if (transport.current(connection)) transport.connect();
        });
      }
      return;
    }
    if (value.type === "SNAPSHOT") void refreshPermissions();
    if (value.type === "CHAT_DELETED" && typeof value.id === "string") {
      chatCommands.remove(value.id);
      return;
    }
    if (value.type === "CHAT") {
      chatCommands.accept(value as unknown as Message);
      return;
    }
    if (value.type === "ERROR") {
      const failure = new RequestFailure(value);
      session.invalidate(failure);
      chatCommands.disconnected();
      error.value = failure.message;
      if (stopsReconnect(failure)) {
        clearPresence();
        transport.stop();
        if (failure.code === "NOT_A_MEMBER") void leave();
      }
    }
    if (value.state)
      applyProjection(
        projectRoomFrame(projection.value, value as RoomStateFrame),
        connection,
      );
  }
  function refreshLifecycleInBackground() {
    const scope = requestScope.capture();
    if (!scope) return;
    void commands.refreshLifecycle().catch((failure) => {
      if (requestScope.current(scope) && !(failure instanceof StaleIdentity))
        cleanupError.value = "暂时无法获取房间清理状态，将自动重试。";
    });
  }
  function seek(event: Event) {
    position.value = Number((event.target as HTMLInputElement).value);
    playback.dragging.value = false;
    commands.send("SEEK", { position_ms: position.value * 1000 });
  }
  const playbackControls = createPlaybackControlsPort({
    timeline: { state: readonly(state), connected: readonly(connected), can },
    playback: {
      duration: playback.duration,
      position,
      dragging: playback.dragging,
      live: playback.live,
      preparation: playback.preparation,
      loadingStage: playback.loadingStage,
      setLocalVolume: playback.setLocalVolume,
      setLocalMuted: playback.setLocalMuted,
    },
    commands: {
      play: () => commands.send("PLAY"),
      pause: () => commands.send("PAUSE"),
      setRate: (rate) => commands.send("SET_RATE", { rate }),
      seek,
    },
  });
  const statusTimer = setInterval(() => {
    checkClockContinuity();
    if (room.value?.lifecycle === "closing") refreshLifecycleInBackground();
    if (
      roomActive.value &&
      clock.ready &&
      connected.value &&
      state.value &&
      video.value
    )
      transport.send({
        type: "CLIENT_STATUS",
        status: clientPlaybackStatus(
          state.value,
          clock.now(),
          position.value,
          waiting.value || blocked.value,
        ),
      });
  }, 5000);
  onScopeDispose(() => {
    clearInterval(statusTimer);
    transport.dispose();
    void leave().catch(reportCleanupFailure);
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
    playlistLoaded,
    playlistLoading,
    playlistError,
    queueNotice,
    queuePendingCount,
    queuePending,
    queueReceipt,
    refreshPlaylist,
    chat,
    chatPending,
    chatFailed,
    error: viewing.error,
    busy: viewing.busy,
    errorNotice: viewing.errorNotice,
    dismissError: viewing.dismissError,
    roomError: error,
    roomBusy: busy,
    owner,
    canManageRoom,
    can,
    refreshPermissions,
    roomActive,
    lifecycleLabel,
    cleanupError,
    refreshLifecycle: commands.refreshLifecycle,
    changeLifecycle: commands.changeLifecycle,
    currentTitle,
    refreshMetadata,
    remember,
    enter,
    leave,
    connect: transport.connect,
    selectionContext: () => `${roomSerial}:${transport.generation()}`,
    send: commands.send,
    sendChat,
    choose: commands.choose,
    transferOwnership: commands.transferOwnership,
    addQueue,
    removeQueue,
    makeInvite: commands.makeInvite,
    revokeInvite: commands.revokeInvite,
    seek,
    run,
    playbackControls,
    ...createRoomPlaybackFacade(playback),
  };
});
