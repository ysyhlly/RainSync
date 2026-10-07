# Transport measurement producers v1

This contract adds measurement only. It creates no credentials, listener,
resource grant, drain proof, control revision or telemetry-based authorization.
Unknown/unnegotiated producers remain unmeasured. It has no migration.

## Control state recovery

JOIN/RESUME may request `control_recovery_metrics_version: 1`. Only the first
authorized SNAPSHOT on that socket echoes the same marker. The client may then
send one strict `ControlRecoveryMetricsSample` (type
`CONTROL_RECOVERY_METRICS`) after applying that accepted SNAPSHOT's room state,
owner, lifecycle and control epoch. It must not wait for playback or calibration.

The two integer intervals are socket-open to state-application, and optional
observed unexpected disconnect to state-application. Both are at most seven
days; the latter cannot be shorter. `background` records whether either
interval included a hidden page. Persisted-page restoration and discontinuous
clocks discard the sample. Initial failed joins do not invent an earlier disconnect. A browser
online hint is not an independent observation of network restoration.

These are explicitly client-reported successful recoveries. They do not measure
the interval from independently observed network restoration to snapshot
application; that requires a separate tester's observation of network restoration.
Unrecovered or unreported outages are absent, not zero or successful.
There is one packet slot per socket, no timer, retry, persistent queue or ACK.
Missing server marker means ordinary control recovery continues without data.
Metrics frames cannot refresh heartbeat/presence, issue credentials, broadcast,
or enter the command queue. Admission rechecks the current login and membership
even for a client that did not negotiate presence.

## NAS uplink

The Agent's dedicated collector records only bytes whose Binary-frame send
successfully finishes. These are bytes handed to its WebSocket transport, not
remote acknowledgement, playback or independently trusted Server measurements.
Successful non-HEAD 200/206 bodies begin after metadata is sent. Exact declared
body length ends Complete; earlier body failures end Failed; owner cancellation,
peer Close/EOF and dropped observation end Cancelled. HEAD, rejection and
pre-body failures create no transfer. Drain proof remains independent.

An ordinary HELLO may include `uplink_metrics_version: 1` and
`uplink_metrics_baseline: NasUplinkTotals`. The Server may reply
`{type:"NAS_METRICS_READY",version:1,connection_id:<current control UUID>}`.
The baseline is valid but uncredited. Only after READY does the Agent add an
optional `uplink_metrics: NasUplinkMetricsSample` to its existing five-second
HEARTBEAT. There is no extra periodic send or ACK/retry loop. Sequence starts at
1, increases without wrapping, and may have gaps. Newer cumulative snapshots
recover missed intermediate samples; exact duplicate sequence/payload credits
nothing and conflicting or decreasing data is rejected. Reconnect establishes
a new baseline and can lose an unsent tail; it cannot recount an old prefix.

Totals contain only fixed integers, one boolean, three outcomes and nine fixed
duration buckets. Numeric values are bounded to exact JavaScript integers,
active measurements to the existing sixteen body slots, and the entire metrics
envelope to 4KiB. Histogram counts/order/duration bounds, admitted versus
active/terminal counts, and cumulative monotonicity are checked. A transfer
finishing after a baseline may legitimately include bytes handed off before
that baseline in its terminal aggregate; do not compare terminal-byte delta to
live-byte delta.

Receiver cursors exist only for the current authenticated ordinary control
connection, with a bounded global permit and rate/auth-work limits. Mutation
rechecks that connection and the exact non-revoked token under the Agent row
lock. The dedicated receipt-only route never participates. Server exports use
`agent_reported_nas` names, never the Worker-observed namespace or identity
labels. Values can be falsified by an eligible producer and must not drive
billing, permissions, lease extension or resource-release decisions.

Control admission uses one socket-owned task, at most 128 pending tasks and two
concurrent database authorizers per Server process. Its two-second deadline owns
and closes a cancelled connection. Room, member and exact login locks remain held
through the synchronous aggregate update, with final expiry checked after waiting.
A malformed first packet consumes the socket slot. Metrics have no ACK or replay
across Server restart; cancellation or process exit may lose data. An ordinary
socket operation does not await this optional task, and socket disposal aborts it.

Shared aggregate state has a tested 4 KiB fixed-size budget, independent of the
number of Agents, rooms and clients. Counter overflow rejects a whole update;
there are no identity-keyed aggregate maps. The original Worker body collector
retains its own process-local namespace and 1024-handle bound; the sealed Agent
collector is limited to the existing sixteen body owners.

Producer, admission and finite integration evidence is recorded in
[RUNTIME_METRICS.md](RUNTIME_METRICS.md). Neither these measurements nor short
fixtures satisfy the separate long-duration/device/production release gates.
