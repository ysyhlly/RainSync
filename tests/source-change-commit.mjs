// Production HTTP writes and autonomous maintenance against a process-owned
// disposable PostgreSQL fixture. Fault triggers exist only in that fresh DB.
// Requires W03_BACKEND_BINDING, CARGO_TARGET_DIR, RAINSYNC_ARTIFACT_DIR and
// optionally RAINSYNC_NATIVE_POSTGRES_BIN. Never uses an existing DATABASE_URL.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import {
  withPlaybackAdmission,
  testLoginHash,
} from "./fixtures/playback-admission.mjs";
import { safeFailure } from "./fixtures/safe-failure.mjs";
import {
  changedStateSections,
  createSourceChangeDiagnostics,
  sourceChangeDeadline,
} from "./fixtures/source-change-diagnostics.mjs";
import { loadOwnerBinding } from "../scripts/native-owner-binding.mjs";
import { withTerminationSignal } from "../deploy/owned-process.mjs";

const repo = resolve(import.meta.dirname, "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
assert.equal(
  process.env.DATABASE_URL,
  undefined,
  "owned fixture refuses an inherited database URL",
);
assert.ok(
  process.env.W03_BACKEND_BINDING,
  "a frozen backend binding is required",
);
assert.ok(
  process.env.CARGO_TARGET_DIR,
  "an explicit owned Cargo target is required",
);
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "an external artifact directory is required",
);
assert.ok(
  isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR),
  "artifact directory must be absolute",
);
const artifactRelative = relative(repo, process.env.RAINSYNC_ARTIFACT_DIR);
assert.ok(
  artifactRelative === ".." ||
    artifactRelative.startsWith(`..${sep}`) ||
    isAbsolute(artifactRelative),
  "artifacts must be outside the checkout",
);
const bindingFile = resolve(process.env.W03_BACKEND_BINDING);
const bound = await loadOwnerBinding({
  root: repo,
  target: process.env.CARGO_TARGET_DIR,
  path: bindingFile,
});
const binding = JSON.parse(await readFile(bindingFile, "utf8"));
for (const path of [
  "apps/server/src/source_access.rs",
  "apps/server/src/source_settings.rs",
  "apps/server/src/upstream.rs",
  "migrations/0032_source_access_policy_revisions.sql",
  "migrations/0083_source_settings.sql",
])
  assert.ok(
    binding.source.some((input) => input.path === path),
    `binding includes ${path}`,
  );
const coordinator = await Promise.all(
  [
    "scripts/native-owner-binding.mjs",
    "tests/source-change-commit.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/postgres.mjs",
    "tests/fixtures/unused-port.mjs",
    "tests/fixtures/playback-admission.mjs",
    "tests/fixtures/safe-failure.mjs",
    "tests/fixtures/source-change-diagnostics.mjs",
    "deploy/owned-process.mjs",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  await bound.verify();
  for (const input of coordinator)
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      `bound source unchanged: ${input.path}`,
    );
}
await verifyBinding();

const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "source-change-commit",
  randomUUID(),
);
await mkdir(root, { recursive: true });
const report = {
  schema_version: 1,
  result: "running",
  started_at: new Date().toISOString(),
  scope:
    "Current-source-bound real Server/HTTP/PostgreSQL. Logical retirement and immediate source fencing; no physical owner-drain claim.",
  commit_fault_scope:
    "Deferred COMMIT rejection is injected. Transport loss during COMMIT is not simulated and is not asserted successful.",
  backend_binding: {
    path: bindingFile,
    ...bound.summary,
  },
  coordinator,
  checks: [],
  cleanup: {},
};
const save = () =>
  writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
