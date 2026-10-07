export type CookieAccountPhase =
  "idle" | "submitting" | "stored" | "uncertain" | "invalid";

/** Single-use submission: never retain a secret for retry or publish after close. */
export function createCookieAccountFlow<
  Status extends { state: string },
>(options: {
  current: () => boolean;
  hasInput: (secret: string) => boolean;
  validateInput: (secret: string) => boolean;
  validateStatus: (value: Status) => unknown;
  submit: (
    secret: string,
    revision: string | null,
    signal: AbortSignal,
  ) => Promise<Status>;
  clearSecret: () => void;
  change: (phase: CookieAccountPhase) => void;
}) {
  let closed = false,
    busy = false;
  const controller = new AbortController();
  const current = () =>
    !closed && !controller.signal.aborted && options.current();
  async function submit(
    secret: string,
    revision: string | null,
    consent: boolean,
  ) {
    if (!current() || busy || !consent || !options.hasInput(secret)) return;
    busy = true;
    options.clearSecret();
    if (!options.validateInput(secret)) {
      secret = "";
      busy = false;
      options.change("invalid");
      return;
    }
    options.change("submitting");
    try {
      const value = await options.submit(secret, revision, controller.signal);
      secret = "";
      if (!current()) return;
      options.validateStatus(value);
      options.change(value.state === "connected" ? "stored" : "uncertain");
    } catch {
      // Never surface service error text that could echo a session credential.
      if (current()) options.change("uncertain");
    } finally {
      secret = "";
      busy = false;
    }
  }
  function close() {
    closed = true;
    controller.abort();
    options.clearSecret();
  }
  return { submit, close };
}
