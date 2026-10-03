# Independent playback metrics contract

This is a separate optional namespace. Current playback observations remain version 1, and their upstream reporting and owned final DELETE body are unchanged. Strict shared DTOs/generated schemas, additive migrations0035–0036, durable admission, the POST receiver and process-local client_reported aggregation are implemented. The backend emits the marker only for a successfully published opted-in request. The browser playback runtime now creates the logical meter before asynchronous preparation and sends only after a matching open grant marker. Reports remain explicitly client-reported; browser presentation and device acceptance are separate evidence boundaries.

## Negotiation and wire shape

PlaybackRequest gains a paired `playback_metrics_version: 1` and `playback_metrics: {meter_start_generation, startup_origin}`. Both require the existing viewer_id/plan_generation pair. Omitting both preserves old serialized request hashes. Origin is `user_intent` or `automatic_load`; start generation is positive and no later than the request's plan generation.

PlaybackPlan echoes that version and a grant `{meter_start_generation, startup_origin, metrics_seq, closed, last_sample?}`. Same-key replay refreshes this state. The new POST `/api/v1/playback-sessions/{id}/metrics` carries a strict sample:

- version=1, media_generation, current plan_generation, meter_start_generation
- independent integer seq in 1..=9007199254740991; immutable startup_origin
- elapsed_ms and eight cumulative totals: startup_ms, autoplay_blocked_ms, background_ms, paused_ms, seeking_ms, rebuffer_ms, playing_ms, unobserved_ms
- optional immutable first_frame `{elapsed_ms, confirmed_elapsed_ms, evidence}`; evidence is video_frame_callback or playing_time_advance
- final boolean

Every millisecond value is an integer 0..=604800000 (seven days). Unknown fields are rejected; request size is capped at 4096 bytes. Receipt is `{session_id, meter_start_generation, metrics_seq, closed}`. User/viewer scope comes from the authenticated owned grant. No identity is a metric label. Observed and expected-playing totals are derived; source, delivery mode and arbitrary reason fields are not transmitted. Aggregates use an explicit client_reported namespace, fixed origin/evidence/state labels, and distinguish sample absence from measured zero.

## Durable bounded admission

One optional typed metrics slot lives on each existing playback_viewer_plans high-water row. It records start generation, media generation, lifecycle epoch, startup origin, last seq/payload, closed state, admission time, and a fixed first-accept elapsed/database-time anchor. Existing 1024-viewer admission bounds still apply; no arbitrary meter UUID table is added. Payload objects are capped at 4096 bytes and validated through the strict DTO. Retain high-water/closed state through stop, expiry and restart; do not evict it and allow old packets to re-enter.

Admission happens atomically in playback_requests::begin before preparation. A descriptor starting at the new current plan generation replaces the one slot with a zero baseline. An older start generation continues only the matching open meter with unchanged origin, media and lifecycle. This permits failed initial preparation followed by fallback before any accepted sample. Same-key retry never resets state. A higher plan with metrics omitted closes the previous slot without inventing a final sample. Only successfully published opted-in grants receive the paired version/start marker.

Sampling locks room, snapshot, membership, the matching viewer slot, source/account authority, then the owned playback session, in the same order as preparation and retirement. Recheck all authority after contended locks. Current grant plan generation must equal the viewer high-water; old grant samples cannot mutate a continuing meter after fallback. Equal seq/equal typed packet returns its saved receipt without credit; lower or conflicting seq rejects. Sequence gaps are permitted. Closed meters reject newer packets. A final packet can replay only while its grant remains current and authorized.

## Validity and bounded resource use

Checked sums of the eight nonnegative cumulative categories must equal elapsed_ms; all counters must be nondecreasing. First frame may appear once, then remains identical, with elapsed <= confirmed_elapsed <= sample elapsed. Fixed client classification preserves seeking in expected-play duration; startup, blocked, background, paused and unknown time are separate. Unexpected local observation gaps over 15 seconds become unobserved, not extrapolated playback.

