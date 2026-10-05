// Supervise only children spawned by this call. Never accepts a PID or an
// operator attestation; interruption/timeout cannot become a graceful receipt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

export async function ownedProcess(
  program,
  args,
  { env = process.env, timeoutMs = 10000, signal, graceMs = 3000 } = {},
) {
  signal?.throwIfAborted();
  const child = spawn(program, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    closed = false,
    timer,
    abortListener;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      if (output.length < 32768)
        output += bytes.toString("utf8").slice(0, 32768 - output.length);
    });
  let launchError;
  child.once("error", (error) => {
    launchError = error;
  });
  const done = new Promise((resolve) =>
    child.once("close", (exit_code, signal) => {
      closed = true;
      resolve({
        pid: child.pid ?? null,
        observed_close: true,
        exit_code,
        signal,
      });
    }),
  );
  const wait = async (ms) => {
    let deadline;
    try {
      return await Promise.race([
        done,
        new Promise((resolve) => {
          deadline = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  let failure, outcome;
  try {
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("owned_child_timeout")), timeoutMs);
      abortListener = () => reject(Error("owned_child_interrupted"));
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) abortListener();
    });
    outcome = await Promise.race([done, interrupted]);
    if (launchError) throw Error("owned_child_launch_failed");
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    if (!closed) {
      child.kill("SIGTERM");
      outcome = await wait(graceMs);
    }
    if (!closed) {
      child.kill("SIGKILL");
      outcome = await wait(graceMs);
    }
    // A stuck child leaves an explicit failed cleanup, never a success report.
    assert.ok(
      closed && outcome?.observed_close,
      "owned_child_cleanup_unconfirmed",
    );
  }
  if (failure) {
    failure.cleanup = outcome;
    throw failure;
  }
  return { ...outcome, output };
}

// Only fixture-created ChildProcess objects and their already-installed close
// promises are accepted. A forced cleanup is always reported as a failure.
export async function reapOwnedChildren(
  entries,
  { graceMs = 30000, killMs = 5000 } = {},
) {
  if (!entries.length) return;
  const done = Promise.all(entries.map((entry) => entry.closed));
  const wait = async (ms) => {
    let timer;
    try {
      return await Promise.race([
        done.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (const { child } of entries)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  if (await wait(graceMs)) return;
  for (const { child } of entries)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  assert.ok(await wait(killMs), "owned_fixture_cleanup_unconfirmed");
  throw Error("owned_fixture_forced_cleanup_not_graceful");
}

export async function withTerminationSignal(run) {
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(Error("preview_transition_interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    return await run(controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
