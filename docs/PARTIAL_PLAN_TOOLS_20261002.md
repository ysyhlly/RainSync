# Bounded validation tools checkpoint — 2026-10-02

Code checkpoint: `db480d4`. Service production sources remain unchanged from the capability/redirect checkpoint `4a008f2`; the backend additions are standalone test examples. Native workload checks consume the independently frozen runtime source `f31d5a259087b5af1675358c4aa52b495fcf327f5d79020c68660725fcc7816a`. This is not a new production release or an approval to publish.

Full result/path/hash index: `tooling/partial-plan-tools-validation-index.json`. It separates lane-only execution, integrated execution, read-only remeasurement, passed checks and expected failures.

## Completed slices

- Visible RST1 timecode: real encoded/decoded pixels, checksum/numeric/geometry/alpha rejection, saved failure frames and explicit frame quantization. Real browser/dual-client measurement remains unrun
- Negotiated exact decoding:8 actual continuous zero-origin CFR/VFR cases at fractional non-keyframe starts,84 sampled output frames, selected audio frequency,32 ineligible nonzero copy checks and wrong-source/drift controls.4,475 artifact hashes were independently rechecked.8 offset/gap encodes preserve source PTS and content clocks separately; they do not establish a production bug or universal refusal
- Static-HLS prerequisite:16 integrated actual-byte/timestamp/decoder cases, including AAC media-end versus decoder-padding checks, mismatched init/final segments, offset/gap/audio rejection, bounded process termination and FIFO/spawn failure cases. No production capture, grant, queue, schema or fallback is enabled
- Owned native workload: admitted direct sessions with bounded delivery probes, online membership changes without authority mutation, generated HLS segment delivery, separate Stop and true membership-SQL F4. Admission probes are not sustained playback-capacity evidence
- Owned cache pressure: actual quota-driven inactive-output eviction, a production read lease/open file preserved, and a real FFmpeg writer still writing after logical cancellation/lease expiry while its reservation remains. Only positive process drain permits its receipt and later deletion

## Integrated and source-equivalent evidence

68 combined Node checks passed with zero skips after the newer browser observer was composed with the owned workload. The integrated happy report is `owned-soak/7a72b317-6c50-46b4-bf52-42625186365e`; membership-SQL F4 closed the long body in about1.998s, preserved a different user's direct viewer, and did not revive the old grant after a normal rejoin epoch change. `owned-soak/a9771e73-5ef0-4a8f-a9c8-10a8fa328495` is an intentional lifetime-abort failure with the primary error and complete independent cleanup preserved. Both reports bind all9 current coordinator files.

Cache report `cache-pressure/124cabee-2c32-4d6d-968d-2cb193da817d` passed. Pressure was125,009 bytes against a106,911-byte application quota, then stabilized at97,131 and83,822 bytes. The live writer grew13,497→28,066 bytes while65,536 reservation bytes remained. Known released outputs finally reached0 bytes. The lifetime-abort `2739aec7-706a-4cac-9d67-5e78fc295276` and callback/unattended-operation abort `55081e01-b1b7-47bc-bba7-cc7995a95e13` failed as intended and confirmed cleanup while leaving the unfinished writer receipt unresolved. All225 helper source hashes and copied helper bytes match the integration tree, so identical native inputs were not pointlessly rerun.20 cache contract checks were rerun and passed.

The old soak report `7d7eac5d-…` only proved Stop/session deletion. Its original F4 label was incorrect and is not reused as permissions-revocation evidence. Later membership reports are explicit SQL fault injection into an exact owned fixture row, not a new public member-removal endpoint or the full upstream-account/Agent matrix.

## Remaining gates

The concrete operations still do not complete the standard image-bound72h scheduler. Production automatic F1 recovery, final F2 integration, F3 isolated-volume ENOSPC, browser presentation, sustained1/2/5/10 capacity, resource trends and final-image execution remain separate. A small application quota does not prove disk exhaustion, and a production cache lease/open handle does not prove browser HTTP backpressure.

Static-HLS production authority/capture/reader coexistence remains design work. The scanner assumes an owned directory without concurrent writers; before/after hashes are not an immutable production snapshot. No RLS/runtime-role or credential changes were made. Existing no-publication, blocked Agent receipt, browser and network boundaries are unchanged.
