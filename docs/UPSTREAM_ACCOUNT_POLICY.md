# Bounded upstream account observation

RainSync observes the existing upstream account configured on each Jellyfin or
Emby source. This does not map RainSync logins to upstream logins, create an
upstream account, or request broader account permissions.

The authenticated, read-only `GET /Users/{Id}` must return the exact configured
account ID and explicit boolean `Policy.IsDisabled` and
`Policy.EnableMediaPlayback` fields. Missing, ambiguous, inaccessible, malformed,
oversized or unauthorized responses are inconclusive and fail closed. The
configured source credential must already be able to read that account. A source
which cannot do so needs its administrator to correct the existing configuration;
RainSync does not fall back to an administrator or another account. `/sources`
exposes only normalized policy state and reason to RainSync administrators.

The shared source transport enforces the current origin/CIDR policy, validates
all DNS answers in strict mode, pins the checked destination, refuses redirects
and proxies, and scopes credentials to the configured origin. Legacy-origin mode
retains its previously documented DNS limitation. The policy body is limited to
256 KiB and the entire lookup, including DNS and body consumption, to two seconds.

Positive evidence lasts at most five seconds, counted from the start of the
lookup. Demanded or active sources are refreshed about every two seconds. Eight
poll owners can run concurrently, with at most 1,024 active or retained source
identities in memory; excess load may make a source temporarily
unavailable and never extends old evidence. Concurrent requests for one source
share observation work. An unknown or expired source waits at most three seconds for fresh evidence;
an observed denial or unavailable result returns a normalized error immediately.

Migration 0033 stores source ID, configuration revision, observer epoch,
observation sequence, authorization generation and the bounded deadline. It
creates no historical positive evidence. Denial, expiry, source replacement and
Server restart invalidate the old authorization generation. An old playback
plan cannot revive after an allow response; the viewer must prepare a new plan.
Server startup invalidates persisted positives before opening HTTP admission.
An old source configuration or delayed prior claim cannot overwrite a newer
observation. Earlier migrations remain unchanged.

Preparation, final publication, idempotent replay, readiness, renewal, new
delivery and retained delivery all require current evidence. Final transaction
admission serializes source then policy locks; observation I/O holds no database
lock. Observation commits release their authority locks before retiring sessions
and reserving cleanup. Jellyfin/Emby transcoding remains owned by the upstream
product; the local encoding queue is not used for these sources.

Worker checks remain independent of HTTP progress or backpressure. The remaining
policy lifetime is converted to a monotonic deadline at the beginning of each
database check and carried through preparation, final response headers and the
stream. Repeated reads of the same observation cannot move that deadline later.
A hung query cannot outlive the shorter policy deadline or the existing
five-second generic authorization age. Cancelled database checks close their
owned connection instead of stranding a shared pool slot.

The normal detection window includes the remaining five-second observation
lifetime, polling and Worker checks. An observed denial is a different timestamp
from the actual upstream policy edit. Runtime evidence must report both and
actual upstream socket closure. PostgreSQL is the existing durable time
authority: arbitrary cross-host wall-clock rollback is not a strict five-second
guarantee for a newly admitted connection. Per-process monotonic deadlines bound
already observed evidence even if the same database row stops advancing.
Already delivered browser/kernel buffers and a final buffered chunk after source
EOF cannot be recalled.

Stop and durable cleanup remain available after account revocation. They retain
the original SID, device identity, attempt budgets and positive disposal
receipts, and still obey the latest origin/CIDR destination restrictions. Policy
revocation is never reported as proof that a remote process physically drained.

The raw fixed-product behavior remains a separate compatibility result:
Jellyfin 10.11.0 and Emby 4.10.0.40 returned media after their policy flag became
false. Automatic RainSync enforcement tests must prove the compensating boundary
without changing those raw assertions or reporting the upstream behavior fixed.

Local validation passed 205 Rust tests (five explicitly ignored), strict Clippy,
protocol export checks, 125 frontend tests/build, and 13 actual isolated upgrade
checks. Thirty controlled Server/Worker/PostgreSQL cases passed for both provider
namespaces: actual policy edit to source closure was 1.979/3.981 seconds, versus
0.062/1.901 seconds after the observed denial. Pausing the Server observer closed
sources in 4.730/4.740 seconds; twelve deliveries blocked on a shared database
lock all closed within 4.253 seconds. Eight concurrent prepares shared one policy
GET. Late allocated SIDs retained Stop obligations; a policy denial during audio
metadata lookup prevented the resource-allocating POST. Recovery, account/config
replacement, monotonic expiration and restart fencing were exercised.

These are controlled upstream contracts, not actual Jellyfin/Emby execution.
The last retirement-reason-only refinement has separate focused regression.
Complete CI and the separate immutable real-product enforcement job remain
pending for the final published candidate. The prior raw 8/10 product result
continues to describe the upstream servers themselves.
