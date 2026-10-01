# Reliable HTTP file capability candidates

Status: the backend and Web consumer are integrated and have passed the bounded
checks below. This batch is not yet published; exact-head remote CI is pending.
No new migration or endpoint is required.

## Negotiation and compatibility

`PlaybackCandidateRequest.http_file_capabilities_version: 1` explicitly opts in
to concrete generic-HTTP file candidates. Omission retains the old provider
path; an unsupported value is rejected. Explicit `direct` requests omit the
field, preserving direct playback without forced HTTP preflight. The Web still
calls the generic candidates endpoint for existing local/Agent compatibility. A direct-mode
prepare carrying an HTTP candidate report is rejected; an auto request may
still select direct after its restricted, pinned probe. Local/Agent
candidates and upstream-product negotiation keep their existing contracts.

A successful, verified single-Binary HTTP response includes the same optional
version marker. Legacy responses and unproven HTTP inputs omit it. The marker
is not authorization. Callers never supply a URL, validator or credential in
these new fields; the existing opaque encrypted binding carries those facts.
HLS, multiple resources and weak or absent reliable validators are excluded
from this concrete-candidate slice and retain existing conservative behavior.

The identity guarantee uses the origin's reliable HTTP validator and total
length contract, as in existing 0034 delivery. It is not a full-content hash
and cannot detect an origin silently replacing arbitrary binary bytes while
reusing the same supposedly reliable validator, length and resource class.

## Frozen input and current authority

HTTP preflight uses a normal owned preparation and a short restricted Worker
probe grant. It captures the current login hash/member epoch, room/lifecycle,
media/generation, source ID/config-policy revision, canonical target digest and
one eligible 0034 Binary representation identity. The returned binding includes
that expectation, audio intent, exact server-issued candidates and a fixed
five-minute expiry minted from the PostgreSQL authority clock. HTTP-specific encrypted bindings are capped at 8 KiB,
within the older general report limit of 32 KiB. It is purpose-separated from local stat-v1 bindings and
from HTTP continuation claims. Probe resources are retired even on failure or
client disconnect; issuing a binding does not preserve the probe grant.

Ordinary prepare rechecks current authorization before trusting the encrypted
expectation. It persists that immutable expectation with the request's existing
encrypted context; `http_file_parent` remains null. Every new attempt commits
its own independent representation pin with the restricted provisional grant,
before Worker probe, direct source reading or FFmpeg input. Pending request and
provisional probe leases are clipped to the same immutable preparation deadline,
including incomplete retries; published session lifetime remains unchanged. Source/policy/login,
membership, media and lifecycle gates remain active through publication and
delivery. Retry restores the original expectation and cannot observe a newer
source as though it were the original. Completed replay uses existing active
session checks; the candidate expiry bounds new preparation rather than
retroactively shortening an already published session's lifetime.

Confirmed upstream input denial remains `MEDIA_INPUT_DENIED` / 502 in this
preflight path; origin 401/403 does not invalidate the RainSync login. Other
unknown errors retain the sanitized probe-failure fallback.

No candidate binding grants parent-stop authority, changes quota/high-water
rules, resurrects cancelled keys or allows cleanup with revoked identities.
The separate one-hop continuation endpoint retains its current scope.

## Bounded automatic recovery

