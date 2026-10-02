# Upstream profile response compatibility

This bounded correction follows the pinned-product artifact from
[run 36949379906](https://github.com/ysyhlly/RainSync/actions/runs/36949379906),
artifact `11203432113`, against source `464dc39`. All six original cases passed
metadata preflight and sent exactly one PlaybackInfo request, then received a
RainSync 502. No finite HLS decode was reached. The changes below are covered
by controlled tests; they are not a replacement for rerunning those products.

## Jellyfin 10.11.0

Only compact (32 hexadecimal characters) and standard hyphenated GUID spellings
of the same item are interchangeable. Matching still requires the configured
base directory, exact Videos/item/master.m3u8 route, origin policy, exact media
source and owned SID. No arbitrary hyphen removal, percent-decoding, alternate
route, URL rewrite or query completion is performed. Emby IDs retain their
existing exact comparison.

The pinned [DynamicHlsController](https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Controllers/DynamicHlsController.cs#L395-L400)
binds the master route's item to a GUID. Its subtitle-index parameter explicitly
describes omission as selecting no subtitle. The pinned
[EncodingHelper](https://github.com/jellyfin/jellyfin/blob/v10.11.0/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L6593-L6595)
looks up subtitles with `returnFirstIfNoIndex=false`; the lookup returns null
when no matching index was requested. Thus `SubtitleMethod=Encode` with no index
is an inert default. Index -1 is also a disabled selection. Nonnegative, empty,
malformed and duplicate indices remain rejected, including when the method is
missing or External. Other providers do not inherit Jellyfin's omission rule.

The product recorder retains literal `exact_item_master_path` as an observation
and separately checks `same_item_master_path` under the bounded GUID rule. It
records the returned URL fields without adding absent constraints.

## Emby 4.10.0.40 remains unsupported for these observed responses

The artifact lacks top-level `maxframerate` and `audiosamplerate`. It includes
the key `h264-maxframerate`, but its value was not recorded by the original
allowlist. The recorder now captures that value for the next run. This patch
does not claim that codec-scoped key is an enforced alias and does not accept
it in place of a verified bound. Source 10 fps / 48 kHz metadata is input
evidence, not proof of the encoder's output or an enforced requested limit.

The official [PlaybackInfo schema](https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html)
documents device-profile codec conditions, including VideoFramerate and
AudioSampleRate, which the existing request already supplies. It does not
document top-level PlaybackInfo fields for directly setting either constraint.
The response omission does not establish whether a condition was ignored,
represented elsewhere or optimized away for already-compatible source media.

Emby's [HLS API](https://dev.emby.media/doc/restapi/Http-Live-Streaming.html)
supports explicit stream query controls such as AudioSampleRate. Completing a
returned URL with RainSync-owned controls would be a different recipe/evidence
contract from validating unchanged provider-returned constraints. That option
needs a deliberate contract decision and pinned-product decoding tests before
implementation; it must never be reported as upstream-returned proof.

Next investigation should record all relevant returned namespaces and compare
a finite high-frame-rate/non-48-kHz input with the current compatible input.
Keep one owned negotiation per case and verify the corresponding output and
cleanup. Do not loosen admission simply because a compatible input happened to
decode within limits. The public marker continues to describe requested bounds,
not measured output; strict returned-route admission is an additional gate.

## Cleanup interpretation

The original rejected cases confirmed durable ownership closure and a matching
Stopped receipt. Jellyfin's `encoding_stop_confirmed=false` is expected because
the current lifecycle sends its Stopped request only; Emby additionally requires
the ActiveEncodings deletion receipt. These are API/ledger proofs, not measured
encoder-process termination. The rejected cases never fetched the output.
Product-container exit and host storage cleanup are separate fixture evidence.
