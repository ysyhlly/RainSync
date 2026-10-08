// Closed report categories: assertion messages/diffs, causes, stacks and raw
// command errors can contain tokens, URLs, ciphertext or private configuration.
export function safeFailure(error) {
  if (!error) return undefined;
  if (error.code === "ERR_ASSERTION") return "assertion_failed";
  if (error.name === "AbortError" || error.name === "TimeoutError")
    return "deadline_or_abort";
  return "verification_failed";
}