let fixture, runSignal;
const diagnostics = createSourceChangeDiagnostics();
const retainFailure = (error) => {
  report.failure ??= diagnostics.failure(error);
};
async function scenario(name, work) {
  runSignal.throwIfAborted();
  report.active_case = name;
  diagnostics.at("case_setup");
  await save();
  let evidence;
  try {
    evidence = await work();
  } catch (error) {
    retainFailure(error);
    throw error;
  }
  runSignal.throwIfAborted();
  report.checks.push({ name, result: "passed", ...evidence });
  console.log(`PASS ${name}`);
  await save();
}
async function bounded(work, ms = 12000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(sourceChangeDeadline()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function hold(f, sql) {
  diagnostics.at("sql_blocker_start");
  const marker = `source_change_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "";
  const ready = new Promise((done, reject) => {
    child.stdout.on("data", (bytes) => {
      output += bytes;
      if (output.includes(marker)) done();
    });
    child.once("error", reject);
    child.done.then(
      () => reject(Error("SQL blocker exited before admission")),
      reject,
    );
  });
  child.stdin.write(
    `BEGIN; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${sql};\n\\echo ${marker}\n`,
  );
  try {
    await bounded(ready);
  } catch (error) {
    retainFailure(error);
    child.stdin.end("ROLLBACK;\n\\q\n");
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    diagnostics.at("sql_blocker_release");
    child.stdin.end("COMMIT;\n\\q\n");
    await bounded(child.done);
  };
}
const waitBlocked = (f, prefix) => {
  diagnostics.at("sql_lock_wait");
  return f.waitForSql(
    `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE ${quote(`${prefix}%`)})`,
    "t",
    7000,
  );
};
async function response(work, expected) {
  diagnostics.at("http_wait", { expected_status: expected });
  try {
    const result = await bounded(work);
    const status = { expected_status: expected, actual_status: result.status };
    diagnostics.at("http_body", status);
    const value = await result.json();
    diagnostics.at("http_status", status);
    assert.equal(result.status, expected, `expected HTTP ${expected}`);
    diagnostics.at("http_redaction", status);
    assert.doesNotMatch(
      JSON.stringify(value),
      /fixture_sql_failure|fixture-secret|never-echo/,
    );
    return value;
  } catch (error) {
    retainFailure(error);
    throw error;
  }
}

try {
  await withTerminationSignal(async (termination) => {
    runSignal = AbortSignal.any([termination, AbortSignal.timeout(180000)]);
    await isolatedServer(
      "source-change-commit",
      async (f) => {
        fixture = f;
        report.fixture_id = f.id;
        report.postgres = f.postgresDiagnostics();
        await save();
        const admin = f.client(),
          identity = await admin.login();
        const sourcePrefix = (kind) =>
          kind === "policy"
            ? "SELECT kind,config_encrypted,access_policy_revision FROM sources"
            : "SELECT * FROM sources WHERE id=";
        async function target(label, playback = false) {
          diagnostics.at("target_setup");
          const source = await admin.request("/sources", "POST", {
            name: label,
            kind: "http",
            config: {
              url: "https://example.test/source-change.mp4",
              headers: { "X-Fixture": "fixture-secret" },
            },
          });
          const detail = await admin.request(`/sources/${source.id}`);
          const media = randomUUID();
          f.sql(
            `INSERT INTO media_items(id,source_id,resource,title) VALUES(${quote(media)},${quote(source.id)},'https://example.test/source-change.mp4','owned source-change fixture')`,
          );
          const value = { id: source.id, media, detail };
          if (playback) {
            const room = await admin.request("/rooms", "POST", { name: label });
            const session = randomUUID();
            f.sql(
              `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}',${quote(JSON.stringify(media))}::jsonb),'{media_generation}','1') WHERE room_id=${quote(room.id)}`,
            );
            withPlaybackAdmission(
              f,
              { client: admin, user: identity.id, room: room.id, session },
              `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at)
           VALUES(${quote(session)},${quote(identity.id)},${quote(room.id)},${quote(media)},1,${quote(digest(randomUUID()))},
             ${quote(JSON.stringify({ source_id: source.id, source_policy_revision: detail.access_policy_revision }))}::jsonb,
             clock_timestamp()+interval '10 minutes')`,
            );
            value.session = session;
            assert.equal(
              f.sql(
                `SELECT playback_source_allowed(media_id,resource,id) FROM playback_sessions WHERE id=${quote(session)}`,
              ),
              "t",
            );
          }
          return value;
        }
        const state = (value) =>
          f.sql(`SELECT encode(sha256(convert_to(jsonb_build_object(
      'source',to_jsonb(s),'snapshot',(SELECT to_jsonb(p) FROM source_access_policy_snapshots p WHERE p.source_id=s.id),
      'scan',(SELECT to_jsonb(scan) FROM source_scans scan WHERE scan.source_id=s.id),
      'media',(SELECT to_jsonb(m) FROM media_items m WHERE m.id=${quote(value.media)})
    )::text,'UTF8')),'hex') FROM sources s WHERE s.id=${quote(value.id)}`);
        // Additional diagnostic observations only. The original whole-state
        // equality assertion below remains unchanged. Fingerprints stay local;
        // a failure report contains only the names of changed fixed sections.
        const stateSections = (value) =>
          JSON.parse(
            f.sql(`WITH observed AS (
          SELECT jsonb_build_object(
            'source',to_jsonb(s),
            'snapshot',(SELECT to_jsonb(p) FROM source_access_policy_snapshots p WHERE p.source_id=s.id),
            'scan',(SELECT to_jsonb(scan) FROM source_scans scan WHERE scan.source_id=s.id),
            'media',(SELECT to_jsonb(m) FROM media_items m WHERE m.id=${quote(value.media)})
          ) AS value FROM sources s WHERE s.id=${quote(value.id)}
        ) SELECT jsonb_object_agg(part.key,encode(sha256(convert_to(part.value::text,'UTF8')),'hex'))
          FROM observed,LATERAL jsonb_each(observed.value) part`),
          );
        const mutate = (kind, value) =>
          kind === "policy"
            ? admin.raw(`/sources/${value.id}/access-policy`, {
                method: "POST",
                body: {
                  expected_revision: value.detail.access_policy_revision,
                  policy: {
                    schema_version: 1,
                    origins: [
                      {
                        origin: "https://example.test",
                        cidrs: ["0.0.0.0/0", "::/0"],
                      },
                    ],
                  },
                },
              })
            : admin.raw(`/sources/${value.id}`, {
                method: "PATCH",
                body: {
                  expected_revision: value.detail.revision,
                  config: {
                    headers: { "X-Fixture": "changed-fixture-secret" },
                  },
                },
              });
        function assertAdvanced(value, receipt) {
          assert.equal(receipt.id, value.id);
          assert.equal(
            receipt.access_policy_revision,
            value.detail.access_policy_revision + 1,
          );
          assert.equal(
            f.sql(
              `SELECT access_policy_revision FROM sources WHERE id=${quote(value.id)}`,
            ),
            String(value.detail.access_policy_revision + 1),
          );
          assert.equal(
            f.sql(
              `SELECT settings_revision FROM sources WHERE id=${quote(value.id)}`,
            ),
            String(BigInt(value.detail.revision) + 1n),
          );
          if (Object.hasOwn(receipt, "revision")) {
            assert.equal(
              receipt.revision,
              String(BigInt(value.detail.revision) + 1n),
            );
            assert.equal(receipt.config_changed, true);
          }
        }
        async function sqlFailure(kind, deferred) {
          const value = await target(
            `${kind} ${deferred ? "commit" : "precommit"} failure`,
          );
          diagnostics.at("state_before");
          const before = state(value),
            beforeSections = stateSections(value);
          diagnostics.at("fault_install");
          f.sql(`CREATE FUNCTION source_change_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id=${quote(value.id)}::uuid THEN RAISE EXCEPTION 'fixture_sql_failure'; END IF; RETURN NEW; END $$;
        ${
          deferred
            ? "CREATE CONSTRAINT TRIGGER source_change_fixture_fault AFTER UPDATE ON sources DEFERRABLE INITIALLY DEFERRED"
            : "CREATE TRIGGER source_change_fixture_fault BEFORE UPDATE ON sources"
        }
        FOR EACH ROW EXECUTE FUNCTION source_change_fixture_fail()`);
          let primaryError,
            primaryFailed = false;
          try {
            await response(mutate(kind, value), 500);
            diagnostics.at("state_after");
            const after = state(value),
              afterSections = stateSections(value);
            diagnostics.at("state_compare", {
              changed_sections: changedStateSections(
                beforeSections,
                afterSections,
              ),
            });
            assert.equal(
              after,
              before,
              "unconfirmed/rejected transaction cannot produce a success receipt",
            );
          } catch (error) {
            primaryFailed = true;
            primaryError = error;
            retainFailure(error);
          } finally {
            diagnostics.at("fault_remove");
            try {
              f.sql(
                "DROP TRIGGER source_change_fixture_fault ON sources; DROP FUNCTION source_change_fixture_fail()",
              );
            } catch (error) {
              report.fault_cleanup_failure = diagnostics.failure(error);
              if (!primaryFailed) throw error;
            }
          }
          if (primaryFailed) throw primaryError;
          return { committed: false, http_status: 500 };
        }

        for (const kind of ["policy", "settings"]) {
          await scenario(`${kind}: normal commit and stale CAS`, async () => {
            const value = await target(`${kind} normal`, true);
            assertAdvanced(value, await response(mutate(kind, value), 200));
            assert.equal(
              f.sql(
                `SELECT stopped FROM playback_sessions WHERE id=${quote(value.session)}`,
              ),
              "t",
            );
            const committed = state(value);
            const conflict = await response(mutate(kind, value), 409);
            assert.equal(conflict.error.code, "SOURCE_CHANGED");
            assert.equal(
              state(value),
              committed,
              "stale retry must not repeat the write",
            );
            return { committed: true, stale_retry_status: 409 };
          });
          await scenario(`${kind}: precommit database failure`, () =>
            sqlFailure(kind, false),
          );
          await scenario(`${kind}: rejected COMMIT is not successful`, () =>
            sqlFailure(kind, true),
          );

          await scenario(
            `${kind}: demotion before transaction admission`,
            async () => {
              const value = await target(`${kind} demotion`),
                before = state(value);
              const release = await hold(
                f,
                `UPDATE users SET admin=false WHERE id=${quote(identity.id)}`,
              );
              try {
                const write = mutate(kind, value);
                write.catch(() => {});
                await waitBlocked(f, "SELECT admin FROM users WHERE id=");
                await release();
                await response(write, 403);
                assert.equal(state(value), before);
              } finally {
                await release();
                f.sql(
                  `UPDATE users SET admin=true WHERE id=${quote(identity.id)}`,
                );
              }
              return { committed: false, http_status: 403 };
            },
          );
          await scenario(
            `${kind}: exact login revoked before admission`,
            async () => {
              const value = await target(`${kind} logout`),
                before = state(value);
              const release = await hold(
                f,
                `SELECT id FROM users WHERE id=${quote(identity.id)} FOR UPDATE`,
              );
              try {
                const write = mutate(kind, value);
                write.catch(() => {});
                await waitBlocked(f, "SELECT admin FROM users WHERE id=");
                await admin.request("/auth/logout", "POST");
                await release();
                await response(write, 401);
                assert.equal(state(value), before);
              } finally {
                await release();
                await admin.login();
              }
              return { committed: false, http_status: 401 };
            },
          );
          await scenario(
            `${kind}: natural login expiry during source wait`,
            async () => {
              const value = await target(`${kind} expiry`),
                before = state(value);
              const login = testLoginHash(f, admin);
              f.sql(
                `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=${quote(login)}`,
              );
              const release = await hold(
                f,
                `SELECT id FROM sources WHERE id=${quote(value.id)} FOR UPDATE`,
              );
              try {
                const write = mutate(kind, value);
                write.catch(() => {});
                await waitBlocked(f, sourcePrefix(kind));
                await f.waitForSql(
                  `SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=${quote(login)}`,
                  "t",
                  7000,
                );
                await release();
                await response(write, 401);
                assert.equal(state(value), before);
              } finally {
                await release();
                await admin.login();
              }
              return { committed: false, http_status: 401 };
            },
          );

          await scenario(
            `${kind}: retirement failure preserves commit and maintenance converges`,
            async () => {
              const value = await target(`${kind} retirement`, true);
              f.sql(`CREATE SEQUENCE source_change_retirement_attempt;
          CREATE FUNCTION source_change_retirement_fail() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.id=${quote(value.session)}::uuid AND NEW.stopped AND NOT OLD.stopped THEN
            PERFORM nextval('source_change_retirement_attempt'); RAISE EXCEPTION 'fixture_sql_failure';
          END IF; RETURN NEW; END $$;
          CREATE TRIGGER source_change_retirement_fault BEFORE UPDATE OF stopped ON playback_sessions
          FOR EACH ROW EXECUTE FUNCTION source_change_retirement_fail()`);
              let committed;
              try {
                assertAdvanced(value, await response(mutate(kind, value), 200));
                committed = state(value);
                assert.equal(
                  f.sql(
                    "SELECT is_called FROM source_change_retirement_attempt",
                  ),
                  "t",
                  "retirement really failed",
                );
                assert.equal(
                  f.sql(
                    `SELECT stopped FROM playback_sessions WHERE id=${quote(value.session)}`,
                  ),
                  "f",
                  "failure leaves cleanup responsibility pending",
                );
                assert.equal(
                  f.sql(
                    `SELECT playback_source_allowed(media_id,resource,id) FROM playback_sessions WHERE id=${quote(value.session)}`,
                  ),
                  "f",
                  "reader authority fences before retirement succeeds",
                );
                assert.equal(
                  f.sql(
                    `SELECT source_account_policy_allowed(${quote(value.id)},${value.detail.access_policy_revision},NULL)`,
                  ),
                  "f",
                  "publication cannot use the old source revision",
                );
                const attempts = Number(
                  f.sql(
                    "SELECT last_value FROM source_change_retirement_attempt",
                  ),
                );
                await f.waitForSql(
                  `SELECT last_value>${attempts} FROM source_change_retirement_attempt`,
                  "t",
                  7000,
                );
                assert.equal(
                  state(value),
                  committed,
                  "maintenance retries never repeat the source mutation",
                );
                // A later login is not needed for cleanup; revoke the administrator
                // after the committed response while the original fault persists.
                f.sql(
                  `UPDATE users SET admin=false WHERE id=${quote(identity.id)}`,
                );
              } finally {
                f.sql(
                  "DROP TRIGGER source_change_retirement_fault ON playback_sessions; DROP FUNCTION source_change_retirement_fail(); DROP SEQUENCE source_change_retirement_attempt",
                );
              }
              try {
                await f.waitForSql(
                  `SELECT stopped FROM playback_sessions WHERE id=${quote(value.session)}`,
                  "t",
                  7000,
                );
                assert.equal(state(value), committed);
              } finally {
                f.sql(
                  `UPDATE users SET admin=true WHERE id=${quote(identity.id)}`,
                );
              }
              const deadline = Date.now() + 3000;
              let pendingLogged = false;
              while (!pendingLogged && Date.now() < deadline) {
                pendingLogged = (
                  await readFile(resolve(f.root, "server-1.log"), "utf8")
                )
                  .split("\n")
                  .some(
                    (line) =>
                      line.includes(value.id) &&
                      line.includes(
                        "source change committed; retirement deferred to maintenance",
                      ),
                  );
                if (!pendingLogged) await delay(20);
              }
              assert.equal(
                pendingLogged,
                true,
                "cleanup failure has a separate safe diagnostic",
              );
              return {
                committed: true,
                http_status: 200,
                immediately_fenced: true,
                retirement_failure_observed: true,
                autonomous_retry_observed: true,
                converged_without_resave_or_authority: true,
                cleanup_pending_logged: pendingLogged,
              };
            },
          );
        }
        await scenario(
          "settings: name-only and semantic no-op retain playback authority",
          async () => {
            const value = await target("settings no-op", true);
            const oldCipher = f.sql(
              `SELECT encode(sha256(convert_to(config_encrypted,'UTF8')),'hex') FROM sources WHERE id=${quote(value.id)}`,
            );
            const renamed = await admin.request(
              `/sources/${value.id}`,
              "PATCH",
              {
                expected_revision: value.detail.revision,
                name: "display-only rename",
              },
            );
            assert.equal(
              renamed.access_policy_revision,
              value.detail.access_policy_revision,
            );
            assert.equal(renamed.config_changed, false);
            const before = state(value);
            const noop = await admin.request(`/sources/${value.id}`, "PATCH", {
              expected_revision: renamed.revision,
              name: renamed.name,
            });
            assert.equal(noop.revision, renamed.revision);
            assert.equal(state(value), before);
            assert.equal(
              f.sql(
                `SELECT encode(sha256(convert_to(config_encrypted,'UTF8')),'hex') FROM sources WHERE id=${quote(value.id)}`,
              ),
              oldCipher,
            );
            assert.equal(
              f.sql(
                `SELECT NOT stopped AND playback_source_allowed(media_id,resource,id) FROM playback_sessions WHERE id=${quote(value.session)}`,
              ),
              "t",
            );
            return {
              ciphertext_preserved: true,
              noop_revision_preserved: true,
              playback_allowed: true,
            };
          },
        );
        diagnostics.at("binding_verify");
        await verifyBinding();
      },
      {
        signal: runSignal,
        binary: bound.server,
        beforeStart: (f) => {
          fixture = f;
        },
      },
    );
    runSignal.throwIfAborted();
  });
  report.result = "passed";
  delete report.active_case;
} catch (error) {
  report.result = "failed";
  retainFailure(error);
  report.error = safeFailure(error);
  process.exitCode = 1;
} finally {
  if (fixture) {
    diagnostics.at("fixture_cleanup");
    try {
      report.cleanup = await fixture.verifyStopped();
    } catch (error) {
      report.cleanup_failure = diagnostics.failure(error);
      report.cleanup_error = safeFailure(error);
      report.result = "failed";
      process.exitCode = 1;
    }
  }
  try {
    diagnostics.at("binding_verify");
    await verifyBinding();
  } catch (error) {
    report.binding_failure = diagnostics.failure(error);
    report.binding_error = safeFailure(error);
    report.result = "failed";
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  await save();
  console.log(JSON.stringify(report, null, 2));
}
