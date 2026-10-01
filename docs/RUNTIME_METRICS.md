# Runtime metrics: measured boundaries and limits

The Server and Worker now export independent process-local counters. Server uses `/api/v1/metrics`; Worker uses `/metrics`. Both require the existing RainSync administrator session cookie, recheck expiry/current role, and return `Cache-Control: no-store`. There is no new service credential. Worker byte measurements stay local to the Worker; negotiated Agent reports are exported by the Server in a separate untrusted namespace. Route the Worker scrape through an existing secure cookie-bearing topology; this change does not configure infrastructure access.

Each endpoint permits at most 16 concurrent scrapes. Database acquisition, authorization and queries share a three-second deadline with transaction-local 1000ms statement/500ms lock limits. The explicitly owned connection closes on cancellation or failure; only a completed rollback permits reuse. Server room-map acquisition shares its remaining deadline. Actual PostgreSQL tests include all occupied pool slots cancelled while a table lock remains held, and a proxy discarding a database connection's replies: the request fails closed and a replacement connection stays usable.

## Body accounting

The shared collector has fixed labels and at most 1024 active transfer handles per process. Capacity refusal drops measurement, not playback. No user, room, URL, token, filename or arbitrary error becomes a label. Saturating unsigned counters reject nonmonotonic/conflicting cumulative samples. Unknown families remain absent, not fabricated zero measurements.

- `upstream_read` counts original network chunks before sniffing or buffering. It includes HTTP playback resources, manifests, keys and subtitles. Replaying a saved sniff prefix does not count another upstream read. Library browsing and dedicated preview input are not instrumented.
- `worker_egress` counts bytes yielded by the final permission-checked HTTP body. This includes viewer requests and internal FFprobe/FFmpeg `/source` requests; `/probe` JSON, rejected responses and HEAD are excluded. Counts are local handoff, not receiver acknowledgement, decoder success or pure video bitrate.
- Known validated Content-Length completes a measurement once that exact body length crosses the boundary. Partial drop is cancelled; an observed error or clean short EOF before completion is failed; an overrun is failed. Unknown-length bodies require actual EOF. This instrumentation neither drains nor truncates a source. A completed byte handoff does not assert resource disposal or remote playback.
- NAS uplink is measured in the Agent only after a Binary-frame send succeeds. Only successful non-HEAD 200/206 body owners admitted after metric negotiation participate. The Server receives cumulative reports on the existing heartbeat and exports `rainsync_agent_reported_nas_*`; Worker relay receipt is not substituted. This is local transport handoff, not peer acknowledgement, media decoding or billing evidence. Completed/failed/cancelled byte and duration aggregates remain separate.

Cache lookups are recorded at actual eligible output resolution. Waiting for queued/running generation records one Miss; an initially complete cached output must pass proof/read-lease/response validation before recording Hit. A later completion never retroactively converts a Miss to Hit. Cached-byte totals include only bytes handed out for a validated Hit. Cache lookup and transferred-byte denominators differ; a later permission failure can prevent delivery after an otherwise valid lookup.

Server preparation failures count only a newly committed pending-to-failed transition. Replay, rollback, cancellation, replaced plans, and lifecycle/authorization-generation retirement do not count. This measures that transition subset, not every rejected playback request. There is an explicit crash-after-commit loss window before updating the in-memory collector; durable exactly-once export is not claimed.

## Current evidence

Strict workspace Clippy passes. Shared collector 13, Server metrics 4, Worker module 20, numeric compile-boundary 3 and client sampler core 22 checks pass. The actual PostgreSQL auth cancellation/blackhole fixture passes. Thirteen actual Server/Worker/public-API cases pass with frozen source/binary hashes: exact full/range bytes, chunked EOF, paused active accounting, cancellation/revocation/truncation, internal probes, deduplicated committed failures, fixed labels and actual remux Miss→Hit. All owned processes, listeners and PostgreSQL clusters were verified stopped.

The evidence above belongs to the actual-I/O checkpoint. The subsequent backend adds independently negotiated client playback ingress and fixed client_reported aggregates; the browser runtime now produces and transports those negotiated samples. Their media observations remain client-reported rather than independent presentation proof. Legacy CLIENT_STATUS metrics remain explicitly untrusted message/sample counts, not duration or independently measured playback evidence. Observation v1 and owned final Stop behavior are unchanged. Control-recovery metrics have a separate room/auth lifetime and use the independent transport contract below.

## Client-reported playback measurements

Only a successfully published, explicitly opted-in playback grant can POST the strict payload in [the independent contract](PLAYBACK_METRICS_CONTRACT.md). The receiver rechecks current membership, login, lifecycle, viewer plan, source/account policy and expiry after contended locks. Durable sequence/payload state prevents duplicate or conflicting packets from crediting the process-local collector; restarted processes do not replay old credit. A commit-to-collector crash can lose measurement. Telemetry rejection never replaces playback cleanup.

The initial cumulative prefix may include time before preparation and is capped at seven days, but remains untrusted client data. It is never called independently measured playback time. Later elapsed increments use one durable fixed anchor with 15 seconds of allowance; repeated samples cannot renew that allowance. A dishonest eligible client can still falsify measurements within those bounds. Use this namespace for client-reported experience, not billing or resource authorization.