The initial cumulative prefix is capped untrusted client data: t0 predates clock-readiness deferral and preparation, so admission time cannot prove that prefix's age. Once accepted, anchor it durably and never move the anchor. Later `(elapsed - anchor_elapsed)` must be no greater than nonnegative elapsed database time since that anchor plus 15000ms. This allowance is not renewed per packet. Database wall-clock stability is an explicit assumption; a clock anomaly may drop telemetry without stopping playback. Horizon or validity failure does not silently reset the meter.

The receiver permits 32 in-flight requests, with one cancellation-owned database connection and a three-second whole-handler deadline; statements are bounded to 1000 ms and lock waits to 500 ms. A route-local 4096-byte body limit runs before JSON extraction. After current owned-grant eligibility, a monotonic rate map allows six requests per ten seconds per user/room/viewer, at most 4096 identities, with 60-second idle expiry. Rate-map expiry never deletes durable metrics high-water state. Historical/revoked grants cannot allocate rate buckets or consume successor allowance. Normal production cadence is five seconds plus one final capture; newly accepted non-final cumulative packets require at least 1000 ms additional elapsed time. The one terminal packet may contain a shorter interval. Replay never credits aggregates. Fixed counters distinguish known telemetry loss; no unbounded identity/rate map or dynamic reason label is permitted.

Persist first, commit, then emit only newly accepted deltas/first-frame samples to the process-local collector. A crash between commit and collector update can lose credit; replay does not credit it again. Exactly-once durable export is outside this contract.

## Frontend and stop ownership

Create one logical meter before asynchronous clock/probe/queue work. Keep t0, sequence, totals and first-frame receipt through automatic fallback; only the attachment attempt adopts the next generation. Media callbacks are fenced by current identity and generation and disposed on teardown. RVFC is presentation-submission evidence, not proof of physical viewing; its coarser playing/time-advance fallback is separately labeled.

The sampler uses one pending snapshot plus one in-flight immutable packet. Never rewrite a queued old packet's generation or destination. If coherent local totals/time origin are lost, stop reporting that meter and start a new meter on a newer admitted plan rather than restoring only seq.

Capture and start a bounded best-effort final metrics POST before the existing Stop, but never delay cleanup waiting for metrics. Stop may win and reject the final packet; the last interval can be lost. Preserve the exact observation-v1 DELETE body and its existing late-final-current ownership. Automatic fallback disposes the old grant without finalizing the logical meter.

Playback runtime, a new fenced metrics binding, and a separate bounded sender own this work. The observation-v1 binding/sender and presence room-runtime remain separate. Control reconnect metrics have a room lifetime across media changes and are explicitly deferred from this per-playback contract.

## Backend verification

Protocol tests and strict workspace Clippy passed with the optional fields; legacy constructor defaults remain None. Receiver transition tests pass nine cases; the actual shared collector passes21 cases and the Worker wrapper passes seven with one explicitly ignored integration fixture. Three negative numeric compile checks use the real Cargo-built collector.

Actual PostgreSQL17.11 schema34→35→36 tests preserve all legacy row hashes and1,024 high-waters, pass20 upgrade/persistence checks and104 constraint rejections, and verify a real restart plus clean owned-process shutdown. Historical migrations1–35 remain byte-for-byte unchanged. The separate five-check recovery suite also passes through schema36, including actual backup/restoration into fresh generated databases. This does not represent a production-old-database drill. The frozen schema36 backend passes 29 actual public-API/PostgreSQL cases: legacy canonical hashes and observation final Stop, paired negotiation and pre-parse body bounds, concurrent receipt deduplication, immutable first frame/fixed anchor, fallback and same-key retry, rollback, rate/capacity limits, blocked source/member/playback-expiry races and current-login expiry/logout during a real lock wait, connection cancellation and pool recovery, independent account-generation revocation through a controlled Jellyfin peer, real Server restart, and final-metrics/Stop ordering. Owned processes/listeners are verified stopped and final source/binary hashes unchanged. The controlled peer is not a real Jellyfin product acceptance test. The integrated frontend passes192 unit/runtime/binding/sender cases, strict Vue types and a production Vite build. Tests include old-server marker absence preserving playback without POSTs, clock deferral, queued old RVFC callbacks after decoder and same-grant native/MSE replacement, identity changes, sender cancellation and nonblocking Stop. These synthetic media callbacks do not prove physical browser presentation or real-device behavior.

