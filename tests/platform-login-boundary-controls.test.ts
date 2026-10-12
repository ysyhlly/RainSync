import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestFailure } from "../apps/web/src/errors";
import { createPlatformLoginFlow } from "../apps/web/src/features/account/platform-login-flow";

// Deliberately unsafe variants are evaluated only in memory. No source file is
// rewritten, and all transport functions are local promise stubs.
const source = readFileSync(
  new URL(
    "../apps/web/src/features/account/platform-login-flow.ts",
    import.meta.url,
  ),
  "utf8",
);
const apply =
  "  function apply(raw: unknown, generation: number, fromPoll = false) {";
const parse = "    const value = validate(raw, fromPoll);";
const id = "00000000-0000-0000-0000-000000000001";
const otherId = "00000000-0000-0000-0000-000000000002";
const payload =
  "https://passport.bilibili.com/h5-app/passport/login?oauthKey=synthetic-qr-capability-0123456789";
const response = () => ({
  id,
  provider: "bilibili",
  status: "pending",
  stage: "waiting",
  qr_payload: payload,
  server_time: 0,
  next_poll_at: 3000,
  expires_at: 5000,
});
function variant(
  transform: (source: string) => string,
): typeof createPlatformLoginFlow {
  const changed = transform(source);
  expect(changed).not.toBe(source);
  const code = ts.transpileModule(changed, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((path: string) => {
    expect(path).toBe("../../errors");
    return { RequestFailure };
  }, exports);
  return exports.createPlatformLoginFlow as typeof createPlatformLoginFlow;
}
function deferred() {
  let resolve!: (raw: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

it("detects parse-before-current and parse-before-deadline negative controls", async () => {
  for (const fence of ["current", "deadline"] as const) {
    const unsafe = variant((text) =>
      text
        .replace(parse, "")
        .replace(
          fence === "current"
            ? apply
            : "    // A resumed tab may process a settled request before its overdue timer.",
          fence === "current"
            ? `${apply}\n${parse}`
            : `${parse}\n    // A resumed tab may process a settled request before its overdue timer.`,
        ),
    );
    for (const [create, expectTouched] of [
      [createPlatformLoginFlow, false],
      [unsafe, true],
    ] as const) {
      vi.setSystemTime(0);
      let current = true;
      const delayed = deferred();
      const get = vi.fn(() => {
        throw Error("Poisoned receipt was parsed");
      });
      const raw = Object.defineProperty({}, "id", { get });
      const f = create({
        current: () => current,
        start:
          fence === "current" ? () => delayed.promise : async () => response(),
        poll: () => delayed.promise,
        cancel: async () => {},
        change() {},
        confirmed() {},
        uuid: () => id,
        now: () => Date.now(),
      });
      const starting = f.start();
      if (fence === "current") current = false;
      else {
        await starting;
        await vi.advanceTimersByTimeAsync(3000);
        vi.setSystemTime(10000);
      }
      delayed.resolve(raw);
      await starting;
      await Promise.resolve();
      await Promise.resolve();
      expect(get.mock.calls.length > 0).toBe(expectTouched);
      await f.close();
    }
  }
});

it("detects returning the raw DTO instead of the whitelisted snapshot", async () => {
  const unsafe = variant((text) =>
    text.replace(
      /    const value: PlatformLogin = \{[\s\S]*?\n    \};/,
      "    const value = record as unknown as PlatformLogin;",
    ),
  );
  for (const [create, expectedId] of [
    [createPlatformLoginFlow, id],
    [unsafe, otherId],
  ] as const) {
    vi.setSystemTime(0);
    const raw = response();
    const poll = vi.fn(async () => ({ ...response(), qr_payload: null }));
    const f = create({
      current: () => true,
      start: async () => raw,
      poll,
      cancel: async () => {},
      change() {},
      confirmed() {},
      uuid: () => id,
      now: () => Date.now(),
    });
    await f.start();
    raw.id = otherId;
    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledExactlyOnceWith(
      expectedId,
      expect.any(AbortSignal),
    );
    await f.close();
  }
});
