# YouTube ordinary VOD subprocess boundary

This provider is disabled unless the server administrator configures an existing
absolute trusted yt-dlp executable. Configuration is server deployment state,
never an import field. No runtime download, update, package installation or
bootstrap is implemented. Executable files must be regular, executable and not
group/world writable on POSIX; the administrator must additionally protect their
ownership, parent directories, packaged dependencies and updates. Windows is
currently unavailable pending an audited private working-directory ACL design.

## Actual isolation and limits

The boundary consists of a separate managed process group, fixed argument vector,
cleared environment, anonymous extractor configuration and a fresh atomic 0700
working/home/config/cache directory. It is **not an OS sandbox**. The process
retains the service account's OS filesystem permissions and network access.
Administrators needing filesystem or network confinement must deploy it in an
appropriately restricted OS/container boundary; this code makes no such claim.
The server's subsequent media fetch uses the fixed googlevideo provider policy,
all-public DNS checking and address pinning. Those controls do not confine
yt-dlp's own extraction network activity.

There is no shell, arbitrary argument extension, playlist import, browser-cookie
extraction, automatic account login, netrc opt-in, proxy inheritance, plugin directory, filesystem
cache, updater or remote-component download. PATH is empty; use a standalone
official executable or a trusted installation with an absolute interpreter
shebang, rather than an `/usr/bin/env python3` launcher. Python user site and
unsafe working-directory search are disabled. Only static anonymous request
headers are accepted from the returned selected format; none are forwarded as
user-provided media headers.

Two extraction supervisors are admitted per resolver; clones share the same
semaphore. The original deadline includes queueing and is capped at 30 seconds.
Stdout is bounded to 2 MiB. Stderr is concurrently drained, never retained or
interpreted, and terminates extraction after 32 KiB. A caller cancellation,
deadline, pipe error or overflow instructs termination and waits for actual
process-tree reaping. No successful descriptor is returned before the managed
tree owner has reaped the tree. Cleanup can outlast the extraction deadline if
the operating system cannot promptly reap a terminated process; no expiry,
timeout, released permit or missing PID is represented as a cleanup receipt.

The supervisor owns its concurrency permit and private directory through
reaping, including after the public waiter is dropped. Its checked completion
receipt is synchronously registered in the global media-core registry, and in
its caller's retained process Scope when one exists, before creating the process
under that inherited Scope. Global shutdown retains unscoped import capture and
disposal as well as process-group reaping. The global media-core registry also
owns the process group and ordinary Deno descendants. Graceful
service shutdown must drain that registry before shutting down the async
runtime. The existing separate owner-runtime configuration runs capture and
process owners when the application runtime stops. If the owner runtime itself
is destroyed, it cannot continue capture/reaping; failed or panicked owner
receipts do not prove successful disposal, and the application must not admit
new imports during shutdown. Descendants escaping their process group are outside this
mechanism's containment guarantee; the configured executables remain trusted.

After positive reaping, private directory disposal checks the original device
and inode, inspects at most 4096 entries and 16 directory levels without following
symlinks, then removes only that owned root. Deno cache/temp paths remain within
it. Disposal failures are sanitized errors, retained in the global ledger and any checked Scope receipts
even when a cancelled caller cannot receive the result. They prevent a successful
drain/ACK and quarantine the concurrency slot until the resolver is replaced;
the unresolved private directory is preserved. Drop is only a best-effort empty
directory fallback for early non-admitted work, never silent recursive cleanup.

## Optional official player-JS solver

Without a configured JavaScript runtime, `--no-js-runtimes` remains effective.
Only videos exposing compatible anonymous direct URLs without JS can work; this
is not advertised as general YouTube support. A separately configured absolute
trusted Deno path enables only `--js-runtimes deno:/absolute/path`. The normal
official yt-dlp player-JS solving path then runs in Deno under yt-dlp's documented
runtime restrictions, in the same managed process tree. `--no-remote-components`
stays effective, so the administrator must supply an official executable with
packaged EJS or preinstall the matching official yt-dlp-ejs dependency. Arbitrary
caller runtimes, scripts, plugins and arguments cannot be supplied.

No Deno runtime or actual YouTube extraction is executed by the offline fixture checks.
No PO-token bypass/provider, SABR extraction, DRM handling, live, upcoming,
post-live, paid, private or age-gated media flow is implemented.

## Explicit viewer session opt-in