## Initial lifecycle epoch correction

Actual public-API preparation exposed an incorrect assumption in0035: new rooms and sessions legitimately use lifecycle_epoch=0 until their first lifecycle transition. Published0035 remains unchanged. Additive0036 changes only the metrics-slot epoch constraint from positive to nonnegative, matching 0028. It retains paired-null checks, payload/sequence bounds and existing viewer high-waters. The original failed public-API report is retained; no fixture epoch bump is used to hide the regression.

## Browser transport ownership

Three lifetimes stay distinct: the logical meter owns t0/start generation/cumulative sequence; the published grant owns plan generation; every source attachment has a separate local callback generation. User reload/audio selection creates a new logical intent, while automatic fallback preserves the meter. A repeated clock-readiness deferral resumes its one pending intent without resetting t0. RVFC uses presentationTime as compositor-submission evidence; the coarse fallback needs a playing event followed by nonseeking time advancement, never loadeddata/canplay alone.

The sender keeps one in-flight immutable packet, one replaceable pending snapshot and one finite retry timer. Each request has a five-second AbortSignal deadline; one transient retry preserves the exact sequence/body/destination. A new binding cancels old work and never rewrites its packet. An absent, closed or incoherent version-1 marker disables sending while playback continues. Receipt identity/sequence/closed fields must match. More than seven days ends telemetry permanently for that intent without clamping or resetting playback.

Final POST starts before the existing owned Stop but is never awaited by cleanup. Stop may win; queued final work or component disposal can cancel the last sample. This is explicit best-effort tail coverage, not a promise of lossless final duration.

## Frontend-to-receiver integration evidence

Five focused checks run the actual Vite-loaded playback runtime, sampler, media-event binding and sender against isolated real Server/Worker/PostgreSQL public APIs. They verify accepted durable receipts, one credit after an identical lost-ACK retry, direct-to-remux automatic fallback retaining cumulative sequence/time/frame, cancellation and media revocation, and final POST ordering without delaying Stop. In the final run the held final POST returned410 after Stop won, while Stop completed in16ms; this is a measured short-fixture result, not a universal latency guarantee. The same frozen backend hashes are verified before and after. Video events/capabilities in this test are synthetic; the additional browser-real assertions require actual Chromium playback callbacks and remain pending final CI.

CI integration also exposed a validation-harness boundary: package-scoped Worker Cargo tests can relink the non-test binary with different feature unification. The reliability test now copies its owned test/example executables and restores the workspace service build before subsequent frozen-hash checks. The exact failure was reproduced without weakening binding checks; restored binaries match all three original hashes, reliability passes, and all24 unchanged upstream-observation scenarios pass in that same order.

## Negotiated v2 startup coverage and originating-grant attribution

An additive outer request offer `playback_metrics_supported_versions: [1,2]`
accompanies the unchanged version-1 intent. An absent offer serializes exactly as
before, including the canonical request hash. Old servers ignore that outer
field and may return the existing v1 grant. A new server stores its selection in
the existing bounded viewer slot; retries and automatic fallback retain it. The
browser freezes the first valid selected version for its logical meter. A
missing, malformed, closed or version-changing optional marker cannot stop
playback. There is no same-key negotiation rewrite or downgrade retry.

`PlaybackMetricsSample` and `PlaybackMetricsGrant` remain the strict v1 DTOs.
The new packet wrapper dispatches on integer version before strict parsing.
Version 2 has the same common counters plus required `startup_phases` containing
cumulative integer `preparation_ms`, `loading_ms`, and `unobserved_ms`. These are
independent coverage of intent t0 through first-frame confirmation, not a
subdivision of the eight playback-state totals. Preparation includes clock
readiness, discovery, plan preparation and readiness before actual source
attachment. Loading begins on the actual source attachment edge. A gap above
15 seconds is wholly unobserved. Automatic fallback can re-enter preparation
without resetting t0 or totals. The phases sum to elapsed time until a first
frame is confirmed, then sum to its immutable confirmation time and freeze.
Background and autoplay-blocked time remain represented in the existing state
partition independently. No queue duration is subtracted from client startup.

