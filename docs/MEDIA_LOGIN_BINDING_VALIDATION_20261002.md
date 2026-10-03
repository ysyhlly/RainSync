# Login-bound media validation, 2026-10-02

Implementation commit: `c197c53ddb6b4da26f51037eb4cdafbb1f9f7004` on the local
`feat/media-login-binding` branch, based on `59b082c`. No publication or deployment.
The follow-up validation commit only adds the post-upgrade rollback assertion and
this evidence index; it does not change production inputs.

## Bound implementation

Frozen binding: `tooling/media-login-frozen-final/backend-binding.json`.
Backend source SHA-256:
`c26d979860c551e8e55ae3b69b9f1976f91ffd68f7caafa8903e33ac63546ddd`.

- Server: `04df1c7e94f4282173a3bde3f74e7bf89875a253e108b1fad13d61630c78ef4c`
- Worker: `5e4e39f716ac31d70b0de865f838e8b68d51ebee34aa75e4b29cfdde8c879eb0`

`bind-native-backend.mjs` built all locked binaries/examples from unchanged inputs.
Executables and helpers were copied before any subsequent package test could
relink the shared target. Agent was part of the workspace build only; no Agent
channel or process test was run by this lane.

## Actual results on the final frozen build

Paths below are relative to the task's `tooling/artifacts/` directory.

| Check | Result | Evidence |
| --- | --- | --- |
| Migration / legacy / old-writer SQL | 14 passed | `media-login-migration/6c682ccf-b198-4397-87b4-67e2ed4cb914/report.json` |
| Server + Worker login isolation | 7 passed | `media-login-runtime/e3a98164-745c-485e-8fcc-968debd95670/report.json` |
| Actual old Server API grants → new SQLx migration | 6 passed | `media-login-upgrade/9c3996a2-e14e-4d19-a85a-4a620945af06/report.json` |
| Controlled Jellyfin/Emby login cleanup | 4 passed | `media-login-lane/upstream-reservations/c9d0f589-5d81-454b-a110-3e6f02b46428/report.json` |
| Existing full HTTP candidate regression | 28 passed | `http-file-candidates/314386c6-6a64-49de-9171-e317fb680063/report.json` |
| Strict persistence/Server/Worker all-target Clippy | passed | `media-login-lane/clippy-final.log` |
| Protocol unit tests | 31 passed | `media-login-lane/protocol-tests.log` |
| Formatting and generated protocol `--check` | passed | final command outcomes |

Actual logout-to-reaping observation for the paused/backpressured local body was
2046.38ms, below the ten-second target. Login B retained new bytes and renewal.
The queued local job was cancelled before any Worker attempt. This is one measured
owned fixture, not a hardware-independent latency guarantee.

The old binary came from `tooling/partial-plan-final-frozen`, with its original
source/binary binding and the clean `59b082c` source worktree. The old Server
actually issued the legacy grant with metrics v1; migration preserved ciphertext
and the exactly stored deadline. Another login's fresh request could not adopt the
NULL viewer or mutate its existing metrics/high-water/expiry. Successful legacy
keepalives returned decreasing remaining time and did not extend expiry. The old
grant expired; an independently bound replacement remained usable.

After0041 existed in that real owned DB, the sanitized old-binary preflight was
repeated. It failed without being given DB credentials; migration records, grant
contents and the running compatible Server PID remained unchanged, and its API
remained available. This proves rejection, not safe execution of old Server APIs
on the upgraded DB.

All owned Server/Worker/peer processes and PostgreSQL resources were cleaned up;
fixture reports record observed shutdown and PID/port checks.

## Failed attempts remain evidence

- First Clippy run rejected a collapsible `if`; the second found an ignored test
  still calling the removed unauthenticated admission helper. Both were corrected
  and strict all-target Clippy passed. Logs remain under `media-login-lane/`
- The first runtime report
  `media-login-runtime/f0c380d5-4063-48c2-a5b7-a03fc7a5954e/report.json` failed
  because the test client paused on every resumed data chunk. Worker durable
  reaping had already succeeded. The harness now pauses once; final rerun passed
- An initial protocol-export invocation used `--bin` instead of `--example` and
  failed. The compiled bound export example subsequently generated the output and
  passed `--check`. No failed result was relabeled as successful

## Required integration and acceptance boundaries

- The parent integration owns exact-login metrics receiver prefilter/locking/final
  SQL and its combined A-frame/B-report accounting tests. This lane does not claim
  that unmodified metrics receiver is safe
- The client lane owns the single dedicated legacy-viewer recovery retry. It must
  not rotate on cross-login denial or uncertain creation
- `media-login-preflight.mjs` supplies the tested minimum Server contract. The
  automated `preview-transition.mjs` caller must invoke the guard before selecting
  or launching a rollback baseline. This lane did not wire that deployment tool
- Once0041 is retained, arbitrary pre0041 Server rollback is unsupported. Use a
  source-bound compatible Server and retain origin data/constraints
- The Jellyfin/Emby peers here are controlled protocol mocks. Their 4 passes are
  distinct from any separately pinned-product compatibility12/12 report and do
  not prove real product decode, seek, track switching or account revocation
- No browser, Agent channel, NAS receipt recovery, live-account change, real
  persistent credential creation, publication, deployment or72-hour run occurred
