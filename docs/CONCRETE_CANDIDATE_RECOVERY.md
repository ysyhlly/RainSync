# Concrete candidate identity during recovery

This bounded NEXT_PLAN §8.3 follow-up is implemented locally. Publication and
exact-head CI remain pending. It changes the Web runtime only; existing server
authorization, source-version contracts, protocol and database remain unchanged.

## Same intent, original evidence

A schema-1 response with a nonempty binding and a nonempty finite candidate set
now retains an immutable copy of the original configurations, device report,
capabilities and cumulative failed-route IDs. This applies to verified local and
Agent candidates as well as negotiated reliable HTTP files. The existing report
validator bounds the candidate count; the runtime does not manufacture routes.

Automatic decoder recovery reuses that snapshot and the existing three-route
budget. It does not call discovery again to accept a changed file, refreshed
binding, different device result or rollback server. A concrete report failure
remains terminal for that intent. Missing/empty legacy candidates and an old
server's 404 still permit initial legacy negotiation.

The local five-minute bound starts before the original discovery request.
Elapsed time must be finite, nonnegative and below the bound before a new
prepare. This is a conservative client limit, never authorization: the server
still checks its original expiry, source version, identity, room and lifecycle.
It does not expire an already published plan. Explicit reload, mode/audio/media
changes, Stop, identity/lifecycle changes and disposal retain their existing
new-intent or cancellation behavior.

Local/Agent stat-v1 remains its existing change-detection contract. Retaining it
is not a cryptographic guarantee that every byte is immutable. HTTP relies on
its separately documented reliable representation contract. Jellyfin/Emby
concrete output negotiation remains separate unfinished work.

## Error classification and lifecycle

HTML MediaError code 3 can request a different authorized decoder route. Code 4
is ambiguous and now shows the neutral load/support message without creating a
new grant, including the older one-hop HTTP continuation path. The existing
same-grant native-HLS to MSE switch still accepts code 3 or 4. hls.js fatal
mediaError remains a distinct supported decoder signal with the same finite
route budget. Network/authentication errors and load deadlines do not add routes.

Recovery preserves final observation → Stop → old-key cancellation before a new
grant, original metric intent/t0, stale-callback fences and current room time.
A clock recalibration cannot allocate a different request key at an already
claimed generation. Same-grant reattachment keeps the remaining 20-second data
budget; a newly authorized plan gets its own 20 seconds.

## Evidence and limits

The final production change is a0805dd9b45abcbc06b016510a799975836102be on the
0184fb7 backend/timing candidate. The full frontend suite passed 517 tests in
33 files; Vue type checking and Vite production build passed. The existing
large-chunk build advisory remains. Formatting and diff checks passed.

The 170 focused executions include the original marked-HTTP cases and new
local/Agent binding mutation, finite exclusions, stale/expired/report failures,
five-minute and invalid-clock boundaries, clock reply ordering through the real
request manager, resets/late callbacks, final Stop sample ordering, original
metric t0, per-plan/same-grant budgets, HTML-code-4 neutrality, Hls.js recovery and
legacy empty/404 compatibility. The fixture controls browser/media and API
responses; it is not new physical-browser playback evidence or a fresh server
authorization matrix. Backend source and executables are unchanged from their
separately bound timing verification. Device, weak-network and long acceptance
remain deferred and are not reported as passed.