Version 2 pairs a first-frame report with `first_frame_plan_generation`, copied
from its immutable published grant at the presentation callback. The local
source-attachment callback generation is a different fence and is never sent as
this field. If a direct-grant first frame is reported for the first time on a
later remux grant, it retains the original direct generation. Both the first
frame and that generation become immutable after acceptance.

Migration 0040 adds only bounded fields to existing viewer/session rows and
permits session versions 1 and 2. It assigns v1 only to existing known metrics
slots and leaves historical attribution unknown. Publication freezes the
bounded source kind and delivery mode from the server's actual selected
resource, separately from the encrypted resource and its mutable authorization
or representation wrapper. The receiver resolves the first-frame generation
within the same user, room, viewer, logical meter, media generation and lifecycle
using those publication facts. A missing or ambiguous historical grant produces
`unknown`; it is never relabeled with the current grant. Historical lookup is
attribution only: all existing locks, current owned-grant authorization, expiry,
fixed anchors and commit-before-credit requirements still gate acceptance.
The accepted attribution is saved with the cumulative packet on the viewer slot.

The collector adds six origin/phase counters and at most 576 attributed
first-frame histogram series: six fixed source kinds × four fixed modes × two
evidence kinds × twelve histogram series. It never expands the eight playback
state counters by these dimensions. The exact 582-series additional budget and
fixed 16 KiB snapshot ceiling have tests. Unmeasured phases and attribution are
absent, not invented zeros. The existing first-frame evidence distinction and
`client_reported` namespace remain explicit.

Worker output-entry availability and independently observed overlapping queue
correlation are separate producer work. This v2 client/server change does not
claim general cache hotness, cross-client synchronization error, a tester's
network-restored boundary, physical screen presentation, or device acceptance.

### V2 implementation verification (2026-10-02)

The isolated step1 checkout passed 708 frontend tests, strict Vue types and the
production Vite build; focused Rust checks cover 96 media-core tests (one
existing ignored process fixture), 34 protocol tests including strict duplicate
JSON rejection, one roundtrip test, and 11 receiver transition tests. Targeted
all-target Clippy with warnings denied, formatting and generated export checks
passed. The unchanged v1 sample/receipt schemas have no generated diff.

A successful source-bound workspace binary/example build then ran 32 real
Server/PostgreSQL receiver groups, including v2 negotiation, source/mode capture,
pre-first-report direct→remux fallback attribution, phase regression, same-key
conflicts, fixed version across fallback, restart deduplication, all existing v1
authority/anchor/rate/capacity checks and final Stop. Five real frontend-runtime
HTTP integration checks additionally exercised the actual v2 producer/binding/
sender with synthetic media events, immutable lost-ACK retry and original-frame
attribution through fallback. Owned Server, Worker and PostgreSQL PIDs/listeners
were positively verified stopped. Migration39→40 preserved all 1,024 generated
viewer values and prior session values and passed ten constraint rejections.

Two initial fixture failures were retained: the old source-revision race left
corrupt ciphertext, correctly rejected by the startup key guard; it now rotates
to another actual server-encrypted generated configuration. The old synthetic
video supported only one RVFC callback, overwriting the independent metrics
observer; it now models independent callback IDs. Neither fix weakened a
production guard. These are generated short-fixture results, with no real
browser/device, actual upstream product, sustained load or release acceptance.

## Worker output-entry availability and overlapping queue cutoff

Migration 0042 and the actual Worker route implement a deliberately narrow
cohort: the initial eligible non-HEAD `index.m3u8` output lookup. Its first
queued/running job observation is `cold_waiting`. An already-succeeded initial
lookup becomes `warm` only after output/manifest validation, a healthy read lease,
a constructed response and the normal final authorization gate. Later readiness
never promotes initial cold. Other delivery modes are server-published
`not_applicable`; missing, historical, failed or ambiguous observations remain
`unknown`. None of these labels means general cache hotness or cached bytes.

Eligibility rides the existing compulsory, cancellation-owned delivery execution
receipt before any output lookup. New writers distinguish eligible index
requests from HEAD/source/probe/segment admissions with a nullable boolean.
Older NULL receipts are unknown and prevent first-entry claims. The existing
room admission lock serializes first eligibility; an optional, 100 ms read-only
savepoint failure leaves the mandatory receipt committed and grants no permit.
The response classification is best-effort, with at most eight concurrent writes
and a 250 ms deadline, and never delays or changes playback. A missed cold write,
failed first request, process exit or Worker restart cannot let a later warm
request claim to be first.

