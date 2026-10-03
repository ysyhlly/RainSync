# Per-login media authorization: proposed W03 contract

Status: implementation authorized for policy B, 2026-10-02; isolated work is in progress. This document itself implements no universal binding or expiry change. The user approved preserving each legacy current expiry while preventing renewal extension and unbound retry issuance. This is v0.1 shared-source authorization, not a private-library/Moderator expansion.

## Actual gap

Authentication retains account ID/admin but discards the exact login in most media flows. The existing optional HTTP-file authority is narrower than a universal media grant. Account-scoped idempotency, viewer high-waters, cancel-before-reserve tombstones, provisional probes, upstream reservations, readiness, observations, renewal, Stop and metrics all need consistent origin ownership. Binding only final playback_sessions would leave pre-publication work and same-account mutation paths exposed.

Useful existing mechanisms:

- `apps/server/src/media.rs` already captures the authenticated cookie hash at playback entry, but `playback_requests::begin_authenticated` uses it only in the advertised HTTP-file path
- `migrations/0037_http_file_fallback.sql` explicitly preserves absent-context legacy grants and rejects malformed/present-null context
- `apps/media-worker/src/playback_access.rs` repeatedly calls `playback_source_allowed`, including backpressured bodies, using two-second checks and a five-second maximum authorization age; this can enforce a new server-authored resource origin without changing playback URLs
- `upstream_reservations` already separates late SID/checkpoint cleanup responsibility from playback authorization. A revoked login must not prevent capturing a late SID or stopping its owned upstream session
- Login uses positional `INSERT INTO sessions VALUES(...)`; reuse the existing canonical token hash internally rather than silently adding a sessions column that breaks old binaries

No real token or login-hash value belongs in this design, diagnostics, telemetry labels or shared reports.

## Proposed implementation boundaries

1. Add nullable canonical origin columns to request, playback, upstream-reservation and viewer high-water rows. Keep account ownership separately. New room-bound origins also retain the membership identity so leave/rejoin cannot revive old authority
2. Never use `ON DELETE SET NULL`, infer a historical login from current account sessions, or change a bound origin. Logout removes the original session but the recorded origin remains non-null and auditable
3. Bind every newly admitted provider and capability/probe path, independent of optional client feature flags; no client-supplied login field is trusted and no public playback-protocol extension is needed
4. Add a versioned server-authored origin envelope in the encrypted/stored playback resource, with database consistency checks against typed columns, account and room. Preserve existing HTTP-file restrictions as additional restrictions
5. Keep current request/viewer keys initially; reject cross-login collisions before replay, cancellation, generation mutation or supersession. A login cannot adopt another login's existing logical request or viewer slot
6. Under consistent room/snapshot → membership → login → source → request/grant locking, recheck database-clock expiry after waits. Existing early admission reads do not replace final publication gates
7. Carry the same origin on upstream reservations before any final session exists. Guard negotiation claims, response publication, activation and Start/Progress, but keep late response recording and cleanup admissible after revocation
8. Require caller-origin equality for readiness/replay, observations, metrics, renewal, Stop, cancellation and generation supersession. The fact that origin A is still live is not permission for caller B
9. Extend job claim/heartbeat/publication and bounded all-provider retirement. Logout should wake retirement only after committing its session deletion, avoiding inverted room/login locks. Natural expiry must also retire work without waiting for the generic expired-login sweep

## Compatibility decision

### A: preserve current legacy behavior

Existing NULL origins retain stored expiry and existing renewal/retry behavior. They are never assigned to a guessed login, adopted by the next caller or revoked account-wide. New bound grants gain isolation, but legacy grants may remain renewable indefinitely; universal per-login revocation cannot be claimed.

### B: finite grandfathering

Existing NULL origins retain exactly their current expires_at, with no early invalidation. Renewal cannot extend that time and retries cannot mint additional unbound authorization. A fresh authenticated request/key creates a bound replacement. This changes legacy renewal/retry compatibility and needs explicit approval before implementation.

Neither choice removes existing 0037 restrictions. There is no timeout/admin/UUID escape hatch for an unrelated unknown resource-release obligation.

## Cutover and rollback

Nullable columns alone cannot distinguish old rows from new unbound rows written by an old Server. Declare a coordinated cutover: either accept mixed-writer unbound issuance and keep the W03 result partial, or reject new unbound issuance after an approved switch. Bound rows must stay bound even if an old resource replacement or UPDATE runs.

The database predicate can protect compatible old Workers, but old Server control handlers still lack caller-origin equality. Schema compatibility does not make arbitrary Server rollback safe. Set a minimum compatible Server version and fail preflight for unsafe rollbacks. Data backup restoration and authorization-semantics rollback are distinct operations; a supported rollback must retain the gate or stop new admission until a compatible Server is active.

## Required isolated acceptance

- Same account with real fixture logins A/B, plus other account C, across every provider and old/new optional request shapes
- B cannot replay, renew, observe, report metrics, stop, cancel or supersede A, including copied idempotency/viewer identifiers; A's own retry remains idempotent
- Logout/expiry of A during preparation, upstream negotiation, final publication, job queue/execution, headers, active bodies and backpressure cannot publish or revive authority
- B retains actual decoded media, readiness/renewal/observations and its original upstream SID/DeviceId; account/source/member revocation still applies at its intended wider scope
- Manifests, segments, subtitles, HEAD/Range, hot-cache paths and capability probes use the same origin restriction; delivered browser buffers are reported separately from the stream-revocation window
- Legacy rows preserve their exact original expiry and encrypted scope under the chosen policy; bound-to-NULL, malformed origins, old inserts and old resource rewrites fail safely
- Exact supported old binaries are exercised for migration/rollback; arbitrary old Server compatibility is not inferred from a database version number

The separately prohibited normal Agent WebSocket receipt-race reproduction and unprovable historical Agent cleanup are outside this design and its test plan.
