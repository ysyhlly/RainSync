# HTTP file decoder continuation, first implementation slice

Status: parent accepted bounded scope and request sequence on 2026-10-01. This is an implementation contract, not a claim that code or acceptance is complete. Baseline: collaboration commit `8e46f157cfa427b7614bf7417c53d2d3b1cdd31f`.

## Supported behavior

A newly negotiated, currently live generic HTTP **single Binary file** may continue once into local transcode, using the exact original representation. The original response must prove complete length and a strong ETag or the existing reliable Last-Modified rule. Its current mode must be direct; current evidence must justify transcode and establish exactly one audio selection or positively establish that there is no audio. Missing/ambiguous audio evidence is ineligible. The successor is not eligible for another continuation.

HLS inputs, weak/missing validators, unknown complete lengths, multiple targets, stopped/expired parent grants, old non-negotiated grants and other providers are ineligible. Same-key retries of an already persisted claim are the sole stopped-parent exception. Ordinary explicit reload remains a fresh intent. Decoder route hints alone are not continuation authority.

## Additive wire contract

`PlaybackRequest.http_file_fallback_version?: 1` negotiates the feature. `http_file_fallback?: { parent_session_id: UUID, final_observation?: PlaybackObservation }` requests the single transition and requires the version, existing viewer/generation and an explicit idempotency key. The server only accepts the transcode mode and preserved original audio selection for this transition. It does not accept caller-supplied validators, URLs, source IDs or authorization context.

`PlaybackPlan.http_file_fallback_version?: 1` appears only when that particular root grant is eligible. Existing `decoder_fallback_modes` remains a route explanation. No version marker is returned for a continuation child. Omitted new fields are omitted by serde so legacy request hashes and replay bytes remain compatible.

## Authority and bounded state

Append migration 0037; never alter published migration checksums. Add an independent UUID membership epoch with a database default. Existing room insertion statements must name their two columns so the default applies. Rejoining after deletion creates a new epoch. Record the existing login token hash, never its raw token or a new credential.

Use the existing request row for immutable opt-in authorization context and, when claimed, one parent ID, frozen single-target representation and claim deadline. A partial unique constraint permits only one successor request key for a parent. The existing three preparation attempts, cancellation tombstone, 48-hour request retention, viewer high-water and session quotas continue to apply. No new root registry, route graph or HLS closure subsystem is introduced. Copy one bounded, validated identity into each new provisional session before its first source I/O; do not share a mutable root identity set. The claim deadline is fixed at the minimum of the parent's expiry and claim time plus 335 seconds; attempts cannot extend it. Completed replay returns the already authorized live child, never creates another grant. Normal child renewal does not create further fallback rights.

Both the initial opt-in grant and child carry server-produced authorization context used by current playback admission: the same still-valid login, same membership epoch, same user/room and current source revision are required. Initial opt-in retries preserve this original context. A new login, removal/rejoin, policy restoration, cancellation or restart cannot regenerate a missing old authority snapshot. Non-opt-in grants keep existing behavior.

## Exact client/server transition

1. The client captures one final observation and freezes/detaches the old media/binders synchronously, preserving the logical metrics intent. It retains the old session and request key for cleanup; it does not send their DELETE/cancel yet.
2. A dedicated method of the existing request manager cleans unrelated uncertain keys, preserves only the known completed parent, and persists the new key before POST. Its POST includes the immutable final observation. Retries use identical bytes and key.
3. Server begin takes current room/snapshot/membership/login/user/request/viewer/source/HTTP/session locks in a consistent order. After waits it rechecks expiry and all scope facts, accepts the final observation while the parent is live, records the claim and retires the parent in the same transaction. No child I/O occurs before commit. The child probe and final publication independently recheck current authority and the frozen identity.
4. After success or failure, the client still sends the parent's final DELETE as idempotent cleanup, then cancels its old request key. Successful claim already persisted the exact sample, so this is duplicate-safe. Failure before claim preserves the existing final-DELETE-before-key-cancel order.
5. User Stop during the request aborts its waiter and cancels the NEW key immediately. Existing cancel-before-begin semantics fence a late POST. The final old DELETE and old-key cleanup remain owned and ordered. After claim, cancellation retires the child; a parent DELETE never grants or revives a child.

An invalid final observation rejects the claim before any new source I/O. Normal explicit old-grant cleanup still occurs; it retains existing behavior where stopping does not depend on accepting invalid telemetry. Final data is never treated as media authorization.

## Required basic evidence

Use owned PostgreSQL/Server/Worker and generated legal media. Capture actual conditional origin requests and actual FFmpeg input. Cover A→A success; changed validator/length/type and ignored conditions; weak/unknown/HLS/multiple-target rejection; known no-audio versus unknown; cross-user/room/viewer/media/source fences; concurrent keys; retry after lost response; timeout before claim and after commit; duplicate final sample; cancel-before/after-claim plus late POST; public logout while probe waits; member removal/rejoin; queued old requests; source revision changes; original request replay and old-client compatibility. Bind binaries and source before runtime tests. No real-device or long-duration acceptance claim.

## Ownership

Integration owner: protocol/generated artifacts, migration 0037, shared exports, existing Server/request/persistence wiring and final integration. Frontend wake/UI owner retains its current files until that chain is delivered. A new native test worker is read-only until this contract and schema compile. Consumer implementation begins only after those frontend files are handed back or explicitly reassigned by the parent.
