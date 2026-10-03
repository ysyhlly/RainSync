# Static HLS Stage B integration proposal

Status: design only. Stage A and public fallback remain disabled. No migration,
protocol marker, parent/child endpoint, queue dispatcher or activation is enabled
by this document. The final-candidate PostgreSQL checks remain paused.

## Smallest storage change under consideration

Stage A custody currently references `playback_sessions`, requires a completed
request, and forbids changing that request's status/response while custody is
retained. The ordinary Server publishes the session and completed response in one
final transaction. A public fallback marker therefore cannot simply be appended
after Stage A capture: that would mutate an already acknowledged immutable result.

The proposed next migration reuses the existing custody and request tables:

- Retarget `static_hls_captures.session_id` to the already unique
  `playback_requests.session_id`. A pending request can own capture without
  creating a provisional media grant or exposing a delivery token
- Add an explicit publication phase to custody, separate from capture/disposal
  state. Pending-parent qualification, published-parent custody and child capture
  have different authority predicates
- Add one bounded encrypted typed input snapshot on `playback_requests`. This
  freezes trusted source/configuration, selected target/audio and request authority
  before any I/O. The child must freeze this input before parent retirement,
  before its capture/reservation can exist. Completed graph inventory keeps its
  existing distinct immutable custody storage
- Add a purpose-specific parent-capture reference on child requests and a unique
  non-null claim constraint. Reuse request hash, owner epoch, attempts, encrypted
  response and 48-hour retention; do not overload Binary fallback fields or create
  another request ledger

A phase field alone is insufficient because of the existing foreign key and
request-status guard. A separate provisional `playback_sessions` row is not the
preferred approach: it adds a temporarily readable-grant boundary and makes
returning a valid unmarked native route after refused qualification harder.
The candidate field names and ordered transactions below make this proposal
reviewable before implementation. They are not an implemented migration. Existing
Stage A rows require an explicit compatible interpretation, with no adoption of
unresolved ownership.

## Admission and atomic parent publication

A mint-only pending-capture admission is created under the same room, snapshot,
exact login/member and request/source lock order as normal preparation. It binds
the request's actual owner epoch, user, exact login, membership epoch, room and
lifecycle epoch, viewer and plan generation, media generation, source/configuration
revision, selected audio, immutable input and hard expiry. A request ID or stored
UUID cannot reconstruct the process owner. Metadata and track facts used later
must come from this capture's complete scan. A configured source revision is not
a claim of byte identity; the verified graph supplies byte identity separately.

The current45-second preparation budget is not restarted by qualification.
Capture uses the lesser of its35-second work budget, remaining preparation budget
and the conservative authority deadline. The public40-second capture waiter and
background cleanup ownership remain separate. The20-second presentation budget
starts at attachment under its existing visibility/pause/autoplay rules; it is not
an allowance to turn a slow prepare or capture into a decoder-failure grant.

After verification, one short publication transaction repeats every live
authority check and proves the exact frozen input and immutable inventory. It
inserts the parent session, marks custody published and completes the encrypted
request response with its marker atomically. Deferred consistency checks may be
needed for the linked rows; no outside reader sees an intermediate state. No
network read, file hash or decoder runs while this transaction holds its locks.
A lost response follows the same immutable request replay path. It never patches
a completed result or creates a second parent.

Refused qualification creates no public marker. A valid ordinary native route can
be returned only while the original request/authority/budget remain valid and its
qualification owner has positively disposed. Unknown cleanup produces a
controlled blocked result and retains the obligation; it does not silently
release a slot or publish a fallback promise. Stop, cancel or source change is
handled by the original request failure/tombstone machinery.

Changing the custody foreign key requires reviewing all cleanup/lifecycle joins.
Pending custody must join its owning request to its room; joining only a not-yet-
created session would hide a live obligation. Failure and cancellation may retire
the request but cannot remove its exact owner link before positive disposal.

## Request retention and compatibility invariants

Pending cancellation, failed preparation, attempt exhaustion or lease expiry
revokes new capture work, but never deletes custody or turns expiry into disposal.
The foreign key is restrictive, with no cascade. Reusing the same idempotency row
cannot replace its session/owner epoch while an old capture is unresolved. Late
positive disposal acknowledgment is checked against that exact retained owner
and proof even after live playback authority has ended; revocation must not lose
cleanup responsibility.

The normal48-hour request deadline is a minimum tombstone retention period, not
permission to erase unknown custody. Request/capture cleanup must also prove
positive disposal and that no retained parent seed, child claim, output/read
obligation or later child-request retention still depends on the rows. Disposed
custody may be pruned only by a matching ordered cleanup transaction after those
conditions, so the new foreign key does not accidentally make every successful
request immortal. Unknown rows remain retained and observable.

An idempotency collision from another login of the same user is not ownership.
Parent and child operations compare the exact captured login before mutable
viewer/request state or replay. A conflicting parent key, child key, root claim
or viewer generation cannot adopt another login's request. Policy B and its
dedicated legacy replacement signal are unchanged; a generic static-HLS refusal
is not permission to silently create another viewer or child.

The typed encrypted input has an explicit schema version and checked plaintext
and actual ciphertext size ceilings (49,124 and 65,536 bytes respectively, including
the existing nonce/tag/base64 overhead). These are per-row limits, not a
whole-database storage guarantee. It is minted only from trusted frozen
source/request data. Its version,
source facts, audio, owner/epoch and original hard deadline cannot be replaced
or re-encrypted as a renewal path. Unsupported versions or oversized input yield
no marker. The bounded initial encrypted seed and final graph proof have distinct
roles and cannot overwrite one another.

Before any retry side effects, compare the exact login/hash and retained custody.
The current begin path can stop the previous session, cancel jobs, close upstream
work, write failures and replace the session/owner epoch; a new viewer intent can
also advance its high-water and retire older requests. A structured in-progress,
retained-custody or terminal replay response must precede those mutations. Foreign
keys and triggers are defense in depth, not the user-facing refusal mechanism.

The phase-specific request transition matrix is:

| Transition | Required meaning |
| --- | --- |
| Pending → completed marked parent | One verified capture/session/publication/response transaction |
| Pending → completed unmarked native | Positive qualification disposal, live original authority, remaining original preparation budget, and an explained native result |
| Pending → failed | Cancel/failure/revocation/expiry; retain session, owner, hash, auth, input and proof |
| Completed → failed | Terminal revocation may clear replay ciphertext and stop delivery; never substitute a plan, add a marker or renew authority |
| Failed → pending/completed | Forbidden for terminal static-HLS requests; recovery requires a fresh explicit intent after required disposal |
| Completed → completed | Compatible bookkeeping only; response ciphertext, marker and authority facts remain frozen |
| Disposal acknowledgment | Still allowed after revocation, with exact original permit and all-positive proof |

There is no HTTP ACK fact in the request ledger. Any committed terminal failure
is treated as stable, even if its response may have been lost. Revocation
tombstones are distinct from rewriting an acknowledged plan. Capture transitions
are also monotonic: verified cannot return to capturing or clear known evidence.

