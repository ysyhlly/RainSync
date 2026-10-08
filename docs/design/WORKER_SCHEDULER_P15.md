# P15 Worker scheduler and typed dispatch

Draft based on `dfbbb4aaf8dc6397e6fce393cd4cfc1c991eac34`. The authoritative
refactor plan makes P15 integration depend on stable P09 interfaces. This draft
preserves the current job wire/spec interfaces; it does not establish P09 as
complete. P08 changes and verification are outside this worktree and scope.

## Seams and ownership

- `scheduler.rs` owns the serial queue coordinator, its one worker UUID, claim
  timeout/stop selection, readiness observations and retry cadence.
- `main::run_next_job` retains the complete original attempt scope. The scope is
  created and entered before claiming. The claim identity is captured before
  dispatch, and the same scope retains preparation, execution, final publication,
  decoder shutdown, scope shutdown, execution receipt and cache-budget release.
- `task_dispatch.rs` supplies a pure ladder route and validated single-output
  types. It borrows the original spec, except for the existing native spec
  deserialization. It creates no execution, owner, output, grant or deadline.
- Existing ladder executors validate at their original entry points. Their
  supervision, publication and settlement implementations are unchanged.
- Preview and static-child owners remain separate. P16 will review executor,
  publication and settlement extraction independently.

## Runtime-discovered async storage regression

The first unoptimized owned runtime run aborted with a Tokio-thread stack
overflow on the existing `invalid.mp4` case, before any new kind-refusal case.
The extracted coordinator embedded a 146,728-byte future. The correction is a
single `Box::pin(run_next_job(...)).await` at the serial boundary: its future is
now 696 bytes, while the original attempt future remains 146,320 bytes. A
footprint regression test guards the coordinator against embedding it again.

This changes storage only. There is no new task, owner, deadline, stack-size
setting, optimization level or relaxed assertion. The exact failing runtime
fixture subsequently passed all 14 cases. The initial failed report, its
complete source/executable copies and the before/after size evidence are retained
separately from successful evidence.

## Scheduling and budget contract map

| Concern | Existing owner and behavior retained |
| --- | --- |
| Local playback concurrency | One serial queue task, one awaited attempt at a time; no new spawn, prefetch, semaphore or concurrency setting |
| Claim/stop race | `process::stopped` is the biased first branch; platform-capable SQL claim has the original 3-second timeout |
| Claim health | Successful `Some`/`None` and failed/timeout claims keep their separate original readiness observations; stop does not fabricate a claim result |
| Worker identity | One UUID per queue coordinator, passed unchanged into every SQL claim; each returned id/owner/attempt remains unchanged |
| Queue capacity | `persistence::media_queue::enqueue_queue` owns advisory lock 72614932, current effective limit and active queued/running count in the caller's existing transaction |
| Fairness | `persistence::media_jobs::claim_queue` retains advisory lock 72614933, user turn ordering (`last_turn`, `created_at`, id), `SKIP LOCKED`, and atomic claim/turn commit |
| Compatibility fences | The original selected-queue and final-UPDATE predicates, reader/recipe settings, output validation version and execution-ledger insert remain untouched |
| Lease/deadline | SQL grants its existing 30-second lease. Existing renewal uses round-trip-adjusted absolute confirmed deadlines. Typed decoding never refreshes any deadline |
| Output budget | `cache::ensure_capacity` then `cache::reserve_output` remain in the original executor position; reservation still includes output, held input and asset copies under the original claim |
| Pacing | Original one-second success/empty delay and two-second error delay, interruptible by stop |
| Resource receipt | Decoder stop is retried; scope shutdown must confirm release before writer ACK. Original id/attempt/owner ACK is retried through DB failure, including shutdown, before cache-budget release |
| Missing drain proof | Scope shutdown failure keeps `writer_stopped=false`, readiness failed and ownership unacknowledged. This draft does not reinterpret that condition as disposal |

Logical `finish`/`release` and publication still happen at their original places.
They are not physical-drain receipts. There is no new claim while the original
attempt's receipt retry is pending. The pre-existing behavior after an
unconfirmed scope shutdown is not redesigned here.

## Complete task-kind matrix

