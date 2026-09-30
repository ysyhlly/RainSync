# W08 shared collector and Worker production modules

Base: `9b167ab92e36b373bdb6c46718ced16dfb8070aa`. Existing private collector
checkpoints are preserved in commit history. This follow-up uses the existing
media-core crate and changes no manifest, lock, migration, protocol or main/lib.

## Exact controller-owned edits required

1. `crates/media-core/src/lib.rs`: `pub mod runtime_metrics;`.
2. `apps/media-worker/src/main.rs`: `mod metrics; mod metric_stream;`.
3. Worker App (baseline main.rs:37):
   `metrics: media_core::runtime_metrics::RuntimeMetrics`.
   Initialize once with `metrics: Default::default()` in the App constructor.
   Existing Clone derives share its process-local Arc, not another instance.
4. Worker Router: `.route("/metrics", get(metrics::endpoint))`.
   Existing error-normalization middleware can wrap this route as usual.
5. Server App remains `metrics: Arc<metrics::Metrics>` (baseline main.rs:56).
   Owned metrics.rs now imports `media_core::runtime_metrics as runtime` and
   calls `runtime.render_for(runtime::Process::Server)` for shared families.
   No extra Server App field or router change is needed.

**Without edit 1, the Server binary's new import cannot compile.** This is an
explicit shared-wiring gate, not a passed full-workspace build. The independent
Worker test harness imports the exact new collector source via its own crate
alias to validate modules before controller wiring; this scaffolding adds no
production crate or shared export. After controller wiring run the affected
Server/Worker suites with the real module export; then test the actual producers.

## Production files and callable interfaces

- `crates/media-core/src/runtime_metrics.rs`: public std-only collector. APIs
  `begin_transfer(Layer, Cache) -> Option<Transfer>`, `Transfer::sample(u64,u64)`,
  consuming `finish(Outcome)`, `cache_lookup(CacheDecision)`,
  `playback_failure(Failure)`, `render_for(Process) -> String`.
- `apps/media-worker/src/metric_stream.rs:21`:
  `wrap<S>(source:S, metrics:&RuntimeMetrics, layer:Layer, cache:Cache) -> Measured<S>`.
  Measured implements Stream where S yields `Result<axum::body::Bytes,E>`.
  Non-Unpin sources work through one pinned Box. Pending adds no sample; each
  yielded successful chunk adds its byte delta once. First error is terminal and
  records Failed once; EOF records Complete once; body Drop records Cancelled.
  Capacity refusal preserves byte delivery while omitting measurement. Wrapper
  state is constant size and retains no sample history. The input's own buffers
  and actual delivery admission remain the HTTP owner's existing resource budget.
- `apps/media-worker/src/metrics.rs:68`:
  `endpoint(State(app):State<App>, headers:HeaderMap) -> Response`.
  Needs only App.db and App.metrics. Successful scrape is Prometheus text with
  no-store. Missing/invalid/expired/revoked session is 401, non-admin is 403,
  unavailable/deadline-limited auth is 503, with generic bounded error text.

All shared collector samples have only `process=server|worker`, fixed layer,
outcome, cache result/reason or histogram le labels. Server-only legacy metrics
retain compatibility labels and explicitly describe client-reported provenance.
No IDs, URLs, paths, credentials, request strings or raw errors are labels.
Unobserved families are absent; an authenticated empty scrape does not claim
Worker ready or healthy. No browser telemetry ingress is introduced.

## Same-database RainSync admin authorization

The Worker reads the same sessions/users tables as Server main.rs:162. It hashes
one rainsync_session cookie using existing SHA-256 hex semantics, requires a live
session and current users.admin, and never creates a session/token. Cookie bytes
are bounded to 8192 and current session token shape to 64 hex characters; ambiguous
cookie duplicates fail closed. Authorization Bearer, service tokens and query
parameters are not alternatives. This read-only GET needs no CSRF write grant.
The final ingress must route cookies over the user's existing secure topology.

One request issues five bounded DB commands: BEGIN, SET TRANSACTION READ ONLY,
transaction-local config SELECT, primary-key session SELECT yielding zero/one
bool, and ROLLBACK. No count scans, sweeps,
in-memory identity table, detached auth task or background polling occurs.
Pool acquisition/whole auth operation has a 3s deadline; transaction-local
statement_timeout is 1000ms and lock_timeout 500ms. Dropping an HTTP request drops
the SQLx transaction; DB-side timeouts bound any still-executing query and its
rollback is returned via SQLx cleanup. Local settings cannot leak to the next
pool borrower. No decrypted source material or session identifiers are exported.