Pruning must change the current unconditional capture, marked-session and
marked-job DELETE refusals into matching ordered positive-disposal checks. This
includes reverse child/seed references, output/read obligations and all retention
deadlines. Both room cleanup and the SQL room guard must use request-to-room joins
for pending custody. No generic request expiry delete may bypass these checks.

## Parent reads and one child

A negotiated parent keeps a sealed complete snapshot. Each manifest/init/segment
GET, HEAD or Range first performs a complete conditional upstream read and hashes
it, then serves the matching sealed bytes. This intentionally adds bandwidth and
latency. A 304 is useful only when the exact previously verified bytes remain
available; it is never an empty-body hash proof. The generated local manifest has
its own representation identity. Redirected final targets, validators and full
body digests remain part of each source-resource identity.

The implementation need not create another resource-sized buffer: it can hash
and discard the complete revalidation body, then serve its existing sealed bytes
under an owned read lease. Per-read buffers, concurrent reads and owner lifetime
remain bounded. A changed unread resource is discovered on its next read or the
child's complete recapture, not by real-time whole-graph monitoring. Any observed
source change invalidates the parent continuation authority.

One eligible decoder-failure report may atomically create one child request with
the same exact login/member/viewer/source/audio authority, a strictly newer plan
generation, root digest/seed and immutable request hash. The root snapshot and
claim metadata are different resources: small encrypted root facts/tombstones
remain after disposing the large snapshot. Network errors,401, timeout, native
code4, unsupported source and capacity errors do not mint this claim.

The parent first stops admitting reads and drains its actual readers, upstream
streams, decoder and files. Only the positive disposal receipt releases its
one-per-user slot and reservation. Then the child obtains its own entire128 MiB
reservation and independently recaptures the complete graph, including unread
future resources. It compares every resource and timeline against the retained
root proof before encoding the child-owned snapshot. No timeout, cancellation
flag or expired lease can substitute for disposal; unknown parent ownership keeps
the child blocked. A claim remains one-shot even when capture fails.

Child authority is frozen in its own request before parent retirement; it must
not require a still-deliverable parent after handoff. This does not revive a
revoked login, membership or policy. The child stays within the original hard
parent/capture deadline, at most 30 minutes from initial admission; renewal cannot
extend that deadline or bypass policy B. The child never advertises another
continuation. Source-dependent recipe metadata comes only from the child's
verified scan, not stale catalog probe JSON.

## Exact deadline and reader contracts

There are two kinds of deadline. The original root hard expiry (at most 30 minutes
from initial admission, and no later than applicable immutable login/grant limits)
is never extended. Each preparation/capture/child-work phase adds its own shorter
work/lease fence. Completing a preparation phase may end its pending lease rule;
it does not move the root expiry. A parent is not accidentally limited to the old
pending60-second lease, and publication cannot restart its30-minute clock.

The database returns conservative remaining phase and root lifetimes. The owner
starts its local stopwatch before the query and subtracts the entire round trip.
Repeated checks only shorten each still-applicable fence. Query error or a missed
fence stops new I/O and publication with unknown cleanup retained. For dynamic
revocation, the proposed responsive-actor observation target is at most 1 second:
an actor pulse at most 250 ms apart and an entire authority check bounded to750 ms,
including both activation checks and SQL. Positive evidence is charged from the
check's start, as specified below. Failure or nonresponse is fail-closed. This is
separate from exact expiry checks before new reads/writes
and publication; it is not a 1 second physical process/file-drain guarantee or proof
under an unresponsive operating system. Actual timing requires runtime evidence.

Reader 1 proves only Stage A custody/queue behavior. Parent/child delivery needs a
new exact reader/recipe contract, including the explicit sequential decode and
absolute-trim semantics. The current25-to30 fps helper evidence is bounded and
does not prove all admitted25/30 fps, mono/stereo/video-only or maximum-size cases.
Phase-aware SQL must preserve Stage A interpretation while requiring the new
exact contract for every Stage B mutation, including request publication and
retirement, session renewal, job claim/housekeeping and cache catalog/eviction. A
new HTTP banner/probe alone is insufficient because current reader 1 connections
remain authorized by all 0043 guards. Unsupported eviction mutations retain the
exception behavior that stops old callers before physical deletion.
All relevant actual configured Workers must prove the new contract and older
claimers must be fenced before any public admission. A package banner or Server
only check is insufficient. Marked claim, renewal, publication, housekeeping,
cache catalog/eviction and physical side effects need old-binary negatives;
NULL legacy work remains unchanged. No new database role, credential or RLS
security claim is proposed.

## Single-Worker custody and proposed private RPC boundary

The first proposed production contract requires one positively bound actual
Worker instance to own qualification capture, parent read leases and local
encoding/capture actors. Server freezes the request and commits the marker based
on a receipt bound to that Worker instance/startup epoch, database/cache context,
request owner and fresh operation challenge. Such a receipt is a remote
attestation, not an in-process opaque snapshot proof. UUIDs cannot establish file
ownership or reconstruct an old process permit.

Worker restart, missing local owner, or a load-balanced WORKER_URL reaching a
different instance fails closed. It cannot adopt a retained capture, emit a new
marker or discard unknown responsibility. Child recapture happens in its own
Worker process and mints a new local proof after full graph comparison; the opaque
proof is never serialized between Server and Worker. Input read leases and the
encode owner must agree. This intentionally withholds the feature when instance
affinity cannot be established; it does not promise arbitrary multi-Worker
shared-file handoff.

The current diagnostic endpoint has no authority to create work. Any new private
operation must be reviewed as a separate typed contract before implementation:

- Qualify a single already-frozen pending request, using a purpose-separated
  authenticated envelope, exact Worker epoch/DB/cache binding, fixed operation
  identity and deadline. Accept no caller URL, file path, raw manifest/probe or
  caller-supplied ownership proof; load the trusted input from its bound request
- Query or cancel that exact operation idempotently. A lost creation reply must
  query the same operation, not allocate another owner. Cancellation does not
  acknowledge disposal
- Return bounded typed pending/verified/refused/unknown status and a graph digest,
  with safe reason codes. Keep source configuration and signed URLs encrypted and
  out of logs. Verify the exact same source/request identity before publication

This reuses the existing authorized private-channel code and keys. It creates no
real credential or remote access and assumes no external setup has been approved.
The following closed envelope/API and SQL ordering are the candidate review
contract. They add no active route or permission to run a qualification.

## Closed input and version contracts

The first candidate admits only registered `sources.kind='http'`, resolved from
the room's current media. It uses that source's frozen configured URL, headers and
access policy through `providers::static_hls::RegisteredSource`. It does not call
Jellyfin/Emby PlaybackInfo, obtain or reuse an upstream SID, accept a client URL,
or admit local/Agent sources. A filename suffix is not HLS qualification. The
entire finite graph and actual scanner result supply that qualification.

Version numbers have separate meanings even when their numeric values coincide:

| Name | Candidate exact value | Meaning |
| --- | --- | --- |
| Public `static_hls_fallback_version` | 1 | One graph-bound parent-to-child continuation |
| `input_version` | 1 | Closed frozen preparation input below |
| `graph_version` | 1 | Complete byte/resource/timeline root identity |
| `reader_version` | 2 | Stage B phase, ownership and output-lifetime SQL contract |
| `recipe_version` | 1 | Static-HLS sequential absolute-trim child recipe |
| `rpc_version` | 1 | Private operation envelopes and bounded attestations |

