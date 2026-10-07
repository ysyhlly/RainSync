export function bestEffort<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    // Local telemetry must never prevent a media action or grant teardown.
    return undefined;
  }
}

export function freezeCandidateSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeCandidateSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

/** A retired response/reader can already be closed; cancellation owns no UI outcome. */
export function ignoreBodyCancellation(): void {
  // A closed/retired response has no further state to apply.
}
