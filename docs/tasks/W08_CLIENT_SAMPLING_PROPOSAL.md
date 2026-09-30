# W08 client sampling proposal (not an approved wire schema)

Inspected at fixed baseline `9b167ab92e36b373bdb6c46718ced16dfb8070aa`.
This document proposes owner hooks; no playback/room/protocol/entry-point files
are edited. All browser measurements remain client-reported after authentication
and validation. Server receipt, admission and commit timing are separate facts.

## Reusable evidence, precise sites

| Site | Current facts | Reuse and limit |
| --- | --- | --- |
| `apps/web/src/features/playback/observation-binding.ts:48` | Media-element sample with generation, event, media_time_ms, paused, seeking, buffering, rate and cumulative has_played | Reuse immutable plan/element/current/finalCurrent fences; no capture timestamp, presentation evidence, foreground or play-intent duration exists. |
| `observation-binding.ts:72`, `:86`, `:90` | Guarded playing; waiting/stalled; pause/seeking/seeked/canplay | Transition inputs only. Stalled network fetching does not by itself prove playback stopped while decoded buffers remain. Canplay is not presentation. |
| `apps/web/src/features/playback/observation-sender.ts:53`, `:69` | MAX_SAFE_INTEGER sequence; immutable packets; one pending packet can replace another | Reuse ordered captures and bounded queue. Event counts/interval packets lose information when replaced; cumulative snapshots survive coalescing. |
| `apps/server/src/playback_observations.rs:112`, `:144`, `:166` | Stale seq rejected; equal identical replay acknowledged; latest row and has_played persisted; transaction commits before ACK | Reuse high-water/replay checks if the protocol owner approves a negotiated extension. A metric update needs an explicit newly-accepted flag after commit; receipt alone also describes a replay. DB timestamp measures receipt, not browser time. |
| `crates/protocol/src/lib.rs:129`, `packages/protocol/playback-observation.schema.json:41` | deny_unknown_fields/additionalProperties=false | Do not append telemetry to v1. Protocol owner must select a negotiated version or separate message and generate schemas. |
| `apps/web/src/features/playback/playback-runtime.ts:253`, `:257`, `:261`, `:338` | loadMedia, clock deferral, new intent, prepare | A load-intent start belongs before the clock-readiness early return, cleanup/probe/queue wait. The current `:261` intent allocation is too late for full load-start timing. Deferred clock work must retain the original meter. |
| `playback-runtime.ts:411`, `:462`, `:515`, `:530`, `:533` | Candidate fallback; native/fatal HLS errors; source attachment; loadeddata timeout | Carry the logical startup origin across automatic fallback. Register/cancel a frame callback per current source attachment. The loadeddata timer is an availability timeout, not a measured first-frame timestamp. |
| `playback-runtime.ts:692`, `:704`, `:804`; `PlaybackHost.vue:117` | Room-driven play/pause; explicit autoplay enable; progress timers; waiting/canplay/playing | Reuse room intent and blocked flag. Programmatic pause during generation wait does not mean the user requested pause. UI waiting also covers preparation. |
| `apps/web/src/features/rooms/room-runtime.ts:209`, `:221`, `:249`, `:314`, `:353` | Attempt serial; socket open; observed close; state validation; accepted state assignment | Only an accepted SNAPSHOT on the current serial completes recovery. Socket open, arbitrary state-bearing EVENT or ACK does not. |
| `room-runtime.ts:330`, `:140`, `:172`, `:557`, `:595` | Revision-gap resync; leave/enter; explicit reopen; visibility wake | Recovery origin can be disconnect_observed or revision_gap. Initial enter and lifecycle reopen are separate operations; neither should inflate reconnects. Reset meters on leave/auth change. |
| `room-runtime.ts:574` | CLIENT_STATUS every 5s, buffering = waiting OR blocked | Preserve legacy semantics; do not multiply these flags by 5 seconds. It conflates startup, generation wait, autoplay block and rebuffering. |
| `tests/nas-soak.mjs:1249`, `:1285`, `:1500` | RVFC metadata and event-based buffer timing in the offline harness | Reuse API pattern only. Existing harness buffer intervals lack the proposed complete exclusion/coverage contract; its result is not live product telemetry. |

## Smallest useful playback snapshot

The following are proposed fields, not a new Rust/public/protocol type. Scope
must be one immutable logical playback intent, with a negotiated meter lifetime.
Use existing session/generation authority for acceptance; no identity is a label.

- `seq`: existing capture-order safe integer. Retry exactly the same packet.
- `media_generation`: existing current grant check; plan generation remains
  independently fenced by the grant/intent owner.
