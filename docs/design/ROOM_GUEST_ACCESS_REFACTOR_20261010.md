# Room guest-access GET/PUT extraction

## Scope and provenance

This change applies the complete guest policy GET and PUT unit from the frozen
2026-10-10 handoff to baseline
`5d976089e3f44a767264a7cb76fe0e23bd321f55`. It is an implementation with static
checks, not a database or release acceptance result.

The original evidence remains unchanged in
`docs/handoff/20261010/pending-source-proposals.zip`:

- `external-proposals/room-guest-access-operations-20261010T1305Z`
- `external-proposals/room-guest-access-authority-native-20261010T125217Z`
- `external-reviews/room-guest-access-whole-source-review-1320`
- `external-reviews/room-guest-access-authority-fixture-review-1323`

All 126 production inputs and 112 fixture inputs matched the baseline byte for
byte before application. The complete 141-member production manifest and
264-member fixture manifest, including their framed aggregate hashes, were
revalidated. The production proposal's original static verifier passed its
complete-file inverse and all four ordered SQL literal checks.

`guests.rs` now keeps extraction, canonical DTO re-export, and private JSON 200
responses. `rooms::guest_access_operations` owns the DTO and both operations,
using the existing `RequestContext` containing only database and Origin. It
does not receive `App`, response construction, room registries, or a new
authority framework. `rooms.rs` receives only the module fragment; the frozen
illustrative whole-file compose reference was not applied.

The production candidate differs only by rustfmt formatting and two new
test-only serde checks. Replacing the actual HTTP adapter span with the frozen
original reconstructs the complete original `guests.rs`. Removing only the
module fragment reconstructs the complete original `rooms.rs`. Routes, shared
authorization, migrations, guest entry, and guest maintenance remain unchanged.

## Preserved behavioral boundaries

- GET authenticates once at entry, rejects guest principals, reads owner first,
  then policy and global settings. It has no membership/lifecycle gate,
  transaction, or final login check. A legitimate owner without membership can
  still read. A read already admitted before natural expiry can still finish.
- GET retains the same `enabled`, `guests_enabled`, `session_ttl_seconds: 7200`,
  and `invite_required: true` wire fields, and the original error precedence.
- PUT retains boolean `enabled` deserialization with `deny_unknown_fields` and
  the original HTTP Origin/CSRF checks.
- PUT continues through the existing owner-authority transaction: room lock,
  active-lifecycle check, snapshot lock, actor membership lock, current role
  SHARE lock, exact originating session SHARE lock, then the existing admission.
- The original UPSERT and all bind ordering are unchanged. Existing database
  triggers still delete guest sessions, revoke principals, and anonymize names
  within that same transaction. They were not reimplemented in Rust.
- The original final exact-login natural-expiry check and deferred cluster fence
  remain before successful commit. No new delegated guest-management grant,
  final GET check, broadcast, physical drain, or restoration of revoked guests
  is introduced.

## Tests and actual verification

`tests/room-guest-access-authority-native.mjs` is based on the frozen fixture.
Independent review identified two incorrect public-code expectations in its
GET guest and PUT guest-before-Origin assertions. The first working correction
changes those expectations from `GUEST_RESTRICTED` to exact `FORBIDDEN`, plus an
explanatory source comment. `identity::request` still emits internal
`guest_restricted`; `http_api::errors` passes this to
`ErrorCode::from_reason`, whose unknown-reason HTTP 403 fallback is `Forbidden`.
There is no public `GUEST_RESTRICTED` enum variant. Production mapping and
request precedence are unchanged; no alternate code is accepted by the test.

The archived fixture remains unchanged with SHA-256
`b7b0e0a735e197e1028a8aa143e3bd561f933be1eadbb4a4703ad01d3ce897b5`.
A second independent finding corrected the snapshot SQL constructor. The
current schema selects 56 table keys, which would require 112 arguments to the
archived single `jsonb_build_object` call. PostgreSQL documents a default
[100-argument function limit](https://www.postgresql.org/docs/18/limits.html).
The working fixture now creates one two-argument object per selected table and
combines those objects with `||` inside the same single `SELECT (...)::text`.
All selected tables, row filters, row ordering, and snapshot fields are retained;
no cap or field stripping is introduced. A source comment explains the bound.

The corrected working fixture has SHA-256
`ab1ffb0fa8d0e2a1e8a97c71b2efbc384d87151a530f37c4f14438e0f310210f`.
Its historical proposal comment remains; this document records the current
implementation and unrun runtime status.

Its four cases produce five named checks:

1. GET/PUT ingress, wire fields, extractor/error precedence, roles, membership,
   lifecycle, and globally disabled policy disclosure.
2. GET entry-only natural expiry at the actual policy SELECT.
3. PUT natural expiry while its UPSERT is blocked in the real revocation trigger,
   followed by complete selected-row rollback comparison.
4. Current-admin demotion before the original users SHARE lock.
5. Successful disable/off/on never restores the exact old guest login.

The native test retains its 180-second owner gate, finite witness/cleanup bounds,
exact UTC-microsecond deadline, same holder/waiter identities, positive process
cleanup, private 0600 raw evidence, and safe reports. Its selected rows and empty
media setup do not prove whole-database, WS, media drain, or cluster equivalence.

Run locally without services:

```sh
npm run test:room-guest-access-contracts
npm run test:backend-contracts
node --check tests/room-guest-access-authority-native.mjs
```

Executed for this change: new source/generation contracts **5 passed**, existing backend
contracts **13 passed**, native fixture Node syntax passed, changed Rust files
passed direct rustfmt checks, and `git diff --check` passed. The exact original
source inverse, formatted canonical core, unchanged authority/routes/migrations/
handoff were checked separately. The working fixture differs from the archived
bytes only by the two exact public-code corrections, the bounded snapshot
constructor, and their source comments. The new no-database generation test
executes the actual fixture's pure SQL-builder statements with 64 selected keys;
it checks that all keys and complete value expressions survive and that every
object constructor has exactly two top-level arguments. It never loads the
native fixture, starts a service, or claims PostgreSQL execution.

The two new Rust DTO tests were added but not run in this lane. Compilation,
Rust tests, PostgreSQL, HTTP, socket, and browser execution were not performed.
GitNexus MCP and a usable existing runner/index were unavailable, so current
source was inspected directly. No dependency installation was needed.

## Required original/candidate acceptance

Before claiming behavioral acceptance, qualify the identical native fixture on
the untouched original, then on the candidate with separate current-source/
binary bindings and owned artifact directories. Required existing companions:

```sh
node tests/scoped-guests-migration.mjs
timeout --signal=TERM --kill-after=15s 180s env RAINSYNC_MEDIA_STACK_EVIDENCE=1 node tests/scoped-guests.mjs
npm run test:room-guest-access-authority-native
```

Use native owned PostgreSQL, no caller-supplied `DATABASE_URL`, and existing
`scripts/bind-native-backend.mjs`/`W03_BACKEND_BINDING` prerequisites. Registration
of the npm entry does not mean it ran or passed. Profile identity and the real
two-node control-cluster fixture remain relevant broader regressions.

The GET wait must reach the exact original policy SELECT. A PostgreSQL
SQL-function planning lock during earlier authentication is a failed fixture
qualification, not evidence of entry-only GET behavior. The trigger wait must
identify the top-level original UPSERT, not relabel an unrelated blocked query.
If original qualification fails, preserve that failure and fix the fixture only
from observed original behavior before comparing candidate results.

No historical test receipt is promoted to fresh acceptance. P08/P09, provider
accounts, Windows/device coverage, long soak, publication, merge, and deployment
remain outside this change.
