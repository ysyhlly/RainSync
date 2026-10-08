// The original account/profile rollout fixture is intentionally frozen at
// migrations 0019→0022. It is not the current-candidate compatibility verifier.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
export async function requireHistoricalCompatibility() {
  assert.equal(
    process.env.RAINSYNC_HISTORICAL_COMPATIBILITY,
    "0019-0022",
    "Historical 0019→0022 fixture only; use deploy/preview-transition.mjs and tests/current-baseline-upgrade.test.mjs for current candidates",
  );
  const versions = (
    await readdir(new URL("../../migrations/", import.meta.url))
  )
    .filter((name) => /^\d+_[^.]+\.sql$/.test(name))
    .map((name) => Number(name.split("_")[0]));
  assert.equal(
    Math.max(...versions),
    22,
    "Historical fixture requires its frozen 0022 candidate checkout; never bypass SQLx unknown-migration checks",
  );
}
