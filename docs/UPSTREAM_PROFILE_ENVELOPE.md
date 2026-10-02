# Explicit upstream transcode profile envelope

Published on `integration/v0.1-next`. The latest bounded product evidence at
`e27051d5b47eba827ed885efb79469665ab7d0fd` passes Jellyfin's three cases but fails
all three Emby cases at actual audio output: 44.1 kHz instead of requested 48 kHz.
The request reaches Emby unchanged; its owned encoder command explicitly selects
44.1 kHz. The current exact-48 kHz Emby recipe is not product-validated. The discrete-rate contract below was approved for implementation; pinned-product
acceptance of the new contract is still required.
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
and actual generated output must be verified against each fixed product before
its profile support is declared implemented. The current per-product evidence
is recorded below.

## Controlled evidence and historical failed product check

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
Seven dependency-free ownership/refusal tests and syntax checks passed locally.
The later `8897d2` product/diagnostic run verified Docker volume cleanup and host
fixture-data removal. No permission widening or privileged host cleanup is used.

The next possible implementation work is the concrete Emby sample-rate request
failure, subject to the selected scope and validation. Existing raw upstream policy
failures remain separate from RainSync enforcement and this profile feature. No
new device, sustained-load or production acceptance is claimed.

## Explicit diagnostic execution

The raw-product diagnostic remains separate from RainSync acceptance and never
relaxes production route validation. Prefer `workflow_dispatch` with
`run_emby_profile_diagnostic: true` when that action is available.

When the workflow is not on the default branch, the same bounded diagnostic can
be requested once by including `[run-emby-profile-diagnostic]` in the pushed head
commit message on `integration/v0.1-next`. The push must target exactly that
branch; ordinary unmarked pushes and pull-request events do not opt in. Only the
head commit message is checked, so a marker in an earlier commit does not enable
later pushes. Re-running that explicitly opted-in workflow run can repeat the
diagnostic; this is an event opt-in, not a persistent setting. The existing
fixed-product acceptance still runs and retains its own failure result.

## Verified product and finite diagnostic checkpoint: 8897d2

