# Capability/redirect composed checkpoint — 2026-10-02

This local checkpoint is code `4a008f2`, backend source digest `f31d5a259087b5af1675358c4aa52b495fcf327f5d79020c68660725fcc7816a`. It has not been published or deployed.

## Binding and results

Independent service/helper copies are in `tooling/partial-plan-capability-redirect-frozen/backend-binding.json`. The full path/hash index is `tooling/partial-plan-capability-redirect-validation-index.json`, SHA256 `c8cb3bf8872ba41fa36dc890c23e687a91f9946a2a5b452e4e361ce4f71d9bae`. All backend inputs, three services and12 helpers were remeasured after the runs; the verification is beside the binding. The compact Cargo target was serially owned and all backend inputs refreshed before the cross-worktree rebuild. Incremental/debug information settings remain recorded in the binding, with ordinary debug-assertion semantics unchanged.

| Check | Actual result |
| --- | --- |
| Workspace/all-target Rust |546 passed;19 ignored in the broad run, then the5 explicit FFmpeg groups executed successfully;14 old DB ignores remain |
| Strict Clippy, formatting, protocol export |Passed |
| Frontend/build |724 passed; production build passed |
| Node acceptance/deployment/recovery tooling |53 passed;1 optional native interruption fixture skipped because its target was not supplied |
| Actual final Server/Worker pair with old-reader rejection |9 passed, separate rerun using the final frozen binaries |
| Bound local/reliable-HTTP capability/output facts |12 groups passed |
| Redirected public candidate/grant/continuation/replay |4 groups passed |
| Guarded local probe/version |7 groups passed |
| Actual metrics receiver / Worker entry cohort / sender wire |33 /5 /5 groups passed |
| Exact-login Server/Worker API/delivery |7 groups passed |

The5 FFmpeg groups retain10 source/output records. They cover actual SDR HEVC headers, AVC3 encode-only, MKV/QuickTime AVC remux, SAR/rotation geometry, VFR-to-CFR, no-audio and audio-only output. The API groups additionally prove exact source-version/candidate/configuration persistence and replay. Capability estimates are not device presentation evidence.

## Supported contract and compatibility

See `CAPABILITY_ROUTE_FACTS.md` for the bounded local/HTTP matrix. New optional facts preserve old schema-v1 omissions. An actual MP4 major brand and AVC1 sample entry are required for AVC1 direct; AVC3 retains an eligible fixed encode route. Exact SDR HEVC direct requires current hvcC/probe agreement and the concrete positive file capability result. Unknown high-depth transfer/pixel facts do not silently acquire SDR conversion.

Controlled redirects apply only to opted-in media GET/HEAD. Every hop and manifest child independently passes origin/port/scheme/CIDR/DNS validation, credentials remain bound to configured origin, and final canonical URL identity includes its query without logging that query. A changed signed destination intentionally invalidates its frozen representation, even with matching ETag. API/POST redirects, independent CDN credentials and rotating destination identity are not generalized by this slice.

`controlled-media-redirects-v1` is a separate exact Server/Worker reader contract. Passing login policy B is not enough. Known redirect use or inability to prove its absence requires both readers before supported startup/rollback. Release packaging uses the same image for Server/Worker and only establishes its co-delivered pair. The fresh owned local/NAS preview exemption never applies to an arbitrary existing database.

## Evidence boundaries

Independent static reviewers found no remaining blocker in final capability/redirect sources or the coordinator's paired gate. Those read-only reviews are not execution results. The newly added gate has actual native pair tests, but Docker/arm64 and a post-redirect cutover rehearsal were not run. Prior final42 recovery evidence remains tied to that earlier pair.

No browser/device decode, independent real dual-client run, packet-level impairment,72-hour soak, real TLS/CDN acceptance or new fixed Jellyfin/Emby product matrix was run. The denied Agent receipt task remains excluded. The original19-unit ledger remains partial, with generic HLS/upstream fallback, generic timeline mapping and concrete acceptance adapters still open.
