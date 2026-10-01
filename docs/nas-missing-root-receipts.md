# NAS receipt recovery with an unavailable media mount

The NAS Agent loads its existing durable drain receipt backlog before validating
MEDIA_ROOT. If the root is unavailable (including a path that is a file), an
existing Agent token may replay those exact UUIDs through
`/api/v1/agents/drain-ws`. This mode never pairs, writes new credentials, scans,
indexes, opens media files, or accepts transfers. An old Server returning 404
leaves receipts pending; there is no fallback to the ordinary control route.
The existing credential and receipt journal must themselves remain readable,
normally on local storage outside the unavailable media mount. Missing or
unreadable journal data cannot be reconstructed as positive drainage evidence.

The Server rechecks the exact current token hash and non-revoked Agent identity
inside each receipt transaction, serialized against revocation. Only that
Agent's dispatched, non-legacy transfer UUID is eligible. Duplicate receipts
preserve the original timestamp. Unknown, foreign, undispatched and legacy IDs
receive a negative acknowledgement; missing receipts never become inferred
drain evidence. Receipt sessions do not register ordinary controls or scans,
change last_seen, create sources, or advertise ordinary readiness.

Both sides bound frame/message size to 4096 bytes. The Server closes the
connection after 60 seconds, including an outstanding database/send wait.
The Agent also requests periodic reconnects, while completing any in-progress
durable journal operation rather than cancelling its write. The Server limits
concurrent recovery sessions to 16 and each to
1024 incoming messages, with three-second database/send deadlines, local
PostgreSQL statement/lock timeouts, and owned connections closed on cancellation.
Transactions commit before network acknowledgements. Mount checks retain at
most one blocking owner across retries. Restoring a directory ends recovery;
ordinary operation requires another root validation and a new ordinary socket.
If storage restoration makes an existing credential visible, the Agent reads
it again before considering pairing and preserves that credential unchanged.
A genuinely stuck operating-system mount or journal write can still delay
Agent process shutdown. This mode does not fabricate a completed I/O receipt.

Run `tests/nas-missing-root-receipts.mjs` with the existing isolated fixture
environment and compiled Server, Worker and NAS Agent. It verifies a real file
owner's durable receipt held behind a database ACK lock, restart without its
mount, mapped room closure after replay, admission isolation, rejection and
revocation cases, unresolved missing evidence, restored-root validation, and
old-server/unsolicited-transfer failure behavior. Its report records source and
binary SHA-256 hashes plus disposable database/process cleanup evidence.
