# Catalog, NAS presence, and compute upload limits

## Jellyfin and Emby catalog scans

Catalog scans accept at most 200 items per page, 2 MiB of response JSON per page,
20,000 items, and 32 MiB of cumulative response JSON. The whole upstream scan has
a 120-second deadline; individual HTTP requests also retain their 30-second
bound. Advertised lengths and streamed bytes are checked before JSON parsing.
Duplicate JSON fields, duplicate item identities, changed totals, and incomplete
pagination reject the scan.

A rejected or capped scan never returns a partial catalog for publication. The
previous complete index remains available and unseen items are not tombstoned.
Catalogs above these limits require a future checkpointed scanning path; raising
HTTP page sizes does not bypass the limits.

## NAS online status

The NAS sends a heartbeat every five seconds. An authenticated control socket is
expired after 30 seconds without a received heartbeat or recognized control
message (or WebSocket Ping/Pong). Initial authenticated connection establishment
and received activity update last contact. Outgoing transfer/scan messages and
server timer ticks do not count as contact. Activity is fenced to the current
connection; an older socket cannot refresh or remove its replacement.

Online status is independent of indexed content readiness. Going offline does
not delete the previously committed catalog or erase its version-readiness state.
A pending manual scan reports disconnection when its silent control expires.

## NAS compute artifact uploads

Ordinary control HTTP calls retain their three-second deadline. Each artifact
upload instead has a bounded deadline of 15 seconds plus one second per started
64 KiB (16–143 seconds for the existing 1-byte–8-MiB artifact limits). This is a
bounded slow-uplink allowance, not a change to the job lifetime or output quotas.

The companion renews the exact attempt every four seconds during an upload and
stops immediately on shutdown, loss of its lease, or the upload deadline. One
retry is allowed for transport failures and HTTP 408/502/503/504 within the same
total deadline, using identical job, attempt, generation, filename, digest, and
bytes. The server's immutable artifact contract makes a repeated successful
upload idempotent. Quota/authorization/conflict rejections are not retried, and
all existing per-artifact, per-job, and global byte checks remain in effect.
