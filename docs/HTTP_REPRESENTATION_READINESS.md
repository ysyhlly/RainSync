# HTTP representation consistency and Worker readiness

This checkpoint implements the generic HTTP playback slice of W04 and cached Worker readiness. It does not close all HLS/provider compatibility or long/device acceptance gates.

## Generic HTTP playback

Migration 0034 records representation evidence per playback session and canonical target digest. A grant pins a strong ETag and total length, or a Last-Modified value demonstrably strong against the origin Date (at least 60 seconds apart). The Worker sends its own conditional requests; client conditional headers cannot choose another representation. HEAD observations cannot erase an existing pin. Range, Content-Range, total length and actual body length are checked before/as bytes are handed over. A response that ignores a required Range fails with SOURCE_SEEK_UNSUPPORTED instead of returning a fake 206.

The durable identity survives Worker restart and the same session's provisional probe to final playback publication. Both Worker observations and Server final publication take the same short transaction fence; no upstream network call runs while that fence is held. A changed validator or total length stops the grant and retains a changed tombstone before releasing replacement bytes. New readiness, renewal and idempotent replay fail for that stopped grant. Existing active streams also remain under the independent authorization watchdog. Cleanup obligations are not deleted by invalidation.

Weak or absent validators cannot prove cross-request identity. They permit one whole, non-seeking GET per target and session. Automatic probing, seeking, transcoding and subsequent body reads require reliable version evidence and return SOURCE_VERSION_REQUIRED when it is absent. Repeated HLS playlist loads therefore also need a reliable version; changing live playlists are not supported by this immutable representation contract. HEAD alone does not consume that one-shot fallback. A fresh plan can recover after an intentional source replacement.

Evidence is capped at 20,000 targets per grant. Retention removes at most 1,000 rows per minute only after the grant is stopped and has been expired for 48 hours, with no undrained preparation. A conforming origin's HTTP validator is metadata evidence, not a cryptographic proof against an origin that deliberately lies while reusing its validator.

This applies to resource kind `http`. Jellyfin/Emby keep their provider-specific delivery contract. Dedicated thumbnail preview remains attempt-local. Existing current source/CIDR, credential-origin and upstream account policy checks still apply independently.

## Worker readiness

`GET /ready` returns cached normalized checks and HTTP 200 only when every required observation is valid; otherwise it returns HTTP 503. Responses use `Cache-Control: no-store`. The request itself performs no database, disk or child-process probe.

Checks reflect actual database responsiveness, writable/readable cache and capacity, FFmpeg/ffprobe availability, real task claim/lease observations, running preview/cleaner owners, accepting-work state and physical drain failures. There is no fictitious Worker singleton lock. A successful idle claim is distinct from a claimed task requiring confirmed ownership. Lease renewal timeout or cancellation immediately marks ownership failed while retaining the last confirmed cutoff; a late response cannot revive an expired task. A drain failure remains failed until restart/recovery and does not fabricate a receipt.

Database/cache evidence expires after six seconds; tool and claim evidence after fifteen seconds. The database probe has a one-second outer bound and a 750ms statement limit, using an owned connection that closes on cancellation. Each tool probe has a two-second limit and a scoped process tree that is killed and reaped. The cache probe creates, writes, syncs, reads and removes a unique owned file; scans are bounded to one second, 100,000 entries and depth 64, with no eviction and no overlapping replacement scan after timeout. Capacity requires more than 10% filesystem free space and use below configured CACHE_MAX_BYTES. A kernel-blocked filesystem operation can outlive a timeout: its owner is retained and readiness fails; shutdown waits for actual disposal rather than claiming release.

Background-task flags establish that the owners are alive, not that every external operation is making progress. Readiness does not prove any particular hardware encoder, NAS filesystem or device compatibility.

## Focused verification

The final candidate is checked with strict workspace Clippy, affected Rust tests and protocol export consistency. Focused tests cover real PostgreSQL/HTTP metadata and first-request races; public source registration, auto preparation, partial bytes, replacement and fresh-plan recovery; actual Worker HTTP fault injection and process reaping; and an active child's stalled renewal through the real supervision timeout. The database recovery fixture explicitly tracks migrations 1–34 and compares restored SQLx checksums individually. These are bounded functional regressions, not sustained-load, real-device, production-old-database or release acceptance.

Concrete executed outcomes are recorded in PROGRESS.md after the candidate's tests finish. Remote CI is tied to each published commit, separately from local evidence.
