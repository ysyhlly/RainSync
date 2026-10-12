# YouTube account native fixture: implemented, not native-qualified

Base: `af1bb109fabf89b942d05772b26dbe9fc8dac01e` (2026-10-10).

This change adds a finite fixture for the real Server's existing YouTube status,
credential import and unlink HTTP routes. **No PostgreSQL, Server, socket, Cargo,
extractor, provider request, real account, user computer or native fixture was
run while authoring this change.** Pure Node checks do not establish native
parity. Registration in package scripts, CI or shared authority-required-checks
is deliberately absent. ORIGINAL and candidate must first be run separately in
an authorized native environment using identical fixture/helper bytes and their
own successful source/binary bindings.

## Files and dependencies

- `tests/youtube-platform-account-authority-native.mjs`: eight ordered groups.
- `tests/fixtures/youtube-platform-account-contract.mjs`: YouTube-only rate
  scope, exact DTO, SQL witness strings, frozen check list and pure assertions.
- `tests/fixtures/youtube-platform-account-holder.mjs`: owned holder lifecycle.
- `tests/fixtures/youtube-platform-account-gate.mjs`: dedicated coordination,
  using the unchanged existing `loadOwnerBinding`, `isolatedServer`,
  `withTerminationSignal`, native PostgreSQL and positive teardown facilities.
  Its mandatory audit occurs after `isolatedServer` has ended every log stream,
  before binding recheck and the final successful report. No shared helper API
  was changed merely to introduce the post-flush hook.
- `tests/youtube-platform-account-fixture-contract.test.mjs`: pure source and
  actual fixture-function negative controls. Fake child objects exercise the
  real holder function; they do not count as a native child/process witness.

Lossless selected-row parsing and database-microsecond window checks reuse
`short-platform-account-snapshot.mjs`; the short-provider rate assertion is NOT
used. YouTube's independent assertion permits exactly one committed increment
in `youtube-cookie-import`, with its own hash, 600-second DB-clock-bounded window,
and exact equality for every other selected row/column. MAX i64 revisions remain
BigInt. Shared sticky response reading/cleanup comes from
`short-platform-account-response.mjs`. Every imported runtime helper receives
its own SHA-256 coordinator receipt, including transitive binding/server/PG/
port/process helpers. Helper bytes and backend binding are rechecked after run.
All runtime coordinator helpers are frozen before Server startup, including the
four dedicated/short snapshot and response dependencies. Startup failure cannot
skip their integrity check. Binding, every coordinator file and each execution
input are rechecked independently in `finally`, including failed fixture/audit
runs; integrity errors are recorded separately and cannot suppress cleanup or
replace the original runtime error. Incomplete preflight explicitly reports
`inputs_complete=false` and cannot certify unchanged inputs.

The gate reads the exact verified binding manifest and independently records
both producer scripts and every `binaries`, `test_helpers`, and optional
`owner_fixtures` entry. Thus an existing eighteenth owner-test executable is
hash/path checked before and after without executing any owner test. Missing
owner fixtures are explicitly recorded as absent, never invented. Each receipt
contains requested absolute path, canonical actual path, byte count, mode and
SHA-256; owner entries also retain their test name and `not_executed` label.

Node major 24 is required before any native metadata probe or service startup.
The actual current Node executable has pre/post path/hash/version receipts.
Each of initdb/postgres/psql/pg_ctl has its own path/hash/version receipt, with a
single canonical PostgreSQL bin directory and identical tool version required.
Only a future authorized native invocation probes those four existing tools
with bounded `--version`; authoring tests replace the process call entirely
in memory. Neither Node metadata nor hash inspection executes backend helpers.
No native version command was run while writing this change.

Final reports are written to a private pending file and atomically renamed.
A final write failure preserves the earlier unqualified report, fails the gate,
and writes a private aggregate with the original runtime/integrity/cleanup
errors first and report-write error last. A successful cleanup cannot upgrade
that outcome to passed. If private evidence writing also fails, the gate still
fails. A stale `running` report is never a qualification result.

Every native case wraps any caught JavaScript rejection in a truthy
`AggregateError` before calling the unchanged shared cleanup helper. The raw
reason stays as the first nested value, including undefined, null, false, zero,
NaN or an empty string; successful cleanup cannot silently swallow it. The main
entrypoint also preserves original and evidence-write errors when handing
failure to the gate.

Failure serialization itself is guarded. Throwing getters or `toString` methods
are recorded as a separate serialization failure; the private file then gets
only a fixed fallback category, explicitly marked `fixed_fallback`. This means
raw details were unavailable, never that original evidence was fully written.
The gate still completes integrity/cleanup checks and attempts its final failed
report. Fallback and report-write failures cannot produce successful qualification.

No production, migration, package, CI, shared-helper or required-check registry
files are changed.

## Frozen expected groups

