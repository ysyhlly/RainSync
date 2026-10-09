import { reapOwnedChildren } from "../../deploy/owned-process.mjs";
import { isolatedServer, delay, finishOwnedFixture } from "./server.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyClosedPort, verifyPidAbsent } from "./postgres.mjs";

// These observations cover only this fixture's original direct spawn calls.
// They do not observe Worker-internal or coordinator execFileSync descendants.
export function observeStackChild(observer, child, role, launch) {
  const record = {
    role: ["worker", "agent", "ffmpeg"].includes(role) ? role : "unknown",
    launch, pid: child.pid ?? null, started_at: new Date().toISOString(),
    closed_at: null, close_observed: false, exit_code: null, signal: null,
    spawn_error: false, pid_absent: null,
  };
  observer.children.push(record);
  child.once("error", () => { record.spawn_error = true; });
  child.once("close", (code, signal) => {
    Object.assign(record, { closed_at: new Date().toISOString(), close_observed: true, exit_code: code, signal });
  });
  return record;
}

// This opt-in wrapper keeps every original phase in the same try/finally order.
// Errors remain local; a later cleanup error cannot erase an earlier run error.
export async function runObservedStack({ observer, run, reap, closeStreams }) {
  try { await run(); }
  catch (error) { observer.run_failed = true; observer.run_error = error; throw error; }
  finally {
    try { await reap(); observer.reap_completed = true; }
    catch (error) { observer.reap_failed = true; observer.reap_error = error; throw error; }
    finally {
      try { await closeStreams(); }
      catch (error) { observer.streams_failed = true; observer.streams_error = error; throw error; }
    }
  }
}

export async function finishStackObservation({ observer, primaryError, primaryFailed, save, pidAbsent = verifyPidAbsent, portClosed = verifyClosedPort }) {
  const failures = [];
  const originals = [];
  for (const phase of ["run", "reap", "streams"])
    if (observer[`${phase}_failed`]) originals.push(observer[`${phase}_error`]);
  if (primaryFailed && !originals.includes(primaryError)) originals.push(primaryError);
  if (originals.length) {
    primaryError = originals.length === 1 ? originals[0] : new AggregateError(originals, "owned_stack_run_and_cleanup_failed");
    primaryFailed = true;
  }
  return finishOwnedFixture({
    primaryError, primaryFailed,
    // All original stack/Server/PostgreSQL cleanup has already run, unchanged.
    cleanup: async () => {},
    verifyStopped: async () => {
      if (!observer.fixture_id || !observer.callback_started) failures.push("stack_start_not_observed");
      if (!observer.reap_completed || observer.reap_failed) failures.push("stack_reap_not_confirmed");
      for (const child of observer.children) {
        if (!child.close_observed || !child.closed_at || child.spawn_error || child.role === "unknown") failures.push("stack_child_close_not_confirmed");
        if (!Number.isInteger(child.pid) || child.pid <= 0) {
          failures.push("stack_child_pid_not_observed");
          continue;
        }
        try { child.pid_absent = await pidAbsent(child.pid); }
        catch { child.pid_absent = null; failures.push("stack_child_pid_check_failed"); }
        if (child.pid_absent !== true) failures.push("stack_child_pid_absence_unconfirmed");
      }
      if (observer.children.some((child) => child.role === "worker")) {
        observer.worker_listener = { port: observer.worker_port, closed: null };
        try { observer.worker_listener.closed = await portClosed(observer.worker_port); }
        catch { failures.push("stack_worker_port_check_failed"); }
        if (observer.worker_listener.closed !== true) failures.push("stack_worker_port_closure_unconfirmed");
      }
      if (failures.length) throw Error("owned_stack_observation_unconfirmed");
      return { completed: true, children: observer.children, worker_listener: observer.worker_listener ?? null };
    },
    save: async (receipt) => save({
      schema_version: 1, kind: "media-stack-direct-children", ...receipt,
      scope: "Only original media-stack direct Worker/Agent/FFmpeg children; no Worker-internal or coordinator execFileSync descendant claim",
      fixture_id: observer.fixture_id ?? null, fixture_root: observer.fixture_root ?? null,
      callback_started: observer.callback_started, reap_completed: observer.reap_completed,
      reap_failed: observer.reap_failed, children: observer.children,
      worker_listener: observer.worker_listener ?? null, observation_failures: [...new Set(failures)],
      finished_at: new Date().toISOString(),
    }),
  });
}

