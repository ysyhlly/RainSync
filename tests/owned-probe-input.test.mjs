import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { isOwnedProbeInput } from "./fixtures/owned-probe-input.mjs";

test("probe barrier matches only the owning Server descriptor and unchanged target identity", {
  skip: process.platform !== "linux" ? "Linux /proc descriptor contract" : false,
}, () => {
  const root = mkdtempSync(resolve(tmpdir(), "rainsync-owned-probe-"));
  const target = resolve(root, "target.mp4"), other = resolve(root, "other.mp4");
  writeFileSync(target, "original"); writeFileSync(other, "other");
  const fd = openSync(target, "r"), otherFd = openSync(other, "r");
  const input = `/proc/${process.pid}/fd/${fd}`;
  try {
    assert.equal(isOwnedProbeInput(input, target, process.pid), true);
    assert.equal(isOwnedProbeInput(input, target, process.pid + 1), false);
    assert.equal(isOwnedProbeInput(input, target, 0), false);
    assert.equal(isOwnedProbeInput(`/proc/self/fd/${fd}`, target, process.pid), false);
    assert.equal(isOwnedProbeInput(target, target, process.pid), false);
    assert.equal(isOwnedProbeInput(`/proc/${process.pid}/fd/${otherFd}`, target, process.pid), false);
    assert.equal(isOwnedProbeInput(`${input}/../${fd}`, target, process.pid), false);
    renameSync(target, resolve(root, "retained-original.mp4"));
    writeFileSync(target, "replacement");
    assert.equal(isOwnedProbeInput(input, target, process.pid), false,
      "a held old descriptor cannot identify the replacement pathname");
  } finally {
    closeSync(fd); closeSync(otherFd); rmSync(root, { recursive: true, force: true });
  }
});