The [exact-head upstream run](https://github.com/ysyhlly/RainSync/actions/runs/36957757296)
and [sanitized artifact 11206840800](https://github.com/ysyhlly/RainSync/actions/runs/36957757296/artifacts/11206840800)
establish separate results:

- Jellyfin 10.11.0 passed all three RainSync profile cases: H.264 from zero,
  HEVC seek with default audio, and HEVC seek with alternate audio. The finite
  Worker-delivered output checks and each case's cleanup passed.
- Emby 4.10.0.40 returned HTTP 502 from RainSync preparation in all three profile
  cases. Strict admission still rejected incomplete profile route evidence;
  these failures were not converted to acceptance successes.
- The separate raw Emby diagnostic used the unchanged returned route and its
  original SID on synthetic 60 fps / 44.1 kHz input. Three segments, totaling
  562,496 bytes, produced finite H.264 Main video at 30 fps and AAC-LC audio at
  44.1 kHz. The finite audio/video decode completed. Requested 48 kHz was not
  observed; changing only the browser capability estimate would hide this fact.
- The original route contained `h264-maxframerate=30`; generic `maxframerate`,
  `framerate`, and `audiosamplerate` were absent. The diagnostic did not add them.
- Exact-SID Playing/Stopped and ActiveEncodings cleanup both returned 204.
  Container, network, owned volumes and host fixture data were removed; source,
  binary and tool/sample integrity checks passed.

Earlier diagnostic attempts at `88388d6` and `f01ce8a` failed in the harness
before media reads. Their JSON redaction/cause retention and origin-root route
handling were repaired before the successful finite diagnostic above. They
provide no output-decoding evidence.

Separately, the core implementation checkpoint `326e744` passed its complete
[checks workflow](https://github.com/ysyhlly/RainSync/actions/runs/36954508736).
That result belongs to that exact head. It does not change the separate upstream
workflow's failures or mark all later candidate workflows, platforms or release
acceptance passed.

## Parameter research for a possible next step

The official [HLS guide](https://dev.emby.media/doc/restapi/Http-Live-Streaming.html)
and [master playlist API reference](https://dev.emby.media/reference/RestAPI/DynamicHlsService/getVideosByIdMasterM3u8.html)
document `AudioSampleRate` as an explicit requested output rate. The public
master/main references inspected on 2026-10-02 did not list generic `MaxFramerate`
or `Framerate`; their absence is not evidence that those fields are unsupported,
but neither is it proof of support on the pinned 4.10.0.40 image. The observed
namespaced `h264-maxframerate=30` and finite 30 fps output are product evidence,
not a general API guarantee. Any new generic frame-rate parameter should first
be checked against that fixed product's own API schema or an explicit bounded
product test.

The successful raw diagnostic above did not alter the route. The authorized local
request-completion candidate below subsequently failed pinned-product output checks, as recorded below. Requested parameters, provider-returned
fields and actual finite output must remain distinguishable in evidence.

### Authorized narrow request repair, historical implementation

The published request-completion implementation preserves the provider-returned `h264-maxframerate=30` and
adds only the documented `AudioSampleRate=48000` when absent, to the already
owned master request for the same SID. This path was approved on 2026-10-02. Do not introduce an undocumented generic
frame-rate field, a second PlaybackInfo call, an automatic new-SID fallback or a
relaxed browser capability estimate.

The mutation is server-owned and narrowly allowlisted. Original route
identity/authorization, copy flags, audio selection and all other constraints
must be checked before it; duplicates, conflicting rate fields, changed source,
item, device, SID or origin must fail closed with the existing cleanup obligation.
Evidence must distinguish provider-returned fields from explicitly requested
parameters instead of treating the inserted field as a provider echo.

Before enabling such a repair, the pinned product must prove finite 30 fps / 48 kHz
output on synthetic 60 fps / 44.1 kHz input through the actual RainSync Worker
path, including seek and alternate audio. Negative cases must retain one owned
SID, no stale/cancelled fetch, bounded reads and exact-SID cleanup. A successful
finite window would still not establish whole-title or physical-device behavior.


The encrypted playback resource now records `upstream_profile_route_provenance`
with schema version 1, semantics `requested_configuration_not_measured_output`,
the returned frame-rate field name, and separate `provider_audio_sample_rate`
and `server_requested_audio_sample_rate` values. Only the absent-rate Emby path
sets the latter to 48000. Its public plan reason is
`emby_server_requested_audio_sample_rate_48000`; the profile envelope continues
to describe requested bounds, not measured output.

Completion runs after the original SID response is durably checkpointed and all
original route/selection/configuration and device checks pass. It preserves the
original query bytes while appending the fixed sample-rate field; final URL
length and query-count bounds are rechecked. Video-only media gains no audio
parameter. Duplicate, contradictory, unknown sample-rate aliases, conflicting
frame-rate aliases and selected subtitles remain rejected.

Completed-key replay recomputes the final route and provenance from the original
encrypted checkpoint, without networking or allocating a new SID, and compares
these to the stored grant and plan reason after the existing authority fences.
Older echoed-rate grants may lack the new provenance field; an absent-rate
completed grant may not.


### Local candidate validation, 2026-10-02

The frozen candidate passed 111/111 actual isolated Server/PostgreSQL scenarios
against controlled Jellyfin/Emby HTTP contracts. Coverage includes missing-rate
completion, already-echoed 48 kHz, namespaced/generic frame-rate alternatives,
duplicate/conflicting fields, wrong identity and selection, copy/subtitle guards,
lost responses, cancellation, late SID cleanup, authorization/expiry fences and
seven tampered replay proofs. All 96 allocated controlled SIDs received exactly
one Stop; every Emby SID received exactly one encoding Stop. Server/PostgreSQL
processes exited, all owned ports closed, and source/binary hashes stayed fixed.
The report's SHA-256 is
`ecda19aaddd8f9c5dd330de299d34a153646cccd7e17dd1c29010b03f2b67227`.

Provider unit tests (36), Server unit tests (81 plus 17 presence tests, with two
pre-existing isolated-database tests explicitly ignored), 583 frontend tests,
31 dependency-free Node tests, strict Clippy, type checking and the frontend
build passed locally. The pinned-product suite now uses synthetic 60 fps / 44.1
kHz input for both H.264 and HEVC and all audio tracks. It checks the untouched
PlaybackInfo checkpoint, the separately completed encrypted resource and actual
Worker request, one SID, seek/alternate audio and finite decoded 30 fps / 48 kHz
output. Docker is unavailable in this workspace, so that new product-output
matrix cannot run locally. CI subsequently produced the failed Emby output and encoder evidence below.


## Exact request-chain and encoder evidence, 2026-10-02

The request-completion implementation at `6cf8202` reached actual Worker media
in all three Emby cases, but finite output remained 30 fps / 44.1 kHz. Jellyfin
passed all three cases. Later diagnostics preserved the same production behavior:

- At `c14a0cd`, [request-chain artifacts](https://github.com/ysyhlly/RainSync/actions/runs/36963703096/artifacts/11208634441)
  show `AudioSampleRate=48000` in the master request, original returned variant
  reference and exact Worker variant GET. SID/source/device checks match. The
  generated media references omit rate/codec fields; actual Worker media GETs
  match those references unchanged. Omission alone does not establish causation.
- At `e27051d`, [owned encoder artifacts](https://github.com/ysyhlly/RainSync/actions/runs/36964767899/artifacts/11208109807)
  contain one new sanitized ffmpeg log per Emby case, with exact owned SID and
  device text matches. Each single-input invocation has output
  `-c:a:0 aac -ar:a:0 44100` and `-f segment`. Default audio maps `0:1`; alternate
  audio maps `0:2`. No resampling filter was observed in these command lines.
  Other partial command-like lines remain unknown; audio summary lines without
  parsed input/output context are not promoted to output evidence.
- Finite Worker probes independently report 44.1 kHz in all three Emby cases.
  Every owned reservation closes, Emby Stop and encoding Stop succeed, fixture
  data is removed and source/binary integrity checks pass. These are finite
  synthetic windows, not whole-title or physical-device proof.

This establishes that the explicit 48 kHz request reached the pinned Emby
4.10.0.40 variant handler while its encoder selected 44.1 kHz. It does not
establish general ceiling semantics, an undocumented override, or a reason to
rewrite opaque segment URLs. The exact-48 kHz product assertion remains failing.
The full checks workflow is tracked independently; product diagnostics do not
constitute a full-CI success.

## Approved implementation: discrete Emby audio rates

The user approved this bounded contract change on 2026-10-02. Publication remains
subject to final review and the coordinated batch decision. It uses a distinct Emby profile ID and
contract version advertising the canonical allowed output rates `[44100,48000]`,
while keeping any requested 48000 parameter explicitly separate from those
allowed rates and from measured output. Jellyfin retains its current 48 kHz
contract and existing v1 client compatibility.

Source admission requires a known selected-audio sample rate in that set;
other or missing rates fail closed. Existing codec/channel guards remain intact.
Any extra input-codec/channel restriction would require an explicit tradeoff,
not be silently inferred from the mono AAC fixture. Silent media keeps no audio
rate set. No generic ceiling rule or automatic fallback is introduced.

The browser must probe both advertised audio configurations at 44.1 and 48 kHz,
with positive path-specific MSE and decoding support for each. A canonical,
versioned per-rate report rejects missing, duplicate, extra, unknown or negative
results. A single favorable sample cannot admit the broader set. The encrypted
binding captures that complete envelope, source/selected-audio metadata, rate
set and profile version; final preparation and completed-key replay compare all
of them under existing authority/lifecycle fences. Old Emby v1 evidence must
never silently become a v2 report or revive an incompatible grant.

The implementation touches the dedicated protocol DTO/generated
schemas, provider profile construction/validation, Server binding/replay and
`packages/player-core/upstream-profile.ts`, plus controlled and pinned tests.
It does not alter auto mode, allocate an extra SID or use a local transcoder.
UI/evidence wording must say supported discrete rates and requested configuration,
not promise exact 48 kHz or imply an upstream echo that never occurred.

Before a support claim, pinned Emby tests must add known 48 kHz sources and keep
44.1 kHz stress, zero/seek/alternate-track cases; include stereo and non-AAC
inputs to validate the retained codec/channel envelope. Every measured output
must be inside the declared set and meet unchanged video/channel/bitrate bounds.
Negative controlled cases include unknown/unsupported source rates, partial or
forged per-rate browser reports, stale version/binding, changed audio selection,
route/provenance tampering, cancellation and one-SID cleanup. Current 44.1 kHz
observations alone do not prove the 48 kHz branch of that future contract.


The wire discriminator is `profile_version:2` with
`profile_id:"emby_avc_sdr_720p_rates_v2"`. For selected audio,
`audio_rate_contract` contains the canonical allowed rates, the selected source
sample rate and two advisory MSE audio configurations. The existing requested
48000 field is not a fixed-output promise. `audio_rate_reports` contains exactly
two positive reports in canonical order; silent v2 uses an explicit empty list
and has no audio contract. Jellyfin v1 omits these new fields entirely.

Discovery request version 2 declares the client's maximum supported contract;
the returned envelope/outer version is 1 for Jellyfin or 2 for Emby. An old
version-1 request cannot obtain an Emby v2 profile by silent reinterpretation.
The sealed Emby binding stores the complete envelope as well as selected source
metadata. V2 route provenance also records the allowed rate set and source rate,
separately from returned and server-requested rate parameters. Every replay
reconstructs and compares the exact contract and provenance without networking.


### V2 local validation before publication

The final frozen native Server/PostgreSQL matrix passed 116/116 scenarios with
102 controlled SIDs. Every SID received exactly one Stop; all Emby encoding
Stops were confirmed, no active/undrained work remained, all owned processes and
ports closed, and backend source/binary hashes stayed unchanged. Report SHA-256:
`c38b2bc07147fdf43e86b2d066119918f0257d3e8fe8056e1201a702b2ae9eb5`.

Coverage includes both known source rates, audio index zero distinct from the
video index, silent v2's exact empty report, all advertised browser-rate proofs,
unknown/other source rates, and unchanged-reseal positive controls before
independent binding and persisted resource/plan/checkpoint mutations. Fresh-key
admission failures, same-key idempotency conflicts and deeper persisted replay
failures are recorded separately; a changed same-key payload is not proof of a
replay-contract check. Earlier failed fixture runs are retained: they exposed
reused viewer generations and synthetic JSON float normalization, not a product
pass. Those fixture corrections did not change the frozen backend.

All 664 frontend tests, type checking and the production frontend build passed;
45 dependency-free Node tests and syntax checks passed. The new source-generation
smoke created/probed 48 kHz stereo AAC and 44.1/48 kHz stereo AC3 inputs. The pinned
product matrix has six cases per provider: the original zero/seek/alternate
cases plus those three additional sources. Emby finite output must belong to
exactly `{44100,48000}`; Jellyfin still requires 48000. This expanded real
Server/Worker/pinned-product matrix awaits Docker CI and is not claimed passed.
