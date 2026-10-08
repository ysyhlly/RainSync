import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, open, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedMediaStack } from "./media-stack.mjs";
import { verifyPidAbsent, verifyClosedPort } from "./postgres.mjs";
import {
  createOwnedSoakWorkload,
  cleanupOwnedResources,
  preserveOwnedFailure,
} from "../../scripts/acceptance-owned-soak.mjs";
import { redactEvidence } from "../../scripts/acceptance-runtime.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

// Exported separately so sink/cleanup failure semantics can be tested without
// launching application processes. A failed sink retains all evidence in the
// thrown error.report; it can never replace an earlier workload failure.
export async function finalizeOwnedNativeResult(
  result,
  { primary, secondary = [], sink } = {},
) {
  secondary = [...secondary];
  if (!result.cleanup?.confirmed && !primary && !secondary.length)
    secondary.push(Error("Owned cleanup unconfirmed"));
  result.result = primary || secondary.length ? "failed" : "passed";
  result.error = primary ?? null;
  result.secondary_errors = secondary;
  try {
    if (sink) await sink(result);
  } catch (error) {
    secondary.push(error);
    result.report_write_error = error;
    result.result = "failed";
  }
  const failure = preserveOwnedFailure(
    primary,
    secondary,
    "Owned native run failed",
  );
  if (failure) {
    failure.report_path = result.report_path;
    failure.report = result;
    throw failure;
  }
  return result;
}

const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

// Filesystem-only verification: no fixture, process, listener or build starts.
// Native qualification always calls this fixed verifier, never one from JSON.
export async function verifyOwnedNativeBinding({
  binding_path,
  source_root = repo,
  target_dir = process.env.CARGO_TARGET_DIR,
}) {
  const bytes = await readFile(binding_path),
    binding = JSON.parse(bytes);
  assert.equal(binding.schema_version, 1);
  assert.equal(binding.result, "passed");
  assert.ok(
    Array.isArray(binding.source) && binding.source.length > 0,
    "frozen backend source required",
  );
  assert.ok(Array.isArray(binding.binaries), "frozen binaries required");
  assert.ok(target_dir, "frozen target directory required");
  assert.equal(binding.build.exit_code, 0);
  assert.equal(sha(JSON.stringify(binding.source)), binding.source_digest);
  const coordinator = await Promise.all(
    [
      "scripts/acceptance-owned-soak.mjs",
      "scripts/acceptance-soak.mjs",
      "tests/soak-native-qualification.mjs",
      "scripts/acceptance-browser.mjs",
      "scripts/acceptance-runtime.mjs",
      "tests/owned-soak-native.mjs",
      "tests/fixtures/owned-native-soak.mjs",
      "tests/fixtures/media-stack.mjs",
      "tests/fixtures/server.mjs",
      "tests/fixtures/postgres.mjs",
      "deploy/owned-process.mjs",
    ].map(async (path) => ({
      path,
      sha256: await hashFile(resolve(source_root, path)),
    })),
  );
  const check = async () => {
    for (const row of coordinator)
      assert.equal(
        await hashFile(resolve(source_root, row.path)),
        row.sha256,
        `coordinator changed: ${row.path}`,
      );
    assert.equal(
      sha(await readFile(binding_path)),
      sha(bytes),
      "native binding changed",
    );
    for (const row of binding.source) {
      assert.ok(
        !row.path.startsWith("/") && !row.path.split("/").includes(".."),
      );
      assert.equal(
        sha(await readFile(resolve(source_root, row.path))),
        row.sha256,
        `source changed: ${row.path}`,
      );
    }
    for (const binary of binding.binaries) {
      assert.equal(
        resolve(binary.path),
        resolve(target_dir, "debug", binary.name),
      );
      assert.equal(
        sha(await readFile(binary.path)),
        binary.sha256,
        `binary changed: ${binary.name}`,
      );
    }
    assert.deepEqual(binding.binaries.map((v) => v.name).sort(), [
      "rainsync-media-worker",
      "rainsync-nas-agent",
      "rainsync-server",
    ]);
  };
  await check();
  return {
    binding: freeze(binding),
    coordinator: freeze(coordinator),
    metadata: freeze({
      path: resolve(binding_path),
      sha256: sha(bytes),
      source_digest: binding.source_digest,
    }),
    check,
  };
}