## HTTP-owner hook placement (one boundary, one count)

For actual HTTP primary media, wrap response.bytes_stream in `http_media.rs:263`
BEFORE sniffing. Count the entire successful upstream chunk (including bytes
retained as prefix), not merely SNIFF_BYTES. Replay of saved prefix at :361 is
part of egress, never another UpstreamRead sample. Manifest/key/subtitle traffic
needs an explicit separate inclusion policy; default primary-media throughput
must not silently absorb those metadata/control resources. HEAD/304 and rejected
admission with no body have no transfer handle.

WorkerEgress wraps the FINAL media body producer after prefix replay, range/file
selection, read-lease and playback-access checks (baseline playback_access.rs:576).
It counts bytes handed from that producer to the HTTP Body, not remote receipt.
Do not also wrap the file_delivery.rs:95 inner read at WorkerEgress. If a new
HTTP owner replaces this path, apply the same final-boundary rule. Wrapper must
be inside any outer owner that can emit its own error, or the final measured
source must include those errors, so expiry/cancellation is not falsely Complete.
Never drain a body merely to collect metrics.

Cache::Hit means preexisting validated cache-eligible content, not any freshly
built file eventually opened. Emit one cache_lookup decision per eligible request.
Count newly generated content after wait as Miss; continue using Cache::NotHit
for its egress. No retroactive cache-hit classification. Separate lookup and byte
denominators. NasUplink remains absent until actual Agent send-side instrumentation;
Worker relay receipt is insufficient.

Committed preparation failure hook remains after playback_requests::fail's new
pending-to-failed transition commits, using rows_affected to exclude replay and
excluding cancel/supersession. Browser startup/window/reconnect producers remain
unwired with the separate proposal; no metric zeros are fabricated for them.

## Basic validation and limits

- Shared collector direct rustc tests: 13 passed, 0 failed. Includes fixed process
  labels, independent instances, repeated cumulative samples, live bytes,
  saturation, 1024 cap, fixed cardinality and concurrent snapshots.
- Owned Worker modules harness: 5 passed, 0 failed; DB test was deliberately
  ignored in the no-DB run, then executed separately.
- Actual PostgreSQL + localhost HTTP fixture: 1 passed, 0 failed. Checks GET/HEAD
  content, no-store, absent cookie 401, member 403, admin 200, expiry/revocation/
  admin demotion, lock deadline, task cancellation during a real waiting query,
  pool recovery while the blocking lock remains held, and timeout-setting reset.
- Updated compile-boundary script: 3 passed (negative/NaN/Infinity body bytes).
- Formatting and whitespace checks pass. No long tests, device tests or unrelated
  offline tests repeated. Earlier 15/15 Server checkpoint remains historical;
  the new Server binary compile awaits the controller-owned public export.

Fixture uses a fresh Unix-socket-only PostgreSQL data directory owned by this
slice, no shared database, preexisting dev service or production credential.
Only deterministic synthetic test records were inserted; no service credential
was issued. DB process was stopped after evidence capture. Build uses the
isolated w08-target and two jobs. Harness runs new production modules directly;
real main/App route and body producers remain integration work, not proven E2E.

After required controller edits, suggested focused commands:

```sh
cargo test --locked --offline -p media-core runtime_metrics::
cargo test --locked --offline -p rainsync-server metrics::
cargo test --locked --offline -p rainsync-media-worker --test runtime_metrics worker_
# DB fixture requires a new empty isolated database:
RAINSYNC_METRICS_TEST_DATABASE_URL=... cargo test --locked --offline \
  -p rainsync-media-worker --test runtime_metrics \
  worker_real_session_authorization_deadlines_and_cancellation -- --ignored
```

This module slice does not complete W08, prove Worker readiness or replace
weak-network/100-online/device/72-hour acceptance.

## Remote advancement recorded at handoff

Final fetch found integration at `79cff19718f94d053d69f5b969147ae540921d9e`,
two commits ahead of the fixed base: `95a271c` (account policy cleanup fixture and
validation record), `79cff19` (compiled presence contract/shared sequence).
Those commits change presence/protocol/Web presence files, Server main.rs and
associated documentation/tests. They do not change this slice's metrics,
media-core collector or Worker module paths. No merge/rebase/reset was performed;
feature history still starts at exact `9b167ab`. Controller must apply its shared
exports/App/route changes against the advanced integration branch. Complete
remote diff path/stat evidence is included in the downloadable delivery package.
