# Explicit upstream transcode profile envelope

Published on `integration/v0.1-next`; the fixed-product run at
`464dc39fba02431807aef0bb924fd0b0e46ba11a` failed. The controlled checks below
remain separate from real-product compatibility.
This is the smaller profile-envelope option chosen on 2026-10-01. It does not
introduce a prepared/consumed upstream SID lifecycle or measured-output claim.

The new dedicated candidates endpoint describes one server-owned explicit
transcode recipe. Its versioned DTO is separate from exact PlaybackCandidate
schema 1. Requested output bounds and an advisory MSE sample are separate
fields. AAC is requested; AAC-LC in the sample is an estimate, not a promise
that the provider enforces a particular AAC profile. Source metadata is not
encoded output or proof that whole-title bytes remain identical.

POST `/api/v1/upstream-profile-candidates` accepts version, room/media generation,
audio intent and position. It performs bounded metadata GET only, under an owned
preparation that is retired on completion. It allocates no upstream SID.

Only POST `/api/v1/playback-sessions/upstream-profile` accepts a nonempty
`upstream_profile_report`; the ordinary prepare endpoint rejects that report.
The final request must explicitly select transcode. Missing, malformed or
negative negotiated evidence and an old server's missing preparation route fail
closed. The client must not retry the request on ordinary prepare.

The client opts in only when the MSE and decodingInfo APIs are readable;
missing or throwing availability access preserves legacy explicit-transcode
native HLS without requesting a profile. No sample is probed before discovery.
After negotiation, the report requires positive path-specific MSE and decoding
support. Native-HLS file samples are not substituted for that evidence. A marked plan uses MSE and
does not enable generic decoder candidate retries or HTTP continuation. A fresh
authoritative target before the current timeline origin is a distinct seek
intent: it retires the old grant and performs fresh authorization/profile
discovery as automatic_load, with a new metric intent. Decoder/network failure
alone cannot enter that path or mint another SID. Auto, direct
and remux retain their current paths; an unmarked legacy candidate response
does not claim this capability.

The purpose-separated encrypted binding expires within five minutes according
to the database clock and captures current caller/member, room/media/lifecycle,
source/config-policy/account generations and normalized selected source/audio
metadata. Final preparation rechecks metadata while its existing ledger is
reserved, then uses the existing admission gate and exactly one PlaybackInfo.
Every SID is checkpointed before route/profile rejection. Final authority and
expiry are checked after contended locks; cleanup obligations remain intact.

The five-minute deadline applies to new preparation. A completed same-key reply
may reuse its still-live published session only after checking the original
login, membership epoch, current source/account, actual plan/session association
and the server-written binding hash. It neither fetches new metadata nor creates
another upstream SID. Re-authenticating as the same user does not make an old
login-bound report valid. Already-issued media URLs retain the existing upstream
bearer-grant lifetime, source/account policy, membership and lifecycle checks.
This report binding does not add a Worker login-context gate: logout alone is
not claimed to revoke an already-issued media URL. No HTTP-specific authority
field is repurposed for this feature. Timed preflight database work uses owned connections
that close on cancellation, with local statement/lock limits; durable request
begin/failure/cleanup commits stay outside that cancellation scope. The network
metadata operation is separately bounded. This is not a claim that every
database outage can return an HTTP response within the preflight deadline.

No new credentials, account mapping, source access, revoked-device authority or
automatic new-SID fallback is introduced. Product-specific recipe propagation
and actual generated output must be verified against the fixed Jellyfin and
Emby images before their profile support is declared implemented.

## Controlled evidence and failed product check

Protocol tests and generated exports passed. Provider and Server tests and strict
Clippy passed; the Server run included 81 unit tests and 17 presence tests, with
two pre-existing isolated-database entries left explicitly ignored. All 576
frontend tests in 34 files passed, including 59 controlled profile cases, and
Vue type checking/Vite build passed. These browser API fixtures are estimates,
not physical-browser decoding evidence.

A frozen combined backend passed 41 actual Server/PostgreSQL cases against
controlled Jellyfin/Emby HTTP contracts: metadata-only preparation, positive and
negative reports, audio-zero/no-audio distinctions, one owned negotiation,
SID checkpoint before rejected output, cancellation/logout, lost responses,
same-key replay, membership/source/account fences and final lock-wait expiry.
The expiry fixture reseals generated test bindings with synthetic clock fields;
it does not claim a real five-minute elapsed acceptance test. Repeated database
lock failures left unrelated authenticated requests usable, and the fixture
verified no stranded read queries while the lock remained held.

Review then reproduced a valid source-base compatibility error: a reverse-proxy
base without a trailing slash was resolved as a file. Normalizing the base to
the same directory semantics as existing media delivery fixed it. The final
frozen backend passed four actual Jellyfin/Emby base-spelling cases plus cleanup.
A further review made known-no-audio metadata and responses reject explicit
contradictory audio evidence, while retaining valid audio index zero. The final
backend then passed the complete 49-case controlled API matrix, including both
base spellings, both silent-response contradictions per provider and cleanup.
All runs verified unchanged source/binary binding, owner receipts, process exit
and closed ports. The original generated fixture's malformed relative URL
failure remains recorded separately. The final frontend suite also covers
incomplete MSE buffer APIs and a fresh-clock seek before the current origin,
with decoder failure still unable to create a replacement grant.

The [fixed-product profile job](https://github.com/ysyhlly/RainSync/actions/runs/36949379906/job/110658667275)
ran against the published `464dc39` candidate. All three cases for each product
(H.264 at zero, HEVC seek with default audio, HEVC seek with alternate audio)
failed final preparation with HTTP 502 rather than 200. No case reached finite
output decoding, so product recipe propagation and actual output remain unverified.
The [sanitized report](https://github.com/ysyhlly/RainSync/actions/runs/36949379906/artifacts/11203432113)
records all six case cleanup checks as verified and the owned reservations as
closed. Jellyfin's `encoding_stop_confirmed` remains false; these receipts do
not prove that an actual Jellyfin encoder was stopped. Both product containers
and networks were confirmed removed, but final host fixture-data removal failed
with EACCES on Emby's bind-mounted configuration directory.

The fixture now uses per-run owner-labeled Docker volumes for disposable config
and cache, retaining credentials outside the host evidence tree. Existing volumes
are not adopted, and named-volume deletion requires the exact run owner label.
Seven dependency-free ownership/refusal tests and syntax checks passed locally;
Docker was unavailable, so the new real-product cleanup path still needs CI.
No permission widening or privileged host cleanup is used.

The next implementation work is the concrete compatibility failure, not broader
exact-output negotiation. Existing raw upstream policy failures remain separate
from RainSync enforcement and this profile feature. No new device, sustained-load
or production acceptance is claimed.
