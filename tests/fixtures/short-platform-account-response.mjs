// Response consumption is tracked independently of HTTP assertions. bodyUsed
// only means a read started; it never proves that the read reached EOF.
export function trackResponseBody(pending) {
  let readPromise;
  let bodyDrained = false;
  return {
    read() {
      return readPromise ??= Promise.resolve(pending).then(async (response) => {
        const text = await response.text();
        bodyDrained = true;
        return text;
      });
    },
    get bodyDrained() { return bodyDrained; },
  };
}

// Use the existing two 12-second cleanup waits. No trigger DROP can start until
// the exact response body read has completed successfully. Unconfirmed drain
// remains a cleanup failure; the owned fixture teardown then stops its services.
export async function cleanupShortAccountCase(options) {
  // Existing callers pass undefined for no failure; an explicit flag preserves
  // a caught throw undefined without changing those successful cleanup calls.
  const { pending, body, wait, release, record, drop, primaryError,
    primaryFailed = primaryError !== undefined } = options;
  const errors = [];
  if (release) {
    try { await release(); }
    catch (error) { errors.push(error); }
  }
  if (pending) {
    try {
      const response = await wait(pending, 12000);
      const text = await wait(body.read(), 12000);
      if (record) await record(response, text);
    } catch (error) { errors.push(error); }
  }
  if (drop) {
    if (pending && !body?.bodyDrained) {
      errors.push(Error("short_body_drain_unconfirmed"));
    } else {
      try { await drop(); }
      catch (error) { errors.push(error); }
    }
  }
  if (errors.length) {
    throw new AggregateError(
      [...(primaryFailed ? [primaryError] : []), ...errors],
      "first_failure_and_cleanup",
    );
  }
  if (primaryFailed) throw primaryError;
}

// Only for the existing mode-0600 private failure receipt. The public report
// must continue to contain fixed categories rather than these error details.
export function privateFailureDetails(error, ancestors = new Set()) {
  if (!(error instanceof Error))
    return { name: "NonErrorFailure", message: String(error) };
  // Keep serialization failures explicit: callers preserve the original and
  // this failure, then attempt a fixed private fallback and the safe report.
  if (ancestors.has(error)) throw Error("private_failure_cycle");
  ancestors.add(error);
  try {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error instanceof AggregateError || Object.hasOwn(error, "errors") || Object.hasOwn(error, "privateErrors")
        ? { errors: [
          ...(error instanceof AggregateError || Object.hasOwn(error, "errors") ? error.errors : []),
          ...(Object.hasOwn(error, "privateErrors") ? error.privateErrors : []),
        ].map(item => privateFailureDetails(item, ancestors)) } : {}),
      ...(Object.hasOwn(error, "cause")
        ? { cause: privateFailureDetails(error.cause, ancestors) } : {}),
    };
  } finally {
    ancestors.delete(error);
  }
}
