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
retaining HTTP Host/TLS SNI/certificate verification. Redirects remain rejected
unless the administrator enables the bounded media policy below.
Environment proxies are not used for source traffic. Proxy-dependent deployments
need a separately verified transport contract before using this path.

Only the configured source origin receives configured credentials. Additional
explicit strict origins receive no configured credential headers. Authority,
proxy and hop-by-hop headers cannot be supplied through source configuration.

## Controlled media redirects (opt-in)

An administrator may add `"redirects":{"max_hops":5}` to a strict version-one
access policy. `max_hops` must be 1–5; omission preserves no-follow behavior.
Legacy origin-only sources cannot enable redirect following. Each origin includes
its exact protocol and effective port, and needs explicit CIDRs. Adding the
redirect option uses the existing access-policy update endpoint and revision
invalidation described below; it is not a client playback parameter.

Only registered media **GET and HEAD** requests follow 301, 302, 303, 307 and 308.
HEAD stays HEAD, including on 303; no request body is replayed. Each hop, including
a same-origin hop, gets a new validated DNS answer and pinned client. Loops,
ambiguous/missing Location headers, invalid URLs and HTTPS-to-HTTP downgrades fail
closed. At most the initial request plus five redirect requests are sent. Header
preparation has a 30-second chain deadline; streaming retains existing ownership,
cancellation and read-timeout checks.

All configured source headers, including Authorization, Cookie, custom secrets
and Referer, are sent only to the exact configured primary origin. Additional
allowed origins receive none of them. Only application-owned Range, If-Range,
If-Match, If-Unmodified-Since and identity Accept-Encoding controls survive a
cross-origin hop. No response cookie store, Referer generation, original-query
inheritance or guessed token names are used. Independently configured CDN
credentials are not supported in this version.

Primary media delivery, guarded media probes, decoder preview inputs, child HLS
resources and upstream subtitle media reads share the bounded request path. HLS
relative references are resolved against the **final manifest URL**, and each
child read is independently authorized and address-pinned. Encrypted tickets
continue to name registered resources and captured source-policy revisions; no
arbitrary URL/header endpoint is added.

Generic HTTP representation evidence remains keyed by the original registered
URL. Redirected responses additionally capture `final_target_sha256` in their
internal identity metadata. It covers the complete canonical final URL including
its query. Missing legacy evidence permits only original-equals-final reads.
Changing CDN, path or query, or changing between redirected and direct delivery,
invalidates the existing grant even when ETag and size match. HEAD and partial
responses obey the same destination comparison. Preview registrations similarly
pin their final destination. Rotating signed redirect URLs therefore require a
new grant/attempt: there is no claim that arbitrary auth-query rotation preserves
resource identity.

Provider metadata/listing/account APIs, PlaybackInfo POST and session/lifecycle
POST/DELETE calls deliberately retain their no-follow contract. Absolute
cross-origin PlaybackInfo routes still do not satisfy the existing negotiated
route/provenance checks; an allowed media redirect from the validated origin does
not relax those checks. General HTTP redirect semantics, authenticated CDN
configuration and real HTTPS/CDN deployment acceptance remain unsupported or
unverified boundaries, not completed integration claims.

## Paired binary identity declaration

Server and Worker expose an offline `--source-access-contract` probe before
runtime construction, configuration, key, database or listener access. Each emits
one exact single-line declaration with ordered fields `schema_version`,
`contract`, `identity`, `credential_origin`, `methods`, `default`, `role`. Version
one names `controlled-media-redirects-v1`, `final-target-sha256-v1`,
`configured-origin`, GET/HEAD and `no-follow`, plus its server/worker role.
This is an exact supported contract, not a health/readiness result or permission
to treat arbitrary newer versions as compatible.

Both strict readers must understand the optional internal final-destination digest.
The Server's private HTTP metadata preserves and validates the same lowercase
64-hex field through candidate bindings, independent grant seeds, continuation
claims and replay. Legacy omission remains unchanged in serialized JSON. An old
Server that rejects unknown metadata fields cannot consume a new redirected
Worker identity, so paired deployment needs a matching declaration.

Durable representation evidence applies specifically to generic `kind=http`
grants. Preview targets have per-attempt in-memory destination pins. Raw
Jellyfin/Emby media retain their existing provider/SID contract, with policy checks
and final-manifest rewriting; these flows do not gain a universal immutable
cross-request byte-identity claim from this feature.

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

## Controlled-redirect verification (2026-10-02 UTC)

Scoped local checks for the additive media redirect contract passed:

- Provider package: 38 unit tests, 11 dedicated redirect fixtures, 12 access-policy
  tests and 13 adapter tests; the isolated proxy-environment helper also passed
  through its owning subprocess test (its standalone entry remains ignored).
- Worker preview gateway: 32 unit fixtures, including nested final-base HLS,
  per-child media checks and changed-destination revocation.
- Durable HTTP identity: 6 units plus the fresh PostgreSQL/owned HTTP fixture
  coordinator, extended with redirected GET/HEAD/ranges, old evidence rejection,
  signed-query change detection and encrypted final-base child tickets.
- Strict Clippy for providers and media-worker all-targets, formatting and diff
  whitespace checks passed. The known ts-rs serde-attribute notice remains.

A follow-up source-bound public-API runner, `tests/http-controlled-redirects.mjs`,
passed four additional groups: redirected candidate/grant/replay; unchanged-ETag
candidate rejection after signed-destination change; ordinary root/continuation
with actual transcoded HLS and segment read plus replay; and continuation rejection
after destination change. All state-changing actions used public APIs, including
ordinary room control; SQL was read-only evidence. The same run verified exact
Server/Worker declarations with an empty environment and no source secrets or
signed queries in process logs. Six focused Server identity units and the shared
contract unit passed, alongside strict Server/Worker/provider Clippy. The public
runner verified Server, Worker, database, source/CDN listeners and room sockets
were closed; its report and frozen source/binary binding live under the configured
artifact/runtime roots.

The database coordinator confirmed its owned PostgreSQL process exited and its
listener closed. These are scoped media/provider checks, not full combined
backend, Agent/NAS, real-CDN/TLS, browser/device or release acceptance.

## Validation checkpoint (2026-09-30 UTC)

The source-policy backend inputs (148 files) and three actual executable hashes are
recorded by `scripts/bind-native-backend.mjs`. On that checkpoint binding, fmt, strict
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

The subsequent explicit-audio discovery checkpoint passes 181 Rust tests with a
fresh backend/binary binding. On that binding, all 35 reservation cases,
including graceful shutdown during metadata discovery, 24 observation cases,
ten gateway groups and four policy admission groups pass. The shutdown checks
observe the real metadata connection close, persisted preparation drain before
restart, and no PlaybackInfo POST or fabricated Stop. See
[fixed-product validation](UPSTREAM_PRODUCT_VALIDATION.md) for the separate real
product failures and source-identity limitation; local controlled tests cannot
replace actual upstream decode acceptance.