Anonymous extraction remains the default. A server administrator may set
`RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES=1` alongside the trusted executable
configuration. Only absent/`0`/`1` are accepted; enabling this without a
configured extractor fails startup. This is a separate trust decision because
the executable has service-account filesystem/network access and is not an OS
sandbox. No configuration or real credential is created by the offline tests.

With that opt-in, each signed-in viewer can consent to importing their own
YouTube-only Netscape cookie file in their profile. Imports are limited to 32 KiB,
32 cookie lines, exact youtube.com/www.youtube.com scopes, HTTPS account fields,
and bounded values. Foreign service domains, duplicate account names, expired
retained fields and malformed files are rejected. Unrelated YouTube fields are
discarded. Google OAuth tokens, passwords, browser extraction and shared admin
cookies are unsupported. The minimum retained login shape is LOGIN_INFO plus
SAPISID, __Secure-1PAPISID or __Secure-3PAPISID, matching the maintained extractor;
SID alone is rejected to avoid accidentally selecting guest extraction. Legacy
Secure=false fields are upgraded to HTTPS-only in the reduced private file.
Imports only establish encrypted storage, never claim
an upstream login or video entitlement. The vault includes exact viewer,
provider, account ID and revision bindings; known cookie expiry is conservative
and replacement/unlink invalidates old source grants.

The authenticated path sends the frozen viewer session exactly once, with no
anonymous retry. It uses the same queue, original deadline, quality policy and
result validation as the anonymous path. It does not admit private, paid,
age-restricted or DRM results. Account rotation or service limits can still make
an imported session fail; renewal means explicitly importing a fresh session.

Before subprocess admission, the session is written with atomic create-new 0600
permissions inside that attempt's atomic 0700 working directory. Only the
server-owned file path enters `--cookies`; contents never enter argv or inherited
environment. `--no-cookies-from-browser`, cleared environment and fixed
arguments remain mandatory. The supervisor retains the file, directory and slot
until positive tree cleanup. It then truncates the retained original inode,
unlinks only the owned path and explicitly removes the bounded private directory.
Caller cancellation cannot release custody early. If tree cleanup fails, the
original cookie inode is still truncated while directory/slot quarantine and
failed owner receipt remain; no successful cleanup is claimed. Logical truncation
and unlink are not a guarantee of physical storage erasure. Replaced paths are
never truncated, and an unexpected replacement fails cleanup closed.

The official yt-dlp project warns that account use can cause temporary or
permanent bans and that YouTube rotates web cookies. The UI discloses that risk
before consent. yt-dlp's OAuth login is currently unsupported according to its
[maintained extractor guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).
Pure fixtures verify 0600 files, early-drop removal, inode replacement safety,
and success/failure/deadline/cancellation disposal using the workspace-built
Rust test executable only. They do not establish live YouTube account validity.

## Result contract and fail-closed validation

Only canonical 11-character video identities or bounded HTTPS watch, youtu.be
and shorts links are accepted. No credentials, ports, fragments, escaped IDs,
playlist keys or arbitrary redirects are followed. Fixed format selection first
asks for the best compatible video-only HTTPS AVC MP4 plus audio-only HTTPS
AAC-LC M4A. It retains the previously selected single compatible muxed MP4 as
yt-dlp's `/` fallback when the pair is unavailable at selection time. The fixed
`+` selector only exposes selected-format metadata: `--simulate` stays mandatory
and returns before download/FFmpeg merging. HLS/DASH manifest extraction is
skipped; there is no alternate-codec or manifest fallback. A malformed selected
pair fails closed, without searching the unselected `formats` list or
downgrading it to a top-level URL.

The server-only closed `SelectionMode` chooses the format string before
extraction. Imports default to `PreferAdaptive`; playback for devices whose
validated advertised capabilities support only progressive playback can use
`ProgressiveOnly`, which selects the original strict muxed selector directly.
No client-supplied selector or flag is accepted. The modes change only that
fixed argument; the same anonymous process restrictions, deadlines and cleanup
apply. A selected adaptive shape unexpectedly returned for ProgressiveOnly is
rejected rather than reinterpreted as a fallback. Capability selection is not a
retry after an invalid extractor response.

