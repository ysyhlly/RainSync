# W08 runtime metrics slice — design and integration contract

Baseline: `9b167ab92e36b373bdb6c46718ced16dfb8070aa` on
`integration/v0.1-next`; fetched branch matched this SHA on 2026-09-30.
Feature branch: `feature/w08-runtime-metrics`. Original checkout was clean at
`5ce1c8496bfa6a216be34361df3dd8aae9e4168e`; work uses a separate worktree.
Only metrics, an independent collector, focused tests and this document are owned
here. No protocol, migration, shared entry point, lockfile, CI or global ledger edits.
The baseline has no `.agents/skills`; AGENTS.md requests cgraphy but that tool is
not exposed in this environment, so local source inspection is the fallback.

## Evidence and fields

Offline `scripts/acceptance-measurements.mjs` consumes test evidence. Its startup,
playbackWindow, throughput and reconnect calculations are NOT live telemetry.
No offline result is loaded into the runtime collector.

| Signal / unit | Available evidence and timing | Implementation / trust |
| --- | --- | --- |
| First frame / seconds | Browser observation-binding has playing and media position, but no presentation callback or user-confirmation monotonic origin | Deferred. Owner must measure confirmation through requestVideoFrameCallback, or explicitly label playing+readyState+time-advance approximation; include queue/preparation. Never infer from Worker ready or HTTP response. |
| Stall / seconds | CLIENT_STATUS buffering is a sample flag; observation-binding lacks a contiguous foreground/expected-play window | Deferred. Browser owner must emit monotonic nonoverlapping windows excluding startup, autoplay block, seeking, background and pause; report coverage. Server arrival intervals are not playback duration. |
| Reconnect / count | room-runtime has connectionSerial and retries, but server RESUME is also initial join | Deferred. Count successful recovery after an initial connection in one mounted room runtime; deduplicate serial, reset on disposal. Network-restored-to-snapshot duration requires independent test evidence, not socket-open time. |
| Playback preparation failures / count | playback_requests::fail persists pending-to-failed transition | Typed process-local counter hook, only after committed new transition; replay, supersession and user cancel excluded. This is not decoder failure. |
| Queue depth / items | RoomHandle::command_queue_depth, connected_receivers; SQL queued jobs | Existing actual instantaneous gauges retained; read each queue once per scrape for total/max coherence. No room labels. |
| Cache lookup / requests; cached body / bytes | Worker delivery_response selects validated generated output and owns read guard | Hook once per actual cache decision; hit only after successful validated open/lease. Miss only for a cache-eligible lookup, not every direct-stream request. Cached bytes count body chunks actually handed off, including partial failed delivery. |
| Layered body transfer / bytes, seconds | Worker bytes_stream and output body stream; Agent relay stream | Independent bounded transfer handles. Fixed layers worker_egress/nas_uplink/upstream_read. Instant monotonic start through terminal outcome; cumulative byte samples from actual body chunks, not Content-Length/reserved bytes. Body handoff/read is not proof of browser receipt. |
| Legacy drift / milliseconds | rooms CLIENT_STATUS untrusted JSON | Preserve existing metric names, explicitly label HELP as client-reported. Signed drift becomes absolute error; invalid/nonfinite/out-of-range values rejected. Reports count received messages, including retries; no identity exists for trustworthy deduplication. |

All counters reset on process restart. No durable exactly-once claim. Runtime
families are absent until observed; absent is unknown/unwired, not healthy zero.
Transfer admission/loss counters expose bounded-capacity drops. No readiness
metric is invented; endpoint liveness does not prove Worker readiness.

## Concrete hooks for the unique owners

The server exposes `app.metrics.runtime` without changing shared App or main.
`metrics.rs` owns `#[path = "runtime_metrics.rs"] pub mod runtime`.
The collector is std-only and can be included by the Worker owner via
`#[path = "../../server/src/runtime_metrics.rs"] mod runtime_metrics;` pending
integration approval. Worker must own one process-wide collector and an
authenticated scrape route; the server cannot scrape Worker bytes from its own
in-memory collector. No new unauthenticated telemetry route is proposed.