1. `startup_opt_in_and_private_ten_field_dto`
   - Disabled status/unlink remain usable, import rejects after authentication
     and before consent/revision/parser. Anonymous disabled import remains 401.
   - Same bound Server path restarts enabled. Ten-field DTO is exact;
     `Cache-Control: no-store` freezes the actual existing private response helper.
     No extra `private` token is invented.
2. `exact_login_guest_csrf_json_precedence`
   - Three-route anonymous and guest denial; write-only origin/CSRF;
     malformed/missing/unknown JSON and HTTP cap rejection before authentication;
     GET does not inherit write requirements. Same-user second exact login works.
     Rejected requests preserve full selected snapshots before guest setup.
3. `netscape_caps_consent_revision_rate_and_cipher`
   - Netscape allowlist, minimum LOGIN_INFO plus APISID-family shape,
     normalization, HttpOnly/legacy Secure upgrade, ignored visitor cookies,
     foreign/malformed/expired/duplicate/value/control/line-limit rejection.
   - Exact and oversized 32 KiB cookie and 64 KiB JSON boundaries; consent and
     canonical revision precedence. First import/null-existing/stale replacement
     CAS; six-field decrypted provider/user/account/revision envelope and nonce
     replacement. Ten committed failed-CAS allowances, then real 429 + Retry-After.
   - Real account lock blocks a valid import until its cookie expires. DB clock
     and exact blocked-query witnesses bracket expiry; accepted stored cookie
     demonstrates the original pre-lock parser sample is not refreshed.
4. `status_exact_login_expiry_account_wait`
   - Real YouTube-specific status SQL lock, exact session deadline, two DB-clock
     witnesses and old/new backend identity. Credential is already expired, so
     denial must roll back attempted normalization including old cipher/revision.
     A same-user live session then legitimately normalizes it.
5. `mutations_exact_login_expiry_account_wait`
   - Both mutations wait on the real account lock and naturally cross the exact
     session deadline. Import keeps only its committed outer limiter increment.
   - YouTube unlink intentionally returns 409/PLATFORM_ACCOUNT_CHANGED here:
     it has no short-provider pre-UPDATE live guard, so the guarded UPDATE yields
     zero rows before the final live check. Import returns 401/SESSION_EXPIRED.
6. `mutations_exact_login_expiry_final_update_wait`
   - Owned BEFORE UPDATE advisory-lock trigger with exact import/unlink UPDATE
     SQL witnesses and owning/blocking backend identity. Both requests naturally
     cross the session deadline and return 401 from the final live guard.
     Full rollback includes old cipher, revision and expiry; import alone retains
     its original limiter increment. Each exact HTTP body is drained to EOF.
7. `credential_expiry_replacement_tombstone_overflow`
   - Exact normalization mutation, replacement, repeated revoked unlink,
     missing GET (no tombstone), missing string conflict and null tombstone,
     maximum-i64 overflow, session-cookie null and earliest known expiry in
     milliseconds with production's floor projection.
   - Import's own expired normalization precedes CAS: old revision conflicts
     and rolls normalization back; normalized revision replaces successfully.
   - Owned BEFORE UPDATE RETURN NULL proves real zero-row update rejection for
     both mutations and exact rollback, with only import's external limiter.
8. `precommit_commit_reject_and_owned_cleanup`
   - Each route's mutation is rejected once before UPDATE and once by a real
     DEFERRABLE INITIALLY DEFERRED constraint trigger at COMMIT. Separate DDL
     and nontransactional sequence receipts prove each owned trigger fired.
     All selected rows roll back; the import limiter remains independently committed.
   - Safe public INTERNAL_ERROR, original raw private evidence, response EOF,
     trigger DROP only after drain, exact holder close/backend/PID absence,
     extractor marker absent at request/restart/stop/post-teardown boundaries.
   - Full post-flush Server log audit, unchanged bindings/helpers and positive
     Server/PG/pg_ctl/port teardown are mandatory for final gate success.

These are intended runtime assertions, not claims that the eight groups passed.
The required list is not generated from cases. Pure tests independently freeze
its eight names and reject missing, duplicate, unknown, reordered and unfinished
receipts.

## Safety and startup

Future native execution requires POSIX, Node 24, an absolute owned artifact
folder, native PostgreSQL bin folder, absolute Cargo target and successful
`W03_BACKEND_BINDING` for the exact checkout/server executable. The fixture
requires `RAINSYNC_FIXTURE_CLEANUP_REPORT=1`, rejects caller DATABASE_URL and all
inherited YouTube extractor/live configuration. It does not build or download.

Initial startup is disabled. Enabled restart points the existing trusted-binary
configuration at a fixture-owned absolute 0700 shell placeholder. The production
configuration only validates that file and does not execute/probe it. The
placeholder, if unexpectedly called, writes an invocation marker and exits 97;
it contains no extraction, downloading or networking. Every restart explicitly
uses `binding.server`. No real yt-dlp, Deno, cookie discovery or platform endpoint
is used. This is not an OS network sandbox claim.