async function port() {
  const server = createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r));
  const value = server.address().port; await new Promise(r => server.close(r)); return value;
}
export async function isolatedMediaStack(name, run, options = {}) {
  const enabled = process.env.RAINSYNC_MEDIA_STACK_EVIDENCE === "1";
  const observer = enabled ? { children: [], callback_started: false, reap_completed: false, reap_failed: false } : null;
  let reportPath;
  if (observer) {
    const directory = resolve(process.env.RAINSYNC_ARTIFACT_DIR, "media-stack-evidence", randomUUID());
    await mkdir(directory, { recursive: true });
    reportPath = resolve(directory, "report.json");
    await writeFile(reportPath, JSON.stringify({ schema_version: 1, kind: "media-stack-direct-children", result: "running", fixture_name: name, started_at: new Date().toISOString() }, null, 2));
  }
  const execute = (actualOptions) => isolatedServer(name, async f => {
    if (observer) observer.callback_started = true;
    const children = new Set(), streams = [];
    let worker, agent, agentPair, launch = 0;
    const workerPort = await port(); f.workerOrigin = `http://127.0.0.1:${workerPort}`;
    if (observer) observer.worker_port = workerPort;
    const start = (binary, env, args = [], role) => {
      f.abortSignal?.throwIfAborted();
      const log = createWriteStream(resolve(f.root, `child-${++launch}.log`)); streams.push(log);
      const child = spawn(binary, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child); child.failure = null;
      if (observer) observeStackChild(observer, child, role, launch);
      child.once("error", e => child.failure = e);
      child.done = new Promise(r => child.once("close", code => { children.delete(child); r(code); }));
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); return child;
    };
    const stop = async child => {
      if (!child) return null;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const code = await child.done;
      return { pid: child.pid ?? null, observed_close: true, exit_code: code, signal: child.signalCode };
    };
    f.startWorker = async (extra = {}) => {
      if (worker?.exitCode === null) throw Error("Worker already owned and running");
      worker = start(resolve(f.target, `rainsync-media-worker${process.platform === "win32" ? ".exe" : ""}`), { ...f.env, WORKER_BIND: `127.0.0.1:${workerPort}`, PUBLIC_ORIGIN: f.workerOrigin, ...extra }, [], "worker");
      f.workerPid = worker.pid;
      for (let i=0; i<100; i++) {
        f.abortSignal?.throwIfAborted();
        if (worker.failure || worker.exitCode !== null) throw Error("Fixture Worker failed; inspect child log");
        try { if ((await fetch(f.workerOrigin + "/health")).ok) return; } catch {}
        await delay(100);
      }
      throw Error("Fixture Worker timeout");
    };
    f.stopWorker = async () => { const outcome = await stop(worker); worker = undefined; return outcome; };
    f.startAgent = async ({ mediaRoot = f.root } = {}) => {
      const admin = f.client(); await admin.login();
      const created = agentPair ??= await admin.request("/agents", "POST", { name: "owned preview agent" });
      agent = start(resolve(f.target, `rainsync-nas-agent${process.platform === "win32" ? ".exe" : ""}`), { ...f.env, SERVER_URL: f.origin, AGENT_DATA_ORIGIN: f.workerOrigin, PAIR_CODE: created.pair_code, MEDIA_ROOT: mediaRoot, AGENT_CREDENTIAL_FILE: resolve(f.root, "agent-token") }, [], "agent");
      f.agentPid = agent.pid;
      return { agentId: created.id };
    };
    f.stopAgent = async () => { const outcome = await stop(agent); agent = undefined; return outcome; };
    f.makeClip = async (name, { blackSeconds = 0, pictureSeconds = 1, width = 640, height = 360, color = "red", rotate = 0 } = {}) => {
      const file = resolve(f.root, name);
      const filter = blackSeconds ? `color=black:s=${width}x${height}:r=25:d=${blackSeconds}[a];color=${color}:s=${width}x${height}:r=25:d=${pictureSeconds}[b];[a][b]concat=n=2:v=1:a=0` : `color=${color}:s=${width}x${height}:r=25:d=${pictureSeconds}`;
      const child = start("ffmpeg", f.env, ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", filter, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", ...(rotate ? ["-metadata:s:v:0", `rotate=${rotate}`] : []), file], "ffmpeg");
      const timeout = setTimeout(() => child.kill(), 15000);
      try { if (await child.done !== 0) throw Error("Fixture clip generation failed"); } finally { clearTimeout(timeout); }
      return file;
    };
    let previewClient;
    f.waitForPreview = async (mediaId, expectedStatus = "ready", timeout = 45000) => {
      if (!previewClient) { previewClient = f.client(); await previewClient.login(); }
      const client = previewClient;
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const result = await client.request(`/media/previews?ids=${mediaId}`);
        const cover = result.items[0]?.cover;
        if (cover?.status === expectedStatus) return cover;
        if (cover?.status === "unavailable" && expectedStatus !== "unavailable") throw Error("Preview unavailable");
        await delay(100);
      }
      throw Error(`Preview did not become ${expectedStatus}`);
    };
    if (observer) return runObservedStack({
      observer,
      run: async () => { await writeFile(resolve(f.root, "ownership.json"), JSON.stringify({ fixture: f.id, container: f.container, workerPort })); await run(f); },
      reap: () => reapOwnedChildren([...children].map(child => ({ child, closed: child.done }))),
      closeStreams: async () => { for (const stream of streams) await new Promise(r => stream.end(r)); },
    });
    try { await writeFile(resolve(f.root, "ownership.json"), JSON.stringify({ fixture: f.id, container: f.container, workerPort })); await run(f); }
    finally {
      try { await reapOwnedChildren([...children].map(child => ({ child, closed: child.done }))); }
      finally { for (const stream of streams) await new Promise(r => stream.end(r)); }
    }
  }, actualOptions);
  if (!observer) return execute(options);
  let value, primaryError, primaryFailed = false;
  try {
    value = await execute({ ...options, beforeStart: async (f) => {
      observer.fixture_id = f.id; observer.fixture_root = f.root;
      await options.beforeStart?.(f);
    } });
  } catch (error) { primaryError = error; primaryFailed = true; }
  await finishStackObservation({ observer, primaryError, primaryFailed,
    save: (report) => writeFile(reportPath, JSON.stringify({ fixture_name: name, ...report }, null, 2) + "\n") });
  return value;
}
