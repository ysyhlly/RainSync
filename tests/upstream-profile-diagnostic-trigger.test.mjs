import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const workflow = await readFile(new URL("../.github/workflows/upstream-products.yml", import.meta.url), "utf8");
const expression = /- name: Observe raw Emby profile behavior \(explicit opt-in only\)\n\s+if: \$\{\{ (.+) \}\}/.exec(workflow)?.[1];
const expected = "always() && ((github.event_name == 'workflow_dispatch' && inputs.run_emby_profile_diagnostic) || (github.event_name == 'push' && github.ref == 'refs/heads/integration/v0.1-next' && contains(github.event.head_commit.message, '[run-emby-profile-diagnostic]')))";
// This exact, intentionally small GitHub expression also uses valid JS syntax.
// Lowercasing event/ref mirrors GitHub string equality for these lowercase
// literals; contains() mirrors its case-insensitive search. No generic YAML or
// GitHub expression interpreter is claimed by these static trigger checks.
function eligible(event, ref, message = "", requested = false) {
  assert.equal(expression, expected);
  return Boolean(vm.runInNewContext(expression, {
    always: () => true,
    contains: (value, marker) => String(value ?? "").toLowerCase().includes(marker.toLowerCase()),
    github: { event_name: event.toLowerCase(), ref: ref.toLowerCase(), event: { head_commit: { message } } },
    inputs: { run_emby_profile_diagnostic: requested },
  }, { timeout: 100 }));
}

test("explicit exact-branch marked push opts in; ordinary pushes do not", () => {
  const ref = "refs/heads/integration/v0.1-next";
  assert.equal(eligible("push", ref, "Run bounded observation [run-emby-profile-diagnostic]"), true);
  assert.equal(eligible("push", ref, "Routine implementation"), false);
  assert.equal(eligible("push", ref, "[run-emby-profile]"), false);
  assert.equal(eligible("push", ref, undefined), false);
  assert.equal(eligible("push", ref, "", true), false, "dispatch input cannot opt in a push");
});
test("marker cannot opt in another branch, tag or pull request", () => {
  const marker = "[run-emby-profile-diagnostic]";
  for (const ref of ["refs/heads/main", "refs/heads/integration/v0.1-next-extra", "refs/tags/integration/v0.1-next", "refs/pull/1/merge"])
    assert.equal(eligible("push", ref, marker), false);
  for (const event of ["pull_request", "pull_request_target", "schedule", "workflow_run"])
    assert.equal(eligible(event, "refs/heads/integration/v0.1-next", marker, true), false);
});
test("existing explicit manual input remains supported and defaults off", () => {
  assert.equal(eligible("workflow_dispatch", "refs/heads/integration/v0.1-next", "", true), true);
  assert.equal(eligible("workflow_dispatch", "refs/heads/integration/v0.1-next", "[run-emby-profile-diagnostic]"), false);
});
test("workflow push filter stays restricted and only head commit is consulted", () => {
  assert.match(workflow, /push:\n\s+branches: \[integration\/v0\.1-next\]/);
  assert.match(workflow, /run_emby_profile_diagnostic:[\s\S]*?type: boolean\n\s+default: false/);
  assert.ok(!expression.includes("commits"));
  assert.match(workflow, /node --test [^\n]*tests\/upstream-profile-diagnostic-trigger\.test\.mjs/);
});
