# Source access policy and primary decoder gateway

This additive implementation is a development checkpoint. Real product,
production network, device and sustained-resource acceptance are separate gates.

## Two explicit modes

Missing `SourceConfig.access_policy` means **legacy single-origin access**. It
preserves administrator-configured LAN and loopback sources. Its checked DNS
answer is pinned to the connection, but there is no CIDR boundary, so this mode
must not be described as strict DNS-rebinding protection.

Strict policy is opt-in:

```json
{"schema_version":1,"origins":[{"origin":"https://media.example.test","cidrs":["192.0.2.0/24"]}]}
```

Origins are exact scheme/host/effective-port identities. Every selected DNS
address must be inside that origin's explicit CIDRs; one forbidden answer rejects
the entire response. IPv4-mapped IPv6 is normalized. Unknown fields, malformed or
noncanonical CIDRs, duplicates and unsupported versions fail closed. There is no
inferred public/private network allowlist. Administrators must supply actual
permitted addresses; the documentation example is not a deployment policy.

The DNS wait is bounded to three seconds, 64 returned addresses and eight owned
OS resolver jobs. Cancellation does not release a resolver slot before its
blocking lookup finishes. Each scoped client pins the checked addresses while
retaining HTTP Host/TLS SNI/certificate verification. Redirects are rejected.
Environment proxies are not used for source traffic. Proxy-dependent deployments
need a separately verified transport contract before using this path.

Only the configured source origin receives configured credentials. Additional
explicit strict origins receive no configured credential headers. Authority,
proxy and hop-by-hop headers cannot be supplied through source configuration.

## Policy revision and revocation

Migration 0032 appends `sources.access_policy_revision` and the upstream ledger's
captured revision, plus a durable current destination-policy snapshot. Existing rows retain epoch zero; it invents no historical
policy identity, resource release or cleanup receipt. Strict newly created
sources start at revision one. Schema version one is not this mutable revision.

An authenticated administrator can use
`POST /api/v1/sources/{id}/access-policy` with `expected_revision` and `policy`
(null explicitly returns the source to legacy mode). It increments the revision;
a stale expected revision is rejected without changes. Existing source listing
returns the current revision. This does not introduce a new frontend editor.

A deleted source keeps its last encrypted policy snapshot for cleanup. Tighten→delete
cannot restore the original broader policy. Configuration changes advance their
revision in the database even when a caller omits the increment. A normal grant
with no current media/source association fails closed; no legacy association is
invented. Historical cleanup obligations remain retained.

Internal playback envelopes, primary child tickets and upstream reservations
capture the revision. Admission/publication, cached replay/readiness/renewal and
continuous Worker authorization reject stale revisions. Preview invalidation
uses the existing source-config trigger and attempt generation fences. A bounded
retirement pass stops stale sessions/jobs and closes stale upstream reservations;
maintenance repeats it if the request disappears after the policy commit.

Source locks are released before cleanup/session retirement. Physical resource
owners still perform their existing drain and durable acknowledgement. Cleanup
cannot use a policy denial as a positive Stop receipt. The durable upstream
ledger retains captured identity/scope when mutable source configuration is
removed; this is bounded cleanup ownership, never new playback authorization.
No production source or old row is changed by the test fixtures.

## Primary HLS and decoder inputs

Primary HTTP delivery uses the structured parser, content-prefix recognition,
2 MiB manifests, 20,000 references, 128 attributes and maximum depth four.
Header/prefix/manifest/key preparation has a 30-second total deadline; produced
media streams retain their separate continuous authorization owner. Provider
JSON requests also retain their per-request deadline.

Encrypted tickets bind schema, session, optional legacy-compatible source UUID,
policy revision, reference kind and depth. Legacy untyped child tickets must
reload their root. Repeated references retain stable URLs for BYTERANGE semantics.
Mixed key/media aliases fail, AES-128 keys are exactly 16 bytes before delivery,
and unknown Data references are rejected. Known playlists use complete fetches;
HEAD is bodyless and does not advertise unmodified upstream manifest lengths.

Decoder inputs use a finite format/protocol allowlist. HLS is enabled only for
rewritten remote gateways; local and NAS files cannot enable reference-bearing
HLS/DASH/concat/SDP inputs. Decoder subprocesses do not inherit proxy variables or
FFREPORT. These are supported-input constraints, not an OS network sandbox or a
claim that arbitrary demuxer formats are supported.

Actual HTTPS/CDN deployments, reliable remote representation identity when an
upstream provides no honest validator, additional product versions, real devices,
network filesystems and long-running acceptance remain separately unverified.

## Validation checkpoint (2026-09-30 UTC)

The final backend inputs (148 files) and three actual executable hashes are
recorded by `scripts/bind-native-backend.mjs`. On that binding, fmt, strict
Clippy, protocol export, and the Rust workspace pass (175 passed, 5 explicitly
ignored fixture/helper entries). No ignored test counts as a passed scenario.

`tests/source-access-gateway.mjs` passes ten actual Server/Worker/Agent/HTTP groups:
hidden HLS/fMP4 decode, Range/HEAD/If-Range, foreign reference/redirect rejection,
key typing and exact size, encrypted ticket binding, live revision cancellation,
missing source associations, tighten→delete cleanup denial, local/NAS disguised
playlist rejection, and continuously emitting unfinished manifests. The last
case returns an error after the total 30-second deadline, closes the actual
upstream socket, and verifies one persisted disposal receipt with zero unreaped
delivery owners. Its report also checks stopped processes and closed ports.

`tests/source-policy-admission.mjs` passes four actual API/SQL-race groups:
allowed policy changes fence a late plan and retain its exact SID cleanup;
strict denial cannot manufacture a positive Stop; completed replay expires and a
higher viewer generation recovers; remaining fixture grants close through the
authenticated API. Unrelated grants and prior receipts are checked unchanged.

Nine isolated 1–31→32 migration checks preserve old encrypted source values,
unknown cleanup state and budgets, then verify automatic revision/snapshot
updates and durable restrictions after deletion. F's 19 measurement/evidence/
recovery tests include a generated empty-schema 1–32 encrypted backup/restore;
this does not stand in for a user's old production database.

Complete local integration, priority (17 stream/pool cases), lifecycle,
generation, account, chat and playlist suites passed on the source-policy
backend before the final total-preparation deadline was added. The final bound
backend reruns the affected gateway and admission suites. Frontend application
code is unchanged from the B–F checkpoint (125 tests/build passed there).
Full remote CI must still validate each published final tree independently.

The first fixed-product Actions attempts failed before compatibility tests:
pinned product images were not preloaded. A separate check job hit a bounded
Ubuntu package-download deadline. Their failed logs remain evidence; neither
failure is relabeled as a product or application pass. The workflow now pulls
only the two exact fixture digests and bounds lean official dependency installs.
Product behavior, single-login revocation, real DNS/CDN deployments, devices and
long-duration acceptance remain open until their respective evidence exists.
