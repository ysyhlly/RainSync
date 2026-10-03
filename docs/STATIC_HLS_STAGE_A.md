# Static HLS Stage A: internal ownership and compatibility foundation

Automatic static-HLS fallback is disabled. There is no public parent offer,
child-creation path, activation endpoint or production static-queue dispatcher.
This slice is local engineering foundation, not production activation or device
acceptance. Binary version 1 and every NULL legacy restriction keep their existing
meaning. `static_hls_capture_id` is an internal DB custody restriction, not a
public fallback marker.

## Ownership and authority

Migration 0043 adds small capture custody rows referencing the existing exact
login-bound request/session. Initial capture requires a completed, live parent,
its exact immutable request owner epoch and resource authority, active room and
lifecycle, current media generation, current viewer plan and source/account
policy. The generic capture transport/manifest/audio inputs are not yet a
DB-produced typed input binding. A trusted future caller must construct them
from that exact frozen source/resource; independent gateway fixtures alone do
not establish full DB-to-source binding. A legacy NULL-login parent, failed request, recursively marked parent or
parent with pre-existing media work cannot be adopted. Existing public grants
are not converted by a production endpoint; fixture marking is explicit owned
SQL for compatibility experiments only.

Capture inventory/proof is encrypted on the custody row, bounded to 256 KiB.
It cannot rewrite the original session authority. Capture expiry is fixed at
admission, no later than the original parent deadline and 30 minutes. Session
renewal cannot extend it. Every later completion repeats authority checks. The
current capture trait checks every chunk and every 250 ms, with a bounded 750 ms
authority query; it subtracts the complete SQL/gate round trip. It does not yet
carry an exact authority-expiry monotonic deadline into the owner watchdog, so
sub-250 ms expiry stopping is not established. Production activation remains off
until the required stricter fence is reviewed.

Admission reserves the entire 128 MiB in the existing cache_write_reservations
catalog. Purpose, owner, attempt and byte budget are immutable. The existing
cache_budget row/revision serializes budget and capture admission. Two global
owners and one per user are conservative Stage A limits: **CPU admission and
retained snapshot storage remain coupled until complete snapshot disposal**.
Finishing a capture does not return a slot for more parents. Cancelled, expired
or crashed unresolved owners still count, even if a scheduling lease is gone.

The mint-only in-process permit is not deserializable or reconstructible from
retained UUIDs after restart. Positive stream/process/file disposal requires the
capture owner's opaque receipt, tied to the exact frozen capture/owner identity.
The process diagnostic distinguishes never_started from reaped. A database
failure, missing receipt or unknown process result never releases the reservation.
No Drop path releases storage. DB guards retain captured requests and forbid room
closed/archive commits while capture custody is unresolved; an old closer's final
transaction fails rather than publishing closed events without actual disposal.

## Mixed binary boundary

Each new physical PostgreSQL pool connection establishes the purpose-specific
rainsync.static_hls_reader=1 contract, including replacement connections. It is a
compatibility promise, not protection against malicious superuser SQL. No role,
RLS, network or credential change is involved.

playback_source_authority_allowed is independent of reader compatibility.
Unsupported-reader rejection must never imply actual authority revocation. DB
mutation guards protect marked sessions, captured requests, logical jobs,
outputs/file proofs, execution receipts, cache catalog/read leases and capture
reservations from frozen old SQL. Old retirement is allowed only after independent
revocation and only for the necessary cancellation fields; it cannot replace an
owner, increase an attempt, extend a lease or change the frozen source/spec.

NULL jobs use the original queue. Static work has an explicit static_hls_v1
predicate; no old worker can claim it even if its SELECT omits the new column.
The separate new claim shares the existing durable fairness turn and claim lock.
The production Worker only dispatches NULL work in Stage A.

## Activation evidence

The pure negative gate requires a positively supplied old-process/resource drain,
actual Worker contract, exact instance/DB/cache/challenge binding and fresh
monotonic evidence. UUID files, empty tables, expired leases, executable banners
and readiness do not prove that old processes stopped. **Even all-positive
compatibility evidence ends with AdmissionDisabled in Stage A.**

An actual-worker probe is a separate bounded authenticated read, using the
existing source key for a fresh purpose-separated AEAD challenge. Shared-cache
evidence must come from a fresh Server-written random challenge read by the
actual configured Worker; a static cache UUID or matching string path is not
such evidence. A temporary challenge/digest/expiry written to the Server
database must also be read by that Worker's actual pool, so a cloned persistent
DB UUID alone cannot satisfy the proof. Conditional cleanup only clears its own
challenge. The admin-only explicit POST accepts no caller URL and repeats
Origin/CSRF/exact-login/current-admin checks after awaits. It does no startup or
periodic probing. Missing/old endpoint, stale response and mismatched DB/cache/
instance keep the gate closed. Probe wiring and integration evidence are
reported separately from the first schema foundation.

## Bounded evidence commands

Native-only PostgreSQL is required; these fixtures have no Docker fallback and
never accept an existing production database URL:

```
RAINSYNC_NATIVE_POSTGRES_BIN=/owned/postgres/bin \
RAINSYNC_ARTIFACT_DIR=/owned/artifacts \
node tests/static-hls-foundation-migration.mjs

RAINSYNC_NATIVE_POSTGRES_BIN=/owned/postgres/bin \
RAINSYNC_ARTIFACT_DIR=/owned/artifacts \
RAINSYNC_STATIC_OLD_BINDING=/owned/frozen/backend-binding.json \
node tests/static-hls-frozen-runtime.mjs
```

The migration fixture records rollback/NULL preservation, no-contract rejection,
real concurrent admission, unresolved capacity/accounting, old mutation/cleanup
refusal and old/new close refusal. Its synthetic DB receipt rows are SQL guard
fixtures, not operating-system disposal evidence. Capture owner's actual HTTP/
filesystem/process fixtures provide that distinct evidence.

The frozen runtime verifies source-bound actual old Server/Worker binaries,
unchanged marked ownership/output/receipt rows across real old housekeeping,
renewal/replay/delivery refusal and a decoder sentinel with zero marked-work
launches. Reports retain source/binary hashes, native database data/logs and
positive child close/PID absence/port closure. No browser, real upstream account,
Agent/NAS, installation, deployment or public fallback acceptance is claimed.