| Stored kind | Logical queue | Dispatch and validator | Execution/publication owner |
| --- | --- | --- | --- |
| Absent or JSON null | NULL legacy | Single `Legacy`; original marker gates and field defaults | Existing scalar attempt in main; source/ticket checks, scalar output proof and publication |
| `owned_http_transcode_v1` | `owned_http_v1` | Single `OwnedHttp`; `owned_http::validate_spec` | Original held HTTP input plus scalar attempt; unchanged representation binding and finite-input constrain |
| `advanced_local_transcode_v1` | `advanced_local_v1` | Single `AdvancedLocal`; `advanced_media::admit_claim`/`request` | Existing advanced local custody and scalar attempt |
| `advanced_owned_local_transcode_v1` | `advanced_owned_v1` | Single `AdvancedOwnedLocal`; existing advanced validator and asset catalog | Existing local input/assets custody and scalar attempt |
| `advanced_owned_remote_transcode_v1` | `advanced_owned_v1` | Single `AdvancedOwnedRemote`; existing advanced validator; finite HTTP/agent input bounds | Existing remote custody and scalar attempt |
| `remote_asset_transcode_v1` | `remote_assets_v1` | Single `RemoteAsset`; existing advanced validator and remote asset/source binding | Existing bounded remote asset custody and scalar attempt |
| `native_platform_clear_transcode_v1` | `native_platform_transcode_v1` | Single native typed `Spec`; `native_platform_transcode::validate_spec` | Existing opaque native ingress and scalar attempt; original absolute native deadline |
| `local_hls_ladder_transcode_v1` | `local_hls_ladder_v1` | `Ladder::Local`; validation remains first in local ladder executor | `local_hls_ladder::run`; common-prefix/rendition proof, validation version 5 |
| `advanced_hls_ladder_transcode_v1` | `advanced_hls_ladder_v1` | `Ladder::AdvancedLocal`; existing local ladder validator | Same existing local ladder executor and advanced recipe |
| `advanced_owned_hls_ladder_transcode_v1` | `advanced_owned_hls_ladder_v1` | `Ladder::AdvancedOwned`; existing local ladder/asset validator | Same existing ladder executor and owned assets |
| `native_platform_clear_ladder_v1` | `native_platform_hls_ladder_v1` | `Ladder::NativePlatform`; existing native ladder validator at entry | `native_platform_ladder::run`; original native ingress and ladder publication |
| `static_hls_child` | `static_hls_v1` | Excluded from this claim path; generic marker guard still refuses it | Separate typed child dispatch/encoder registry, original permits/attempt proof; unchanged opt-in switch |
| Other static-HLS stage-A/spec markers | `static_hls_v1` or malformed legacy data | Not dispatched here; existing static marker refusal and SQL queue fences | Original parent/child operation owners, not the generic scheduler |
| Unknown non-null string or non-string kind | No supported producer/recipe | Separate hardening guard after all existing route/marker validators; fixed `media_job_kind_invalid` error | No input, directory, encoder or decoder work is started by decoding; original claimed-attempt settlement remains responsible for any claim-owned rows |
| Preview attempts | Separate preview tables/queue | `previews::run`, unchanged configured concurrency/limit/revision/lease recovery | Existing preview input/process/receipt lifecycle |
| Distributed compute recipes | Separate compute admission and attempt tables | Not a media-worker task-kind route | Existing independent compute authority, attempt budget and retention |

The matrix describes dispatch, not permission. Actual owner/attempt/lease and
source/session checks remain with the current persistence and execution owners.

## Kind hardening, separately reviewable

The structural extraction retains the old validator order: native, owned HTTP,
advanced markers, static markers, then unversioned legacy fields. Do not tighten
legacy `root`, `resource`, ticket, start, transcode, mode or audio defaults here.
The u64-to-u32 audio conversion remains after source validation and directory
setup, so its error priority is unchanged.

The separate guard closes the former generic fallthrough for unsupported string,
number, boolean, array and object kinds, plus non-object specs. Mixed marked
specs still return their original validator refusal first. The new refusal
stores no untrusted input and logs no resource URL or credential.

