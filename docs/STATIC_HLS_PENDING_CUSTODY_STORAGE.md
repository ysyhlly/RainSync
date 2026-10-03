# Pending-parent HLS custody storage

Status: **implemented but unvalidated storage integration**. Public admission,
prepare dispatch, session/job publication, child/RPC integration, reader rollout
and production activation remain off. The accepted scope is
`STATIC_HLS_PENDING_CUSTODY_SLICE.md`; the broader Stage B proposal is not an
implemented production contract.

## Implemented boundary

Migration 0044 retargets custody to the exact retained request. All historical
captures must already have matching session/user/request-owner provenance;
missing or conflicting history aborts rather than fabricating it. Every Stage A
capture, including an unmarked or disposed capture, continues to protect its
original playback session from DELETE or re-key. Generic request expiry retains
all capture-linked history, and generic preparation pruning excludes every
pending-input request, even when no capture was admitted.

The Server-only builder reads an original database millisecond clock and the
exact login expiry, resolves the stored HTTP catalog target, decrypts trusted
source configuration, validates the closed parent input, and encrypts those same
canonical bytes with a fresh nonce. The root/preparation deadlines are capped by
that original login limit. Under the final ordered authority locks, freeze
re-reads the exact source ciphertext/kind/revision and media
resource/version/generation, then checks live room/login/member/viewer facts.
Nonsecret mirrors and the digest are derived from the canonical input sent to
encryption. Existing pending keys return stable in-progress/terminal/retained
results without re-owning, re-encrypting or advancing their viewer. A NULL input
returns a legacy outcome and stays on the existing legacy path.

For a new key, freeze applies the same-login viewer origin/high-water checks and
1024-viewer cap, retires older pending intents monotonically, and inserts the
fully bound request and original preparation together. It refuses retained
Stage A retirement that would rewrite its immutable completed request. This
private helper has no public caller.

Admission holds room/snapshot/member/login/user/request/viewer/source/media,
then budget, its exact operation capture, and reservation. The budget serializes
retained capacity and measured headroom/revision checks, so admission does not
lock an unrelated global capture set. Pending capture and its exact 128 MiB
reservation must commit together; no permit is minted after a rollback or an
uncertain commit acknowledgment.

Verification repeats the required root-to-parent-input binding and exact stored
identity/deadline checks before installing encrypted graph inventory and its
root digest once under still-pending authority. Validated graph statements are
not scanner/file/process evidence. Verification and monotonic failure/cancel
paths acquire no budget lock, including their triggers. Failure reasons are
stable even when transport errors are retryable. Server begin/guard/completion,
explicit cancel, newer-viewer retirement, lifecycle and startup paths preserve
these restrictions.

Disposal accepts only the original process-local permit and opaque all-positive
`DisposalProof`. It uses budget → exact capture → exact reservation, checks every
write count, and commits positive closure, reservation removal and budget
revision together. Revoked playback/login/source authority does not remove this
old responsibility. No permit or positive receipt is reconstructed from retained
UUIDs after restart.

The inactive pending capture adapter measures one absolute 750 ms authority
budget at `check()` invocation, before the returned future is first polled.
Both activation observations, pool acquisition and the complete transaction
share that deadline. Exact expiry, regressing local clock observations, errors
and timeouts refuse authority. Positive DB remaining lifetimes subtract all
elapsed time from that invocation, including the first activation and any delay
before polling. Cancellation still closes an acquired observation connection
through `close_on_drop`; it does not release custody or establish disposal.

This correction does not install the future responsive owner's phase/root or
freshness fence. `CapturePermit::check()` returns only `()`. The existing
`DeadlineFenceStatements` model holds monotonically shortening phase/root
deadlines, and dedicated pure tests show that conservative observations cannot
extend its earlier fences. Connecting those fences to an owner that checks them
while authority reads wait remains a later slice. No actual one-second stop or
physical drainage bound is established here.

Server preparation acknowledgment locks the exact original request before its
preparation and checks both original-owner writes. Startup records no closure;
pending startup recovery runs after the separate legacy recovery transaction,
with one room and at most 128 sorted pending requests per transaction.

The dedicated pruner uses room/request → budget → exact capture → reservation
and preparation, then a fresh statement/clock. It requires elapsed retention,
positive original preparation closure and either positive known-capture
disposal or synchronized never-admitted absence. Session and operation identities
are both checked for reservations, cache/read/output and other dependencies.
Known/uncertain capture responsibility is never converted to absence. Pruning
never deletes a reservation as a shortcut.

## Migration and compatibility

0044 is an atomic migration requiring a **quiescent migration window**. It takes
request-before-capture prerequisite table locks with `NOWAIT`, including the
session, job, reservation and preparation relations needed by its later DDL.
A busy relation aborts the whole migration with no partial schema. Do not skip a
guard, advertise success, loop indefinitely, or assume arbitrary rolling upgrades
are supported. Historical provenance failures require investigation in an owned
backend; no request is backfilled to make migration pass.

The production pool continues to advertise reader1, and
`static_hls_reader_supported()` is unchanged. Dedicated pending-storage
transactions set only an exact transaction-local reader2/recipe1 fence; this does
not advertise or activate the future full reader2 contract. Authority predicates
remain independent of compatibility, so unsupported readers cannot turn unknown
capability into source revocation. Legacy NULL rows preserve their original
paths. Unknown closure is retained indefinitely.

## Acceptance still required

Focused offline compilation and pure tests cover canonical sealing/projections,
version/size/deadline refusal, identity mismatches, stable retained outcomes and
trusted catalog target/header mapping. They do not establish PostgreSQL syntax,
trigger/deferred behavior, migration/FK acceptance, MVCC, actual row counts,
deadlock freedom, physical drainage or timing.

Dedicated deterministic fake-clock tests cover staged activation/DB latency,
pool wait contribution, exact budget and DB expiry, delayed first polling,
clock regression, unknown/revoked authority and observation cancellation. These
are local budget/future witnesses, not PostgreSQL or responsive-owner evidence.

`tests/sql/static_hls_pending_custody.sql` is an **unexecuted future assertion
fixture**, with a separate required multi-connection/consuming-boundary matrix.
It contains synthetic SQL envelopes and positive metadata statements, not real
scanner or disposal receipts. It provides no service-launch wrapper. The later
owned backend must bind actual Rust transactions and source hashes, exercise
contention/rollback and upgrade refusal, and separately obtain original opaque
runtime proof. Existing F2 PostgreSQL uncertainty and old HLS unknown custody
remain unresolved; this new work cannot clear them.
