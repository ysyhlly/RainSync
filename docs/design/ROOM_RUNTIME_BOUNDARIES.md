# Room runtime boundaries (P06)

The Pinia `useRoomRuntime` entry remains the composition and page compatibility
boundary. It is not a second playback or transport implementation.

## Ownership

- `projection/room-projection.ts` is a pure reducer over one room projection:
  room ownership/lifecycle, control state, control epoch, socket-snapshot
  readiness and safe cleanup notice. The assembler publishes the whole value
  before consuming finite effects. Same-revision ACK/EVENT metadata still
  updates; duplicate playback effects do not run. Gap/clock discontinuities
  retain the previous authoritative room/state and request the existing RESUME.
- `transport/room-transport.ts` alone owns WebSocket callbacks, connection
  generations, reconnect/session checking, clock requests/replies/timers,
  visibility sampling and optional control-recovery metrics. It neither writes
  room projections nor knows video operations.
- `commands/room-commands.ts` owns finite room controls and HTTP lifecycle,
  ownership and invitation commands. Server authority and wire fields are
  unchanged. The original response is settled even if its projection is stale.
- `commands/room-queue.ts` owns queue reads, invalidation coalescing, mutations,
  original-operation deduplication and committed receipts. Refresh failure is
  not mutation failure. A reconnect never resubmits a mutation.
- `commands/room-chat.ts` owns draft/pending-send identity and history requests;
  `projection/chat-projection.ts` purely merges bounded history and deletion
  tombstones. A committed echo clears only its original draft text.
- `commands/room-scope.ts` captures a frozen runtime owner plus distinct exact
  login, room, room generation and connection generation. Room-scoped mutation
  settlement is deliberately distinct from connection-scoped read projection.
- The assembler retains metadata, optional presence names, permission reads,
  page error/busy state and the application viewing composition. Permission
  grants remain one atomic value with original identity/expiry checks.

Room replacement and exact-login invalidation synchronously retire scopes,
clear the room projection and fence socket callbacks before awaiting playback
cleanup. Playback receives the P04 readonly timeline and separate identity,
command, error and busy ports. P05 intent/observation ownership is unchanged.

## Explicit behavior deltas

The extraction also makes these previously incomplete boundaries explicit:

1. An ownership/lifecycle HTTP response initiated before reconnect cannot
   project over the resumed snapshot, even if its old clock epoch differs and
   its revision is higher. The HTTP command still resolves successfully when
   the server reports a commit; it is not repeated.
2. Queue reads and trailing invalidation work are connection-scoped. Reconnect
   detaches an obsolete read so a resumed snapshot can start its fresh read
   immediately; an old response cannot overwrite it or clear its loading/error.
3. An obsolete failed chat cursor read cannot start fallback history traffic
   after the connection or identity has changed.
4. Related room/state/owner/lifecycle/control fields are published atomically,
   eliminating partial combinations observable by synchronous Vue watchers.
5. Owner-only playback callbacks and error writers are no longer auto-exported
   to every page. The existing used page surface is enumerated explicitly.

Known committed queue edits keep their original dedup operation and receipt
across same-room reconnect. Chat retransmission retains its original client
message ID until its original outcome, unless the user changes the draft.
Connection fencing is not a new media, plan, SDK, prepare-budget or auth token.

## Finite playback page surface and remaining compatibility

`projection/playback-view.ts` enumerates existing page fields rather than
spreading the entire playback owner. Production users remain source-compatible.
The removed owner-only fields have no production room-store consumer:
`applyState`, `applyRoomState`, `reset`, `onClockReady`, `onClockInvalidated`,
`mediaChanged`, `resetClockAction`, `playbackError`, `playbackBusy`, and
`distributedIntent`. Tests that need those internals use the playback factory.

The consumer map below records the remaining playback compatibility fields.
Delete each alias only after its listed consumers use a dedicated host,
settings, synchronization or room-page port. P12–P14 own those migrations;
adding another internal playback field will not silently enlarge this facade.

`PlaybackControls.vue` now receives `playbackControls` through its existing
host. This finite port reads the original room/playback view and delegates
play/pause/seek/rate to the room command owner. Drag/position actions use the
existing draft refs; local volume/mute call synchronous playback-owner methods
that read its current element on every call. The component has no room-store,
raw-video, session or general command/API access. Its local audio preferences
remain component-local, and the host/video lifecycle is unchanged.

