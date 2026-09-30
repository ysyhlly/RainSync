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