Owned raw HTTP, rows, SQL witnesses, original errors and holder streams are
0600 files under private artifact roots (umask 077). Summary reports contain
fixed failure categories and digests, never cookie values, keys or ciphertext.
A primary assertion failure remains failure after successful cleanup; holder
receipt failures aggregate behind the original error. If evidence cannot be
written, the gate fails with an explicit evidence failure. Do not upload raw
private evidence as a public CI artifact.

## Inner cleanup versus final native qualification

The unchanged shared positive-stop receipt exposes Server `exit_code`, `signal`,
`closed_at`, `pid_absent` and listener closure, plus native PostgreSQL
`exit_code`, `signal`, `process_close_observed`, `pid_absent`, `pg_ctl_status`
and port closure. The dedicated gate now explicitly requires exit code 0 and
signal null for every recorded Server and PostgreSQL process, as well as those
positive-stop fields. Missing the entire cleanup receipt (including a resolved undefined/null/falsy
value), missing exit evidence, nonzero exit or signal termination blocks the gate even if all eight groups passed. Actual startup failures may
have zero or one Server record; the gate checks available records without
inventing a second launch. The successful fixture independently requires two.

Observed `cleanup` and `cleanup_qualification` are separate: a rejected exit does
not erase the full stopped-process receipt or replace an earlier runtime error.
The pure mocks exercise these decisions with supplied receipt objects; they do
not prove any real process stopped or any port closed.

The inner report deliberately retains
`native_qualification.result = requires_outer_receipt`, even when its finite
checks and cleanup checks pass. Complete native qualification additionally
requires an actual, independently bounded external supervisor and an outer
receipt showing all of the following:

- Outer Node runner exited 0 with signal null, and its complete final inner
  report and exact source/binding/coordinator/tool-input digests are bound to
  this run.
- The external supervisor observed normal completion without timeout or any
  TERM/KILL escalation. An intervention may stop leaked work but cannot earn a
  passing qualification.
- Every owned Server, native PostgreSQL and SQL-holder process is positively
  closed, every recorded PID/backend is absent, and all owned ports are closed.
  Full inner cleanup receipts and outer supervisory observations must agree.

No outer supervisor implementation or completed outer receipt is supplied by
this patch. It must be provided and verified in the authorized native runner;
a direct invocation or an inner `result=passed` alone is insufficient.

Important inherited limitation: shared `stopServer()` waits on its child close
promise; PostgreSQL shutdown waits on owned psql promises and `postgresDone`;
log shutdown awaits `stream.end` callbacks. These waits are not all intrinsically
bounded. The gate's 180-second AbortSignal does not forcibly resolve those
awaits. The external bounded supervisor is therefore mandatory, not an optional
extra timeout. This patch neither changes the shared shutdown implementation
nor claims a pure test demonstrates bounded native teardown.

## Explicit not covered

- Unknown outcome after a COMMIT network disconnect. Controlled deferred
  rejection proves a known failed COMMIT, not an unknown transport outcome.
- Forced SystemTime-before-epoch, cipher RNG/encrypt failures or exact cipher
  invocation counts. The stored envelope and native ordering witnesses do not
  establish those facts. Encryption can already have happened on an expired
  session import before its live check; no zero-encryption promise is made.
- GET body-cap enforcement without JSON extraction. The existing 1024 route
  cap is retained by source/schema tests; this fixture exercises DELETE's cap.
- Every parser combinatorial variation, every principal-deactivation race,
  every SQL conflict topology, real browser, provider validation/network,
  physical media drain, cross-node playback, and all P08/P09 delivery paths.
- Shared server health polling is existing infrastructure; operation response
  EOF receipts here cover the account calls, not a new readiness-body test.

## Authoring verification

Authoring result: all five syntax checks passed; 142/142 pure Node tests passed
(82 new fixture contracts/function mocks, 58 unchanged snapshot/drain tests and
2 unchanged YouTube schema/route tests). No skipped or failed tests.

Allowed pure checks (no native entrypoint execution):

```
node --check tests/youtube-platform-account-authority-native.mjs
node --check tests/fixtures/youtube-platform-account-contract.mjs
node --check tests/fixtures/youtube-platform-account-holder.mjs
node --check tests/fixtures/youtube-platform-account-gate.mjs
node --check tests/youtube-platform-account-fixture-contract.test.mjs
node --test tests/youtube-platform-account-fixture-contract.test.mjs \
  tests/youtube-platform-account-schema.test.mjs \
  tests/short-platform-account-snapshot.test.mjs \
  tests/short-platform-account-response.test.mjs
```

GitNexus MCP, PATH runner and visible shared runner/index were unavailable;
AGENTS-authorized direct source inspection was used. Pure tests neither start
native services nor substitute simulated counters for real SQL authority proof.
The native entrypoint is intentionally omitted from these commands. ORIGINAL
failure must be investigated before candidate parity/CI registration; no native
pass or release-readiness assertion is made by this change.