Compatibility audit used the current Server legacy producer in `media.rs`,
media_queue's original enqueue contract, all worker/persistence test fixtures,
and historical migrations 0001, 0043, 0047, 0048, 0056, 0057, 0060, 0062, 0065,
0067 and 0068. Ordinary producers and old execution fixtures omit kind. The
original SQL `COALESCE(spec->>'kind','')` also accepts JSON null, which is retained
as an explicit compatibility case. No non-string kind producer or fixture was
found. This is a source/fixture audit, not an inventory of a production database.

The guard runs inside the same cancellable preparation future and before cache
capacity/reservation, source verification, input-ticket decryption, local file
opening, output directory creation or process spawn. An invalid claim still
owns its claim-created output/execution ledger rows; the unchanged finalization
path records failure and only acknowledges the original attempt after the
decoder/scope have actually drained. No resource ownership is inferred from the
parse failure itself.

## Verification inventory

New Rust tests cover stop-first selection without polling a ready claim, pending
claim interruption, unchanged returned identity/spec, empty/failure health,
three-second timeout, one/two-second cadence, every supported single-output
kind, all four ladder route tags and their closed validation, native absolute
deadline preservation, sparse legacy/default parity, delayed audio overflow,
marker error precedence, explicit null compatibility, unknown-kind before/after
behavior and credential-free typed diagnostics.

The existing advanced-queue wiring test now follows the coordinator and typed
decoder seam while retaining the pre-cache ordering assertions. These checks
do not replace the existing actual PostgreSQL fairness/capacity/attempt fixtures,
the authenticated stop/claim race, worker shutdown/process/receipt fixtures or
real media playback. No new schema, wire field, reader marker or recipe marker
is introduced; historical migrations and persistence modules are unchanged.

Validation on this isolated draft:

- `cargo check` and Clippy `--all-targets -- -D warnings`: passed. The existing
  ts-rs warning about `non_null_audio_rate_reports` remains unchanged.
- Focused scheduler tests: 7 passed after the heap-storage fix. Focused dispatch
  tests: 9 passed.
- Final Worker binary unit suite in the reliability runner: 255 passed,
  7 existing ignored and 2 explicitly filtered PostgreSQL tests. The transfer
  health test is also run separately against the owned database (6 scenarios).
  The 16 focused tests above are included in the unit total.
- Standalone readiness target: 14 passed, 1 existing ignored; metrics target:
  24 passed, 2 existing ignored. These targets intentionally repeat readiness
  coverage; their counts are not distinct behavior totals.
- Six existing Worker/ladder wiring suites: 23 passed.
- Formatting, diff whitespace and runtime-fixture JavaScript syntax: passed.

Owned runtime verification after the heap-storage fix:

- Classification: 14 passed, including real absent/null-kind success and five
  malformed kinds. Refusals make no upstream request, create no attempt output
  directory, preserve one original drained execution receipt, leave no write
  reservation and expose no private spec values in worker diagnostics.
- Stop/claim: all 5 existing races passed.
- Child reap: the one explicitly selected real-child cancellation case passed;
  other cases in that broader runner were explicitly skipped.
- Production metrics: 13 passed.
- Readiness: 7 actual fault, recovery and shutdown checks passed.
- Worker reliability: the 6 relay scenarios and 7 existing persistence examples
  passed, including attempt fencing, fairness, capacity, cache budget, leases,
  snapshots and cleanup. Publication bytes in these SQL examples are synthetic;
  they do not establish media decode qualification.
- Active delivery shutdown: paused local input, paused HTTP input and delayed
  HTTP admission passed, including receipts, restart and room closure.

Legacy stop/claim, readiness and delivery-shutdown runners are additionally
wrapped with complete backend/executable and coordinator hashes before and after
execution. The original reliability report's `git ls-files` inventory omitted
the two new modules; it is retained with that limitation and an unchanged
reliability rerun uses the same complete-snapshot wrapper. Fixture-owned process
and port cleanup is checked separately from logical job finalization.

This is finite isolated Linux/synthetic-source evidence. It does not establish
P09 integration, P16's unresolved unconfirmed-drain behavior, every platform or
static-HLS execution route, production rollout, or long-running acceptance.