// The sole native deployment entry point. Accepts a successful frozen binding,
// not caller-selected database, application origin, PID, password or shell.
export async function withOwnedNativeSoak(
  { binding_path, signal, presentation, run_id },
  run,
) {
  assert.equal(
    process.platform,
    "linux",
    "Linux /proc native resource observer required",
  );
  assert.ok(
    process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
    "Native PostgreSQL required; Docker fallback forbidden",
  );
  assert.ok(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "Private artifact directory required",
  );
  const verified = await verifyOwnedNativeBinding({ binding_path }),
    { binding, coordinator, check: verify } = verified;
  let fixture, workload, worker, dispose, failure;
  const secondary = [];
  const abort = new AbortController(),
    combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const result = {
    schema_version: 1,
    result: "running",
    scope: "owned-native-bounded-workload",
    accepted: false,
    release_ready: false,
    native_binding: verified.metadata,
    coordinator,
    started_at: new Date().toISOString(),
    checks: [],
  };
  const previousUmask = process.umask(0o077);
  try {
    await isolatedMediaStack(
      "owned-soak",
      async (f) => {
        fixture = f;
        try {
          const mediaRoot = resolve(f.root, "media");
          await mkdir(mediaRoot, { mode: 0o700 });
          // Valid fast-start generated MP4 with sparse owned tail supports bounded
          // long-response backpressure. It is not a visible-timecode fixture.
          const sample = await f.makeClip("media/owned-soak.mp4", {
            pictureSeconds: 8,
            width: 320,
            height: 180,
          });
          const file = await open(sample, "r+");
          try {
            await file.truncate(128 * 1024 * 1024);
          } finally {
            await file.close();
          }
          result.sample = {
            bytes: (await stat(sample)).size,
            sha256: await hashFile(sample),
            authorization: "generated-owned-fixture",
            visible_timecode: false,
          };
          const admin = f.client();
          await admin.login();
          const source = await admin.request("/sources", "POST", {
            name: "owned soak media",
            kind: "local",
            config: { root: mediaRoot },
          });
          await admin.request(`/sources/${source.id}/test`, "POST");
          const media = (await admin.request("/media")).find((v) =>
            v.title.includes("owned-soak"),
          );
          assert.ok(media, "scanned owned sample required");
          assert.equal(
            f.sql(`SELECT source_id FROM media_items WHERE id='${media.id}'`),
            source.id,
            "scanned sample source association",
          );
          await f.startServer({ WORKER_URL: f.workerOrigin });
          await f.startWorker();
          worker = {
            pid: f.workerPid,
            port: Number(new URL(f.workerOrigin).port),
          };
          workload = await createOwnedSoakWorkload({
            fixture: f,
            media,
            presentation,
            signal: combined,
            run_id,
          });
          result.ownership = {
            fixture_id: f.id,
            run_id: workload.run_id,
            resources: workload.owned_resource_ids,
            room_id: workload.room_id,
          };
          result.initial_identity = await workload.nativeIdentity();
          for (const [index, name] of [
            "rainsync-server",
            "rainsync-media-worker",
          ].entries())
            assert.equal(
              result.initial_identity.processes[index].binary_sha256,
              binding.binaries.find((v) => v.name === name).sha256,
              "running executable matches frozen binary",
            );
          assert.equal(
            result.initial_identity.processes[2].binary_sha256,
            f.postgresDiagnostics().native.binary_sha256,
            "running PostgreSQL identity matches owned launch",
          );
          await run(workload, result);
        } catch (error) {
          failure ??= error;
          if (error.cleanup) dispose = error.cleanup;
        } finally {
          if (!worker && f.workerPid)
            worker = {
              pid: f.workerPid,
              port: Number(new URL(f.workerOrigin).port),
            };
          // Capture final live diagnostics even after lifetime cancellation,
          // using an independent read-only deadline before workload disposal.
          if (workload) {
            try {
              await verify();
            } catch (error) {
              secondary.push(error);
              result.final_source_binding_error = error;
            }
            try {
              result.final_identity = await workload.nativeIdentity(
                {},
                { diagnostic: true },
              );
            } catch (error) {
              secondary.push(error);
              result.final_identity_error = error;
            }
          }
          if (workload)
            try {
              dispose = await workload.dispose();
            } catch (error) {
              dispose = error.cleanup ?? { confirmed: false };
              secondary.push(error);
            }
        }
      },
      {
        signal: combined,
        beforeStart(f) {
          fixture = f;
        },
        env: {
          CACHE_MAX_BYTES: String(128 * 1024 * 1024),
          CACHE_UNKNOWN_OUTPUT_BYTES: String(16 * 1024 * 1024),
          PLAYBACK_SESSION_LIMIT: "32",
        },
      },
    );
  } catch (error) {
    if (failure) secondary.push(error);
    else failure = error;
  } finally {
    process.umask(previousUmask);
    abort.abort(Error("owned native soak finalized"));
  }
  // Fixture finally has run. Check every independently owned process group even
  // if a prior check fails; workload cleanup failure remains separately visible.
  const processCleanup = await cleanupOwnedResources([
    ...(!fixture
      ? [
          {
            resource: "fixture-identity-unavailable",
            run: async () => {
              throw Error(
                "Fixture identity unavailable; process cleanup cannot be confirmed",
              );
            },
          },
        ]
      : []),
    ...(fixture
      ? [{ resource: "server-postgres", run: () => fixture.verifyStopped() }]
      : []),
    ...(worker
      ? [
          {
            resource: "worker",
            run: async () => {
              assert.equal(verifyPidAbsent(worker.pid), true);
              assert.equal(await verifyClosedPort(worker.port), true);
              return { ...worker, pid_absent: true, port_closed: true };
            },
          },
        ]
      : []),
  ]);
  secondary.push(
    ...processCleanup.outcomes.filter((v) => !v.confirmed).map((v) => v.error),
  );
  try {
    await verify();
    result.final_binding_verified = true;
  } catch (error) {
    secondary.push(error);
    result.final_binding_verified = false;
  }
  const workloadCleanup = dispose ?? {
    confirmed: !workload,
    not_initialized: !workload,
  };
  result.cleanup = {
    confirmed: processCleanup.confirmed && workloadCleanup.confirmed === true,
    processes: processCleanup,
    workload: workloadCleanup,
  };
  result.finished_at = new Date().toISOString();
  if (fixture)
    result.report_path = resolve(fixture.root, "owned-soak-report.json");
  return finalizeOwnedNativeResult(result, {
    primary: failure,
    secondary,
    sink: fixture
      ? async (value) => {
          const secrets = [
            fixture.password,
            fixture.env?.SOURCE_ENCRYPTION_KEY,
          ].filter(Boolean);
          await writeFile(
            result.report_path,
            JSON.stringify(redactEvidence(value, secrets), null, 2) + "\n",
            { flag: "wx", mode: 0o600 },
          );
        }
      : undefined,
  });
}