- `elapsed_ms`: integer monotonic elapsed since this meter's origin, not Date.now.
- Cumulative integer millisecond counters: `playing_ms`, `rebuffer_ms`,
  `seeking_ms`, `startup_ms`, `autoplay_blocked_ms`, `background_ms`,
  `foreground_not_expected_ms`, `unobserved_ms`.
- Optional first-frame receipt: `startup_origin = load_intent | user_confirmed`,
  `first_frame_ms`, `evidence = video_frame_callback | playing_time_advance`.
  Once set, retain the same value in every later cumulative snapshot.
  No invented zero for an unobserved frame; no startup sample for an abandoned
  attempt. Track abandonment separately when its owner can give a real event.
- Fixed mode from the actual accepted plan: direct/remux/transcode/unknown. Never
  selected_candidate_id, URL, session, room, user or media title as metric labels.

Use one nonoverlapping local state accumulator. Flush before changing state;
quantize one boundary clock to integer milliseconds so intervals conserve time.
All category deltas must be nonnegative and sum to elapsed delta. Derive
`observed_ms = elapsed_ms - unobserved_ms` and
`expected_playback_ms = playing_ms + rebuffer_ms + seeking_ms`.
This intentionally follows `scripts/acceptance-measurements.mjs::playbackWindow`:
foreground seeking stays in the expected-play denominator and is not a rebuffer
interval. Changing this denominator requires an explicit contract revision.

A deterministic classification order: unknown/suspended coverage -> background
-> autoplay blocked -> startup before first presentation -> foreground without
expected play -> seeking -> rebuffering -> playing. Expected play uses the latest
accepted room intent plus local permission/block state, not solely el.paused.
Generated-prefix wait after startup can count as rebuffer while that intent is
playing. A stalled fetch while media still advances is not rebuffer. These states
must be independently updated by visibility, room-state, autoplay, media events
and generation-wait transitions; a periodic snapshot alone cannot reconstruct
missing edges.

Flush every 5 seconds and on those edges. Keep only the existing one pending
snapshot plus one in-flight packet; never accumulate a queue of interval records.
A conservative coverage policy should classify unexpectedly long observation
heartbeat gaps (proposed >15 seconds) as unobserved rather than assigning them
all to the last state. Document this threshold and test timer suspension; it is a
sampling policy, not a promise that hidden/sleep time is measured exactly.

