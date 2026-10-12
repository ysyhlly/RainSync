// Closed, bounded diagnostic fields only. Never serialize an exception, SQL,
// response body, URL, configuration, credential, ciphertext or fingerprint.
const stages = new Set([
  "case_setup",
  "target_setup",
  "state_read",
  "state_before",
  "state_after",
  "fault_install",
  "http_wait",
  "http_body",
  "http_status",
  "http_redaction",
  "state_compare",
  "fault_remove",
  "sql_blocker_start",
  "sql_blocker_release",
  "sql_lock_wait",
  "fixture_cleanup",
  "binding_verify",
]);
const sections = ["source", "snapshot", "scan", "media"];
const signals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const codes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
function property(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}
function facts(input) {
  const value = {};
  for (const key of ["expected_status", "actual_status"]) {
    const status = integer(property(input, key), 100, 599);
    if (status !== undefined) value[key] = status;
  }
  for (const key of ["expected_count", "actual_count"]) {
    const count = integer(property(input, key), 0, 1_000_000);
    if (count !== undefined) value[key] = count;
  }
  const changed = property(input, "changed_sections");
  if (Array.isArray(changed))
    value.changed_sections = sections.filter((section) =>
      changed.includes(section),
    );
  return value;
}
export function changedStateSections(before, after) {
  return sections.filter(
    (section) => property(before, section) !== property(after, section),
  );
}
export function sourceChangeDeadline() {
  const error = Error("source_change_fixture_deadline");
  error.code = "RAINSYNC_SOURCE_CHANGE_DEADLINE";
  return error;
}
export function createSourceChangeDiagnostics(now = () => performance.now()) {
  let stage = "case_setup",
    started = now(),
    details = {};
  return {
    at(next, input) {
      stage = stages.has(next) ? next : "unknown_step";
      started = now();
      details = facts(input);
    },
    failure(error) {
      const name = property(error, "name"),
        code = property(error, "code");
      const causeCode = property(property(error, "cause"), "code");
      const transport = codes.has(code)
        ? code
        : codes.has(causeCode)
          ? causeCode
          : undefined;
      const category =
        code === "ERR_ASSERTION"
          ? "assertion_failed"
          : code === "RAINSYNC_SOURCE_CHANGE_DEADLINE" ||
              code === "ETIMEDOUT" ||
              name === "TimeoutError"
            ? "deadline"
            : name === "AbortError"
              ? "aborted"
              : transport
                ? "transport_failed"
                : name === "SyntaxError" && stage === "http_body"
                  ? "invalid_response_json"
                  : "verification_failed";
      const elapsed = Math.floor(now() - started);
      const result = { stage, category, ...details };
      if (Number.isFinite(elapsed))
        result.elapsed_ms = Math.min(3_600_000, Math.max(0, elapsed));
      const status = integer(property(error, "status"), 0, 255);
      if (status !== undefined) result.process_exit_status = status;
      const signal = property(error, "signal");
      if (signals.has(signal)) result.process_signal = signal;
      if (transport) result.transport_code = transport;
      return result;
    },
  };
}