`PlaybackSettings.vue` receives `playbackSettings` through the same Host. Its
facts are deeply readonly live views over the existing refs, and named actions
preserve staged inputs, immediate reload/audio/quality operations and platform
text routing. The composition uses Pinia's supported setup action helper under
the original eight action names. Shared run/load/subtitle aliases retain the
same wrapped references during that migration; the five Settings-only actions retain their hooks and
promise settlement privately. No runner, raw store, element or API reaches the
Settings consumer. The 36 Settings-exclusive aliases are removed from the old
69-field allowlist. The Host migration below retires twelve more, leaving 21
compatibility fields with the production or fixture consumers listed below.

`PlaybackHost.vue` receives `playbackHost` from AppShell. Its readonly live
facts, finite permission query and named join/retry/cancel/subtitle/waiting/seek
operations use the existing owners. Only the Host receives attach authority;
its same local video, observers, placement, chrome, fullscreen and subtitle
resource lifecycle remain in the component. Information reads a lazy finite
recovery view in its own render. Host and AppShell keep their existing scoped
notice watchers over a readonly notice input and the original dismiss action.
The legacy writable-error notice fallback remains for its real fixture users.

The Host reuses the original Settings run/load/apply wrappers and registers
attach/enable/cancel/can/send/dismiss once under their original Pinia names.
Retained aliases reuse those exact wrappers; internal room and Controls calls
retain their original raw functions. Parent callbacks keep their original
promise while Preparation's child emits keep their original void result.
There is no generic runner/command/API or writable session access in the Host
port, no new owner state, and no retained per-grant media-capability promise.

The public `video` compatibility alias is removed after migrating its only
production page consumer, PlaybackControls. Room assembly still reads the
playback owner's element internally. Other aliases below retain their existing
consumers and must not be removed before those migrations.

- `apps/web/src/features/playback/PlaybackControls.vue`: migrated to the finite `PlaybackControlsPort`; no playback compatibility aliases.
- `apps/web/src/features/playback/PlaybackHost.vue`: migrated to `PlaybackHostPort`; no playback compatibility aliases.
- `apps/web/src/features/playback/PlaybackInformation.vue`: migrated to the finite recovery view; no room-store access.
- `apps/web/src/features/playback/PlaybackSettings.vue`: migrated to the finite `PlaybackSettingsPort`; no playback compatibility aliases.
- `apps/web/src/features/rooms/RoomMediaPicker.vue`: `nativePlaybackMode`.
- `apps/web/src/features/rooms/RoomPage.vue`: `audioIndex`, `distributedFacts`, `duration`, `live`, `nativePlaybackMode`, `peerSharing`, `peerStats`, `playbackSummary`, `recoveryLabel`, `startPeerSharing`, `stopPeerSharing`, `useDistributedOutput`, `useOriginalSource`.
- `apps/web/src/features/rooms/RoomsPage.vue`: `nativePlaybackMode`.
- `apps/web/src/features/rooms/TimelineChatPanel.vue`: `position`.

The twelve Host-only aliases removed after the production and indirect notice
migrations are `blocked`, `dragging`, `platformDanmakuEnabled`,
`platformDanmakuCues`, `subtitles`, `subtitleIndex`, `preparation`,
`loadingStage`, `startupDiagnostics`, `cancelPreparation`, `enablePlayback`
and `applySubtitles`. AppShell's former `useRoomNotice(runtime, error)` was an
indirect preparation consumer and now receives the finite notice view.

Seven compatibility aliases remain for deliberate P24 fixture migration:

- `runPlayback`: viewing-runtime-ports seeds and asserts playback-owned notices.
- `loadMedia`: room-lifecycle-playback exercises the raw closed-lifecycle no-op.
- `attach`: room-lifecycle-playback, room-player-recovery and viewing-runtime-ports.
- `sessionId`: those same three real room/playback fixture files.
- `waiting`, `recoveryState`: room-player-recovery exercises media-event and clock recovery state.
- `nativePlatform`: playback-settings-component seeds existing runtime settings cases.

These actual store tests retain their original actions, rejection/ownership
semantics and assertions. No production test-only capture API is added, and a
raw action is not replaced with a UI runner that catches its failure. The
fourteen other aliases retain the production consumers listed above.

The old writable `room` and `state` Pinia adapters remain for existing test fixtures. Production changes use the projection owner. Remove the setters once those fixtures use explicit frame/HTTP inputs and hydration compatibility has been reviewed. No second copy of either authoritative field exists.
