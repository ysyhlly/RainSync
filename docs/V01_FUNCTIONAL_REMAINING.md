# v0.1 functional work, separate from acceptance

This is the 2026-10-01 code audit against the collaboration branch, including
the NAS/loading, bounded task-health, attempt timing and concrete-candidate recovery implementations described below. It does not replace the
historical evidence in PROGRESS or the release gates in NEXT_PLAN. A historical
“pending” row is not evidence that the same function is still missing today.

The published baseline's [complete checks run](https://github.com/ysyhlly/RainSync/actions/runs/36858681498)
passed: 349 frontend tests, 178 browser tests passed and two explicitly skipped,
real playback and playlist checks, and the transport measurement suites. The
separate fixed-product workflow retains the known original upstream 8/10
result; RainSync's account-policy enforcement passed 30/30. These results belong
to that baseline, not to untested later changes.

## Current bounded implementation

- Reliable single-Binary HTTP concrete candidates are now integrated in Server,
  Worker and Web. The same logical intent retains its encrypted representation
  binding and device report across bounded decode fallback; stale/changed or
  malformed reports cannot silently rediscover a new source. Local checks passed
  28 new API groups, 32 continuation groups and 457 frontend tests. Published
  checkpoint `d8418a7` passed compilation and frontend checks on its CI retry,
  but failed actual integration with Stop returning 500. A separately reproduced
  claim/Stop lock cycle has a locally verified repair awaiting publication; see
  [the bounded regression](stop-claim-lock-regression.md). See [scope and evidence](HTTP_FILE_CAPABILITY_BINDING.md).

- NEXT_PLAN §12.1: current persisted job inventory, registered process-owner
  state and completed cache scan counts/age are exposed through existing admin
  metrics. Unknown samples remain absent; these gauges do not replace task
  duration. Versioned per-attempt queue/run timing is now implemented and locally
  verified with missing samples preserved as unknown ([contract](JOB_TIMING_CONTRACT.md)).
  Fixed process-local retry/cancel/expiry event producers now have
  bounded local transaction/API checks; see [event definitions](JOB_HEALTH_EVENTS.md)
  and [the inventory contract](TASK_HEALTH_OBSERVATIONS.md).
- NEXT_PLAN §9.2: make NAS single-range behavior agree with local file delivery.
  HEAD describes the full file, unsupported/invalid ranges are ignored, and
  valid ranges selecting no bytes return 416. A stat-v1 change detector is not a
  strong HTTP validator, so If-Range cannot authorize a partial response.
- NEXT_PLAN §8.3: bound initial usable-media-data loading for every attached
  plan, including HTTP/Jellyfin/Emby plans without exact candidate IDs. This
  deadline is not presentation evidence and does not convert network delay
  into decoder failure or grant a new fallback route. Preparation/queue waiting
  and autoplay gestures retain their separate behavior.

The NAS/loading implementation passed focused Rust and actual NAS checks plus
the integrated frontend suite. Its published compatibility checkpoint is
`e7ef0d1`; [its exact-head CI](https://github.com/ysyhlly/RainSync/actions/runs/36888979539)
passed separately. The task-health checkpoint `3b93c66` also passed its own
[complete CI](https://github.com/ysyhlly/RainSync/actions/runs/36893338856). See [NAS evidence](NAS_RANGE_SEMANTICS.md)
and [validation limits](VALIDATION.md). Initial usable data is not a complete presented-frame guarantee.

## Remaining implementation work identified in current code

1. **Specific upstream capability negotiation.** Jellyfin and Emby have working
   independent adapters, real seek/audio paths and bounded account-policy
   observation. They still do not consume the concrete candidate report used
   for local/Agent media. This needs a truthful fixed-profile/output contract,
   with every negotiation SID owned and cleaned up. Broad HLS content-identity
   claims, ambiguous versions and unproven automatic fallback stay disabled.


This is a verified implementation gap, not an assertion that every other
v0.1 interface has undergone a fresh exhaustive audit. Keep each next slice
small enough to review and verify before enlarging its contract.

## Already implemented; do not reopen from old ledger rows

Concrete local/Agent automatic recovery now retains the original schema-1
binding, candidate configurations and device report just like marked HTTP.
HTML code 4 cannot create a new grant; same-grant native-to-MSE and hls.js fatal
mediaError remain supported. The local candidate passed all 517 frontend tests,
types and build; no new physical-browser result is claimed. See [the recovery
contract](CONCRETE_CANDIDATE_RECOVERY.md). This change does not turn stat-v1 into
a content hash or provide an upstream-product candidate contract.

NAS periodic source-version refresh and individual unreadable-file isolation
are implemented. So are Worker error classification/readiness, valid-identity
receipt-only recovery without MEDIA_ROOT, lifecycle/member fences, bounded
diagnostic replay, opt-in presence, player wake/rate recovery, source policies,
HTTP representation pinning, and the actual playback/control/NAS metrics
producers. Their limitations remain in their respective scoped documents.

## Decisions and acceptance remain distinct

Revoked Agent credentials are still rejected, including for receipt submission.
Unknown legacy rows cannot be declared drained without trustworthy ownership
and release evidence. Any new cleanup authority or reconciliation mechanism
needs its own explicit security decision; ordinary feature progression does not
authorize it.

Physical iOS/Android/Safari behavior, network-filesystem guarantees, sustained
weak-network/load runs, two-hour NAS playback, 72-hour operation, arm64 and real
old-library recovery are acceptance work. They are deferred from the current
function-first sequence, not marked passed. Private libraries, new roles,
per-login upstream identities, ABR/HDR/full ASS, plugins, multi-node and P2P are
outside this v0.1 implementation sequence.