Reader 1 remains Stage A only. An input version is not a reader version; Binary
`http_file_fallback_version=1` is never an alias for any of these. Proposed SQL
settings are exactly `rainsync.static_hls_reader='2'` and
`rainsync.static_hls_recipe='1'` for Stage B. Compatibility of a different number,
including a numerically greater one, must not be assumed.

The new public request fields, when eventually implemented, are optional
`static_hls_fallback_version:1` and optional `static_hls_fallback`. Their absence
preserves legacy canonical request hashes. The latter is a closed object with
exactly `parent_session_id`, `failure` and required nullable `final_observation`.
`failure` is `{kind:"native_decode",code:3}` or
`{kind:"hls_media_decode"}`; the browser may choose the latter only from its current
fatal media/decode gate, never network/HTTP/timeout/timeline-unsupported events.
`final_observation` is the existing closed, validated `PlaybackObservation`, or
null; it conveys no authorization. Require version 1, key/viewer/newer generation,
transcode mode, unchanged audio intent and an HLS-capable output transport for a
child; reject simultaneous Binary fallback, candidate/profile reports or another
parent type. Neither lookup DTO accepts capture ID, URL, validator, root digest,
input hash or ownership evidence. The parent response carries only the optional
version 1 marker alongside its existing session/plan fields; the completed child
omits the marker and fallback modes. Bound the new lookup subtree to 4,096 encoded
JSON bytes before typed parsing, retaining existing full-request limits.

All new DTOs are closed at every object/variant level: reject unknown or duplicate
fields, missing required fields, wrong scalar types, unsupported versions, excess
collection lengths and invalid enum combinations before work. Required nullable
fields use explicit null; omission does not invent a default. Closed objects
require JSON objects; positional-array struct aliases are refused. UUIDs are
non-nil canonical lowercase hyphenated strings; hashes are exactly 64 lowercase hex
characters. Integers used in canonical JSON are within the safe exact JSON
integer range. The entire decrypted typed input, including `auth_login_hash`,
source/configuration, headers and signed URLs, has no Debug/log/public serialization
path. Its serialization exists only for validated canonical hashing and encrypted
private storage; do not expose the full type through public DTO derives, error
formatting or diagnostics. Use a separate closed diagnostic projection containing
only the safe reason code and operation identity. A general
`SourceConfig`/`serde_json::Value` is not the
closed input type: current `SourceConfig` accepts extra fields.

`StaticHlsInputV1` is a tagged `parent` or `child` object with the following exact
common fields; the child has the additional closed `root` object below:

| Field | Type and rule |
| --- | --- |
| `input_version`, `graph_version`, `reader_version`, `recipe_version` | Exact values1,1,2,1 |
| `kind` | Exactly `parent` or `child` |
| `operation_id`, `session_id` | New operation UUID and reserved request-session UUID; distinct |
| `request_owner_epoch`, `request_sha256` | Exact existing Server request owner and normalized request hash |
| `user_id`, `room_id`, `auth_login_hash`, `auth_membership_epoch` | Exact authenticated principal and captured membership origin |
| `lifecycle_epoch`, `media_id`, `media_generation` | Nonnegative lifecycle/media counters and current media UUID |
| `viewer_id`, `plan_generation` | Required viewer UUID and positive generation |
| `worker_instance`, `database` | Actual bound Worker startup UUID and database-binding UUID |
| `root_admitted_at_ms`, `root_hard_expires_at_ms` | Original DB-clock root admission/expiry, integer epoch milliseconds |
| `prepare_started_at_ms`, `prepare_expires_at_ms` | This request's one preparation interval, no more than 45 seconds and no later than root expiry |
| `position_ms` | Finite nonnegative requested presented-source time; no catalog-duration clamp |
| `audio_intent` | Closed `{kind:"default"}` or `{kind:"stream",index:u32}` |
| `source` | Closed registered HTTP source object below |

`source` has exactly `kind:"http"`, `source_id`, `source_policy_revision`,
`media_source_generation`, `configured_base_url`, `canonical_target`, `headers`
and `access_policy`.
`media_source_generation` is the existing positive
`media_items.preview_generation`, which also changes when source configuration,
media resource or source metadata changes. It is a configuration/media fence,
not byte identity. No new configuration-revision ledger is introduced.
`source_policy_revision` is the existing separate source access-policy revision.
The current locked media row must still be available and belong to this source.
Keep scanner facts with the request/capture; do not update catalog metadata during
Stage B publication and thereby advance this input's own configuration fence.

`configured_base_url` and `canonical_target` are separately frozen canonical HTTP
or HTTPS URLs, each at most 16,384 UTF-8 bytes. Reject leading/trailing whitespace,
ASCII controls, backslashes, URL userinfo, absent host, port zero and fragments.
Parse once with the transport's URL/gateway semantics and persist each serialized
canonical URL. Do not strip, reorder or reconstruct query data later.
`configured_base_url` comes from the trusted registered `SourceConfig.url` under
the captured source/media configuration fence. Its origin is the credential
authority for all configured headers. Reconstruct the provider transport with
`SourceConfig.url=configured_base_url`, never with a selected or redirected target.
`canonical_target` is the trusted selected manifest request target; hash its
canonical UTF-8 string for target identity and authorize it through the source
gateway rooted at `configured_base_url`. In the first HTTP-only route the initial
target equals the configured URL, but the two fields retain different roles.
Every manifest reference and redirected final target is independently checked by
the existing source-policy/origin/address gateway. A separately allowed CDN target
does not become the configured credential origin: configured headers stay confined
to `configured_base_url`'s origin. A different allowed final URL is still a
different resource identity. Child input must preserve both frozen URLs, policy
and headers exactly from its parent input.

`headers` is a sorted array of closed `{name,value}` objects, at most 32 entries,
with unique lowercase HTTP names (at most 128 bytes each), values at most 4,096
bytes each and at most 16,384 aggregate name/value bytes. Apply the existing
`validate_source_headers` and HTTP header parsers, including rejection of routing
and hop/framing headers. These are frozen configured headers, not browser input.
`access_policy` is required null for explicit legacy-origin-only enforcement, or
the exact closed existing `{schema_version:1,origins,redirects}` policy. Each
origin is the existing closed `{origin,cidrs}` shape; preserve the current 16-origin,
64-CIDR-per-origin and redirect-hop1–5 bounds. `redirects` is required null or
`{max_hops}`. Null policy does not claim a strict address boundary.

The child's `root` has exactly `parent_session_id`, `parent_capture_id`,
`parent_input_sha256`, `root_digest`, `root_admitted_at_ms`,
`root_hard_expires_at_ms` and `selected_audio`. Copy these from the locked verified
parent proof; require the repeated root times to equal the common times. The
source object and original audio intent must equal the parent's frozen values.
The child has its own operation/session/owner/request/input hash, strictly newer
plan generation and its own shorter preparation fence. `selected_audio` is the
closed scanner-produced `{kind:"none"}` or `{kind:"single",stream_index:u32}`.
Request `default`, omitted catalog audio and an empty client field never prove
`none`. Initialization, every fragment and the complete decoded scan must agree
on presence and stream identity; an explicit intent must match the actual scan.
The first recipe below requires `single`; Stage A's proven no-audio case remains
distinct rather than being silently admitted to the child recipe.