Receipt pruning explicitly excludes one deterministic true-or-NULL delivery
receipt per live, unstopped v2 grant as a durable existence witness. Pruning
shares the existing room admission lock with renewal and skips busy rooms.
An explicit READ COMMITTED transaction fully consumes the room-lock SELECT,
then executes DELETE as a separate statement with a fresh snapshot and bound
locked-room UUIDs; clock_timestamp expiry cannot use a pre-renewal snapshot. Stopped or expired
grants can release the witness without changing historical unknown facts.
UUID ordering selects a
representative, not chronological evidence. Every bulk deletion sees that same
excluded witness; “some other row exists” is insufficient and is not used. HEAD
and segment receipts still age out normally. The separate cache-writer rule
retaining job physical-reaping evidence until eviction/reservation release is
unchanged. No new identity table or all-segment retention is introduced.

New queue writers initialize a bounded cumulative prefix only when enqueueing a
new job. An observational trigger retains witnessed queued exits using the locked
OLD 0039 phase tuple and validated NEW transition, including the actual attempt
increment. It never changes scheduling, source authorization, ownership or
lease fields, and never fills legacy NULL. Unrelated/heartbeat updates preserve
the prefix. Missing phase continuity, corrupt metadata, overflow or clock
regression irreversibly make coverage incomplete; a later valid phase cannot
turn an unknown prefix into measured zero. Running duration is excluded.

The first eligible request pins its initial expected output attempt: queued N
expects N+1, running/succeeded N expects N. Only its own validated response at that
attempt may freeze a complete cumulative queue prefix. If that request fails,
or its output moves to a replacement attempt, queue stays unknown. A later
request cannot capture extra retry queue after an earlier presented frame. The
queue prefix is an independently observed, overlapping component at that
specific response cutoff, not a disjoint client startup phase and not subtracted
from end-to-end startup. First-frame receipt resolves and freezes the historical
originating grant's availability and queue under the same exact-login scope as
source/mode attribution; the untrusted client DTO gains no cache or queue claims.

The collector adds at most 111 fixed series independently of source/mode/state:
four entry cohorts × two evidence kinds × twelve first-frame histogram series,
one twelve-series complete-queue histogram, and three coverage counters
(complete/not_applicable/unknown). Together with step1, this is 693 additional
series and remains under the fixed 16 KiB snapshot budget. Old v1 samples do not
acquire invented v2 cohorts or queue zeros.

### Output-entry verification (2026-10-02)

After correcting the reviewed same-statement snapshot race, 13 real PostgreSQL
regression groups passed. A deterministic advisory gate establishes the room-lock
statement snapshot, lets a valid renewal commit after the old expiry but before
room-lock acquisition, then verifies the separate DELETE sees the renewed grant
and retains its witness. Queue-claim rollback, corruption/old-writer gaps,
monotonic completeness, bulk/concurrent pruning, expired/stopped cleanup and
historical unknown preservation are covered.

A fresh source-bound build with all 12 required helper executables passed the
five actual Worker cohort groups: warm with HEAD/concurrent admission, immutable
initial cold, failed first-request queue unknown, classification-write failure
surviving pruning/restart, and frozen server attribution. That same post-fix
binding passed 33 receiver groups, five runtime-to-receiver wire groups, five
recovery checks (including all 42 schema checksums), and eight native/Server/
Worker timing groups. Owned processes and listeners were verified stopped.
Targeted strict Clippy, formatting, 27 collector tests, two Worker producer tests
and 11 receiver unit tests also passed. Pre-fix results remain separate evidence.

Earlier owned fixture failures were retained: actual disk headroom protection
prevented output generation below its unchanged 10% floor, and a fixture held
completed grants until the default two-session quota was reached. Disk cache
cleanup restored headroom; completed cases now stop their grants. No production
capacity or authorization guard was weakened. These remain short generated
fixtures and synthetic client frame reports, not browser/device, independent
network-recovery, cross-client synchronization, sustained-load or release proof.
