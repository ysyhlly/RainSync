# Runtime metrics: measured boundaries and limits

The Server and Worker now export independent process-local counters. Server uses `/api/v1/metrics`; Worker uses `/metrics`. Both require the existing RainSync administrator session cookie, recheck expiry/current role, and return `Cache-Control: no-store`. There is no new service credential or cross-process aggregation channel. Route the Worker scrape through an existing secure cookie-bearing topology; this change does not configure infrastructure access.

Each endpoint permits at most 16 concurrent scrapes. Database acquisition, authorization and queries share a three-second deadline with transaction-local 1000ms statement/500ms lock limits. The explicitly owned connection closes on cancellation or failure; only a completed rollback permits reuse. Server room-map acquisition shares its remaining deadline. Actual PostgreSQL tests include all occupied pool slots cancelled while a table lock remains held, and a proxy discarding a database connection's replies: the request fails closed and a replacement connection stays usable.

## Body accounting

The shared collector has fixed labels and at most 1024 active transfer handles per process. Capacity refusal drops measurement, not playback. No user, room, URL, token, filename or arbitrary error becomes a label. Saturating unsigned counters reject nonmonotonic/conflicting cumulative samples. Unknown families remain absent, not fabricated zero measurements.

- `upstream_read` counts original network chunks before sniffing or buffering. It includes HTTP playback resources, manifests, keys and subtitles. Replaying a saved sniff prefix does not count another upstream read. Library browsing and dedicated preview input are not instrumented.
- `worker_egress` counts bytes yielded by the final permission-checked HTTP body. This includes viewer requests and internal FFprobe/FFmpeg `/source` requests; `/probe` JSON, rejected responses and HEAD are excluded. Counts are local handoff, not receiver acknowledgement, decoder success or pure video bitrate.
- Known validated Content-Length completes a measurement once that exact body length crosses the boundary. Partial drop is cancelled; an observed error or clean short EOF before completion is failed; an overrun is failed. Unknown-length bodies require actual EOF. This instrumentation neither drains nor truncates a source. A completed byte handoff does not assert resource disposal or remote playback.
- NAS uplink remains absent until the actual Agent send boundary is instrumented; Worker relay receipt is not substituted.

Cache lookups are recorded at actual eligible output resolution. Waiting for queued/running generation records one Miss; an initially complete cached output must pass proof/read-lease/response validation before recording Hit. A later completion never retroactively converts a Miss to Hit. Cached-byte totals include only bytes handed out for a validated Hit. Cache lookup and transferred-byte denominators differ; a later permission failure can prevent delivery after an otherwise valid lookup.

Server preparation failures count only a newly committed pending-to-failed transition. Replay, rollback, cancellation, replaced plans, and lifecycle/authorization-generation retirement do not count. This measures that transition subset, not every rejected playback request. There is an explicit crash-after-commit loss window before updating the in-memory collector; durable exactly-once export is not claimed.

## Current evidence

Strict workspace Clippy passes. Shared collector 13, Server metrics 4, Worker module 20, numeric compile-boundary 3 and client sampler core 22 checks pass. The actual PostgreSQL auth cancellation/blackhole fixture passes. Thirteen actual Server/Worker/public-API cases pass with frozen source/binary hashes: exact full/range bytes, chunked EOF, paused active accounting, cancellation/revocation/truncation, internal probes, deduplicated committed failures, fixed labels and actual remux Miss→Hit. All owned processes, listeners and PostgreSQL clusters were verified stopped.

The client sampler is a pure tested module only. First-frame, buffering durations and control-recovery ingress are not yet wired or exported. Legacy CLIENT_STATUS metrics remain explicitly untrusted message/sample counts, not duration or independently measured playback evidence. The next negotiated playback metrics contract remains a separate implementation step; observation v1 and owned final Stop behavior are unchanged.
