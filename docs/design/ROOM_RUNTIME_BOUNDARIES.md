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

- `apps/web/src/features/playback/PlaybackControls.vue`: `dragging`, `duration`, `live`, `loadingStage`, `position`, `preparation`, `video`.
- `apps/web/src/features/playback/PlaybackHost.vue`: `applySubtitles`, `attach`, `blocked`, `cancelPreparation`, `dragging`, `duration`, `enablePlayback`, `live`, `loadMedia`, `loadingStage`, `nativePlatform`, `platformDanmakuCues`, `platformDanmakuEnabled`, `preparation`, `recoveryLabel`, `recoveryState`, `runPlayback`, `sessionId`, `startupDiagnostics`, `subtitleIndex`, `subtitles`, `waiting`.
- `apps/web/src/features/playback/PlaybackInformation.vue`: `recoveryLabel`.
- `apps/web/src/features/playback/PlaybackSettings.vue`: `advancedCapabilities`, `advancedFacts`, `applySubtitles`, `audioIndex`, `burnInSubtitleIndex`, `ladderCapabilities`, `ladderFacts`, `ladderManual`, `ladderQuality`, `ladderSelected`, `live`, `loadMedia`, `localHlsLadderEnabled`, `mode`, `nativeCredentialMode`, `nativeEncodedHeight`, `nativeLadderRenditions`, `nativePlatform`, `nativePlaybackMode`, `nativeProvider`, `nativeQualityMaxHeight`, `nativeQualityOptions`, `nativeQualitySelectedHeight`, `platformDanmakuEnabled`, `platformDanmakuStatus`, `platformLiveDanmakuMode`, `platformSubtitleId`, `platformSubtitleStatus`, `platformSubtitleTracks`, `platformTextError`, `platformTextLive`, `playbackSummary`, `runPlayback`, `selectLadderQuality`, `selectNativeQuality`, `selectPlatformSubtitle`, `setPlatformDanmaku`, `setPlatformLiveDanmaku`, `startupDiagnostics`, `staticHlsAvailability`, `staticHlsAvailabilityText`, `staticHlsFallbackEnabled`, `subtitleIndex`, `subtitles`, `toneMapHdr`, `tracks`, `upstreamMeasuredMatchesRequested`, `upstreamMeasuredOutput`.
- `apps/web/src/features/rooms/RoomMediaPicker.vue`: `nativePlaybackMode`.
- `apps/web/src/features/rooms/RoomPage.vue`: `audioIndex`, `distributedFacts`, `duration`, `live`, `nativePlaybackMode`, `peerSharing`, `peerStats`, `playbackSummary`, `recoveryLabel`, `startPeerSharing`, `stopPeerSharing`, `useDistributedOutput`, `useOriginalSource`.
- `apps/web/src/features/rooms/RoomsPage.vue`: `nativePlaybackMode`.
- `apps/web/src/features/rooms/TimelineChatPanel.vue`: `position`.

The old writable `room` and `state` Pinia adapters remain for existing test fixtures. Production changes use the projection owner. Remove the setters once those fixtures use explicit frame/HTTP inputs and hydration compatibility has been reviewed. No second copy of either authoritative field exists.
