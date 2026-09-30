# v0.1 next: shared contract, milestone 1

Base: `5ce1c8496bfa6a216be34361df3dd8aae9e4168e`.
This is an additive implementation contract, not release acceptance. No deployment
or production migration is implied. Existing lifecycle/cleanup and resource
release proofs remain authoritative.

## Playback intent identity

- `PlaybackRequest.viewer_id?: UUID` and `plan_generation?: u32` must be present
  together. Generation is in `1..=4294967295`; mismatched fields or zero return
  HTTP 400 `INVALID_PLAN_GENERATION`.
- Each mounted browser player generates a fresh opaque viewer UUID, and advances
  its local intent generation before starting asynchronous preparation. It does
  not reuse that UUID with a reset counter. This is not a user or device identity.
- The durable high-water scope is `(authenticated user, room, viewer_id)`, across
  media and lifecycle changes. It is not an authorization grant. Membership,
  lifecycle epoch and media generation are independently checked as before.
- A new logical request must be above the high-water mark. Out-of-order/equal new
  keys fail HTTP 409 `STALE_PLAYBACK_PLAN`. Generation gaps are allowed so that
  an aborted/lost response cannot strand the next intent.
- To bound durable state, a user may register at most 1024 distinct viewer IDs
  per room over the room lifetime. Existing viewers may keep advancing. New
  IDs above the cap return HTTP 429 `PLAYBACK_VIEWER_LIMIT_EXCEEDED`, without
  admission side effects; it is not automatically retryable. Other users remain
  independent. High-water rows are never deleted to free slots, because that
  would permit old intents to replay. A new room has a new scope. A future
  compactable identity scheme needs its own authenticated expiry contract.
- Same-key retries retain the generation and canonical request payload. They may
  replay only if their generation is still current. Cancellation/failure do not
  lower the durable high-water mark.
- Higher-generation admission retires older opted-in requests/sessions for that
  viewer through existing stop/cancel/upstream-close paths. It never marks a
  process, transfer or upstream resource physically drained.
- `PlaybackPlan.plan_generation?` and `PlaybackReadiness.plan_generation?` echo
  the grant generation. A new client applies results only when its current
  intent, media, session and echoed generation match.
- Audio/rebuild/fallback create new intent generations, while an HTTP retry of
  the same logical request retains its generation. These changes do not modify
  room revision. Room media generation and Worker attempt remain separate.
- Capability probes omit both fields and do not supersede active playback.
  Existing clients omitting both fields keep the legacy path. New clients fail
  closed when a response lacks the requested generation.

## Migration 0031

Append only `0031_playback_plan_generations.sql`; do not alter migrations 1–30.
`playback_viewer_plans` has the scope primary key, positive bounded bigint
`plan_generation`, and `updated_at`. Sessions and requests gain nullable paired
`viewer_id` and `plan_generation` fields and filtered lookup indexes. Legacy rows
remain NULL; migration does not invent past generations or resource receipts.

## Other interfaces and ownership

This milestone deliberately retains the current Provider, observation, event,
presence and metrics interfaces. A proposed change needs concrete call sites,
compatibility behavior and a test vector before changing a shared interface.
Do not add speculative public fields or a second upstream reservation ledger.

Integration owns protocol/generated schemas, migrations, manifests/lockfiles,
CI, shared `lib.rs`/`main.rs`, and global status documents. Playback implementation
owns server media/capabilities/requests, player-core/sync-engine and Web playback.
Other module tasks use isolated branches and request shared changes before
editing. Baseline contract tests do not prove the dependent implementation;
merge only with implementation and rerun the complete affected test suites.

## Required focused checks

Legacy request hash/replay compatibility; malformed/zero generation; same-key
retry; equal/lower/newer key ordering; canceled/failed high-water; simultaneous
admission and late publication; independent viewers/users/rooms; media/epoch
changes; readiness/renewal fencing; fast audio/fallback/seek switching; no room
revision change; capability probes do not supersede active playback; migration
from actual 1–30 schema with legacy rows. Existing cleanup and revocation suites
must remain green. Real products, devices, old production databases and long
runs retain their independent acceptance gates.
