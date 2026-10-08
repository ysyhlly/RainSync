// Actual owned native PostgreSQL 1–36 -> 37 upgrade and authority checks.
// Never uses a caller-supplied database URL or builds service binaries.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set RAINSYNC_ARTIFACT_DIR");
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Owned native PostgreSQL is required; Docker is not used",
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const id = randomUUID();
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "http-file-fallback-migration",
  id,
);
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "http-file-fallback-migration", id });
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owner = randomUUID(),
  other = randomUUID(),
  room = randomUUID(),
  otherRoom = randomUUID();
const source = randomUUID(),
  media = randomUUID(),
  parent = randomUUID();
const loginHash = digest("owned migration login " + id);
const requestKeys = [randomUUID(), randomUUID(), randomUUID()];
const report = {
  schema_version: 1,
  result: "running",
  started_at: new Date().toISOString(),
  scope:
    "Owned native PostgreSQL 1–36 to 37 migration and SQL authority checks; seeded rows are explicit migration fixtures, not public API or product acceptance",
  fixture_id: id,
  migrations: [],
  checks: [],
};
const check = (name, run) => {
  run();
  report.checks.push(name);
  console.log("PASS: " + name);
};
const allowed = (context) =>
  db.sql(
    `SELECT playback_http_file_context_allowed(${context === undefined ? "NULL" : json(context)})`,
  );
const sourceAllowed = (resource) =>
  db.sql(`SELECT playback_source_allowed(${quote(media)},${json(resource)})`);
const requestRow = (key) =>
  `user_id=${quote(owner)} AND idempotency_key=${quote(key)}`;
const snapshot = () =>
  JSON.parse(
    db.sql(`SELECT jsonb_build_object(
  'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
  'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY token_hash) FROM sessions t),
  'rooms',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM rooms t),
  'members',(SELECT jsonb_agg(to_jsonb(t)-'membership_epoch' ORDER BY room_id,user_id) FROM room_members t),
  'sources',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sources t),
  'media',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM media_items t),
  'playback',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM playback_sessions t),
  'requests',(SELECT jsonb_agg(to_jsonb(t)-ARRAY['http_file_context_encrypted','http_file_parent'] ORDER BY idempotency_key) FROM playback_requests t))`),
  );
