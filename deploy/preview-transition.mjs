// Executable upgrade/rollback rehearsal on a fresh, owned local environment.
// It intentionally has no option for an existing DATABASE_URL, production
// Compose project, PID, drain attestation, or historical Agent release proof.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  rename,
} from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "../tests/fixtures/media-stack.mjs";
import { delay } from "../tests/fixtures/server.mjs";
import { preflight } from "./postgres-recovery.mjs";
import { mediaLoginPreflight } from "../scripts/media-login-preflight.mjs";
import { sourceAccessPairPreflight } from "../scripts/source-access-preflight.mjs";
import { createRecoverySet, restoreRecoverySet } from "./recovery-set.mjs";
import { endpointChecks, configuration } from "./diagnose.mjs";
import { ownedProcess, withTerminationSignal } from "./owned-process.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
export async function verifiedBuild(bindingPath, sourceRoot) {
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  assert.equal(
    binding.result,
    "passed",
    "successful source-bound build required",
  );
  assert.equal(binding.build?.exit_code, 0);
  assert.ok(binding.source?.length > 0);
  assert.equal(sha(JSON.stringify(binding.source)), binding.source_digest);
  for (const item of binding.source) {
    assert.ok(
      !isAbsolute(item.path) &&
        item.path
          .split(/[\\/]/)
          .every((part) => part && part !== ".." && part !== "."),
      "invalid bound source path",
    );
    assert.equal(
      sha(await readFile(resolve(sourceRoot, item.path))),
      item.sha256,
      "bound source changed; freeze it before rehearsal",
    );
  }
  const binaries = {};
  for (const name of [
    "rainsync-server",
    "rainsync-media-worker",
    "rainsync-nas-agent",
  ]) {
    const binary = binding.binaries.find((binary) => binary.name === name);
    assert.ok(binary);
    assert.equal(
      sha(await readFile(binary.path)),
      binary.sha256,
      "bound binary changed; use copied immutable build sets",
    );
    binaries[name] = binary;
  }
  assert.equal(
    new Set(
      Object.values(binaries).map((binary) => dirname(resolve(binary.path))),
    ).size,
    1,
    "binary set must share one frozen directory",
  );
  return {
    binding,
    sourceRoot: resolve(sourceRoot),
    directory: dirname(resolve(binaries["rainsync-server"].path)),
    binaries,
  };
}
const until = async (check, label, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw Error(label);
};
const bounded = async (promise, label, ms = 30000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
async function stop(f) {
  // Each fixture method waits on its own ChildProcess close event. No PID/UUID
  // assertion or reconnect status is used as physical process release proof.
  const outcomes = await bounded(
    Promise.all([f.stopServer(), f.stopWorker(), f.stopAgent()]),
    "owned process drain deadline exceeded; rollback is blocked until actual exit",
  );
  for (const outcome of outcomes) {
    assert.ok(outcome?.observed_close, "missing owned process close event");
    assert.equal(
      outcome.exit_code,
      0,
      "owned process exit was not a successful graceful drain",
    );
    assert.equal(
      outcome.signal,
      null,
      "signal-terminated process is not a successful graceful drain",
    );
  }
  return outcomes;
}
async function keyFailure(binary, env, signal) {
  const outcome = await ownedProcess(binary, [], {
    env: { ...env, SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
    signal,
  });
  assert.notEqual(outcome.exit_code, 0);
  assert.equal(
    outcome.signal,
    null,
    "wrong-key diagnosis requires normal process exit, not a kill",
  );
  assert.match(outcome.output, /source_key_mismatch_or_corrupt_ciphertext/);
}
async function applyRecoveredConfiguration(f, output) {
  const config = JSON.parse(
    await readFile(resolve(output, "configuration.json"), "utf8"),
  );
  const key = JSON.parse(
    await readFile(resolve(output, "source-key.json"), "utf8"),
  );
  await configuration({ ...config, SOURCE_ENCRYPTION_KEY: key.key });
  f.env = { ...f.env, ...config, SOURCE_ENCRYPTION_KEY: key.key };
}
// This native fixture addresses components directly rather than exposing a
// browser reverse proxy. Override only Worker public/media addressing explicitly;
// all other restored configuration is actually applied unchanged.
const startWorker = (f) =>
  f.startWorker({
    MEDIA_ORIGIN: f.workerOrigin,
    AGENT_DATA_ORIGIN: f.workerOrigin,
  });

async function roomControl(f, client, room) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  const frames = [];
  ws.on("message", (data) => frames.push(JSON.parse(data)));
  ws.on("error", () => {});
  const abort = () => ws.terminate();
  f.abortSignal?.addEventListener("abort", abort, { once: true });
  ws.once("close", () => f.abortSignal?.removeEventListener("abort", abort));
  if (f.abortSignal?.aborted) abort();
  const next = async (type, predicate = () => true) => {
    let frame;
    await until(() => {
      const index = frames.findIndex(
        (value) => value.type === type && predicate(value),
      );
      if (index < 0) return false;
      frame = frames.splice(index, 1)[0];
      return true;
    }, `missing room ${type}`);
    return frame;
  };
  await bounded(
    new Promise((done, reject) => {
      ws.once("open", done);
      ws.once("error", reject);
    }),
    "room connection failed",
    10000,
  );
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next("SNAPSHOT");
  let state = snapshot.state;
  return {
    get state() {
      return state;
    },
    async command(type, payload) {
      const command_id = randomUUID();
      ws.send(
        JSON.stringify({
          protocol_version: 1,
          room_id: room.id,
          command_id,
          control_epoch: snapshot.control_epoch.id,
          expected_revision: state.revision,
          media_generation: state.media_generation,
          type,
          payload,
        }),
      );
      state = (await next("ACK", (frame) => frame.command_id === command_id))
        .state;
      return state;
    },
    close() {
      ws.terminate();
    },
  };
}
async function playbackSmoke(f, client, room, media, mode, checks) {
  const control = await roomControl(f, client, room);
  const createPlan = (state, position_ms) =>
    client.request("/playback-sessions", "POST", {
      room_id: room.id,
      media_generation: state.media_generation,
      mode,
      position_ms,
      idempotency_key: randomUUID(),
    });
  const readPlan = async (plan) => {
    const url = new URL(plan.playback_url, f.workerOrigin);
    let bytes;
    await until(
      async () => {
        f.abortSignal?.throwIfAborted();
        try {
          const response = await fetch(url, {
            signal: f.abortSignal
              ? AbortSignal.any([f.abortSignal, AbortSignal.timeout(5000)])
              : AbortSignal.timeout(5000),
          });
          if (!response.ok) return false;
          bytes = Buffer.from(await response.arrayBuffer());
          return bytes.length > 0;
        } catch (error) {
          f.abortSignal?.throwIfAborted();
          return false;
        }
      },
      "playback bytes unavailable",
      45000,
    );
    if (mode === "transcode") {
      assert.match(bytes.toString("utf8"), /^#EXTM3U/);
      const paths = bytes
        .toString("utf8")
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"));
      assert.ok(paths.length > 0);
      const segment = await fetch(new URL(paths[0], url), {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(segment.status, 200);
      assert.ok((await segment.arrayBuffer()).byteLength > 0);
    }
    return url;
  };
  const stopPlan = async (plan, url) => {
    await client.request(`/playback-sessions/${plan.session_id}`, "DELETE");
    assert.equal(
      (await fetch(url, { signal: AbortSignal.timeout(5000) })).status,
      401,
    );
  };
  try {
    const state = await control.command("CHANGE_MEDIA", { media_id: media.id });
    const initial = await createPlan(state, 0);
    await stopPlan(initial, await readPlan(initial));
    const sought = await control.command("SEEK", { position_ms: 500 });
    const seekPlan = await createPlan(sought, 500);
    if (mode === "transcode") assert.equal(seekPlan.timeline_origin_ms, 500);
    await stopPlan(seekPlan, await readPlan(seekPlan));
    checks.push(
      mode === "transcode"
        ? "transcoded playlist/segment delivery, fresh 500ms seek plan bytes and independent stop revocation"
        : "direct delivery, fresh seek plan bytes and independent stop revocation",
    );
  } finally {
    control.close();
  }
}
// SQL migration compatibility does not establish caller-authorization semantics.
// A two-build rehearsal includes rollback: reject an incompatible plan before
// starting any service or creating/migrating a database. Individual launch gates
// below also remeasure the exact selected executable immediately before startup.
export async function transitionAuthorizationGate(baseline, candidate, probe = mediaLoginPreflight) {
  const requiresLoginBinding = [baseline, candidate].some(build =>
    build.binding.source.some(input => /^migrations\/0041_/.test(input.path)));
  if (!requiresLoginBinding) return { required: false, reason: "pre0041 pair only" };
  return { required: true, contract: "media-login-binding-v1", candidate: await probe(candidate.binaries["rainsync-server"].path), rollback: await probe(baseline.binaries["rainsync-server"].path) };
}
export async function rehearse({
  baselineBinding,
  baselineSource,
  candidateBinding,
  candidateSource,
  requireSourceAccess = false,
  signal,
}) {
  signal?.throwIfAborted();
  const baseline = await verifiedBuild(baselineBinding, baselineSource),
    candidate = await verifiedBuild(candidateBinding, candidateSource);
  const authorization = await transitionAuthorizationGate(baseline, candidate);
  assert.equal(typeof requireSourceAccess, "boolean");
  const pair = build => ({server:build.binaries["rainsync-server"].path,worker:build.binaries["rainsync-media-worker"].path,requirement:"required"});
  // The default fixture creates only local/NAS sources in a brand-new owned DB.
  // It accepts no existing DB and cannot certify a real deployment's state.
  const sourceAccess = requireSourceAccess ? {
    required:true,candidate:await sourceAccessPairPreflight(pair(candidate)),rollback:await sourceAccessPairPreflight(pair(baseline)),
  } : {required:false,basis:"hardcoded fresh owned local/NAS-only fixture; no existing database"};
  const authorizeStart = async (build) => {
    if (authorization.required) await mediaLoginPreflight(build.binaries["rainsync-server"].path);
    if (sourceAccess.required) await sourceAccessPairPreflight(pair(build));
  };
  assert.notEqual(
    baseline.binding.source_digest,
    candidate.binding.source_digest,
    "same-source smoke is not upgrade evidence",
  );
  assert.ok(
    Object.keys(baseline.binaries).some(
      (name) =>
        baseline.binaries[name].sha256 !== candidate.binaries[name].sha256,
    ),
    "same-binary smoke is not upgrade evidence",
  );
  assert.ok(
    process.env.RAINSYNC_NATIVE_POSTGRES_BIN &&
      process.env.RAINSYNC_ARTIFACT_DIR,
    "owned native PostgreSQL and explicit artifact directory required",
  );
  const report = {
    schema_version: 1,
    result: "failed",
    baseline_source_digest: baseline.binding.source_digest,
    candidate_source_digest: candidate.binding.source_digest,
    authorization_contract: authorization,
    source_access_contract: sourceAccess,
    scope:
      "fresh isolated synthetic preview baseline upgrade/rollback only; no historical deployment, real library or production recovery acceptance",
    production_recovery_accepted: false,
    stages: [],
  };
  let fixture,
    keys = [];
  try {
    await isolatedMediaStack(
      "preview-transition",
      async (f) => {
        fixture = f;
        await authorizeStart(baseline);
        f.target = baseline.directory;
        f.env.WORKER_URL = f.workerOrigin;
        const mediaDirectory = resolve(f.root, "media");
        await mkdir(mediaDirectory);
        f.env.MEDIA_ROOT = mediaDirectory;
        const generatedClip = await f.makeClip("owned-recovery.mp4", {
          pictureSeconds: 2,
          width: 320,
          height: 180,
        });
        await rename(
          generatedClip,
          resolve(mediaDirectory, "owned-recovery.mp4"),
        );
        await startWorker(f);
        await f.startServer(
          { WORKER_URL: f.workerOrigin },
          baseline.binaries["rainsync-server"].path,
        );
        const admin = f.client();
        await admin.login();
        const source = await admin.request("/sources", "POST", {
          name: "owned recovery source",
          kind: "local",
          config: { root: mediaDirectory },
        });
        await admin.request(`/sources/${source.id}/test`, "POST");
        const media = (await admin.request("/media")).find(
          (item) =>
            item.resource === "owned-recovery.mp4" ||
            item.title.includes("owned-recovery"),
        );
        assert.ok(media);
        const room = await admin.request("/rooms", "POST", {
          name: "retained recovery room",
        });
        const { agentId } = await f.startAgent({ mediaRoot: mediaDirectory });
        await until(
          async () =>
            (await admin.request("/agents")).some(
              (agent) =>
                agent.id === agentId &&
                agent.connected &&
                agent.source_version_status === "ready",
            ),
          "baseline Agent did not connect/index",
        );
        const agentMedia = {
          id: f.sql(
            `SELECT id FROM media_items WHERE source_id='${agentId}' AND resource='owned-recovery.mp4'`,
          ),
        };
        assert.match(agentMedia.id, /^[a-f0-9-]{36}$/);
        const baselineChecks = [
          "login",
          "encrypted source scan",
          "real owned Agent connection and indexed generated media",
        ];
        await playbackSmoke(f, admin, room, media, "direct", baselineChecks);
        if (!requireSourceAccess) {
          assert.equal(f.sql("SELECT NOT EXISTS(SELECT 1 FROM sources WHERE kind NOT IN ('local','nas'))"),"t","default fixture exemption cannot cover HTTP/provider sources");
          assert.equal(f.sql("SELECT NOT EXISTS(SELECT 1 FROM playback_http_representations WHERE identity->'metadata' ? 'final_target_sha256')"),"t","default fixture exemption cannot cover redirect identities");
        }
        const before = await preflight(f.env.DATABASE_URL, {
          migrationsDirectory: resolve(candidate.sourceRoot, "migrations"),
        });
        report.stages.push({
          name: "baseline-preflight",
          result: "passed",
          checks: baselineChecks,
          candidate_pending_migrations:
            before.candidate_migrations.pending_versions,
        });
        await stop(f);
        signal?.throwIfAborted();
        report.stages.push({
          name: "drain",
          result: "passed",
          scope: "actual child process exits observed for this invocation only",
        });
        const credentialFile = resolve(f.root, "agent-token");
        const credential = JSON.parse(await readFile(credentialFile, "utf8"));
        let drained = [];
        try {
          drained = JSON.parse(
            await readFile(credentialFile + ".drained.json", "utf8"),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const saved = {
          schema_version: 1,
          configuration: {
            PUBLIC_ORIGIN: f.origin,
            MEDIA_ORIGIN: f.origin,
            AGENT_DATA_ORIGIN: f.workerOrigin,
            WORKER_URL: f.workerOrigin,
            BIND: f.env.BIND,
            CACHE_ROOT: f.env.CACHE_ROOT,
            MEDIA_ROOT: mediaDirectory,
          },
          source_key: f.env.SOURCE_ENCRYPTION_KEY,
          source_key_version: "owned-preview-key-1",
          original_media_policy:
            "Generated two-second synthetic media kept in this owned fixture; not a real media backup.",
          agents: [{ id: agentId, credential, drained_receipts: drained }],
        };
        const databaseKeyFile = resolve(f.root, "temporary-db-key"),
          materialKeyFile = resolve(f.root, "temporary-material-key");
        keys = [databaseKeyFile, materialKeyFile];
        for (const key of keys)
          await writeFile(key, randomBytes(32), { mode: 0o600, flag: "wx" });
        const databaseDirectory = resolve(f.root, "database-backup"),
          materialDirectory = resolve(f.root, "material-backup");
        await createRecoverySet({
          connection: f.env.DATABASE_URL,
          materials: saved,
          databaseOutput: databaseDirectory,
          materialOutput: materialDirectory,
          databaseKeyFile,
          materialKeyFile,
        });
        report.stages.push({
          name: "encrypted-backup",
          result: "passed",
          separate_keys: true,
          active_agent_credentials: 1,
        });
        await authorizeStart(candidate);
        await keyFailure(
          candidate.binaries["rainsync-server"].path,
          f.env,
          signal,
        );
        report.stages.push({ name: "wrong-key-startup", result: "passed" });
        let candidateError;
        try {
          await authorizeStart(candidate);
          f.target = candidate.directory;
          await f.startServer(
            { WORKER_URL: f.workerOrigin },
            candidate.binaries["rainsync-server"].path,
          );
          await startWorker(f);
          await f.startAgent({ mediaRoot: mediaDirectory });
          const current = f.client();
          await current.login();
          await until(
            async () =>
              (await current.request("/agents")).some(
                (agent) => agent.id === agentId && agent.connected,
              ),
            "candidate Agent reconnect failed",
          );
          await current.request(`/sources/${source.id}/test`, "POST");
          assert.ok(
            (await current.request("/rooms")).some(
              (value) => value.id === room.id,
            ),
          );
          const checks = [
            "login",
            "retained room",
            "source decryption/browse",
            "Agent reconnect",
          ];
          await playbackSmoke(f, current, room, media, "direct", checks);
          await playbackSmoke(f, current, room, agentMedia, "direct", checks);
          checks.push(
            "actual owned Agent NAS transfer bytes and stop revocation",
          );
          await playbackSmoke(f, current, room, media, "transcode", checks);
          await until(
            async () =>
              (
                await endpointChecks({
                  publicOrigin: f.origin,
                  mediaOrigin: f.workerOrigin,
                  agentDataOrigin: f.workerOrigin,
                })
              ).result === "passed",
            "candidate native component entry checks failed",
          );
          report.stages.push({
            name: "candidate-upgrade",
            result: "passed",
            checks,
            entry_scope:
              "direct native component reachability only; no browser/reverse-proxy topology acceptance",
          });
        } catch (error) {
          candidateError = error;
          report.stages.push({
            name: "candidate-upgrade",
            result: "failed",
            reason:
              "candidate application verification failed; inspect private fixture logs",
          });
        }
        await stop(f);
        signal?.throwIfAborted();
        let compatible = true;
        try {
          const result = await preflight(f.env.DATABASE_URL, {
            migrationsDirectory: resolve(baseline.sourceRoot, "migrations"),
          });
          compatible =
            result.candidate_migrations.pending_versions.length === 0;
        } catch {
          compatible = false;
        }
        if (!compatible) {
          const maintenance = new URL(f.env.DATABASE_URL);
          maintenance.pathname = "/postgres";
          const restored = await restoreRecoverySet({
            connection: maintenance.href,
            databaseDirectory,
            materialDirectory,
            output: resolve(f.root, "rollback-recovery"),
            databaseKeyFile,
            materialKeyFile,
          });
          await applyRecoveredConfiguration(
            f,
            resolve(f.root, "rollback-recovery"),
          );
          report.stages.push({
            name: "rollback-restore",
            result: "passed",
            database: restored.database,
            data_loss_scope:
              "changes after this rehearsal's quiescent backup are excluded from the restored database; original upgraded DB is retained",
          });
        }
        await authorizeStart(baseline);
        f.target = baseline.directory;
        await f.startServer(
          { WORKER_URL: f.workerOrigin },
          baseline.binaries["rainsync-server"].path,
        );
        await startWorker(f);
        await f.startAgent({ mediaRoot: mediaDirectory });
        const reverted = f.client();
        await reverted.login();
        await reverted.request(`/sources/${source.id}/test`, "POST");
        await until(
          async () =>
            (await reverted.request("/agents")).some(
              (agent) => agent.id === agentId && agent.connected,
            ),
          "rollback Agent reconnect failed",
        );
        const rollbackChecks = [
          "login",
          "existing-source decryption",
          "Agent reconnect",
        ];
        await playbackSmoke(f, reverted, room, media, "direct", rollbackChecks);
        report.stages.push({
          name: compatible
            ? "binary-only-rollback"
            : "new-database-baseline-rollback",
          result: "passed",
          checks: rollbackChecks,
          destructive_down_migration: false,
        });
        await stop(f);
        signal?.throwIfAborted();
        // Always exercise the full recovery path into ANOTHER fresh DB and cache,
        // even when the current schema also allowed a binary-only rollback.
        const maintenance = new URL(f.env.DATABASE_URL);
        maintenance.pathname = "/postgres";
        const output = resolve(f.root, "fresh-recovery");
        const recovery = await restoreRecoverySet({
          connection: maintenance.href,
          databaseDirectory,
          materialDirectory,
          output,
          databaseKeyFile,
          materialKeyFile,
        });
        assert.deepEqual(await readdir(resolve(output, "cache")), []);
        await applyRecoveredConfiguration(f, output);
        // The credential is restored from the encrypted archive, not re-paired.
        await writeFile(
          credentialFile,
          await readFile(resolve(output, `agents/${agentId}.json`)),
          { mode: 0o600 },
        );
        await writeFile(
          credentialFile + ".drained.json",
          await readFile(
            resolve(output, `agents/${agentId}.json.drained.json`),
          ),
          { mode: 0o600 },
        );
        // The rollback stage already proves baseline recovery. This separate
        // fresh DB/cache drill must exercise the final candidate's own startup,
        // migrations, Worker and restored Agent credential path.
        await authorizeStart(candidate);
        f.target = candidate.directory;
        await f.startServer(
          { WORKER_URL: f.workerOrigin },
          candidate.binaries["rainsync-server"].path,
        );
        await startWorker(f);
        await f.startAgent({ mediaRoot: mediaDirectory });
        const recovered = f.client();
        await recovered.login();
        await recovered.request(`/sources/${source.id}/test`, "POST");
        await until(
          async () =>
            (await recovered.request("/agents")).some(
              (agent) => agent.id === agentId && agent.connected,
            ),
          "restored Agent reconnect failed",
        );
        const recoveryChecks = [
          "fresh restored DB",
          "empty initial cache",
          "restored config/key/version",
          "restored Agent credential reconnect",
          "login",
          "existing source browse",
        ];
        await playbackSmoke(
          f,
          recovered,
          room,
          media,
          "direct",
          recoveryChecks,
        );
        await playbackSmoke(
          f,
          recovered,
          room,
          media,
          "transcode",
          recoveryChecks,
        );
        await playbackSmoke(
          f,
          recovered,
          room,
          agentMedia,
          "direct",
          recoveryChecks,
        );
        recoveryChecks.push(
          "restored credential authorizes real owned Agent NAS transfer",
        );
        report.stages.push({
          name: "fresh-application-recovery",
          result: "passed",
          source_digest: candidate.binding.source_digest,
          database: recovery.database,
          checks: recoveryChecks,
        });
        await stop(f);
        signal?.throwIfAborted();
        if (candidateError) throw candidateError;
        report.result = "passed";
      },
      { binary: baseline.binaries["rainsync-server"].path, signal },
    );
    return report;
  } finally {
    if (fixture) {
      if (signal?.aborted) {
        report.result = "interrupted";
        report.interrupted = true;
      }
      report.cleanup = await fixture.verifyStopped();
      for (const key of keys) await rm(key, { force: true });
      // Delete only synthetic credential material this invocation created.
      for (const name of [
        "fresh-recovery",
        "rollback-recovery",
        "agent-token",
        "agent-token.drained.json",
      ])
        await rm(resolve(fixture.root, name), { recursive: true, force: true });
      await writeFile(
        resolve(fixture.root, "transition-report.json"),
        JSON.stringify(report, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      console.log(
        `Preview transition report: ${resolve(fixture.root, "transition-report.json")}`,
      );
    }
  }
}
async function cli() {
  const options = new Map();
  let requireSourceAccess = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--require-source-access") { assert.equal(requireSourceAccess,false);requireSourceAccess=true;continue; }
    const match =
      /^--(baseline-binding|baseline-source|candidate-binding|candidate-source)=(.+)$/.exec(
        arg,
      );
    assert.ok(match && !options.has(match[1]));
    options.set(match[1], resolve(match[2]));
  }
  assert.equal(
    options.size,
    4,
    "specify both frozen source trees and successful backend bindings",
  );
  await withTerminationSignal((signal) =>
    rehearse({
      baselineBinding: options.get("baseline-binding"),
      baselineSource: options.get("baseline-source"),
      candidateBinding: options.get("candidate-binding"),
      candidateSource: options.get("candidate-source"),
      requireSourceAccess,
      signal,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  cli().catch(() => {
    console.error(
      "Preview transition failed; preserved private fixture report/logs contain the failing stage. No production recovery acceptance.",
    );
    process.exitCode = 1;
  });
