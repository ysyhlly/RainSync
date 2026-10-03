# Current-schema fixture admission repairs

These changes adapt synthetic, current-schema non-Agent fixtures to0041. They do
not weaken production admission or assign origins to historical NULL grants.

`tests/fixtures/playback-admission.mjs` requires the exact Client object from the
owned fixture, its existing session cookie, and explicit user/room/session IDs.
It locks and verifies that login and membership, inserts a bound pending request,
executes synthetic grant/reservation setup, and completes the request atomically.
The generated request owner is only a fixture label, not process/drain evidence.
Coordinator hash lists include the helper where suites already bind their inputs.

Actual pure Node suite results used the immutable
`tooling/media-login-frozen-final` Server/Worker set. The production implementation
is `c197c53`; the subsequent native helper source edit below was not rebuilt here.
Logs are under `tooling/artifacts/media-login-lane/fixture-repair/`.

- room-lifecycle: passed
- room-ownership: passed on second run. First run failed restart because its old
  synthetic source used literal `fixture` instead of encrypted config. It now uses
  the existing encrypted sourceMedia helper. Failed log retained
- worker-delivery-shutdown: passed, including paused local/HTTP bodies and delayed
  delivery admission; no Agent connection
- worker-error-classification:8 passed; report
  `worker-error-classification/0aaa5b58-b339-4aa4-a09a-7e12e24f418c/report.json`
- stop-claim-race:5 passed; report
  `stop-claim-race/8068fcab-a63c-4da7-8e04-06f2697af2ec/report.json`
- job-health-events:13 passed; report
  `job-health-events/11f0dbec-5b17-4c8c-9ec8-9e8b07748075/report.json`
- playback-plan-generations:14 passed; report
  `playback-plan-generations/0f8f70e3-de72-46d5-bdea-833dfa334d37/report.json`

Job-timing-runtime failed in its frozen native helper before the Node API cases;
report `job-timing-runtime/2a4308a0-949f-4db5-91cc-bc152ab9eb98/report.json`.
The helper's enqueue_scoped inserted a user-owned grant without request/login
provenance. Its source now explicitly creates one owned test login and membership,
uses the same known origin for its scoped rows, and cleans up only its owned
request/session rows. Anonymous timing cases stay anonymous. The original NULL
phase-timing assertions are preserved; they were never historical-login tests.
This native edit has only been rustfmt checked and needs the integration build and
full timing rerun. No Cargo invocation was made during this repair phase.

The non-Agent grant/cleanup-reservation setup in source-access-gateway was adapted
and syntax checked only. Its mixed full entrypoint still includes a real Agent
scenario, which was left unchanged and was not run. Room-cleanup, stream-revocation,
input-retries/source-version-playback and Agent/NAS/relay fixtures were excluded.
Historical migration fixtures remain on their explicit pre0041 schema; they must
not be made current-schema fixtures by inventing a login origin.
