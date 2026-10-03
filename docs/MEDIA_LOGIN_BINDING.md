# W03: login-bound media authorization (migration 0041)

Scope: v0.1 administrator-configured shared sources. This is not private-library,
Moderator, real upstream product compatibility, deployment, or long-run acceptance.

## Authority and the legacy boundary

New playback requests are bound to the hash of the exact authenticated login and
the current room membership epoch. The hash is an internal reference, not a cookie
or new credential. Login rows retain their original four-column schema. Logout
still deletes only that login; it does not delete membership or other devices.

Request, viewer, grant and upstream-reservation origin cannot be reassigned or
made NULL. Provisional, capability-probe and final grants inherit the origin of
their exact admitted request transactionally. Server-authored resource envelopes
make the existing continuous Worker gate enforce the same origin for every route.
Replacing the encrypted resource cannot erase that restriction. New user-owned
SQL grants without an admitted bound request are rejected, including old writers.
Anonymous low-level rows confer no delivery authority and cannot be reassigned to
a user later.

Migration does not guess origins. Existing NULL grants retain their precise
stored expiry. A legacy keepalive returns `ok: true`, actual remaining
`expires_in_seconds`, and `legacy_expiry_unchanged: true` without extending expiry.
This prevents an old client from treating a renewal failure as an early stop.
Successful keepalive is not a new 30-minute grant. Expiry still requires a new
request. Current web keepalive runs at a fixed ten-minute interval; it does not
reschedule an immediate retry from this response.

An interrupted legacy request cannot mint another unbound attempt. Use a fresh
request key. A legacy viewer high-water row is never adopted or deleted. A fresh
request using that old viewer receives `PLAYBACK_VIEWER_ORIGIN_REQUIRED` only
before any request/grant creation. A new client may replace the viewer and request
key once as a new intent on that dedicated rejection. Cross-login collisions,
network uncertainty, generic403 and repeated rejection are not rotation signals.
Old clients require player re-entry/reload, which constructs a new random viewer.
The separate client integration must verify this bounded recovery behavior.

Readiness, renewal, observations, metrics, explicit Stop, request cancellation,
replay and viewer supersession require the same originating login for bound rows.
Legacy NULL ownership remains account-scoped because its originating login is
unknown. Delivery remains an opaque bearer ticket restricted by its originating
login's current existence/expiry, membership and source policy; no cookie or raw
login hash is added to the media URL.

## Continuous cancellation and cleanup

The Worker reuses its existing preparation, header and body monitor: two-second
checks, three-second query timeout and five-second maximum authorization age. It
runs independently of response backpressure, including cached bytes, manifests,
subtitles and range requests. Existing client/network buffers cannot be recalled.
The acceptance target remains ten seconds, measured rather than inferred.

All-provider retirement stops grants and cancels jobs after origin loss. Job
claim, heartbeat and output publication also check origin. Upstream negotiation,
activation and Start/Progress use exact reservation origin. A late SID/response
checkpoint remains admissible for cleanup only. Stop cleanup does not require a
live login and preserves exact SID/DeviceId, partial receipts, uncertainty and
existing bounded retry budgets. Logout does not assert remote execution completion.

No Agent-channel or historical-drain behavior is changed by this work.

## Supported cutover and rollback

Before switching a Server binary after0041, run:

    node scripts/media-login-preflight.mjs /absolute/path/to/rainsync-server

It launches only the offline `--media-authorization-contract` probe in an owned
empty temporary working directory, with application configuration/secrets removed
from the environment. It requires the exact `media-login-binding-v1` contract and
pins the executable's bytes before/after the probe. A known pre0041 Server fails.
The declaration alone is insufficient: release evidence must bind that exact
binary to the A/B isolation and upgrade tests.

The current supported authorization contract is the exact `media-login-binding-v1` declaration, not an automatic promise for every migration or Server version >=41. Future compatible implementations must retain it or update the gates and source-bound A/B/upgrade/recovery tests together.

Migration0041 is the minimum supported Server contract. Do not use a pre0041
Server for rollback: its control handlers do not enforce caller-origin equality.
Keep database origin restrictions and use a tested compatible build. Do not drop
0041, clear origins, reassign legacy ownership or use unrelated old rollback
results as evidence. Older-writer raw inserts are rejected at the database; that
is not a claim that arbitrary older Server APIs are safe to expose.

## Reproducible owned-fixture checks

Build from unchanged sources with `scripts/bind-native-backend.mjs`; freeze the
resulting executable copies and binding before package tests can relink them.
Set explicit owned `CARGO_TARGET_DIR`, `RAINSYNC_ARTIFACT_DIR`, and
`RAINSYNC_NATIVE_POSTGRES_BIN`. All test accounts, PostgreSQL clusters, loopback
peers and generated media are disposable. No test accepts a production DB URL.

- `tests/media-login-migration.mjs`: legacy exact expiry, no invented origin,
  new old-writer rejection, immutable context, A/B SQL authority, rollback
- `tests/media-login-runtime.mjs`: source-bound Server/Worker exact-login API
  isolation, queued local jobs, paused/backpressured body, expiry, tombstones
- `tests/media-login-upgrade.mjs`: real old Server issues API grants; new SQLx
  migration preserves them until their actual deadline; new bound replacement
- `tests/upstream-reservations.mjs --login-binding-only`: controlled Jellyfin and
  Emby exact-login cleanup and held negotiation/late-SID preservation

The last two require the frozen pre0041 Server plus its original source/binary
binding via `RAINSYNC_OLD_AUTH_SERVER` / `RAINSYNC_OLD_AUTH_BINDING` where applicable.
`W03_BACKEND_BINDING` identifies the new frozen source-bound build.

These focused fixtures do not replace real-product playback/decode, all-route
browser acceptance, metrics-lane integration, client recovery tests or72-hour
acceptance. Old tests that insert user-owned playback rows directly must supply
an explicit owned authenticated request; never make them pass by selecting an
arbitrary live login or relaxing production constraints.
