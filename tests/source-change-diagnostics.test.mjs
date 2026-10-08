import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedStateSections,
  createSourceChangeDiagnostics,
  sourceChangeDeadline,
} from "./fixtures/source-change-diagnostics.mjs";

test("source diagnostics retain only bounded status/count and fixed failure fields", () => {
  let now = 100;
  const diagnostics = createSourceChangeDiagnostics(() => now);
  diagnostics.at("http_status", {
    expected_status: 500,
    actual_status: 503,
    expected_count: 0,
    actual_count: 1,
    url: "SECRET",
    config: "SECRET",
    message: "SECRET",
  });
  now = 123;
  const error = Object.assign(Error("SECRET response URL"), {
    code: "ERR_ASSERTION",
    actual: "SECRET",
    expected: "SECRET",
    status: 1,
    signal: "SIGTERM",
    cause: { message: "SECRET" },
  });
  assert.deepEqual(diagnostics.failure(error), {
    stage: "http_status",
    category: "assertion_failed",
    expected_status: 500,
    actual_status: 503,
    expected_count: 0,
    actual_count: 1,
    elapsed_ms: 23,
    process_exit_status: 1,
    process_signal: "SIGTERM",
  });
  assert.doesNotMatch(JSON.stringify(diagnostics.failure(error)), /SECRET/);
});

test("unknown stages, fields, exception values and out-of-range numbers cannot enter a report", () => {
  const diagnostics = createSourceChangeDiagnostics(() => 0);
  diagnostics.at("SECRET", {
    actual_status: Infinity,
    expected_status: 99,
    actual_count: -1,
    expected_count: 1_000_001,
    changed_sections: ["SECRET", "media", "media", "source"],
  });
  for (const error of [
    undefined,
    null,
    false,
    "SECRET",
    {
      name: "SECRET",
      code: "SECRET",
      status: 256,
      signal: "SECRET",
      cause: { code: "SECRET" },
    },
    {
      get code() {
        throw Error("SECRET");
      },
    },
  ]) {
    assert.deepEqual(diagnostics.failure(error), {
      stage: "unknown_step",
      category: "verification_failed",
      changed_sections: ["source", "media"],
      elapsed_ms: 0,
    });
  }
});

test("custom fixture deadlines and safe transport or response failures remain distinguishable", () => {
  const diagnostics = createSourceChangeDiagnostics(() => 0);
  diagnostics.at("http_wait", { expected_status: 500 });
  assert.equal(
    diagnostics.failure(sourceChangeDeadline()).category,
    "deadline",
  );
  assert.equal(diagnostics.failure({ name: "AbortError" }).category, "aborted");
  assert.deepEqual(
    diagnostics.failure({ cause: { code: "ECONNRESET", message: "SECRET" } }),
    {
      stage: "http_wait",
      category: "transport_failed",
      expected_status: 500,
      elapsed_ms: 0,
      transport_code: "ECONNRESET",
    },
  );
  diagnostics.at("http_body", { expected_status: 500, actual_status: 500 });
  assert.equal(
    diagnostics.failure(new SyntaxError("SECRET")).category,
    "invalid_response_json",
  );
});

test("state mismatch diagnostics name changed sections without retaining fingerprints or values", () => {
  const changed = changedStateSections(
    { source: "SECRET-before", snapshot: "same", scan: "same", media: "same" },
    {
      source: "SECRET-after",
      snapshot: "same",
      scan: "same",
      media: "changed",
    },
  );
  assert.deepEqual(changed, ["source", "media"]);
  const diagnostics = createSourceChangeDiagnostics(() => 0);
  diagnostics.at("state_compare", { changed_sections: changed });
  assert.doesNotMatch(
    JSON.stringify(diagnostics.failure(Error("SECRET"))),
    /SECRET|before|after/,
  );
});
