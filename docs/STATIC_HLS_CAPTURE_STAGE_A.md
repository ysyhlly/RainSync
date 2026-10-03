# Native bounded static-HLS capture, Stage A

This is a private reusable capture prerequisite. Automatic/public fallback,
parent/child issuance, browser media clocks and production activation remain
disabled. The separate persistence foundation owns durable admission and
reservations. This slice does not provide historical Agent disposal evidence.

## Module and ownership boundary

- `media_core::static_hls` accepts an already acquired `CapturePermit`. Its
  repeated `check()` must conjoin activation and current exact-login/source/
  lifecycle/media/viewer authority. There is no implicit admission or Drop
  release. A permit cannot be recreated from a stale capture UUID
- `providers::static_hls::RegisteredSource` uses `source_media_request` for each
  request, preserving existing exact-origin credentials, per-hop source policy,
  fresh DNS/address pinning, redirects and the actual final URL identity
- The native timeline port consumes one init/fragment at a time, retains only
  bounded sample tables, and validates the complete packet/decoded-frame scan.
  It preserves the tested sequence/edit/priming contract; ENDLIST and sequence
  do not imply a zero media origin
- One independent capture owner outlives a canceled waiter. Scoped blocking file
  operations and independently owned process trees must drain before deletion
  and the opaque identity-bound `DisposalProof` callback. `NeverStarted` is
  different from a launched and actually `Reaped` process
- Failed cleanup, unknown DB acknowledgment or the fixed five-second disposal
  ACK timeout is `Unresolved`. The module never
  retries release blindly and never infers cleanup from timeout, lease, or crash
- A verified handle retains the unified admission/storage slot until disposal.
  Retention is capped at 30 minutes from capture start, with no renewal extension

## Snapshot and resource identities

Each attempt uses the exact `static-hls/{capture_id}` key and refuses reuse.
Creation is exclusive and handle-relative with no symlink following. Private
ownership marker plus held directory inode bind later decode and cleanup. Every
writer closes before sealing; file and directory modes become read-only and the
public API exposes neither writable handles nor a decoder path. FFprobe inherits
a held directory FD, and reads the generated manifest through that FD; replacing
an ancestor cannot redirect it to a different tree.

This proof excludes a malicious administrator or unrelated same-UID process
intentionally changing permissions/replacing private files. It eliminates
ordinary supported runtime writer/attempt reuse; before/after path hashes are
not substituted for that ownership transition. Cleanup only unlinks registered
server names and rejects any unknown entry, retaining unresolved ownership.

The inventory records canonical original/final target SHA-256, strong ETag,
actual body length and SHA-256 for the entire closure, including init and the
last previously unread resource. Query ordering changes identity. All demand
revalidation performs an independent full-body recapture and compares the entire
inventory; a 304 is refused, never hashed as an empty representation. The local
decoder manifest contains only generated `init.mp4`/`sNNN.m4s` names. Original
source bytes are private attempt data (`source.bin`), never the decoder manifest;
original signed URLs/headers do not enter public evidence or diagnostics.

## Fixed bounds and source admission

Manifest 256 KiB; init 2 MiB; each media resource 32 MiB; total actual source
bytes 128 MiB; 64 segments; depth one; 300 seconds. Reads are sequential, at
most one upstream resource in flight, below the maximum of two. Storage preaccounts the private marker and maximum generated manifest before
creating an attempt, then replaces that manifest reservation with its exact size
as soon as the playlist is parsed. One checked-add counter admits every write
before IO and must fit the fixed 128 MiB file-byte reservation. Filesystem inode/
block-rounding overhead remains covered by the separately measured cache
headroom floor; the counter does not claim exact filesystem allocation blocks. There is no whole-128-MiB source allocation: structural parsing
loads one bounded resource, not the closure.

Capture plus decode has one 35-second deadline. Decoder bounds are 70,000
packet/frame records, 16 MiB stdout, 64 KiB stderr (any error is failure), 1 GiB
address space, 128 MiB single allocation, one decoder thread, and 35 CPU seconds.
File-only protocols and HLS/mov-only formats apply to generated local input.

Caller observation has separate defaults: `CaptureHandle.wait()` is bounded to
40 seconds and `VerifiedCapture.dispose()` to 10 seconds. Their monotonic
budgets start at the public method call, including time before the returned
future is polled; explicit budgets may only shorten these limits. Deadline
checks run both before and after completion, and expired ready results do not
win. A queued result cannot create a new verified handle after retirement,
disposal, unresolved ownership, or loss of its live owner watchers.