Serialize validated input using the project's versioned closed-schema deterministic
JSON byte convention and compute
`input_sha256=SHA256("rainsync-static-hls-input-v1\0" || canonical_bytes)` before
encrypting it once. This internal Rust contract follows the existing typed request-
hash convention, not RFC8785/JCS or generic JSON key sorting. Object fields appear
in the typed declaration order (the input table order, then child `root`; nested
objects use their listed field order); arrays retain their validated order, including
sorted headers and ordered inventory/segments. UTF-8 strings preserve exact Unicode
code points with serde_json's JSON escaping; there is no Unicode normalization,
query reconstruction or lexical-key sort. Integers use decimal safe exact JSON values;
finite f64 fields use serde_json's shortest round-tripping representation with
negative zero normalized to positive `0.0`. Numeric aliases such as `0`, `0.0`
and `-0.0` therefore serialize as the same typed f64 `0.0`. Unknown/duplicate fields,
omitted required nullable fields and unsupported versions are rejected before this
serialization. Golden bytes/domain hashes and parse-reserialize stability pin v1.
A future cross-language contract would require separate interoperability review;
this implementation makes no JCS claim. Do not include the resulting digest in its
own hash input.
Check plaintext before encryption and the actual stored base64 ciphertext after
encryption: plaintext1–49,124 bytes and ciphertext1–65,536 bytes. Existing AES-GCM
uses 12 nonce bytes, 16 tag bytes and standard padded base64; the plaintext ceiling
allows that exact ciphertext ceiling. Also bound encoded input before decrypting
and plaintext before parsing. SQL enforces the actual ciphertext limit. Do not
renew by replacing input, changing versions/deadlines or re-encrypting it.

The root digest is
`SHA256("rainsync-static-hls-root-v1\0" || canonical_root_bytes)` for the closed
`RootGraphV1={graph_version,parent_input_sha256,inventory,closure,timeline}`.
It uses that same internal typed-byte convention with fields in the order shown;
inventory/closure/timeline and track fields use their listed/current typed order.
The inventory contains the existing ordered manifest/init/media resource
identities: original/final target hashes, strong ETag, actual bytes and body hash.
Closure/timeline use the current complete typed `ClosureIdentity` and
`TimelineProof`, with finite numeric fields, exactly the current field sets and
bounded track/segment arrays. Reject duplicate or unknown fields rather than
accepting flattened arbitrary metadata. The full scan must still validate them;
this is not permission to authenticate caller-supplied probe JSON. Exclude
capture elapsed time, local file descriptors/paths and process-instance argv
details from root byte/timeline equality. Retain the existing separately encrypted
complete scanner/decoder inventory evidence (actual ciphertext at most 262,144
bytes) in custody. The root's inventory and timeline, not its configuration
generation, prove representation equality. Child comparison checks every resource,
including final-target/query identity, every track and the complete timeline.
Specifically inventory has 3–66 resources in manifest/init/segment order, with
`inventory.len()==closure.segments.len()+2`. Inventory position 0 must match the
closure manifest's hash/size, position 1 the init's hash/size, and position `i+2`
segment `i`'s hash/size; the closure embedded in timeline must equal the root
closure. Each inventory item also preserves its original/final target and strong
validator identity. Closure
has version 1, manifest hash/bytes, closed init `{bytes,sha256}` and 1–64 closed
segments `{index,bytes,sha256,track_ids}` in increasing index order, with at most
two unique track IDs. Timeline has exactly that same flattened closure plus
`scope:"bounded-zero-origin-avc-fmp4-prerequisite-only"`, `source_origin_ms:0`,
`duration_ms`, `media_sequence` and 1–2 tracks. Each track has exactly the current
`track_id`, `stream_index`, `kind` (`video`/`audio`), `time_base`, `packet_count`,
`decoded_frames`, `raw_first_pts`, `decoded_first_pts`, `priming_samples`,
`tail_padding_samples`, `raw_end_seconds`, `end_seconds`, `last_frame_pts` and
`codec_config_sha256`. Validate rational time bases and the scanner's current
70,000-record/300 second/byte limits before canonicalization. Child equality
recomputes the graph with the parent's `parent_input_sha256`; it binds the child's
different input digest separately and does not replace that parent digest in the
root hash. This makes equal recapture roots possible despite a new child request.

Keep pure input/graph/owner contracts in media-core or a dependency-neutral existing
protocol boundary. Providers translate the closed HTTP input to their own gateway
configuration with `url=configured_base_url` and implement `CaptureTransport`;
media-core never imports providers
or persistence. The application's private RPC boundary carries plain attestations,
while opaque `VerifiedCapture`, input leases and `DisposalProof` remain media-core
values held by the actual Worker. Do not introduce a crate dependency cycle merely
to reuse the currently open `SourceConfig` type.

## Candidate table fields and predicates

Reuse the existing tables and 48-hour ledger. The candidate additions are:

| Table | New field or constraint | Rule |
| --- | --- | --- |
| `playback_requests` | `static_hls_input_version smallint NULL` | Null is legacy; exact 1 is Stage B |
| | `static_hls_input_encrypted text NULL` | Exactly one bounded immutable input ciphertext |
| | `static_hls_input_sha256 text NULL` | Immutable input digest, canonical hash format |
| | `static_hls_operation_id uuid NULL UNIQUE` | Immutable operation ID; also the new capture ID |
| | `static_hls_root_expires_at timestamptz NULL` | Immutable original hard deadline mirrored from input |
| | `static_hls_prepare_expires_at timestamptz NULL` | Immutable shorter preparation deadline mirrored from input |
| | `static_hls_parent_capture_id uuid NULL` | Restrictive FK to custody; child-only and unique when non-null |
| `static_hls_captures` | Retarget `session_id` FK | Restrictive FK to unique `playback_requests.session_id`; no cascade |
| | `publication_phase text NOT NULL` | `stage_a`, `pending_parent`, `published_parent`, `pending_child`, `published_child` |
| | `input_sha256 text NULL`, `root_digest text NULL` | Stage B input digest at admission; graph root digest added only on complete verification |
| | `worker_instance uuid NULL`, `database uuid NULL` | Immutable actual Worker startup and DB binding |
| | `binding_challenge uuid NULL`, `binding_cache_sha256 text NULL` | Immutable create challenge and its fresh-cache-byte digest |
| | `reader_version smallint NULL`, `recipe_version smallint NULL` | Exact2/1 on Stage B custody; legacy null on Stage A |
| | Unique Stage B `session_id` | At most one qualification/recapture operation for a frozen Stage B request |