- `RuntimeMetrics::begin_transfer(Layer, Cache) -> Option<Transfer>`: call after
  stream authorization/open and before polling the first body chunk. Keep one
  handle per actual stream, never per scrape/retry callback. `Cache::Hit` is valid
  only for WorkerEgress. No IDs/URL/path strings are accepted.
- `Transfer::sample(sequence: u64, cumulative_bytes: u64) -> bool`: after actual
  successful body chunk handoff/read. Start at sequence 1; increment per chunk.
  Equal sequence/equal bytes is an idempotent replay. Stale sequence, conflicting
  duplicate and regressing bytes fail without mutation. Sequence gaps allowed.
- `Transfer::finish(Outcome)`: call exactly once on EOF/error. Drop before finish
  records cancellation and partial bytes, releases admission. Successful EOF is
  not proof of decode. Outcome labels are complete/failed/cancelled. Histograms
  cover all outcomes, so failed time is not omitted from transfer diagnostics.
- `RuntimeMetrics::cache_lookup(CacheDecision)`: after validated cache lookup,
  once per request; fixed hit/miss. Owner prevents callback duplication. Cache
  bytes and request counts have separate denominators.
- `RuntimeMetrics::playback_failure(Failure)`: after playback_requests::fail
  commits a *new* pending-to-failed transition (baseline line 321). Return/use
  rows_affected before commit in the owner; no metric for same-key cached error,
  transaction rollback, stale plan or cancellation. Fixed prepare/upstream/
  capacity/other enum; no raw error text. Decoder failure needs separate
  client-reported instrumentation and is deferred.
- Worker baseline `main.rs::delivery_response`: upstream `bytes_stream` (line
  163), generated output/read lease branch (line 301 onward); new HTTP file
  delivery owner must place equivalent hooks around its final body producer.
  Include all chunk and cancellation paths. Do not edit that owner's files here.
- Room owner: existing metrics endpoint reads queue snapshots; no change needed
  in rooms.rs. Browser owner: room-runtime connect/onopen/onmessage and
  observation-binding are the future reconnect/presentation/window hook sites.

Byte counter rates over scrape wall time are the supported live layer throughput:
`rate(rainsync_transfer_bytes_total{layer="worker_egress",outcome="complete"}[5m])`.
Do not sum layers (the same payload traverses several). Completion counters are
credited at finish and may be bursty for long transfers. Transfer duration sum
counts overlapping transfers separately; NEVER divide bytes by that sum and call
it aggregate goodput. Offline union-duration goodput remains an independent tool.

## Resource and sampling contract

Fixed enum labels only. A single Mutex protects a fixed-size aggregate snapshot;
no maps of identities, payloads, samples or strings. At most 1024 live transfer
handles per collector; excess admission returns None and increments a saturating
drop counter without interfering with media delivery. Each admitted handle has
constant state; Drop returns its slot. Finite histogram bounds in seconds:
0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 600, plus +Inf. Counters and integer duration
sums saturate rather than wrap. Process-local Instant avoids wall-clock jumps.
No external numeric duration API is accepted by transfer timing. Scraping uses
one coherent snapshot; unobserved series stay absent.

Legacy metrics keep their compatibility names, with a coherent bounded snapshot
and no arbitrary JSON retention. A sample interval/frequency is not used as a
fabricated duration. Their duplicate-message limitation remains explicit.

## Validation and status

Implementation and focused validation results will be appended below. Shared
hook approval and actual owner integration are pending. Unit fixtures must not be
presented as end-to-end Worker/browser proof. This is a W08 basic metrics slice;
weak-network, 100-online capacity, mobile devices and 72-hour gates remain open.
