# Fixed product validation: open compatibility gates

The isolated 2026-09-30 run on checkpoint `3e8df53` exercised the exact official
Jellyfin 10.11.0 and Emby 4.10.0.40 image digests declared by the fixture.
[Run and preserved reports](https://github.com/ysyhlly/RainSync/actions/runs/36746877870)
are genuine product evidence, separate from RainSync's controlled adapter tests.

Both products passed authenticated browsing, direct H264 negotiation/output
decode, and two devices on one account where stopping A preserved B's decoded
playback and progress. Both failed the first HLS seek/audio case when decoding
one extracted TS segment, and both returned HTTP 200 for an already negotiated
static media URL after `EnableMediaPlayback` became false. The administrator
policy readback was verified before accessing media. Six of ten cases passed;
four failed. All captured SIDs were stopped and owned containers/networks removed.

The HLS harness now retains probe and bounded segment-window diagnostics and
decodes up to three adjacent segments from the returned timeline. Requested
10/27/43-second source pixels (600 ms tolerance) and selected 440/880 Hz audio
(30 Hz tolerance) remain required; no failed seek position is skipped. This
correction is not declared passed until its new fixed-product run finishes.

The media-policy failure must remain visible. Jellyfin's fixed-version
[Static video route](https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Controllers/VideosController.cs#L434-L482)
returns file content through a path that does not call
[BaseItem.GetPlayAccess](https://github.com/jellyfin/jellyfin/blob/v10.11.0/MediaBrowser.Controller/Entities/BaseItem.cs#L1054-L1067),
where `EnableMediaPlayback` is checked. Its
[stream-state lookup](https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Helpers/StreamingHelpers.cs#L86-L130)
uses the authenticated user, while
[media-info route selection](https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Helpers/MediaInfoHelper.cs#L213-L295)
checks compatibility and transcode permissions. This source review supports the
observed separation between this policy flag and static media delivery; it is
not a claim about all releases or routes. Emby's observed 200 is recorded without
inferring undocumented implementation semantics.

The follow-on evidence retains the immediate denial assertion and also samples
the same token/device/media at 1 and 3 seconds, canceling each response body.
It measures the unrelated account's actual decoded media even when the first
account's denial fails. Account disablement, logout or an altered credential
would test a different revocation and are not substituted to turn this green.

RainSync's source-policy revision revocation has separate real local admission
and active-stream evidence. It must not be equated with immediate discovery of
an upstream account-policy change. No production service, user media or account
was used. Browser playback, single-login behavior and sustained resource gates
remain separate requirements.

## Explicit audio source binding

The follow-on real run confirmed that `MediaSourceId` is required alongside an
explicit audio index. Jellyfin applies the index only when that identity matches
in [MediaInfoHelper](https://github.com/jellyfin/jellyfin/blob/877251bcaec3780d44b7657c54684dc28646b1c3/Jellyfin.Api/Helpers/MediaInfoHelper.cs#L206-L211).
Both pinned products selected index 2 after the actual source ID was supplied;
the 27-second decoded-output case remained failed at that checkpoint, so this is
not yet full audio/seek acceptance.

RainSync now discovers explicit audio's source through the authenticated
single-item GET, bounded to ten seconds and two MiB, while its reservation is
still `reserved`. The existing request/lifecycle/membership/policy admission gate
runs after discovery and before the sole PlaybackInfo POST. Failed or cancelled
discovery can retain a positive `not_sent` result; it must not invent an unknown
allocated SID. A complete POST response and SID are checkpointed before checking
the returned source ID and selected audio index, so a mismatch still has an
owned Stop obligation. Errors returned to the API do not include upstream URLs
or credential headers.

This first contract requires exactly one upstream media source for explicit
audio selection. Multiple versions are rejected with `UPSTREAM_PLAYBACK_FAILED`
until the public playback request can carry a selected source identity. The
implementation never guesses an ID from the item or arbitrarily selects one of
several versions. Ordinary default-audio playback does not add this GET.

The output harness gives codec discovery explicit finite limits: eight MiB,
60 seconds of fixture media timestamps and 32,768 packets, while each subprocess
still has its original 15-second wall deadline. This addresses the observed
declared H264 stream with unknown dimensions after default probing; actual
pixel/audio success remains required. FFmpeg documents the separate
[probe-size and analysis-duration controls](https://ffmpeg.org/ffmpeg-formats.html#Format-Options).
