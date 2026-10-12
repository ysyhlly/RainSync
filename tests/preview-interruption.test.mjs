import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ownedProcess,
  withTerminationSignal,
} from "../deploy/owned-process.mjs";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";
import { delay } from "./fixtures/server.mjs";

test("owned child successful close, timeout and abort always reap the child", async () => {
  const completed = await ownedProcess(process.execPath, [
    "-e",
    "process.stdout.write('owned fixture'); process.exitCode=2",
  ]);
  assert.equal(completed.exit_code, 2);
  assert.equal(completed.signal, null);
  assert.equal(completed.observed_close, true);
  assert.ok(verifyPidAbsent(completed.pid));
  for (const interrupted of [false, true]) {
    const controller = new AbortController();
    let timer;
    if (interrupted) timer = setTimeout(() => controller.abort(), 80);
    try {
      await assert.rejects(
        ownedProcess(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
          {
            timeoutMs: interrupted ? 5000 : 80,
            graceMs: 100,
            signal: controller.signal,
          },
        ),
        (error) => {
          assert.match(error.message, interrupted ? /interrupted/ : /timeout/);
          assert.equal(error.cleanup.observed_close, true);
          assert.notEqual(error.cleanup.exit_code, 0);
          assert.ok(verifyPidAbsent(error.cleanup.pid));
          return true;
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }
});

test(
  "controlled SIGTERM handler cancels and cleans up an actual owned native stack",
  {
    skip:
      !process.env.RAINSYNC_NATIVE_POSTGRES_BIN ||
      !process.env.RAINSYNC_INTERRUPT_TEST_TARGET
        ? "set owned native PostgreSQL and frozen RAINSYNC_INTERRUPT_TEST_TARGET"
        : false,
  },
  async () => {
    const previous = process.env.CARGO_TARGET_DIR;
    process.env.CARGO_TARGET_DIR = process.env.RAINSYNC_INTERRUPT_TEST_TARGET;
    let fixture;
    const pids = [];
    try {
      await assert.rejects(
        withTerminationSignal((signal) =>
          isolatedMediaStack(
            "preview-interruption",
            async (f) => {
              fixture = f;
              await f.startWorker();
              const { agentId } = await f.startAgent();
              const client = f.client();
              await client.login();
              let connected = false;
              for (let i = 0; i < 100; i++) {
                connected = (await client.request("/agents")).some(
                  (agent) => agent.id === agentId && agent.connected,
                );
                if (connected) break;
                await delay(50);
              }
              assert.ok(connected);
              pids.push(f.serverPid, f.workerPid, f.agentPid);
              // Exercise the CLI's exact handler with a controlled event; no external
              // process/production service receives a signal from this test.
              process.emit("SIGTERM");
              signal.throwIfAborted();
            },
            { signal },
          ),
        ),
        /preview_transition_interrupted/,
      );
      assert.ok(fixture);
      await fixture.verifyStopped();
      for (const pid of pids) assert.ok(verifyPidAbsent(pid));
    } finally {
      if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = previous;
    }
  },
);


test("borrowed output descriptor retains complete stdout/stderr beyond the console cap", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "rainsync-owned-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "driver.private.log");
  const fd = openSync(path, "wx", 0o600);
  let result;
  try {
    result = await ownedProcess(process.execPath, ["-e",
      "process.stdout.write('X'.repeat(40000));process.stderr.write('owned-stderr-complete')",
    ], { outputFd: fd });
  } finally { closeSync(fd); }
  assert.equal(result.exit_code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.observed_close, true);
  assert.equal(verifyPidAbsent(result.pid), true);
  assert.equal(result.output, "", "direct descriptor does not claim bounded console capture");
  const bytes = await readFile(path);
  assert.equal(bytes.length, 40000 + Buffer.byteLength("owned-stderr-complete"));
  assert.equal(bytes.toString().replaceAll("owned-stderr-complete", ""), "X".repeat(40000));
});
