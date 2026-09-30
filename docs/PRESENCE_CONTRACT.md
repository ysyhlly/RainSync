# Presence version 1 shared contract

This checkpoint exports the public DTOs and initializes one process-wide
`App.presence_sequence: presence::Sequence`. The existing presence core and
frontend reducer are included; authenticated room registration, delivery and UI
mounting remain the presence lane's work. It is not a claim that the complete
presence feature is live.

- JOIN and RESUME may opt in with `presence_version: 1`
- Only opted-in connections participate in presence registration and its limits;
  existing control connections without negotiation retain their behavior
- An initial authoritative SNAPSHOT includes `presence_connection_id` and
  `presence` together, or neither when unavailable
- `PresenceSnapshot` contains `room_id`, `presence_epoch`, `presence_seq: u32`
  and `members: PresenceMember[]`; each member has `user_id` and a positive
  `connection_count`
- Subsequent full replacements use `{type: "PRESENCE_SNAPSHOT", ...snapshot}`
- A missing member is unknown, not confirmed offline. Counts cover reported,
  opted-in connections and cannot be described as every legacy room connection
- Server-issued connection IDs are new on each authenticated join/resume. They
  are not credentials and never authorize room control or media
- The lease core limits participating connections to eight per user and eighty
  per room, independently of permanent membership. Admission errors need an
  explicit bounded response, not silent inaccurate counts
- Existing authenticated Ping/Pong may refresh a 45-second lease at its
  15-second cadence. CLIENT_STATUS is not presence authority
- Full snapshots allow sequence gaps. Compare only within the same room and
  presence epoch. Old socket callbacks and smaller/equal snapshots cannot
  replace newer state; an epoch change requires a new authenticated handshake
- Sequence allocation belongs to the Server process, so actor recreation cannot
  reset it. Exhaustion changes the presence epoch and requires reconnect
- Presence changes never modify control revision, media generation, playback
  state, persisted events or membership

Authorization precedes admission, renewal and snapshot publication. Candidate
reconciliation must not remove newly admitted connections based on an older
database result or renew a removed/expired connection. The room lane must keep
replaceable presence separate from durable control/chat and protect it from
CLIENT_STATUS queue churn. Old servers without presence fields show status as
unavailable. The UI must not label absent or unsupported members offline.