First frame: preserve the t0 at actual user confirmation if supplied by the UI;
otherwise label it load_intent. Do not relabel automatic load as a user gesture.
For fallback within a logical intent, keep t0 and capture the final accepted
route; also keep route-attempt metrics separately if later required. RVFC must
be armed after old-source teardown and before new-source attachment, fenced by
loadSerial/plan/element/auth/media generation, and cancelled on disposal. Use
metadata.presentationTime from the same time origin; reject stale/reversed or
nonfinite timestamp data. RVFC reports submission for composition, not a proof
of physical screen display. It may run late; keep callback evidence separate
from a fallback requiring playing + readyState>=2 + actual currentTime advance.
The fallback endpoint is its confirmation callback's monotonic time and has
coarser precision. loadeddata/canplay/HTTP ready do not complete either receipt.
The browser API semantics are documented in the primary
[RVFC draft](https://wicg.github.io/video-rvfc/).

## Capture lifecycle and deduplication requirements

For one accepted meter, keep only last seq, last cumulative counters, first-frame
receipt and fixed dimensions. Equal seq/equal packet returns the stored receipt
without metric mutation; equal seq/conflicting packet rejects; older seq rejects;
a newer packet with any regressing total, impossible conservation or changing
first-frame receipt rejects atomically. Sequence gaps are allowed because pending
captures are coalesced. Histogram first-frame is observed only once; durations
aggregate validated cumulative deltas, not HTTP receive intervals.

Counters belong to the meter lifetime, not merely a newly created sender. Same
session rebind must restore the coherent cumulative totals along with seq, or
stop reporting that meter. Restoring only seq (what current code does) is not
sufficient. If totals are lost, a new meter requires owner-approved lifetime
admission; never accept a silent reset or reinterpret it as another full sample.
After logout, disposal or newer plan wins, late callbacks/samples are ignored.
No metric update is permitted on DB rollback or same-key replay. A crash between
commit and in-memory counter update can lose a sample; durable exactly-once
metrics would need an outbox/ledger decision and are not claimed here.

Before wiring ingress, the owner must choose where its per-meter high-water
state lives. Reuse a current grant row where possible. A process map requires a
fixed admission cap (suggest 1024), authorized expiry and retirement rules.
Do not evict live high-water entries and then re-admit their delayed retries.
Capacity overflow drops telemetry without failing playback and exposes a fixed
loss counter. Unknown/expired meter packets remain rejected after eviction;
registration/expiry must make that enforceable. No unbounded UUID map is proposed.

## Smallest control-recovery snapshot

Control telemetry has a room-runtime lifetime across media/plan changes and can
exist without playback. It therefore cannot be accurately piggybacked on a
per-playback-session observation without documenting those omissions.
Proposed local fields: `seq`, `control_reconnects_total` (cumulative), and one
retained latest completion `{serial, recovery_origin, snapshot_recovery_ms}`.
A retained latest completion measures only sampled completions: pending packet
replacement can omit intermediate recoveries. For a complete recovery-time
histogram, use fixed cumulative duration bucket/count/sum totals per origin,
validated for monotonicity; do not present the latest-completion approach as full
coverage. Reconnect count alone is the smallest reliable first increment.

Start a recovery episode once when the client observes a close after its first
accepted SNAPSHOT, or when a revision gap triggers connect. Preserve the same
origin/start across failed attempts and backoff. Complete once at :353 only for
a SNAPSHOT accepted by the existing room/serial/revision/epoch checks. Deduplicate
that connection serial. Initial join, lifecycle reopen, stale snapshots, rejected
membership/auth and deliberate leave produce no successful reconnect increment.
Reset on enter/leave/auth lifetime changes, not every socket attempt or media
switch. This is client-observed snapshot recovery, never independently confirmed
network-restored recovery. Define any media catch-up as another metric with its
own presentation/position coverage; snapshot application is insufficient.

Room/WS owner and protocol owner must choose a negotiated namespace and bounded
resume/dedup lifetime. Existing CLIENT_STATUS has no sequence or meter identity;
adding a counter there without those rules still lets retries/reset double count.
No ingress or cross-process message is implemented in this slice.

## Server / Worker integration decision

The controller has approved reuse of the EXISTING media-core crate:
`crates/media-core/src/runtime_metrics.rs` is the std-only shared implementation.
`apps/server/src/metrics.rs:2` imports it; controller must add the public module
export in media-core/lib.rs. No new crate, manifest or lock change is needed.
Worker's new metrics and metric_stream modules import the same public module;
controller adds one Worker-local RuntimeMetrics to App and an authenticated route.
`render_for(Process::Server|Worker)` emits fixed process labels.

Each executable creates its OWN collector instance. Within one process, App
clones share only its collector's Arc. Sharing a source module or crate never
shares counters between executables. There is no Worker snapshot imported into
Server and no aggregate IPC. Both independently protected targets are scraped.
Actual exports, App initialization and stream hooks are listed in
[W08_WORKER_METRICS_WIRING.md](W08_WORKER_METRICS_WIRING.md).

The earlier private `#[path]` workaround and new-crate proposal are superseded.
The instance-isolation test models independent instances; Worker HTTP/auth fixture
runs the new production modules against a minimal App and disposable PostgreSQL.
Neither is evidence that controller-owned production main/App/HTTP hooks are
already present. If a combined endpoint is later requested, it needs a separate
communication/auth/timeout/staleness contract; none is implemented here.

## This turn's independent collector improvement

`rainsync_transfer_body_bytes_total{layer}` now counts accepted cumulative byte
*deltas as body chunks occur*, including active and later failed/cancelled
streams. Cache served-byte totals also update at the same actual handoff samples.
Duplicate or invalid samples do not mutate either total; finish/Drop cannot
credit those bytes a second time. Only three fixed layer series can exist.
`rainsync_transfer_bytes_total{layer,outcome}` remains terminal accounting.
Use live body-byte rate for observed I/O throughput and terminal outcome totals
for completed-stream diagnostics; neither proves receiver acknowledgement or
decoder success. No hook signature changes and no communication are needed.

## Focused continuation validation

`cargo test --locked --offline -p rainsync-server metrics:: -- --nocapture`:
15 passed, 0 failed (12 existing plus 3 new tests). New tests verify visible bytes
before EOF, duplicate/invalid samples and finish cannot double count, saturation
and cancelled partial bytes, and independent instances versus within-process Arc
clones. Existing concurrent/cardinality/resource tests were rerun because
sample-time accounting changed; they still pass. Rustfmt and git diff --check
pass. This run uses the existing isolated `/workspace/w08-target`, two build
jobs and offline dependencies. No offline measurement, type-boundary, device,
load, or E2E tests were repeated; no relevant signature changed.

Browser schema, sampler implementation, room recovery producer, Worker process
wiring, scrape authentication and cross-process evidence remain awaiting their
unique owners/controller. All proposed client fields above remain design only.