All request Stage B fields except the child-only parent reference are all-null or
all-present. A non-null parent reference requires the all-present input set.
Mirror deadlines, digests and IDs must agree with decrypted input in both Server
and Worker before admission/publication. SQL joins also require request operation
ID=capture ID, request session=capture session, matching request owner/user and
input digest. New plain fields contain no URL, configuration header or credential.
The existing `resource_authority` remains a bounded encrypted-resource wrapper.
Its Stage B outer object has exactly `encrypted`, `source_policy_revision`,
`account_policy_generation:null`, `auth_context` (the existing exact login/member
shape) and `static_hls_input`. That new closed authority object has exactly
`input_version:1`, `reader_version:2`, `recipe_version:1`, `source_id`,
`media_source_generation`, `input_sha256`, `worker_instance` and
`root_hard_expires_at_ms`. Its inner encrypted Stage B delivery descriptor has
exactly `kind:"http"`, `transport:"hls"`, `delivery_mode` (`direct` parent or
`transcode` child), `session_id`, `input_sha256` and `timeline_origin_ms`.
Worker loads source data from the bound request's encrypted input, not a second
source/configuration snapshot in this descriptor. A published session adds its
existing `static_hls_capture_id` to the outer object; custody stores the unmarked
outer object for exact equality. An unmarked native result uses its ordinary
resource wrapper after qualification disposal. No plain object contains decrypted
source configuration. Request hash and input hash are different values.
Publication copies the custody wrapper exactly before adding the capture ID;
re-encrypting an equal descriptor with a new nonce would change that equality.

`owner_id` remains the mint-only capture owner generated by the actual Worker;
`request_owner_epoch` remains the original Server request owner. Neither is
replaced by a later Server/Worker. `capture.id=static_hls_operation_id` differs from
the session/job/cache ID, so the existing prohibition on using a media-job ID as
a capture ID remains meaningful. Stage B per-user/global capacity still counts
every `disposed_at IS NULL` row, including cancelled, expired and unknown rows.

Interpret all pre-migration captures as `publication_phase='stage_a'`, with the
new nullable binding/version fields null. Keep their existing completed-session
authority predicates and reader 1 compatibility. Do not mint input, root digest,
startup ownership or a disposal proof for them. Legacy requests with the entire
new field set null retain their exact old behavior. An unsupported Stage B row
never falls through to this interpretation. Retargeting the FK must preserve every
existing capture-to-request association; a missing association blocks migration
rather than discarding/adopting the capture. The new publication phases are
monotonic: pending parent/child can become their corresponding published phase
only once; cancellation/disposal changes `state`, not the historical phase.

Use three distinct authority predicates:

1. Pending input authority joins capture→request→room/snapshot, exact login/member,
   source/configuration and viewer generation, without requiring any session.
   It requires pending status, the original request owner and live preparation,
   pending lease and root fences. The child predicate uses its own frozen
   authority; the parent may already be stopped/failed/disposed
2. Published parent-read authority requires completed parent request, live parent
   grant, published-parent verified undisposed custody, exact current authority,
   root fence and an actual same-Worker local snapshot/input lease
3. Child-output authority requires completed child request, its live grant,
   current child login/member/source/viewer/media/lifecycle, original root fence,
   and verified job/attempt/output binding to child input digest, expected root
   digest and recipe. It does not require live parent authority or undisposed
   child input. Child claim/encode additionally requires that original Worker's
   live local verified child snapshot and permit

The job's closed Stage B spec has exactly `kind:"static_hls_child"`,
`reader_version:2`, `recipe_version:1`, `input_version:1`, `graph_version:1`,
`capture_id`, `input_sha256`, `root_digest`, `worker_instance`, frozen
`position_ms`, scanner-selected `selected_audio` and `estimated_output_bytes:33554432`.
It has no generic root/path, upstream input ticket, raw argv or browser options.
It uses the existing `static_hls_v1` logical queue, with its phase/version guard;
Stage A's queue meaning stays distinct. Require exact
matches to child custody/input and preserve the spec immutably for an attempt.
Existing execution/output/file/read/reservation rows bind through `(job_id,attempt,
owner_id)` to this spec; no competing output table is added. Claimed attempts and
output publication must recheck these links. Same-Worker claim also checks the
in-process permit registry before any file/process side effect. A reader 2 Worker
with a different startup UUID cannot claim this job. Affinity/compatibility refusal
is not source revocation, permission to cancel another owner or evidence of drain.

Every Stage B request/capture/publication/renewal/job-claim/normalization/spec/
execution/output/file/reservation/read-lease/catalog/eviction mutation requires
the exact reader 2/recipe 1 SQL fence. Claim and encode publication additionally
compare the actual startup against custody and the immutable job spec. The new
Worker installs its own actual startup UUID in
`rainsync.static_hls_worker_instance` for these conditional SQL predicates; a
declared value never reconstructs
a local permit. Put affinity filtering in the queued candidate and final UPDATE,
before advancing attempts, fairness turns or execution/output ownership. Exclude
foreign-startup jobs from lease-expiry retry/attempt-exhaustion normalization too;
the same reader number alone cannot adopt them. SQL compatibility remains the
existing cooperative mixed-binary boundary, not a malicious-superuser security
claim. Null legacy jobs and Stage A reader 1 rows retain their respective behavior.

After the actual child encoder and all input readers/processes close, the original
owner positively disposes its input directory and acknowledges custody, releasing
the 128 MiB capture reservation. That action preserves immutable input/root proof
and completed child response. Valid cached output remains readable under predicate3
until its own authority/expiry/eviction; its writer, output files and read leases
have their separate existing disposal obligations. No active-capture predicate
may accidentally revoke that already verified output. This does not authorize
reconstructing a lost input proof to resume an unfinished encoder after restart.

## Exact private operation envelope and results

Candidate endpoint: one new private POST
`/media-delivery/static-hls-operation`. This is design only. Reuse the existing
source-key AES-GCM nonce/tag/base64 channel and `no-store` response behavior; add
no key, credential, access grant or setup. The current
`rainsync-static-hls-contract-request-v1` diagnostic purpose stays read-only and
must be rejected by the operation endpoint. It cannot create/query/cancel work.

Each create/query/cancel request is a closed envelope with `purpose`, `rpc_version`
and `binding`. Purpose is exactly one of
`rainsync-static-hls-create-request-v1`,
`rainsync-static-hls-query-request-v1`,
`rainsync-static-hls-cancel-request-v1`; rpc version is exactly 1. There are no other
action-specific fields. `binding` has exactly:

- `operation_id`, `operation_kind` (`parent` or `child`), `session_id`,
  `request_owner_epoch`, `request_sha256`, `input_sha256`
- `worker_instance`, `database`, `challenge`, `cache_challenge_sha256`
- `reader_version`, `recipe_version`, `input_version`, `graph_version`
- `issued_at_ms`, `rpc_expires_at_ms`, `root_hard_expires_at_ms`,
  `prepare_expires_at_ms`

All identity/version/deadline fields except the fresh `challenge`,
`cache_challenge_sha256` and RPC times must match the same original
input/request/capture. The original create challenge/digest pair stored on custody
is immutable; later query/cancel or same-operation create retries use their own
fresh pair, checked against that call's probe rather than against the original
digest. `worker_instance` is the existing
Worker `INSTANCE` fresh startup UUID; do not introduce a durable machine ID or
pretend a request owner UUID identifies a process. The Worker accepts only its
own startup UUID. The database UUID is the current singleton binding.