let failure;
try {
  await db.start();
  report.postgres = db.diagnostics();
  const names = (await readdir(resolve(repo, "migrations")))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const name of names.filter((name) => Number(name.split("_")[0]) <= 36)) {
    const bytes = await readFile(resolve(repo, "migrations", name));
    db.sql(`BEGIN; ${bytes}; COMMIT;`);
    report.migrations.push({ name, sha256: digest(bytes) });
  }
  assert.equal(report.migrations.length, 36);
  db.sql(`INSERT INTO users(id,username,password_hash) VALUES(${quote(owner)},'owned-legacy-owner','not-for-login'),(${quote(other)},'owned-other-user','not-for-login');
    INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(${quote(loginHash)},${quote(owner)},'owned-csrf',clock_timestamp()+interval '1 hour');
    INSERT INTO rooms(id,name,owner_id) VALUES(${quote(room)},'owned legacy room',${quote(owner)}),(${quote(otherRoom)},'owned other room',${quote(other)});
    INSERT INTO room_members(room_id,user_id) VALUES(${quote(room)},${quote(owner)}),(${quote(otherRoom)},${quote(other)});
    INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${quote(source)},'owned legacy HTTP','http','legacy-source-ciphertext');
    INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata) VALUES(${quote(media)},${quote(source)},'owned legacy movie','movie.mp4',2345,'{"streams":[]}');
    INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(parent)},${quote(owner)},${quote(room)},${quote(media)},3,'owned-legacy-delivery','{"encrypted":"legacy-grant","source_policy_revision":0}',clock_timestamp()+interval '1 hour');`);
  for (const [index, status] of ["pending", "completed", "failed"].entries()) {
    db.sql(`INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,response_encrypted,error_status,error_code,lease_until,expires_at,room_id,lifecycle_epoch)
      VALUES(${quote(owner)},${quote(requestKeys[index])},${quote("legacy-hash-" + status)},${quote(index === 1 ? parent : randomUUID())},${quote(randomUUID())},${quote(status)},${status === "completed" ? "'legacy-response-ciphertext'" : "NULL"},${status === "failed" ? "409" : "NULL"},${status === "failed" ? "'source_changed'" : "NULL"},clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',${quote(room)},0)`);
  }
  const before = snapshot();
  const beforeLegacy = [
    sourceAllowed({}),
    sourceAllowed({ source_policy_revision: 0 }),
    sourceAllowed({ source_policy_revision: 1 }),
  ];
  const migration = "0037_http_file_fallback.sql";
  const bytes = await readFile(resolve(repo, "migrations", migration));
  db.sql(`BEGIN; ${bytes}; COMMIT;`);
  report.migrations.push({ name: migration, sha256: digest(bytes) });
  check(
    "upgrade preserves all old row values and encrypted payloads across pending/completed/failed requests",
    () => assert.deepEqual(snapshot(), before),
  );
  check("old grants retain their existing source authority behavior", () =>
    assert.deepEqual(
      [
        sourceAllowed({}),
        sourceAllowed({ source_policy_revision: 0 }),
        sourceAllowed({ source_policy_revision: 1 }),
      ],
      beforeLegacy,
    ),
  );
  check("upgrade leaves new request context and parent absent", () =>
    assert.equal(
      db.sql(
        "SELECT count(*) FROM playback_requests WHERE http_file_context_encrypted IS NOT NULL OR http_file_parent IS NOT NULL",
      ),
      "0",
    ),
  );
  check("existing memberships receive distinct non-null epochs", () =>
    assert.equal(
      db.sql(
        "SELECT count(DISTINCT membership_epoch)=count(*) AND count(membership_epoch)=count(*) FROM room_members",
      ),
      "t",
    ),
  );
  let epoch = db.sql(
    `SELECT membership_epoch FROM room_members WHERE room_id=${quote(room)} AND user_id=${quote(owner)}`,
  );
  const context = {
    version: 1,
    user_id: owner,
    room_id: room,
    membership_epoch: epoch,
    login_hash: loginHash,
  };
  check(
    "absent SQL context retains legacy behavior while current frozen context is allowed",
    () => {
      assert.equal(allowed(), "t");
      assert.equal(allowed(context), "t");
      assert.equal(
        sourceAllowed({
          source_policy_revision: 0,
          http_file_context: context,
        }),
        "t",
      );
    },
  );
  const malformed = [
    null,
    [],
    true,
    false,
    1,
    "authority",
    {},
    { ...context, version: "1" },
    { ...context, version: 2 },
    { ...context, extra: true },
  ];
  for (const field of Object.keys(context)) {
    const missing = { ...context };
    delete missing[field];
    malformed.push(missing, { ...context, [field]: null });
  }
  for (const field of ["user_id", "room_id", "membership_epoch", "login_hash"])
    malformed.push(
      { ...context, [field]: {} },
      { ...context, [field]: 1 },
      { ...context, [field]: "" },
    );
  malformed.push(
    { ...context, login_hash: loginHash.toUpperCase() },
    { ...context, login_hash: loginHash.slice(1) },
    { ...context, user_id: other },
    { ...context, room_id: otherRoom },
    { ...context, membership_epoch: randomUUID() },
  );
  check(
    `${malformed.length} malformed, missing, extra, JSON-null and foreign authority shapes fail closed without SQL errors`,
    () => {
      for (const value of malformed) {
        assert.equal(allowed(value), "f", JSON.stringify(value));
        assert.equal(
          sourceAllowed({
            source_policy_revision: 0,
            http_file_context: value,
          }),
          "f",
        );
      }
    },
  );
  check("context cannot replace the current source revision", () =>
    assert.equal(
      sourceAllowed({ source_policy_revision: 1, http_file_context: context }),
      "f",
    ),
  );
  check("expired frozen login fails closed", () => {
    db.sql(
      `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${quote(loginHash)}`,
    );
    assert.equal(allowed(context), "f");
    assert.equal(
      sourceAllowed({ source_policy_revision: 0, http_file_context: context }),
      "f",
    );
    db.sql(
      `UPDATE sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=${quote(loginHash)}`,
    );
  });
  check(
    "deleted login and a different live login never regenerate old authority",
    () => {
      db.sql(
        `DELETE FROM sessions WHERE token_hash=${quote(loginHash)}; INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(${quote(digest("new login " + id))},${quote(owner)},'new-csrf',clock_timestamp()+interval '1 hour')`,
      );
      assert.equal(allowed(context), "f");
      db.sql(
        `INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(${quote(loginHash)},${quote(owner)},'owned-csrf',clock_timestamp()+interval '1 hour')`,
      );
    },
  );
  check(
    "explicit-column public-compatible member insert gets a fresh epoch after removal/rejoin",
    () => {
      db.sql(
        `DELETE FROM room_members WHERE room_id=${quote(room)} AND user_id=${quote(owner)}`,
      );
      assert.equal(allowed(context), "f");
      db.sql(
        `INSERT INTO room_members(room_id,user_id) VALUES(${quote(room)},${quote(owner)})`,
      );
      const fresh = db.sql(
        `SELECT membership_epoch FROM room_members WHERE room_id=${quote(room)} AND user_id=${quote(owner)}`,
      );
      assert.notEqual(fresh, epoch);
      assert.equal(allowed(context), "f");
      assert.equal(allowed({ ...context, membership_epoch: fresh }), "t");
      epoch = fresh;
    },
  );
  check("membership epoch rejects SQL null and explicit malformed UUID", () => {
    assert.throws(() =>
      db.sql(
        `UPDATE room_members SET membership_epoch=NULL WHERE room_id=${quote(room)}`,
      ),
    );
    assert.throws(() =>
      db.sql(
        `UPDATE room_members SET membership_epoch='invalid' WHERE room_id=${quote(room)}`,
      ),
    );
  });
  const setContext = (value, parentValue = "NULL", key = requestKeys[0]) =>
    db.sql(
      `UPDATE playback_requests SET http_file_context_encrypted=${value},http_file_parent=${parentValue} WHERE ${requestRow(key)}`,
    );
  for (const value of ["''", "repeat('x',8193)", "repeat('é',4097)"])
    check(`encrypted context rejects byte length ${value}`, () =>
      assert.throws(() => setContext(value)),
    );
  for (const value of ["'x'", "repeat('x',8192)", "repeat('é',4096)"])
    check(`encrypted context accepts bounded byte length ${value}`, () => {
      setContext(value);
      assert.equal(
        db.sql(
          `SELECT octet_length(http_file_context_encrypted) BETWEEN 1 AND 8192 FROM playback_requests WHERE ${requestRow(requestKeys[0])}`,
        ),
        "t",
      );
    });
  check("a parent claim requires a non-null bounded encrypted context", () =>
    assert.throws(() => setContext("NULL", quote(parent))),
  );
  check("a claim parent must refer to an actual grant", () =>
    assert.throws(() => setContext("'owned-context'", quote(randomUUID()))),
  );
  check("exactly one successor key may claim the same parent", () => {
    setContext("'owned-context'", quote(parent));
    assert.throws(() =>
      setContext("'second-context'", quote(parent), requestKeys[2]),
    );
    assert.equal(
      db.sql(
        `SELECT count(*) FROM playback_requests WHERE http_file_parent=${quote(parent)}`,
      ),
      "1",
    );
  });
  check(
    "nullable root contexts coexist and ordinary legacy requests remain valid",
    () => {
      setContext("'root-context'", "NULL", requestKeys[2]);
      assert.equal(
        db.sql(
          "SELECT count(*) FROM playback_requests WHERE http_file_parent IS NULL",
        ),
        "2",
      );
      assert.equal(
        db.sql(
          `SELECT http_file_context_encrypted IS NULL AND http_file_parent IS NULL AND response_encrypted='legacy-response-ciphertext' FROM playback_requests WHERE ${requestRow(requestKeys[1])}`,
        ),
        "t",
      );
    },
  );
  check(
    "source revision change retires both valid opted-in and legacy old-revision authority",
    () => {
      const current = { ...context, membership_epoch: epoch };
      db.sql(
        `UPDATE sources SET config_encrypted='owned-new-config' WHERE id=${quote(source)}`,
      );
      assert.equal(allowed(current), "t");
      assert.equal(
        sourceAllowed({
          source_policy_revision: 0,
          http_file_context: current,
        }),
        "f",
      );
      assert.equal(sourceAllowed({ source_policy_revision: 0 }), "f");
      assert.equal(
        sourceAllowed({
          source_policy_revision: 1,
          http_file_context: current,
        }),
        "t",
      );
    },
  );
  for (const input of report.migrations)
    assert.equal(
      digest(await readFile(resolve(repo, "migrations", input.name))),
      input.sha256,
      "Migration inputs remained frozen",
    );
  report.result = "passed";
} catch (error) {
  failure = error;
  report.result = "failed";
  report.failure = String(error.stack ?? error);
} finally {
  await db.stop();
  report.cleanup = await db.verifyStopped();
  report.postgres = db.diagnostics();
  report.finished_at = new Date().toISOString();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `${report.result}: ${report.checks.length} checks; evidence ${resolve(root, "report.json")}`,
  );
}
if (failure) throw failure;
