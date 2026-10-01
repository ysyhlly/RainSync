# Additive playback plan facts

This contract is an implementation boundary for the next provider-facts slice.
The initial shared checkpoint adds types and compatibility defaults only; it does
not advertise new facts before the provider/receiver wiring is implemented.

`PlaybackPlan` gains optional fields. Missing values preserve legacy serialized
responses and mean that the corresponding fact is unavailable:

- `subtitle_mode`: `none` or `external_vtt`, describing the plan's available
  delivery pipeline. This does not claim the viewer selected a subtitle.
- `seekable_media_ranges_ms`: `{start_ms,end_ms}[]` in original-media coordinates,
  with inclusive start and exclusive end. Missing means unknown; `[]` means a
  known empty published prefix. Values must be finite, nonnegative and nonempty.
  HTTP/upstream duration alone does not establish reachable media intervals.
- `pending_job_id`: only an actual authorized local job while queued/running.
  Provider-side jobs do not acquire a made-up local identifier.
- `decoder_fallback_modes`: next request modes `remux` or `transcode` justified
  by existing probe/negotiation facts and transport support. Unknown or no
  justified remaining mode produces an empty list. These are hints, not access
  authorization or guaranteed device decoding.

`PlaybackReadiness` gains the same optional ranges and pending-job fields. Its
existing `available_until_ms` remains relative to the plan's timeline origin;
the new ranges use original-media coordinates. Existing published-output proof
determines advancing ranges. No predicted encoding duration becomes visibility.

New plans use factual source-aware `decision_reason` values. Selected audio is
reported only when justified by an explicit validated request, the actual local
mapping, or a valid unambiguous upstream default. Unknown direct-file/upstream
audio selection remains absent; array order is not sufficient evidence.

Provider facts reuse existing encrypted plan/resource JSON. No migration is
needed. A replay helper must check the owned current grant, source/account
policy, membership, lifecycle, plan high-water and current job attempt before
refreshing facts. It must not return another user's job identifier or retrofit
unproven facts into a legacy encrypted response.

Frontend fallback consumption follows later through the current runtime owner.
Only actual decoder failures may use a hint. Keep original logical meter/start
time, room time and audio preference; advance plan generation, try each route
once and preserve the three-route ceiling. Network, authorization and ordinary
timeouts never trigger additional transcoding. Every new preparation still
passes the existing source/account/HTTP identity gates and owns its cleanup.

This slice does not claim exact all-provider candidate negotiation, HLS
discontinuity mapping, first-frame presentation acceptance or device support.

## HTTP cross-plan representation boundary

The existing HTTP identity contract pins resources within a playback grant.
A fallback hint derived from that grant does not prove that a new grant will see
identical content. Automatic same-content HTTP fallback therefore requires a
separate bounded authenticated expected-representation binding, including any
already-observed HLS child identities, or an explicit visible fresh intent/source
refresh. Telemetry meter identity never provides this authority. That binding is
concrete follow-on work in provider fallback; fact/hint delivery alone does not
complete all-provider automatic recovery. Fresh explicit preparations may bind
changed content by design.
