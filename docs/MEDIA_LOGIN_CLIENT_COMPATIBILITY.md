# Client compatibility with finite legacy media grants

The server's `PLAYBACK_VIEWER_ORIGIN_REQUIRED` response is reserved for a fresh,
nonexistent request key rejected before mutation because the requested viewer
has legacy NULL login ownership. The client treats only the very first HTTP
attempt's dedicated response as permission to rotate. A prior timeout, unknown
result, retry or in-progress response removes that permission. Ordinary403,
`STALE_PLAYBACK_PLAN`, login expiry and all other failures never rotate identity.

The request manager forgets only the proven uncreated local key without making
a cancellation request. The runtime then allocates a fresh viewer and request
key, starts a new logical metrics intent and retries once. It does not adopt or
delete the legacy high-water row, mutate the old request, relabel an old metrics
packet or retry repeatedly on the dedicated error. Another dedicated rejection
stops. Explicit later user playback actions retain their normal behavior.

A legacy renewal receipt has `legacy_expiry_unchanged: true` and truthful
`expires_in_seconds` from the original database expiry. The client remembers a
conservative monotonic deadline which can move earlier, never later, for that
plan. HTTP200 alone does not fabricate an extension. Renewals remain on the
existing ten-minute cadence, with one in flight per current plan; even a200
receipt with zero remaining cannot cause a tight retry loop or a new intent.
Only a real `INVALID_PLAYBACK_SESSION` rejection at or after that explicit
legacy boundary starts one fresh automatic intent. Earlier rejection or login
expiry requires the ordinary user-facing reload/authentication path. Late
receipts for an old plan or login epoch are ignored. Ordinary bound renewals
retain the existing behavior.

720 frontend tests and strict Vue/Vite production build passed on the metrics
branch, including first-attempt certainty, repeated rejection bounds, generic
failure non-rotation and old/new/zero-remaining renewal fixtures measured against
the original fixture expiry. These are deterministic client tests. The server's
pre-mutation error and real finite legacy expiry need the separate exact-login
backend integration; no browser/device or release acceptance is implied.
