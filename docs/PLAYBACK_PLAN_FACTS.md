# Provider plan facts and bounded route hints

New preparations record `plan_facts_version=1` inside the existing encrypted
session resource. No migration or extra upstream negotiation is involved.
Legacy encrypted resources and responses retain absent optional facts; replay
does not invent facts that the original preparation never recorded.

## Reasons and audio

`decision_reason` identifies the source, actual returned mode and evidence:

- Exact local/Agent candidates retain `actual_media_<candidate_id>`.
- Jellyfin/Emby return `<provider>_negotiated_<actual_mode>` from their existing
  PlaybackInfo response, not from library metadata.
- Legacy local/HTTP/Agent routes return
  `<source>_<automatic|requested>_<actual_mode>_<evidence>`. Evidence is
  `authorized_probe`, `source_version_matched_metadata`, or
  `legacy_transport_policy`. The last value explicitly conveys the absence of
  current codec proof; it does not claim exact device decoding.

The actual mode may differ from the requested mode. For example, a requested
`remux` at a nonzero position returns `transcode` so the generated output honors
the plan's original-media origin. Its facts describe `transcode` and do not
offer a repeated transcode hint.

Upstream `selected_audio_track` requires one current negotiated MediaSource, a
valid source ID, and a nonnegative `DefaultAudioStreamIndex` identifying exactly
one current Audio stream. An explicit request must match this result; the
existing upstream preparation also discovers an unambiguous source and verifies
the requested source/default before publication. Unknown, invalid, duplicate or
multi-version selection is omitted rather than guessed from array order.
Static direct playback with multiple audio streams also leaves selection unknown,
even with a valid metadata default, because those original bytes do not enforce
which track the native media element selected. A negotiated HLS pipeline can
report its valid default/explicit mapped selection; this is a pipeline fact,
not an observation of decoded audio.

Local generated HLS maps the validated absolute stream index or `0:a:0?`.
Version-matched probe metadata can therefore describe that mapping. Direct
multi-audio files leave the selection unknown because the media element chooses
its track. An unprobed HTTP direct request does not reuse an earlier probe as
current evidence. Invalid/overflow stream indices are not converted to index 0.

`subtitle_mode` is `external_vtt` when the plan offers its existing authorized
VTT delivery pipeline; otherwise it is `none`. This describes availability,
not which subtitle the viewer selected.

## Dynamic job and range facts

Initial publication, readiness and idempotent replay use one authorized
current-attempt snapshot. It checks the user, room membership, active lifecycle
and epoch, source/account policy, current media generation, unexpired session
using `clock_timestamp()`, and per-viewer plan high-water. Queue admission fixes
`job.id=session.id`; both that identity and the encrypted resource's job ID
must match. Extra or foreign jobs cannot supply a pending ID or range.

`pending_job_id` names an actual local job only while queued/running. Provider
transcoding has no invented local job ID. Completed jobs clear the pending ID
through readiness and replay.

`seekable_media_ranges_ms` uses original-media coordinates, with inclusive start
and exclusive end. Missing means unknown. A new queued, unstarted job has a
known empty prefix `[]`. A current owned running attempt with a live lease and
valid output record has `[]` before publication; its incrementally committed
`visible_manifest` grows while the output still has status `writing`.

Positive ranges require current output ownership, validation version >=2, a
matching committed manifest SHA-256, an exact positive EXTINF/ready-segment
count and finite bounds. They are `[timeline_origin_ms, timeline_origin_ms +
published_duration_ms)`. Completed output must be `published`; running output
must be `writing` with a live lease. Expired/unowned, abandoned, malformed,
legacy or missing unexpected output evidence stays unknown. Failed range
construction or arithmetic overflow also stays unknown. Old attempts never
supply the current range.

For fresh resources, invalid live output proof also returns
`available_until_ms=null` and `status=preparing`; a known valid unpublished prefix
returns `0` and `[]`. Legacy resources deliberately retain their older readiness
behavior. The existing `available_until_ms` remains relative to the origin. Neither it
nor the new interval means that the browser downloaded or decoded the prefix.
The new interval does not predict the final duration. HTTP and upstream
duration alone never create a range; direct-file ranges are left unknown here.
Generic HLS discontinuity mapping remains a separate contract.

## Decoder fallback hints

Fresh plans return a bounded `decoder_fallback_modes` list. Unknown or no
justified next route returns `[]`; missing preserves legacy compatibility.
These are request-mode hints, not authorization or guaranteed device decoding.

- Local/Agent require existing version-matched metadata; HTTP requires this
  preparation's existing authorized probe.
- All local generation hints require supported HLS transport and known
  non-HDR video under the existing compatibility policy.
- A direct AVC 8-bit route at zero origin with no required video transform can
  hint `remux`, followed by `transcode`. Other eligible routes hint only
  `transcode`. A returned transcode route has no repeated transcode hint.
- Upstream direct play requires one unambiguous negotiated source, known audio
  selection or no audio, `SupportsTranscoding=true`, a valid existing
  `TranscodingUrl`, and supported HLS before hinting `transcode`.
- Exact `selected_candidate_id`/`candidate_report` recovery retains precedence.
  Its `decoder_fallback_modes=[]` disables only legacy hints and does not disable
  the existing bound candidate mechanism.

Every future prepare still rechecks source/account/HTTP identity, room and plan
authorization and owns its cleanup. No additional PlaybackInfo call, play SID
or probe is made to populate a hint. This does not complete exact all-provider
candidate negotiation or frontend fallback consumption.

HTTP hints describe the current probe's codec/route evidence. They do not bind
the next separately signed grant to identical HTTP content. Automatic HTTP
fallback across plans remains pending a bounded authenticated expected-
representation binding, or an explicit visible fresh intent/source refresh.
Telemetry meter identity must not be used as content/access authority.

## Verification

`tests/playback-plan-facts.mjs` requires a successful unchanged-source binding
from `scripts/bind-native-backend.mjs` through
`RAINSYNC_PLAN_FACTS_BINDING_FILE` (or `W03_BACKEND_BINDING` in CI). It verifies
source, binary and coordinator hashes and never builds its own binaries.

The regression uses public source scans, room commands and playback APIs on
owned native PostgreSQL/Server/Worker processes. A generated local clip and
the same bytes through a controlled ranged HTTP source exercise actual probes
and FFmpeg's queued/incremental/completed output. Controlled Jellyfin and Emby
peers verify defaults, explicit audio, unknown/multi-version handling and no
extra negotiation on replay. Clearly labeled owned SQL/encrypted compatibility
injections verify foreign job/user isolation, lease expiry, current attempt,
malformed manifest and absent legacy facts. Cleanup verifies owned process,
listener and database shutdown. This evidence is not product, device, browser
decode, long-run or production acceptance.