`challenge` is a fresh non-nil UUID and `cache_challenge_sha256` is the digest of
the Server's fresh 64-byte owned cache probe for that challenge. Both Server and
the actual Worker must positively read the same challenge bytes under the current
DB challenge/expiry fence. Existing `WorkerContract.cache_identity` means exactly
this digest, not a stable global cache identity. Compare it only to that challenge's
expected digest. Query/cancel/publication use new fresh challenges; their different
digests neither contradict the original binding nor prove durable cache affinity.
The original local owned-directory binding plus actual same-startup owner still
must agree. No opaque snapshot/disposal/file-descriptor proof is serialized.

Request plaintext is at most 3,044 bytes and actual ciphertext/body at most 4,096
bytes. Response plaintext is at most 6,116 bytes and actual ciphertext/body at
most8,192 bytes, checked before parsing and after encryption. Bound HTTP bodies
before allocation. Reject plaintext/unauthenticated/old-purpose responses.
`issued_at_ms<=now<rpc_expires_at_ms<=issued_at_ms+6000`; check freshness after
every wait. Server starts the receipt stopwatch before challenge work and charges
all transport/DB/cache time. Query/cancel may address revoked or expired work for
observation/cleanup; the repeated original work deadlines remain unchanged.
Create additionally requires all live pending authority and remaining phase/root
budget. A6-second RPC fence does not grant6 seconds of new capture budget.

Response has exactly `purpose`, `rpc_version`, the complete echoed `binding` and
one closed tagged `result`. Response purpose is the matching
`rainsync-static-hls-{create|query|cancel}-response-v1`. Result alternatives are:

| `kind` | Exact additional fields | Meaning |
| --- | --- | --- |
| `pending` | `capture_id`, `stage` (`capture`, `verify`, `drain`) | Original operation exists; no publication/disposal fact |
| `verified` | `capture_id`, `root_digest`, `verified_at_ms`, `selected_audio` | Owner holds the full local verified snapshot and has committed matching encrypted inventory; Server still must publish atomically |
| `cancel_requested` | `capture_id` | Owner stops admitting work; cleanup remains retained |
| `refused` | `capture_id` (required null if admission never committed), `reason` | No marker; it makes no disposal claim |
| `disposed` | `capture_id`, `disposed_at_ms` | Original owner already committed positive DB disposal; response itself is not the disposal proof |
| `unknown` | `capture_id` (nullable), `reason` | Binding, authority or original local owner cannot be established |

`reason` is one closed code: `unsupported_input`, `source_changed`,
`authority_revoked`, `deadline`, `capacity`, `unsupported_version`,
`worker_mismatch`, `local_owner_missing`, `operation_conflict`, `cancelled`,
`unavailable`. Never return upstream text, URL, headers, PID, path, proof bytes or
arbitrary diagnostic JSON. A verified result has no root graph/resource bodies;
Server loads the existing encrypted custody evidence and compares its input/root
digests outside publication locks. No status enum, successful cancel, HTTP 200,
expired lease or absent process is sufficient to acknowledge disposal.

Create performs one durable operation-ID/request/hash check before any source
read or file/process allocation. A duplicate with identical original binding
returns the existing operation's current result; it never starts another capture.
A collision with different kind/session/request/input/owner is `operation_conflict`.
A lost create reply is followed by query of the same operation, optionally a
same-operation create retry; no new operation ID or replacement owner is allocated.
Fresh query challenges authenticate a new status observation without extending
work authority. Terminal cancellation/refusal/disposal never reopens work.
An extant custody row without this startup's original local permit yields
`unknown`, even if SQL says verified. Positive disposed rows may be observed as
immutable DB facts without adopting any local ownership.

Only the original Worker, with its still-retained mint-only permit and actual
all-positive `DisposalProof`, writes streams/process/files/disposed timestamps.
That owner first closes admitted readers and upstream bodies, drains/reaps all
process/blocking scopes, and removes its inode-bound owned directory. It then
calls the existing positive-disposal transaction with exact capture/owner/session
and startup binding. This remains allowed after login/request/root expiry or
Server cancellation. Server query/cancel handlers cannot translate an RPC status
or the serialized fact `disposed` into that acknowledgment. They read the matching
all-positive DB row; a lost disposal acknowledgment can only be retried by the
original holder of that real proof. Restart/different Worker retains unknown
responsibility and emits no new publication marker.

## Ordered transactions and deferred publication checks

The lock order for admission/publication/child claim is the existing room lifecycle
row, room snapshot, member, exact login, user quota, existing request rows, viewer
high-water, source/current media configuration fence, capture rows, playback
session rows, then job/output/cache rows and the cache budget/reservation lock when
needed. Lock multiple requests/captures/sessions in UUID order within each group.
The source row is locked before the media configuration row to match source
configuration changes. Source authority precedes playback-session locks; no
qualification introduces a reversed wait on that order. Cache cleanup/disposal
uses its existing budget-first owner transaction and never takes room authority
locks afterward. No network, decoder, filesystem hash or physical deletion occurs
under these transactions. Recheck clock/current authority after contended locks
and in the final conditional mutation.

Parent admission:

1. Validate the closed negotiation and actual Worker compatibility/affinity.
   Under the existing begin locks, compare exact login/member/request hash before
   mutable viewer/replay handling. Inspect retained Stage B input/custody/terminal
   state before current begin can retire a session, cancel jobs, close upstream
   work, advance high-water or replace an owner. Return an existing live completed
   response, stable terminal result or controlled retained-custody/in-progress
   refusal as appropriate; never reclaim unresolved ownership
2. For a new accepted intent, resolve and freeze the trusted source/input and root
   clock. Insert its pending request and existing preparation row atomically.
   Initial `root_hard_expires_at<=root_admitted_at+30minutes` and no later than the
   captured login/other immutable authority limits; preparation is at most 45 seconds.
   Pending lease is at most 60 seconds and no later than root expiry; it remains a
   distinct fence from the shorter 45-second preparation deadline.
   Do not insert a parent `playback_sessions` row or mint an exposed delivery token
3. The actual bound Worker handles create, locks the same authority, measures
   owned headroom outside locks, checks its unchanged budget revision, and inserts
   pending-parent custody plus one full 128 MiB capture reservation atomically.
   It mints/registers that local owner before source/file/process side effects.
   Unknown admission reply cannot discharge it. Capture/decode gets
   `min(35seconds,remaining preparation,remaining root/authority)`
4. Outside locks the Worker fully captures/scans/seals; a short owner-conditional
   transaction commits verified inventory/root digest under pending authority.
   Verification does not publish or complete the request. A bounded fresh query
   attests that this original Worker still holds the corresponding local proof
5. Server validates/decrypts/hashes bounded input/evidence outside locks, then
   takes publication locks and repeats current authority, original budgets,
   exact input/root/Worker/DB/version binding. Insert the parent session while
   request is still pending, so existing session-origin SQL derives the exact
   login/member. Immediate session checks require matching verified pending-parent
   capture linkage, immutable source/authority facts and expiry<=original root;
   they must not yet require request.status=completed
