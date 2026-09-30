# Next playback metrics contract (frozen design, not yet wired)

This is a separate optional namespace. Current playback observations remain version 1, and their upstream reporting and owned final DELETE body are unchanged. The pure client sampler exists; the DTOs, durable admission and POST receiver below are the next implementation slice.

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

Sampling uses room-first transaction order, owned current grant and membership/source/account/lifecycle/expiry checks, then locks the matching viewer slot. Recheck all authority after contended locks. Current grant plan generation must equal the viewer high-water; old grant samples cannot mutate a continuing meter after fallback. Equal seq/equal typed packet returns its saved receipt without credit; lower or conflicting seq rejects. Sequence gaps are permitted. Closed meters reject newer packets. A final packet can replay only while its grant remains current and authorized.

## Validity and bounded resource use

Checked sums of the eight nonnegative cumulative categories must equal elapsed_ms; all counters must be nondecreasing. First frame may appear once, then remains identical, with elapsed <= confirmed_elapsed <= sample elapsed. Fixed client classification preserves seeking in expected-play duration; startup, blocked, background, paused and unknown time are separate. Unexpected local observation gaps over 15 seconds become unobserved, not extrapolated playback.

The initial cumulative prefix is capped untrusted client data: t0 predates clock-readiness deferral and preparation, so admission time cannot prove that prefix's age. Once accepted, anchor it durably and never move the anchor. Later `(elapsed - anchor_elapsed)` must be no greater than nonnegative elapsed database time since that anchor plus 15000ms. This allowance is not renewed per packet. Database wall-clock stability is an explicit assumption; a clock anomaly may drop telemetry without stopping playback. Horizon or validity failure does not silently reset the meter.

The receiver needs bounded in-flight admission and authenticated per-identity request rate before database contention; normal production cadence is five seconds plus one final capture. Accepted cumulative packets also have a fixed minimum interval except the one terminal packet. Replay never credits aggregates. Fixed counters distinguish known telemetry loss; no unbounded identity/rate map or dynamic reason label is permitted.

Persist first, commit, then emit only newly accepted deltas/first-frame samples to the process-local collector. A crash between commit and collector update can lose credit; replay does not credit it again. Exactly-once durable export is outside this contract.

## Frontend and stop ownership

Create one logical meter before asynchronous clock/probe/queue work. Keep t0, sequence, totals and first-frame receipt through automatic fallback; only the attachment attempt adopts the next generation. Media callbacks are fenced by current identity and generation and disposed on teardown. RVFC is presentation-submission evidence, not proof of physical viewing; its coarser playing/time-advance fallback is separately labeled.

The sampler uses one pending snapshot plus one in-flight immutable packet. Never rewrite a queued old packet's generation or destination. If coherent local totals/time origin are lost, stop reporting that meter and start a new meter on a newer admitted plan rather than restoring only seq.

Capture and start a bounded best-effort final metrics POST before the existing Stop, but never delay cleanup waiting for metrics. Stop may win and reject the final packet; the last interval can be lost. Preserve the exact observation-v1 DELETE body and its existing late-final-current ownership. Automatic fallback disposes the old grant without finalizing the logical meter.

Playback runtime, a new fenced metrics binding, and a separate bounded sender own this work. The observation-v1 binding/sender and presence room-runtime remain separate. Control reconnect metrics have a room lifetime across media changes and are explicitly deferred from this per-playback contract.
