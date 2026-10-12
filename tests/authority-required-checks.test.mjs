import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const expected = JSON.parse(read("tests/fixtures/authority-required-checks.json"));
const counts = [6, 5, 10, 6, 8, 8];

for (const [index, [name, names]] of Object.entries(expected).entries()) {
  test(`${name} rejects incomplete, duplicate, unknown, reordered or failed checks`, () => {
    const source = read(`tests/${name}.mjs`);
    const declaration = source.match(/const requiredChecks = (\[[\s\S]*?\]);/);
    assert.ok(declaration, "The fixed check set must be independent of dynamic cases");
    const actualNames = JSON.parse(declaration[1]);
    assert.deepEqual(actualNames, names);
    assert.equal(actualNames.length, counts[index]);
    assert.equal(new Set(actualNames).size, actualNames.length);
    const statement = source.match(/assert\.deepEqual\(report\.checks, requiredChecks\.map\(\(name\) => \(\{ name, result: "passed" \}\)\),\s*"Every frozen native check must complete exactly once"\);/);
    assert.ok(statement, "The callback must enforce its complete fixed set");
    // Execute the actual, narrowly matched pure assertion, not a second validator.
    const verify = new Function("assert", "report", "requiredChecks", statement[0]);
    const passed = names.map((name) => ({ name, result: "passed" }));
    verify(assert, { checks: passed }, actualNames);
    for (const invalid of [
      passed.slice(0, -1),
      [...passed, passed[0]],
      [{ name: "unknown_check", result: "passed" }, ...passed.slice(1)],
      [...passed].reverse(),
      [{ ...passed[0], result: "failed" }, ...passed.slice(1)],
      [],
    ]) {
      assert.throws(() => verify(assert, { checks: invalid }, actualNames),
        assert.AssertionError);
    }
  });
}

test("all finite authority gates and their pure contracts stay registered", () => {
  const pkg = JSON.parse(read("package.json"));
  const workflow = read(".github/workflows/ci.yml");
  const ownerJob = workflow.slice(workflow.indexOf("  owner-gates:"));
  assert.match(ownerJob, /^  owner-gates:[\s\S]*?timeout-minutes: 75/);
  for (const name of Object.keys(expected)) {
    assert.equal(pkg.scripts[`test:${name}`], `node tests/${name}.mjs`);
    const step = ownerJob.split(/(?=      - name:)/)
      .find((text) => text.includes(`node tests/${name}.mjs`));
    assert.ok(step, name);
    assert.match(step, /if: \$\{\{ !cancelled\(\) && steps\.binding\.outcome == 'success' \}\}/);
    assert.match(step, /timeout-minutes: 5/);
    assert.ok(step.includes(`timeout --signal=TERM --kill-after=45s 240s node tests/${name}.mjs`));
    assert.doesNotMatch(step, /continue-on-error/);
  }
  for (const file of [
    "room-kick-seed-contract.test.mjs", "room-guest-access-contract.test.mjs", "room-lifecycle-source-contract.test.mjs",
    "room-lifecycle-snapshot.test.mjs", "room-lifecycle-clock-socket.test.mjs",
    "room-directory-clock-socket.test.mjs", "short-platform-account-snapshot.test.mjs",
    "short-platform-account-response.test.mjs", "short-platform-account-schema.test.mjs",
    "authority-required-checks.test.mjs", "media-preview-admission-contract.test.mjs",
    "room-playlist-contract.test.mjs", "room-playlist-socket.test.mjs",
  ]) assert.ok(pkg.scripts["test:backend-contracts"].includes(`tests/${file}`), file);
  assert.ok(workflow.includes("npm run test:backend-contracts"));
});

test("kick synthetic media helper also participates in the final coordinator recheck", () => {
  const source = read("tests/room-kick-authority-native.mjs");
  assert.ok(source.includes("report.coordinator.push(...report.additional_coordinator);"));
  assert.ok(source.includes("report.additional_coordinator_unchanged=true;"));
});