6. In that same transaction set phase published-parent and complete the request
   with the encrypted response containing the new static-HLS marker. Final
   deferred constraint triggers, installed on request/capture/session, require all
   three rows to describe one completed marked parent. Abort unless every expected
   conditional UPDATE/INSERT affected exactly one row. Commit precedes delivery
   and immutable replay; a lost response cannot add a marker later

For an admitted qualification that refuses, stop its owner and wait for actual
all-positive DB disposal before completing an unmarked native response. Repeat
live exact authority and the remaining original 45-second budget in that final
transaction. If disposal is unknown or budget/authority ended, commit a terminal
failed/blocked request and retain original input/owner/proof; do not issue native
playback optimistically. A source/version/capacity refusal before qualification
admission creates no capture permit and offers no continuation promise.

Child claim/admission/publication:

1. Require the completed marked live parent, exact captured login/member/viewer,
   current source/media/lifecycle, unclaimed root and original root deadline.
   Accept only a current-plan decoder-failure report: native media error 3 or a
   fatal HLS media/decode classification with no authorization/network/timeout
   classification. Native code4 never qualifies. Reported failure is intent,
   not source/ownership proof; Server independently validates all authority
2. Under the same ordered locks, compare child key/hash/login before side effects,
   validate/copy parent inventory/root digest and scanner-selected audio, freeze
   the child's complete typed input and check actual encrypted bounds. Insert
   the pending child request/preparation and unique parent-capture claim **before**
   stopping the parent or advancing viewer high-water. The child's source/root
   deadline is immutable and its own preparation<=45 seconds starts here
3. Still in that transaction stop parent delivery/new reads, retain the parent's
   historical response/input/proof and advance the child's viewer generation.
   Parent completed→failed, if used for revocation, only clears replay and records
   terminal failure; it never substitutes a child response. Commit the child claim
   even though parent cleanup is pending. No child capture/reservation exists yet
4. Cancel the exact parent operation on the same Worker. Drain its real local read
   leases, upstream bodies, processes and files. Original-owner positive disposal
   commits reservation release and budget revision. Status/cancel/timeout/expiry
   cannot free the one-per-user slot. A failed/unknown drain leaves the child
   blocked or terminal under its own deadline, without resetting its claim
5. Within the child's remaining original preparation/root fences, the same actual
   Worker admits a new child operation and its own full 128 MiB reservation under
   child request authority. Independently recapture the complete graph, scan and
   mint a fresh local proof; compare full inventory/closure/timeline and scanner
   audio against the retained root, including resources the parent never served.
   Commit verified pending-child custody only after exact equality
6. Publish child in one short transaction after fresh same-Worker attestation.
   Insert its session while its request is pending to retain the current origin
   trigger; require the child's own verified capture/input/root/current authority,
   live original deadline and recipe. Set published-child, complete its encrypted
   queued transcode response, then insert the existing purpose-specific queued job.
   Immediate job guards now see completed child authority. Deferred final checks
   require the session/capture/request/job tuple to match. The child response has
   **no** static-HLS or Binary fallback marker and no recursive fallback modes
7. Only that original Worker can claim/encode from its fresh local child proof.
   Reserve bounded output through existing writer machinery; revalidate exact
   input/root/recipe/job-attempt ownership before spawn and output publication.
   No output is published from pending/unverified child custody. Actual encoder
   completion/reaping and validated output publication precede positive input
   disposal; the published output then uses its separate predicate/lifetime above

This avoids the immediate-trigger cycle in which session insertion requires a
pending request while capture/delivery validity requires a completed one. Linkage
and immutability are immediate; the completed publication dependency is checked
at deferred commit, never by briefly exposing a provisional parent grant. On
rollback there is neither grant/marker nor child job. All source work stays outside
locks. Existing Stage A immediate completed-session checks remain phase-specific.

Deferred checks inspect final rows, not a transient NEW snapshot. Their allowed
terminal tuples are explicit: pending qualification/recapture has a pending or
failed retained request and no exposed session; disposed pending-parent custody
may accompany a completed **unmarked** native result; published-parent requires
one completed marked matching grant, or a retained revoked/stopped historical
publication; published-child requires the matching completed child grant/job,
   or retained stopped/failed historical publication. Revocation/disposal never
requires current playback authority merely to preserve these historical links.
Only a new publication transition requires current authority and verified local
ownership; disposal may leave a stopped parent or live already-published child
output. Check the child-only parent reference/kind and unique claim, input/root
digests, original root expiry, phase, session origin and absence of a recursive
marker at final commit. Do not reuse Stage A's blanket request-status-immutable
guard on Stage B, or it would prevent publication and terminal revocation.

Cancellation/lease expiry/failure keeps request session, request owner, input,
capture owner/binding, unique child claim and known inventory/root unchanged.
Failed Stage B requests never transition back to pending/completed, including
retryable transport failures and lost responses. A fresh explicit key/intent may
start later work only after required positive disposal; it cannot reuse the old
claim. Completed→completed cannot change response ciphertext/marker/authority;
replay-only current lifetime/observation fields may be rendered outside stored
ciphertext without creating a new fallback promise.

Pruning is an ordered exact-reader cleanup, after every relevant 48-hour request
retention deadline (including later child requests), positive capture disposal,
preparation closure and existing execution/output/file/read/writer obligations.
Under locks remove positively drained output/read/catalog/job/session dependents,
then obsolete child capture/request references, and only then the retained parent
proof/request. The unique claim survives until the original root can no longer be
used and all its dependents have ended. Deferred consistency permits this ordered
whole-set deletion but rejects partial removal of a live publication. Room cleanup
and room-close SQL must join pending captures through `playback_requests.room_id`.
Unknown ownership blocks pruning indefinitely, even past 48 hours. Unsupported cache
catalog/eviction mutations must RAISE before old callers can proceed to physical
deletion; returning NULL/zero rows is insufficient for current `claim_eviction`.

## Responsive checks, input reads and first recipe boundary

The proposed entire authority check has one 750 ms absolute timeout started before
activation-check1, connection acquisition, SQL/current-authority/root/phase read,
activation-check2 and final elapsed-time validation. It is not three independent
750 ms allowances. Use conservative DB remaining phase/root durations; subtract
all elapsed time and only shorten previously installed monotonic deadlines.
Timed-out SQL connections are closed rather than returned to the pool as positive
evidence. A positive observation has a freshness fence no later than
check-start+750 ms, never completion+750 ms. The responsive owner pulses/checks its
stop/freshness fence at most every 250 ms, including while an authority read waits.
Missed/unknown evidence fails closed. Thus an old positive cannot authorize new
work beyond the proposed1 second observation/stop target; runtime evidence still
must prove the responsive-actor premise. This target does not promise physical
reader/process/file drainage within 1 second.

Check exact local phase/root expiry before each new I/O, input lease/file open,
process spawn, output write/publication and externally served body chunk. A future
poll cannot authorize work beyond a known local deadline. Positive disposal still
comes from actual owner shutdown after those checks stop work.