JSON output is untrusted. Only a closed typed field list is materialized.
Unknown info_dict fields, unselected formats, thumbnails and arbitrary metadata
are skipped, never copied to a general map or persisted. The returned ID and
Youtube extractor identity must match the request; a returned webpage URL must
identify the same video. Only public/unlisted `not_live` video results pass.
Progressive selection must prove `ext=mp4`, `protocol=https`,
`vcodec=avc1.<six hex digits>` and `acodec=mp4a.40.2`. Adaptive selection requires
exactly two typed `requested_formats` with complementary roles, distinct URLs,
video-only `ext=mp4`/AVC and audio-only `ext=m4a`/AAC-LC. Both tracks individually
require `protocol=https`; the synthetic top summary requires `ext=mp4`,
`protocol=https+https`, matching codecs and no top media URL. Null, missing-track,
extra-track and other malformed selected arrays cannot mean progressive mode.
Top VOD duration remains required, finite, positive and at most seven days.
Optional per-track duration is bounded and must match within two seconds; the
official extractor normally omits per-format duration. Adaptive video dimensions
are required in width 1..8192 and height 1..4320, FPS in (0,120], and total
bitrate in (0,80000] kbit/s.
Audio requires sample rate 8000..96000 Hz, 1..2 channels and bitrate in
(0,512] kbit/s. The selector uses this same downstream-compatible envelope,
so an incompatible larger representation does not crowd out an available
compatible one. Non-role dimensions/rates and contradictory top summary values
are rejected. Progressive metadata keeps its existing optional dimensions;
any reported FPS, rate, channels or bitrate is also bounded.

DRM/ambiguous DRM, fragments, manifests, nested requested formats, request
bodies, cookies and impersonation are rejected. The official direct-format
`downloader_options` object is accepted only as the exact inert
`http_chunk_size=10485760` hint, validated and discarded; extra options and
changed values are rejected and no option configures our transport. Returned
init/index range fields are rejected rather than trusted. Selected headers on
the root and each track must fit the same closed static anonymous whitelist.
Every chosen URL must satisfy the shared googlevideo HTTPS host policy, use
`/videoplayback`, contain no credentials or PO/SABR query keys, and have a unique
expiry 30 seconds to 24 hours in the future. Adaptive expiry is the earlier
track expiry; each track retains its individual expiry.

The result is a server-only `Playback` enum containing either one progressive
descriptor or exactly one typed video/audio pair. None implements Serialize;
all Debug output excludes URLs, title and identity. Public DTO construction
must select metadata explicitly; signed URLs stay in the server's authorized
playback descriptor. Import only validates metadata and does not request media
bytes. Adaptive playback separately requires the bounded MP4 byte probe to
discover and validate initialization/SIDX ranges; extractor metadata does not
supply those ranges and no synthetic range is invented. Errors use
fixed codes and never return stdout, stderr, command lines or signed addresses.
`sanitize_info` is JSON conversion, **not secret redaction**.

## Primary-source basis

Reviewed against official yt-dlp source at commit
`51bab8a0116f4d8004c315706d809782607d5847` (stable 2026.08.19 reference):

- [README options, runtimes, EJS, configuration and format selection](https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/README.md)
- [YoutubeDL sanitize_info and selected-format processing](https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/YoutubeDL.py)
- [YouTube video extractor, format protocols, DRM and manifest skip](https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/extractor/youtube/_video.py)
- [FormatSorter bitrate normalization and kbit/s units](https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/utils/_utils.py)
- [CLI option definitions](https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/options.py)

The code does not probe or enforce the configured executable's version. An
incompatible version fails with sanitized unavailable/extractor/response errors;
the administrator owns provenance and version compatibility. Unit fixtures use
only the workspace-built Rust test executable and synthetic local JSON. Their
results are not proof of real YouTube availability, login or production readiness.

## Ordinary playlist preview

The separate closed PL playlist mode is simulated, flat, lazy and capped at
21 metadata records (20 preview positions plus one truncation sentinel). It
admits only exact `/playlist?list=PL…` URLs and canonicalizes bare PL IDs before
spawn. Its extractor list is fixed to `youtube:tab,youtube:playlist`; child
video extractors, channels/feeds, unavailable-video reloads and channel redirects
are absent. Output requires matching playlist identity and explicitly public or
unlisted availability. Only canonical child video identities and sanitized
200-character titles leave normalization, never info dictionaries or headers.
This mode shares the VOD semaphore, deadline, output caps, process-tree supervisor
and request-private cookie custody. Caller-owned credentials require the same
administrator opt-in and are never retried anonymously. See
`docs/PLATFORM_COLLECTION_IMPORT.md` for the server and selection contract.