For a negotiated HTTP candidate set, retain its original immutable binding and
device report throughout the same logical playback intent. Decoder fallback
excludes each failed route within the existing finite budget, retires the old
grant through the existing final-observation/Stop ordering, then prepares a new
independent grant against that same frozen input. It never calls preflight
again to silently rebind after source change, binding expiry or a failed route.
Transport/auth/loading-timeout failures do not create decoder fallback. Marked
HTTP candidates require a decode error (MediaError code 3) for a new-plan
fallback. Code 4 alone is insufficient: the [HTML media loading rules](https://html.spec.whatwg.org/multipage/media.html)
also allow early DNS/HTTP failures to produce that value. This is a conservative
classification rule, not a claimed physical-browser reproduction. The existing
one-time native-to-MSE recovery can retain the same authorized plan.

Native-to-MSE, same-plan range recovery and clock deferral retain the candidate
snapshot. Explicit reload, mode/audio change, media or room/lifecycle change,
login identity change, Stop and disposal invalidate it. A genuinely new plan
intent may perform fresh preflight. Source mismatch or stale binding requires
an explicit reload; it does not automatically select changed content. The
20-second usable-data budget remains per authorized plan: native-to-MSE and
same-plan reattachment preserve the remainder, while a new plan gets its own
budget. Clock recalibration preserves an already preparing request key, plan
generation and requested position; it cannot supersede its own pending attempt.

A marker with an unsupported schema, empty binding or failed device report is
terminal for that intent. It cannot downgrade to legacy probing or unbound
prepare. A retained marked snapshot also stays bound if a later server response
rolls back; only an explicit new intent may rediscover capabilities.

## Essential evidence and limits

Use finite real HTTP/Worker/PostgreSQL fixtures for unchanged and changed ETag,
length/target/source-revision fences, login expiry/logout, member remove/rejoin,
late probe completion, cancelled and retried requests, pinned direct/transcode
input and retained original representations. Cover malformed/weak/HLS inputs,
old clients and explicit-direct no-probe behavior. Frontend controlled tests
must prove one preflight per HTTP logical intent, finite routes, stale callbacks,
clock deferral, final Stop ordering and source-change refusal. These checks are
not physical-device or long-running playback acceptance.


## Integrated checkpoint evidence (2026-10-01 UTC)

The current backend has passed 28 real Server/Worker/PostgreSQL API groups and
32 existing one-hop continuation groups against the same final frozen build.
The build covers 192 backend inputs, source digest
`100afa8420bd1581f096e1d1320fd97abdc80d7746f8135e1b0e3da62830be56`,
binding SHA256 `0599a4bc8f0ca985697569eb5355bcebf9355175f4ba630061243ed95e642619`.

The new report `269aaf7f-528c-44d5-a720-40138b1980c8` has SHA256
`00f7b70b92ce7c2a22e49018b2bdc8e7639e13e03882f0aeefc2484c8e53341c`.
It observes real source bytes and decoded transcode output, ETag/date identity,
independent pins before origin I/O, original conditionals, changed source
refusal, retry/replay/cancel, and both preflight and prepare authority races.
Known and extensionless playlists generated zero child origin requests. Input
401/403 remains a classified 502 while RainSync login stays valid. The silent
fixture proves absent audio rather than inventing track zero; existing
local/Agent candidate tests separately exercise real audio configurations.

The near-expiry case is explicitly synthetic fault injection: using only the
isolated fixture's generated key, it shortens an otherwise genuine binding to
three DB-clock seconds. Actual pending/provisional leases are no later than
that deadline. Worker closes the held origin and records drainage before the
fixture releases the response; the incomplete same-key retry is rejected.
This is a finite expiry check, not a physical-network or long-duration SLO.
The full new suite confirms 42 preparation and 85 Worker execution receipts.

The existing continuation report `db01c43b-3410-4402-8d7d-15808b75d812` has
SHA256 `499988bd1d37890ef710703576f75eaff87de630ce9cfe5a019e2909469d5a11`.
Both reports verify unchanged source/executables before and after, and positive
owned process, port and PostgreSQL cleanup. Original reports live on the
isolated temporary test volume; identical persistent copies are retained.

Affected Rust packages passed 280 tests with 12 explicit database/child-fixture
ignores. Four owned PostgreSQL component contracts were run separately, with
an additional DB-clock/fence run after the clock correction. Strict workspace
Clippy, formatting and generated protocol consistency passed. None of these
results substitutes for this batch's remote CI, mobile devices or long playback
acceptance.

The integrated frontend passed all 457 tests in 33 files, including 50 new
controlled HTTP-runtime cases, plus Vue type checking and the Vite production
build. The focused cases cover immutable reports, bounded route exclusions,
marked response/report failures, explicit mode/audio/reload changes, expired
bindings, Stop ordering, stale callbacks, and both clock-reply orderings against
the real request manager high-water behavior. These are controlled runtime
checks, not new browser/device acceptance. The consumer was implemented and
verified afresh in the working cloud checkout; inaccessible earlier cloud-task
commits and their reported checks are not counted as delivered evidence.