A missed caller deadline returns typed `WaiterTimeout` with the actual disposal
state and any known capture failure. It never manufactures a proof, ACK, or
release. If real cleanup subsequently completes, that later `Disposed` state
is distinct from the missed caller deadline, even when the future is polled
only afterward. The independent cleanup owner has no invented OS-IO completion
deadline: it retains responsibility/reservation through stalled file work,
process reaping and deletion. The five-second ACK budget starts only after
positive local disposal; it remains separate from the caller's ten seconds.
Cancellation may wait for unavoidable blocking IO to drain; until then no
positive disposal receipt or storage release exists. These are implementation
ceilings, not a measured total Server/decoder RSS guarantee.

Timeline success alone does not admit a conversion. Actual init avc1/avcC and
AAC configs must match FFprobe extradata. Protected/unknown timing/sample-entry
structures, external data references and overlapping sample payloads fail
closed. Existing `capabilities::validate_source` and measured candidate analysis
then check bit depth, transfer/HDR/protected indicators and selected audio.
Output qualification remains avc1, no B frames, CFR 25/30, at most 1080p,
AAC-LC 48 kHz mono/stereo or init+every-fragment+decoder-proven no audio. No new
public offers follow from qualification.

## Verified local evidence

Using the existing installed toolchain with offline Cargo and compact debug
settings (no installs/network source upload):

```sh
cargo test --offline -p media-core static_hls -- --test-threads=1
cargo test --offline -p providers --test static_hls_capture -- --nocapture --test-threads=1
cargo test --offline -p providers --lib -- --test-threads=1
```

Final results: 15 native parser/ownership/process/storage tests, eight owned
real-HTTP + FFmpeg fixture tests, and 40 provider/framing regressions passed. HTTP fixtures
use actual separate primary/CDN loopback origins with registered strict-CIDR
policy and observed credential-origin behavior. Their permits are explicitly
isolated owner fixtures; they are **not real DB admission proof**.

Coverage includes actual sealed muxed AVC/AAC 25 fps and silent 30 fps positives,
complete full-body recapture, same-ETag changed unread last resource/init, final
query identity, weak/missing ETag, refused 304, malformed/unknown manifest,
truncation/advertised oversize, denied redirect, stalled body with epoch/drop
cancellation, stalled/oversize process-tree draining, unsafe names, attempt reuse,
directory owner mismatch and unknown-entry cleanup without an ACK. An actual
128 MiB on-disk file-byte boundary is accepted; +1 and integer overflow are
refused before another byte is written. A canceled late blocking file writer
finishes and closes before scope drain and owned deletion. Unknown or never-
resolving ACKs stay unresolved after one bounded attempt. An actual 1080p FFprobe
was observed active, its epoch was revoked, no proof was published, and its tree
was reaped; that case does not claim it was killed while still decoding. Full-body
reads deliberately send no conditional headers, so a server ignoring conditions
cannot substitute a validator for byte comparison.

The owned runtime directories retain generated source bytes/argv, per-attempt
wire response bytes/metadata and result evidence; `.runtime/checks` retains final
logs. `.runtime/capture-stage-a-report.json` binds final module/test hashes,
installed tool hashes/versions, check logs and exact fixture bytes. Initial
failed attempts (async stack allocation, a permission-invalid fixture rename,
an unobserved active-decoder test, a missing fake ACK-hang branch and a repeated
test-directory key) are recorded separately; the corrected final checks are the
verdict. Test directories now use exclusive nonce-bearing creation and never
reuse earlier fixture bytes. Coalesced immutable HTTP frames are delivered as
64 KiB hash/write chunks without copying a complete frame or source closure.

Not proved here: real durable admission wired to capture, restart-owned disposal,
frozen mixed-reader Server/Worker combinations, public serving, browser clocks,
source-to-child earliest/later frame mapping, live/master/encrypted/ranged HLS,
or general codec/interoperability support.

### Caller-liveness unit scope

The additional waiter suite holds an actual blocking file writer behind a
controlled synchronization gate. Short caller budgets return while the writer
is still incomplete, the isolated reservation witness remains held, and no
proof or ACK exists. Releasing the gate allows actual writer closure, scoped
drain and owned deletion before one isolated ACK. This is not a simulation of
truly OS-uninterruptible IO, a database admission proof or a media qualification
proof. Production 35/40/10/5-second constants and shared production waiter paths
are checked explicitly; these tests do not run HTTP, FFmpeg or browser work.
