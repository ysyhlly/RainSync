# v0.1 functional work, separate from acceptance

This is the 2026-10-01 code audit against the collaboration branch, including
the NAS/loading and bounded task-health implementations described below. It does not replace the
historical evidence in PROGRESS or the release gates in NEXT_PLAN. A historical
“pending” row is not evidence that the same function is still missing today.

The published baseline's [complete checks run](https://github.com/ysyhlly/RainSync/actions/runs/36858681498)
passed: 349 frontend tests, 178 browser tests passed and two explicitly skipped,
real playback and playlist checks, and the transport measurement suites. The
separate fixed-product workflow retains the known original upstream 8/10
result; RainSync's account-policy enforcement passed 30/30. These results belong
to that baseline, not to untested later changes.

## Current bounded implementation

- NEXT_PLAN §12.1: current persisted job inventory, registered process-owner
  state and completed cache scan counts/age are exposed through existing admin
  metrics. Unknown samples remain absent; these gauges do not replace task
  duration or transition event producers. See [the scoped contract](TASK_HEALTH_OBSERVATIONS.md).
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
is tracked separately. The next task-health candidate passed finite Rust/API
checks but has not inherited that remote result. See [NAS evidence](NAS_RANGE_SEMANTICS.md)
and [validation limits](VALIDATION.md). Initial usable data is not a complete presented-frame guarantee.

## Remaining implementation work identified in current code

1. **Specific HTTP capability candidates.** Local and Agent sources already
   offer source-bound codec/profile/dimension candidates. Generic HTTP still
   falls back to the older negotiation path. Reliable single-file HTTP is the
   bounded next extension: an authenticated candidate must carry its exact
   target and representation identity from preflight into the eventual grant,
   before any new source I/O. Merely opening the existing source-kind gate is
   unsafe. The one-hop HTTP decoder continuation already implemented is a
   separate, constrained feature and does not solve this preflight binding.
2. **Specific upstream capability negotiation.** Jellyfin and Emby have working
   independent adapters, real seek/audio paths and bounded account-policy
   observation. They still do not consume the concrete candidate report used
   for local/Agent media. This needs a truthful fixed-profile/output contract,
   with every negotiation SID owned and cleaned up. Broad HLS content-identity
   claims, ambiguous versions and unproven automatic fallback stay disabled.
3. **Task-health measurements, NEXT_PLAN §12.1.** Current metrics now include
   fixed-state persisted job inventory, oldest queued creation age, recorded
   expired/missing leases, process-owner observations and fresh cache inventory
   ([scope](TASK_HEALTH_OBSERVATIONS.md)). Complete queue/run duration, retry,
   cancellation and lease-expiry event producers remain. `available_at` is an eligibility
   deadline rather than requeue time. Execution drain receipts are not runtime
   measurements. Successful completion uses `media_outputs::publish`, and
   cancellation occurs in several Server and persistence paths; Worker-only
   counters would miss real events. A bounded implementation must state its
   exact observation boundary and distinguish current inventory from events.

These are verified implementation gaps, not an assertion that every other
v0.1 interface has undergone a fresh exhaustive audit. Keep each next slice
small enough to review and verify before enlarging its contract.

## Already implemented; do not reopen from old ledger rows

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