Fixed labels distinguish user_intent/automatic_load, the eight duration categories, and video_frame_callback/playing_time_advance evidence. Integer millisecond totals conserve elapsed time; absent samples remain absent. First-frame elapsed and confirmation-lag histograms receive only the first newly accepted immutable frame. No grant, user, viewer, room, URL or source ID is a label, and delivery mode is not assigned across fallback. At most 121 additional series and fixed collector memory are possible; invalid/overflow updates do not partially change totals. Known dropped measurement reasons are a closed set.

The backend uses 32 in-flight requests, a bounded 4096-entry monotonic request-rate map, three-second cancellation-owned database work, and a 4 KiB route-local body limit before parsing. Accepted non-final packets add at least one second elapsed; normal frontend cadence is five seconds. These controls bound telemetry load rather than proving client truth.


## Control recovery and Agent-reported uplink

The [transport measurement contract](TRANSPORT_METRICS_CONTRACT.md) independently
negotiates both producers. Control reports measure socket-open to accepted state
application, plus an optional interval from an actually observed disconnect.
Hidden-page coverage is separately labelled; persisted-page restoration and
clock discontinuity discard the sample. These successful client-reported
intervals do not establish the tester's physical network-restored boundary from
NEXT_PLAN §12.1, and do not include media catch-up. Missing reports and unrecovered
outages are absent rather than zero. A sample never renews liveness or authority.

NAS metrics start at the actual successful Binary-send boundary and finish
before independently supervised socket/file drainage. Reconnect freezes a new
uncredited baseline; newer cumulative samples recover missed intermediate
packets, while an unsent disconnect tail can be lost. Completed transfers that
cross the baseline can include older bytes in their terminal outcome, so
terminal bytes must not be interpreted as current-connection byte delivery.
No user, Agent, connection, room, file, source, path or credential becomes a
metric label. Eligible clients and Agents can falsify their own reports; only
current authorization and bounded shapes are verified, not producer honesty.

This checkpoint also labels known upstream ASS/SSA text-to-WebVTT subtitles with
an explicit loss of styles, fonts, positioning and animation. The existing
escaped text label and authorized subtitle URL are retained. It does not add
local ASS parsing, graphical subtitle conversion or full ASS rendering.

Candidate validation is tracked separately from the historical checks above;
publication CI, physical devices and long-duration tests must not be inferred
from producer unit checks.


### Transport producer checkpoint evidence (2026-10-01 UTC)

The frozen build covers 191 backend inputs, source digest
`002061daeee91df68bcb968400c14336c84d225ee97e59e896178e91a02b201f`,
and individually hashed Server/Worker/Agent executables. Both new finite suites
verify every input and executable before and after execution.

- Control: seven real PostgreSQL/WebSocket groups passed, including current
  login/membership races, expiry after contention, pool availability while a
  lock remains held, duplicate/malformed/legacy behavior, and a negotiated
  presence socket closing after 44,995ms despite a report sent at 40 seconds.
  Report `df595324-2c56-425f-80c6-3a0de1dfb14a`, SHA256
  `deb41d620f6d52acaa498366332547ac984bbf61493374a1364cc30c0b64bc2d`.
- NAS: eleven groups passed against the same build. Real full/Range downloads
  matched 3,285/127 source bytes, separately matching proxy-received frames and
  Agent reports. HEAD and rejected Range added no body observation. Midbody
  cancellation reported 14,221,312 successfully handed-off bytes while the proxy
  received 11,010,048; the distinction is intentional, and an actually held file
  descriptor was released before the independent durable drain receipt. A real
  Agent reconnect credited zero bytes from its prior cumulative prefix.
- Fabricated report cases are explicitly synthetic: they test baseline, replay,
  malformed input, rate limits and current authority, not actual transmitted
  bytes. A token changed during a real row-lock wait produced an explicit
  unauthorized rejection with no timeout. A replacement connection closed the
  old socket and cancelled its owned task, rather than claiming that an internal
  post-wait branch ran. Fresh current identities could still report afterward.
  NAS report `374e6ba5-d6da-4c43-bf6e-c206cb686b2d`, SHA256
  `02a14db3e0e65555bfa7c24c577201af839ad487d8bf82a082f23f6b89b1ead9`.

All owned PostgreSQL/Server/Worker/Agent processes, listeners, proxy/raw sockets
and HTTP requests were positively checked closed. The initial NAS fixture failed
because its loopback proxy allowed a short response to close before the upstream
socket opened. A standalone reproduction confirmed lost frames; pausing reads
until upstream OPEN fixed the fixture. Production delivery code was not relaxed.
The final authorization test additionally rejects timeout as a substitute for
identity invalidation. Earlier failed reports remain separate evidence.

Producer tests include 105 focused frontend/runtime checks, 17 Agent checks,
nine NAS receiver checks, four subtitle-label checks, and the fixed collector/
DTO checks. The integrated frontend suite passed 349 tests with strict Vue types
and production build. Independent scoped production and fixture reviews found no
remaining blocker. These local checks do not imply this batch's remote full CI
has run, nor close physical-device or sustained-load acceptance.