Parent input leases are nonserializable, same-Worker leases on the retained sealed
`OwnedDirectory`, addressed by a closed resource key `manifest`, `init`, or
`segment(index:0..63)`. No caller file path or ownership UUID constructs one. Bound
admission to at most two simultaneous upstream revalidations/input readers per
parent; cancellation first stops new leases and then drains the real handles.
Parent custody/reservation remains held regardless of any lease deadline. Output
read leases remain the existing attempt-scoped `cache_read_leases`; do not route
parent input through its current session-ID/job-cache assumptions.

Each manifest/init/segment GET, HEAD or Range revalidates a **complete** upstream
resource before serving any requested sealed bytes. Match original/final target,
strong validator, actual full length and body digest; hash/discard streaming body
in bounded chunks rather than buffer another whole resource. A 304 is admissible
only with the exact still-owned verified full bytes and matching response identity;
the first candidate transport may conservatively require full 200 bodies because
the existing capture transport has no 304 proof API. The generated local manifest's
own representation hash/length governs delivery, while the remote source manifest
is separately revalidated. Observed mismatch revokes parent continuation authority
and ends that read. A lease/status flag alone never proves reader closure.

The smallest candidate recipe is `static_hls_seq_trim_25mono_to_30stereo_v1`:
scanner-proved H.264/avc1 with no B frames, 640×360, 25 fps and exactly one muxed
AAC-LC mono 48 kHz track, at most 14-seconds and at most 14 one-second source
segments; output is 1280×720 AVC 30 fps and AAC-LC stereo 48 kHz.
Use sequential file-only decode, `-copyts`, absolute `trim/atrim` to scanner-proved
source end, timestamp rebasing and explicit 30 fps resampling. No input `-ss`, raw
priming arithmetic, duration guess or metadata-only recipe selection is allowed.
The original 35-second full-recapture budget and a separate shorten-only 20-second
encode wall/CPU budget are both bounded by remaining child preparation/root
authority; completing recapture cannot restart preparation. Propose at most a
20-second output window,4 MiB per output resource and 32 MiB total output, with an
independently admitted existing output-write reservation while the 128 MiB input
reservation remains held. Full source decoding may exceed the budget even for a
short output window; refuse rather than seek imprecisely or increase budgets.

This recipe name describes the smallest **candidate** class, not proven admission
of every member. Actual retained evidence is one 14-second, fourteen-one-second-
segment authored source and six seeks 0/13/1000/1013/3417/8013 ms. It does not prove
arbitrary content/seeks, source 30 fps/stereo/video-only,300 seconds, maximum bytes or
registered-HTTP custody/DB/Worker delivery. The default maximums of Stage A are
rejection ceilings, not a qualified production matrix. Public enable remains off
until source-bound full-recapture/recipe/output/authority evidence covers the
chosen admitted class. Broader source variants require new evidence and, if they
change semantics, a distinct exact recipe contract.

## Source anchors and decisions still requiring review

This candidate is grounded in the current source, not in a running service:

- [Request ledger and unique session](../migrations/0003_playback_requests.sql),
  [begin/replay/replacement and completion](../apps/server/src/playback_requests.rs),
  [session origin pending-request trigger](../migrations/0041_media_login_binding.sql)
- [Existing Binary authority/input/audio/claim](../apps/server/src/http_file_fallback.rs),
  [Binary public DTO](../crates/protocol/src/http_file_fallback.rs),
  [actual decoder-failure gates](../apps/web/src/features/playback/playback-runtime.ts)
- [Stage A FK/phases/reader/guards](../migrations/0043_static_hls_foundation.sql),
  [mint-only permit/disposal/activation check](../crates/persistence/src/static_hls.rs)
- [Worker startup UUID/private diagnostic](../apps/media-worker/src/static_hls_contract.rs),
  [Server fresh-cache challenge](../apps/server/src/static_hls_contract.rs),
  [WorkerContract meaning](../crates/persistence/src/static_hls_activation.rs)
- [Open SourceConfig and header validation](../crates/providers/src/lib.rs),
  [closed source policy](../crates/providers/src/access_policy.rs),
  [controlled redirect/credential gateway](../crates/providers/src/media_request.rs),
  [registered capture transport](../crates/providers/src/static_hls.rs),
  [configuration/media generation fence](../migrations/0024_media_previews.sql)
- [Local ownership/transport/resource proof](../crates/media-core/src/static_hls/mod.rs),
  [complete typed timeline](../crates/media-core/src/static_hls/timeline.rs),
  [scanner presence/qualification](../crates/media-core/src/static_hls/scanner.rs),
  [test-only sequential recipe](../crates/media-core/src/static_hls/child_timeline_fixture.rs),
  [bounded measured recipe evidence](STATIC_HLS_CHILD_TIMELINE_FIXTURE.md)
- [Existing queue insertion](../crates/persistence/src/media_queue.rs),
  [queue claim/normalization](../crates/persistence/src/media_jobs.rs),
  [cache eviction/read assumptions](../crates/persistence/src/cache.rs),
  [execution/preparation retention](../migrations/0029_room_cleanup.sql)

The first implementation choice should be one small pure-contract slice: closed
input serialization/bounds/digests and phase/transition predicates with public
admission still disabled. The coordinator chooses that slice after this document's
independent review. This is not a proposal to implement all described APIs at once.
Migration/SQL guards and paused PostgreSQL evidence, private endpoint/owner registry,
parent delivery, same-Worker child queue/recipe, and activation remain separate
later review/evidence gates. No new endpoint, dispatcher or enable path belongs
to that first pure-contract slice.

Before code, independent review must accept the candidate closed schemas, exact
reader 2/recipe 1 gate, deferred trigger transition/cleanup rules and lock-order
compatibility with the existing queue/cache writers. Coordinator decisions remain:
whether to approve the initial registered-HTTP/25 fps-mono recipe class and its
exact admission/evidence matrix; and whether first parent revalidation should
require full 200 or add a reviewed conditional 304 proof transport. Full 200 is the
bounded default proposed here. No generalized multi-Worker handoff, upstream SID
integration or new credential is part of either choice. All new PostgreSQL runs
remain paused, and this document supplies no implementation/test evidence.

## Required implementation and evidence gates

1. Pure state/typed-input tests for pending admission, atomic publication rules,
   monotonic deadline shortening and one-shot parent/child ownership
2. Migration/current-and-old SQL tests, including pending custody lifecycle joins,
   cancellation/failed request cleanup, same-request replay and old-reader physical
   eviction refusal
3. Actual owned graph capture/recapture mutations: manifest/init/last unread
   segment/final query,304 without cached bytes, version change during a read,
   account/logout/member/viewer/media/lifecycle changes and concurrent claims
4. Source-bound child positive/negative matrix beyond the present 25 fps mono
   fixture, including video-only/stereo/30 fps, fractional and segment-boundary
   origins, A/V head/tail identity windows, bounded output and refused wrong origin
5. Ownership tests for preparation timeout, lost response, old Worker publication,
   active read drainage, parent slot handoff and unknown disposal. Tests must
   retain true process ownership rather than invent historical receipts
6. Actual configured Worker compatibility and independent review before any
   public enable decision. Browser/native-HLS presentation and physical platform
   acceptance remain distinct

The existing failed/unresolved F2 and failed HLS helper scopes are not recovery
targets for these tests. A successful new isolated test cannot discharge them.
