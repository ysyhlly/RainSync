# Current v0.1 room authority consistency

These batches close existing REST, socket-admission and queued-command inconsistencies. It adds no private-library role, Moderator grant, credential, or new administrator privilege.

## REST mutation admission

Invitation creation/revocation and playlist addition/removal already share a controller gate. Its transaction now locks in room → snapshot → membership order and rechecks membership after any wait. Current user role and the exact original login are read under shared locks that prevent non-key role/session mutation as well as deletion. The original Origin/CSRF check stays in place; CSRF and database-clock expiry are checked again after the locks. A demoted administrator who remains the actual room controller retains the ordinary controller permission; a demoted non-owner administrator does not retain cached administrator power.

Every mutating path performs another exact-login `clock_timestamp()` check immediately before transaction commit. This catches natural expiry while later invitation/playlist writes wait: row locks cannot stop time. Failed admission rolls back changes. No second pool connection is acquired by authentication while holding the transaction.

## Room WebSocket admission

Login validity is independent of optional presence negotiation. JOIN/RESUME and legacy sockets use the same exact-login/member checks at frame and delivery boundaries. A legacy socket no longer relies only on the next 15-second heartbeat to observe logout. Presence leases, heartbeat cadence, recovery metrics and room revisions retain their existing behavior. These are admission checks; bytes already admitted to transport cannot be recalled.

## Queued room-control commit admission

A room command now carries the account ID and the exact originating login hash through the actor queue, without retaining the WebSocket upgrade's administrator flag. Persistence locks room → snapshot → member → user → session, then computes the authoritative reducer output from the locked snapshot and current administrator role. The diagnostic envelope records that same role. A non-owner administrator demoted during queue/lock waits loses control; a demoted account that remains the room controller retains ordinary controller permission. Promotion is likewise read from the current role.

The role and login rows remain share-locked through all writes. Logout and explicit role/expiry mutations either precede admission or wait for the admitted transaction to finish. Natural expiry is checked with `clock_timestamp()` after the locks and again immediately before commit, including after playlist, event, result and cleanup writes. Failure rolls back the snapshot and all transition records. Revoking or expiring login A does not authorize it via a still-valid login B for the same account, and does not revoke B.

This is a transaction admission boundary, not a claim to recall previously admitted transport bytes or undo a transition committed before a waiting revocation. It does not change media-ticket compatibility, room roles, wire schemas or the historical replay contract.

### Queued-command regression evidence

`tests/queued-control-authority.mjs` passed 25 checks against a clean, source-bound build and disposable PostgreSQL 17.11 / Server fixtures:

- Ten observed actor-queue cases: legacy/presence sockets × non-owner demotion, owner demotion, promotion, logout and expiry
- Nine observed snapshot/current-role/exact-session lock waits, including denial without durable effects and success with the actual current role in diagnostics
- Three natural-expiry waits at playlist, room-event and command-result writes, with full transition rollback and independent same-account login B still usable
- Three admission-first races proving demotion/logout/explicit-expiry mutation waits until the admitted transition ends

Run `15304614-fd2f-4a69-9346-3124f59f646a`; backend source digest `65a37b1390d2f55652a5540a4b00a907f616273dce7dc17eea354017bb3ded74`; report SHA256 `0b0abb0cbc06c85042c89ec020b34ccea2d0c9b9ce66dcf33980112716757ee0`. Source/binary bindings were unchanged before/after, and owned Server/PostgreSQL processes and listeners were positively checked stopped. The original 26-check authority fixture, seven membership transaction checks and 12 diagnostic groups also passed on this build, together with 29 room-core and four persistence tests and targeted Clippy with warnings denied. The first new-fixture rehearsal rejected a malformed test PAUSE payload before the lock; the fixture encoding was corrected and this successful run started a fresh cluster.

To repeat after a successful source-bound build:

```sh
W03_BACKEND_BINDING=/path/to/backend-binding.json node tests/queued-control-authority.mjs
```

This is bounded owned-instance regression evidence, not whole-workspace, device, deployed-service or long-duration acceptance. No Agent WebSocket test was run.

## Executed bounded evidence

The source-bound real PostgreSQL 17.11 / Server fixture passed 26 checks:

- Four REST mutations × membership removal, logout, expiry and non-owner administrator demotion during an observed snapshot-lock wait
- Natural login expiry while invitation/playlist INSERT waits after authority locks, with rollback
- JOIN/RESUME × legacy/presence × inbound/outbound logout, after the first heartbeat and before the next heartbeat; a second independent login by the same account stays usable

Run `29e1dbfa-88cc-4d04-978a-81af6e3f40c4`, source digest `f042e0a23ee49eb6c78cb80f65b910ac6609debf2f26ef6f5022f0408d153777`, report SHA256 `44ed6859c09fef943c2b31d2e4d32e7ed86265f0563f234283652e160ea4262a`. Source/binary bindings were unchanged before/after and owned Server/PostgreSQL processes/listeners were positively checked stopped. Test formatting was normalized afterward; final combined-batch validation reruns the checked-in coordinator.

The same backend passes 29 room-core checks and the 12-group diagnostic fixture, now including reopen/close after an actual Server restart and a literal version-1 golden event fixture. The historical reducer fixture stores fixed input/post-state JSON; it is not regenerated through the current reducer during testing.

## Separate unresolved work

Continuous media authorization is a separate W03 contract: existing optional HTTP file authority binds a login, but this does not imply every legacy/upstream/Worker ticket does. A complete new-grant auth-session binding, explicit legacy-NULL policy and independent same-account A/B login media tests remain separate implementation/compatibility decisions. No old ticket is silently invalidated here. This fixture does not exercise the separately prohibited Agent WebSocket receipt task or assert historical resource-release proof.
