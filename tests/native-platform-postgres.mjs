// Run only in the authorized saved RainSync environment. Owns a disposable
// PostgreSQL cluster; synthetic SQL rows only, no HTTP, QR or platform requests.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set RAINSYNC_ARTIFACT_DIR");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Set RAINSYNC_NATIVE_POSTGRES_BIN to owned native PostgreSQL binaries; no Docker fallback");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const id = randomUUID();
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, "native-platform-postgres", id);
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "native-platform", id });
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${q(JSON.stringify(value))}::jsonb`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const report = {
  schema_version: 1, fixture_id: id, result: "running",
  scope: "isolated-postgres-synthetic-sql-only", started_at: new Date().toISOString(),
  checks: [], migrations: [], inputs: [],
  limits: [
    "No application transaction/lock/concurrency acceptance or HTTP route execution",
    "QR completion checks execute the server's SQL predicate, not provider polling or credential encryption",
    "No real login, QR acquisition, platform requests, DASH/MP4 playback or browser acceptance",
    "Room/media/source gates are not caller/control/lifecycle admission or physical media validation",
  ],
};
const checkpoint = () => writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
async function check(name, run) {
  const row = { name, passed: false };
  report.checks.push(row);
  try { await run(); row.passed = true; console.log("PASS: " + name); }
  catch (error) { row.error = String(error.stack ?? error); throw error; }
  finally { await checkpoint(); }
}
const yes = (sql) => assert.equal(db.sql(sql), "t");
const no = (sql) => assert.equal(db.sql(sql), "f");
const rejects = (sql, error = /violates check constraint/) => assert.throws(() => db.sql(sql), error);
const user = randomUUID(), other = randomUUID(), outsider = randomUUID();
const room = randomUUID(), otherRoom = randomUUID(), source = randomUUID();
const ordinary = randomUUID(), native = randomUUID(), otherNative = randomUUID(), orphan = randomUUID();
const login = sha("synthetic originating login " + id), alternate = sha("synthetic second login " + id);
const otherLogin = sha("synthetic other user " + id);
const account = randomUUID(), otherAccount = randomUUID(), revokedAccount = randomUUID();
const ordinarySession = randomUUID(), anonymousSession = randomUUID(), ownSession = randomUUID();
const viewer = randomUUID();
let membership, completionSQL, failure;

function requestSQL(session, principal = user, targetRoom = room, origin = login, memberEpoch = membership) {
  return `INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
    VALUES(${q(principal)},${q(randomUUID())},${q(sha(session))},${q(session)},${q(randomUUID())},'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',${q(targetRoom)},0,${q(origin)},${q(memberEpoch)});`;
}
function grantSQL(session, media, resource) {
  return `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at)
    VALUES(${q(session)},${q(user)},${q(room)},${q(media)},1,${q(sha("ticket " + session))},${json(resource)},clock_timestamp()+interval '20 minutes');`;
}
function binding(mode = "anonymous", revision = null) {
  return { version: 1, provider: "bilibili", media_id: native, room_id: room, user_id: user,
    entry_revision: "1", credential_mode: mode,
    account_id: mode === "own_account" ? account : null, account_revision: revision };
}
function resource(mode = "anonymous", revision = null) {
  return { encrypted: "synthetic-sealed-descriptor", native_platform_context: binding(mode, revision),
    auth_context: { version: 1, user_id: user, room_id: room, membership_epoch: membership, login_hash: login } };
}
const allowed = (value, media = native) => `SELECT playback_source_allowed(${q(media)},${json(value)})`;
const nativeAllowed = (value, media = native) => `SELECT native_platform_source_allowed(${q(media)},${json(value)})`;
function insertQr(requestId, revision, { nonce = randomUUID(), expired = false } = {}) {
  db.sql(`INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,qr_key_encrypted,qr_payload_encrypted,created_at,expires_at,next_poll_at,operation_nonce,operation_expires_at,account_id,account_revision)
    VALUES(${q(requestId)},${q(user)},${q(login)},'bilibili','pending','synthetic-key-ciphertext','synthetic-payload-ciphertext',
      clock_timestamp()${expired ? "-interval '5 minutes'" : ""},clock_timestamp()+interval '${expired ? "-1" : "4"} minutes',clock_timestamp(),${q(nonce)},clock_timestamp()+interval '${expired ? "-2 minutes" : "1 minute"}',${q(account)},${revision});`);
  return nonce;
}
function terminalize(requestId, state = "failed") {
  db.sql(`UPDATE platform_login_requests SET status=${q(state)},qr_key_encrypted=NULL,qr_payload_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE id=${q(requestId)} AND status='pending'`);
}
function complete(requestId, nonce, revision, changes = {}) {
  const values = [changes.account ?? account, "synthetic-confirmed-credential", revision + 1, revision,
    changes.user ?? user, changes.login ?? login, requestId, nonce];
  // Consume the actual one-line SQL literal, so a production predicate change
  // cannot leave this acceptance runner silently testing a copied old version.
  const sql = completionSQL.replace(/\$(\d+)/g, (_, index) => q(values[Number(index) - 1]));
  return db.sql(`WITH stored AS (${sql} RETURNING id) SELECT count(*) FROM stored`);
}

try {
  const names = (await readdir(resolve(repo, "migrations")))
    .filter((name) => /^\d+_.+\.sql$/.test(name) && Number(name.split("_")[0]) <= 51).sort();
  const migration = names.find((name) => name === "0051_native_platform.sql");
  assert.ok(migration, "0051_native_platform.sql is required");
  const inputPaths = [...names.map((name) => "migrations/" + name),
    "tests/fixtures/postgres.mjs", "tests/native-platform-postgres.mjs", "apps/server/src/platform_accounts.rs"];
  for (const path of inputPaths) report.inputs.push({ path, sha256: sha(await readFile(resolve(repo, path))) });
  const accountSource = await readFile(resolve(repo, "apps/server/src/platform_accounts.rs"), "utf8");
  const predicates = [...accountSource.matchAll(/sqlx::query\("(UPDATE platform_accounts SET state='connected'[^"\n]+)"\)/g)];
  assert.equal(predicates.length, 1, "exactly one QR account-completion SQL literal must be identifiable");
  completionSQL = predicates[0][1];
  assert.ok(completionSQL.includes("operation_expires_at>clock_timestamp()"), "completion SQL shape changed; review runner");
  await db.start();
  report.postgres = db.diagnostics();
  await check("prerequisite migrations 0001–0050 apply in an empty owned cluster", async () => {
    for (const name of names.filter((name) => name !== migration)) {
      const bytes = await readFile(resolve(repo, "migrations", name));
      db.sql(`BEGIN;${bytes};COMMIT;`);
      report.migrations.push({ name, sha256: sha(bytes) });
    }
  });
  db.sql(`INSERT INTO users(id,username,password_hash) VALUES
    (${q(user)},'synthetic-native-owner','not-for-login'),(${q(other)},'synthetic-native-other','not-for-login'),(${q(outsider)},'synthetic-native-outsider','not-for-login');
    INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES
    (${q(login)},${q(user)},'synthetic-csrf',clock_timestamp()+interval '1 hour'),
    (${q(alternate)},${q(user)},'synthetic-alternate-csrf',clock_timestamp()+interval '1 hour'),
    (${q(otherLogin)},${q(other)},'synthetic-other-csrf',clock_timestamp()+interval '1 hour');
    INSERT INTO rooms(id,name,owner_id) VALUES(${q(room)},'synthetic native room',${q(user)}),(${q(otherRoom)},'synthetic other room',${q(other)});
    INSERT INTO room_members(room_id,user_id) VALUES(${q(room)},${q(user)}),(${q(room)},${q(other)}),(${q(otherRoom)},${q(other)});
    INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${q(source)},'synthetic HTTP source','http','synthetic-source-ciphertext');
    INSERT INTO media_items(id,source_id,title,resource,metadata,duration_ms) VALUES(${q(ordinary)},${q(source)},'ordinary fixture','synthetic.mp4','{}',90000);`);
  membership = db.sql(`SELECT membership_epoch FROM room_members WHERE room_id=${q(room)} AND user_id=${q(user)}`);
  db.sql(requestSQL(ordinarySession) + grantSQL(ordinarySession, ordinary,
    { encrypted: "synthetic-ordinary-ciphertext", source_policy_revision: 0 }) +
    `UPDATE playback_requests SET status='completed',response_encrypted='synthetic-response' WHERE session_id=${q(ordinarySession)};`);
  const before = db.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(ordinarySession)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(ordinarySession)}),'media',(SELECT to_jsonb(m) FROM media_items m WHERE id=${q(ordinary)}))`);
  const bytes = await readFile(resolve(repo, "migrations", migration));
  await check("0051 rollback and commit preserve existing ordinary grant/request/media values", () => {
    db.sql(`BEGIN;${bytes};ROLLBACK;`);
    yes("SELECT to_regclass('room_platform_media') IS NULL AND to_regclass('platform_accounts') IS NULL AND to_regclass('platform_login_requests') IS NULL");
    db.sql(`BEGIN;${bytes};COMMIT;`);
    report.migrations.push({ name: migration, sha256: sha(bytes) });
    assert.equal(db.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(ordinarySession)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(ordinarySession)}),'media',(SELECT to_jsonb(m) FROM media_items m WHERE id=${q(ordinary)}))`), before);
    yes(`SELECT playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=${q(ordinarySession)}`);
  });

  db.sql(`INSERT INTO media_items(id,title,resource,metadata) VALUES
    (${q(native)},'平台影片',${q("platform:" + native)},'{}'),
    (${q(otherNative)},'平台影片',${q("platform:" + otherNative)},'{}'),
    (${q(orphan)},'平台影片',${q("platform:" + orphan)},'{}');
    INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,cid,title,duration_ms,created_by) VALUES
    (${q(native)},${q(room)},'bilibili','BV1xx411c7mD',1,123,'synthetic private title',180000,${q(user)}),
    (${q(otherNative)},${q(otherRoom)},'bilibili','BV1xx411c7mD',1,456,'synthetic other private title',240000,${q(other)});`);
  await check("placeholders stay generic/source-less and private entries are room-scoped", () => {
    yes(`SELECT source_id IS NULL AND title='平台影片' AND resource='platform:'||id::text AND metadata='{}'::jsonb AND duration_ms IS NULL FROM media_items WHERE id=${q(native)}`);
    assert.equal(db.sql(`SELECT count(*) FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id IN (${q(native)},${q(otherNative)},${q(orphan)})`), "0");
    yes(`SELECT room_media_allowed(${q(room)},${q(native)}) AND room_media_allowed(${q(otherRoom)},${q(otherNative)})`);
    no(`SELECT room_media_allowed(${q(otherRoom)},${q(native)})`);
    no(`SELECT room_media_allowed(${q(room)},${q(otherNative)})`);
    no(`SELECT room_media_allowed(${q(room)},${q(orphan)})`);
    rejects(`INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,title,created_by) VALUES(${q(ordinary)},${q(room)},'bilibili','av123',1,'bad ordinary entry',${q(user)})`, /platform_placeholder_required/);
    rejects(`INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,title,created_by) VALUES(${q(orphan)},${q(room)},'bilibili','BV1xx411c7mD',1,'duplicate entry',${q(user)})`, /duplicate key/);
  });
  await check("entry identity and global placeholder fields cannot be rewritten", () => {
    for (const fields of ["revision=revision+1", "title='changed'", "content_id='av999'", "part=2", "cid=999", "duration_ms=1", `room_id=${q(otherRoom)}`, `created_by=${q(other)}`, "created_at=created_at+interval '1 second'"])
      rejects(`UPDATE room_platform_media SET ${fields} WHERE media_id=${q(native)}`, /room_platform_media_immutable/);
    for (const fields of [`id=${q(randomUUID())}`, `source_id=${q(source)}`, "title='leaked title'", "resource='https://invalid.example/synthetic'", `metadata='{"private":"synthetic"}'`, "duration_ms=1"])
      rejects(`UPDATE media_items SET ${fields} WHERE id=${q(native)}`, /platform_placeholder_immutable/);
    db.sql(`UPDATE room_platform_media SET title=title WHERE media_id=${q(native)}; UPDATE media_items SET available=false WHERE id=${q(native)}`);
    no(`SELECT room_media_allowed(${q(room)},${q(native)})`);
    db.sql(`UPDATE media_items SET available=true WHERE id=${q(native)}`);
  });
  await check("playlist insertion/reassignment and selection use exact room and entry duration", () => {
    const item = randomUUID();
    db.sql(`INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES(${q(item)},${q(room)},${q(native)},1)`);
    rejects(`INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES(${q(randomUUID())},${q(otherRoom)},${q(native)},1)`, /media_not_found/);
    rejects(`UPDATE playlist_items SET room_id=${q(otherRoom)} WHERE id=${q(item)}`, /media_not_found/);
    rejects(`UPDATE playlist_items SET media_id=${q(otherNative)} WHERE id=${q(item)}`, /media_not_found/);
    assert.equal(db.sql(`SELECT e.title FROM playlist_items q JOIN room_platform_media e ON e.media_id=q.media_id AND e.room_id=q.room_id JOIN media_items m ON m.id=e.media_id WHERE q.room_id=${q(room)} AND m.available AND m.source_id IS NULL`), "synthetic private title");
    assert.equal(db.sql(`SELECT CASE WHEN m.source_id IS NULL THEN e.duration_ms ELSE m.duration_ms END FROM media_items m LEFT JOIN room_platform_media e ON e.media_id=m.id AND e.room_id=${q(room)} WHERE m.id=${q(native)} AND room_media_allowed(${q(room)},m.id)`), "180000");
    assert.equal(db.sql(`SELECT m.id FROM media_items m WHERE m.id=${q(native)} AND room_media_allowed(${q(otherRoom)},m.id)`), "");
  });
  await check("ordinary and agent room-media branches remain available under their existing gates", () => {
    yes(`SELECT room_media_allowed(${q(otherRoom)},${q(ordinary)})`);
    for (const state of ["live", "revoked", "missing"]) {
      const agent = randomUUID(), media = randomUUID();
      db.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${q(agent)},${q("synthetic " + state)},'agent','synthetic-ciphertext');
        INSERT INTO media_items(id,source_id,title,resource) VALUES(${q(media)},${q(agent)},'synthetic agent media','synthetic-file')`);
      if (state !== "missing") db.sql(`INSERT INTO agents(id,name,revoked) VALUES(${q(agent)},'synthetic agent',${state === "revoked"})`);
      assert.equal(db.sql(`SELECT room_media_allowed(${q(room)},${q(media)})`), state === "live" ? "t" : "f");
    }
  });

  db.sql(`INSERT INTO platform_accounts(id,user_id,provider,state,credential_encrypted) VALUES
    (${q(account)},${q(user)},'bilibili','connected','synthetic-credential'),(${q(otherAccount)},${q(other)},'bilibili','connected','synthetic-other-credential');
    INSERT INTO platform_accounts(id,user_id,provider,state) VALUES(${q(revokedAccount)},${q(outsider)},'bilibili','revoked');`);
  await check("account credentials, immutable identity and revision changes are constrained", () => {
    rejects(`UPDATE platform_accounts SET credential_encrypted=NULL,revision=revision+1 WHERE id=${q(account)}`);
    rejects(`UPDATE platform_accounts SET state='revoked',revision=revision+1 WHERE id=${q(account)}`);
    rejects(`UPDATE platform_accounts SET credential_encrypted='',revision=revision+1 WHERE id=${q(account)}`);
    for (const fields of [`id=${q(randomUUID())}`, `user_id=${q(other)}`, "provider='other'", "created_at=created_at+interval '1 second'"])
      rejects(`UPDATE platform_accounts SET ${fields} WHERE id=${q(account)}`, /platform_account_identity_immutable/);
    for (const fields of ["credential_encrypted='changed'", "credential_expires_at=clock_timestamp()+interval '1 minute'", "state='expired',credential_encrypted=NULL", "credential_encrypted='changed',revision=revision+2"])
      rejects(`UPDATE platform_accounts SET ${fields} WHERE id=${q(account)}`, /platform_account_revision_required/);
    for (const revision of ["0", "-1", "NULL", "revision+1"])
      rejects(`UPDATE platform_accounts SET revision=${revision} WHERE id=${q(account)}`, /platform_account_revision_without_change|violates not-null constraint/);
    rejects(`INSERT INTO platform_accounts(id,user_id,provider,state) VALUES(${q(randomUUID())},${q(user)},'bilibili','revoked')`, /duplicate key/);
    db.sql(`UPDATE platform_accounts SET state='expired',credential_encrypted=NULL,revision=revision+1 WHERE id=${q(account)};
      UPDATE platform_accounts SET state='revoked',revision=revision+1 WHERE id=${q(account)};
      UPDATE platform_accounts SET revision=revision+1 WHERE id=${q(account)};
      UPDATE platform_accounts SET state='connected',credential_encrypted='synthetic-reconnected-credential',revision=revision+1 WHERE id=${q(account)};`);
    yes(`SELECT state='connected' AND revision=5 FROM platform_accounts WHERE id=${q(account)}`);
    for (const revision of ["0", "-1", "NULL"])
      rejects(`INSERT INTO platform_accounts(id,user_id,provider,state,revision) VALUES(${q(randomUUID())},${q(user)},'bilibili','revoked',${revision})`, /violates check constraint|violates not-null constraint/);
  });

  let revision = Number(db.sql(`SELECT revision FROM platform_accounts WHERE id=${q(account)}`));
  const qr = randomUUID(), nonce = insertQr(qr, revision);
  await check("QR origin/account scope, one-pending uniqueness and bounded nonce/deadline shape", () => {
    for (const fields of [`id=${q(randomUUID())}`, `user_id=${q(other)}`, `auth_login_hash=${q(alternate)}`, `account_id=${q(otherAccount)}`, "account_revision=account_revision+1", "provider='other'", "expires_at=expires_at+interval '1 second'", "created_at=created_at+interval '1 second'"])
      rejects(`UPDATE platform_login_requests SET ${fields} WHERE id=${q(qr)}`, /platform_login_origin_immutable/);
    for (const fields of ["operation_nonce=NULL", "operation_expires_at=NULL", "operation_expires_at=expires_at+interval '1 second'", "status='confirmed'"])
      rejects(`UPDATE platform_login_requests SET ${fields} WHERE id=${q(qr)}`);
    rejects(`INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,expires_at,next_poll_at,account_id,account_revision) VALUES(${q(randomUUID())},${q(other)},${q(otherLogin)},'bilibili','pending',clock_timestamp()+interval '4 minutes',clock_timestamp(),${q(account)},${revision})`, /platform_login_account_scope/);
    rejects(`INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,expires_at,next_poll_at,account_id,account_revision) VALUES(${q(randomUUID())},${q(user)},${q(login)},'bilibili','pending',clock_timestamp()+interval '4 minutes',clock_timestamp(),${q(account)},${revision})`, /duplicate key/);
    for (const [hash, rev, expiry] of [["not-a-login-hash", revision, "4"], [login, 0, "4"], [login, revision, "6"]])
      rejects(`INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,expires_at,next_poll_at,account_id,account_revision) VALUES(${q(randomUUID())},${q(user)},${q(hash)},'bilibili','failed',clock_timestamp()+interval '${expiry} minutes',clock_timestamp(),${q(account)},${rev})`);
  });
  await check("actual QR completion SQL rejects other login, stale revision/account/principal and wrong nonce", () => {
    for (const changes of [{ login: alternate }, { account: otherAccount }, { user: other }])
      assert.equal(complete(qr, nonce, revision, changes), "0");
    assert.equal(complete(qr, randomUUID(), revision), "0");
    assert.equal(complete(qr, nonce, revision - 1), "0");
    db.sql(`UPDATE platform_login_requests SET operation_expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(qr)}`);
    assert.equal(complete(qr, nonce, revision), "0");
    db.sql(`UPDATE platform_login_requests SET operation_expires_at=clock_timestamp()+interval '1 minute' WHERE id=${q(qr)};
      DELETE FROM sessions WHERE token_hash=${q(login)}`);
    assert.equal(complete(qr, nonce, revision), "0");
    db.sql(`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(${q(login)},${q(user)},'synthetic-restored-csrf',clock_timestamp()+interval '1 hour');
      UPDATE platform_accounts SET credential_encrypted='synthetic-concurrent-revision',revision=revision+1 WHERE id=${q(account)}`);
    assert.equal(complete(qr, nonce, revision), "0");
    terminalize(qr);
    revision++;
  });
  await check("expired QR completion is denied; exact live origin/revision/nonce stores once", () => {
    const expiredQr = randomUUID(), expiredNonce = insertQr(expiredQr, revision, { expired: true });
    assert.equal(complete(expiredQr, expiredNonce, revision), "0");
    terminalize(expiredQr, "expired");
    const freshQr = randomUUID(), freshNonce = insertQr(freshQr, revision);
    assert.equal(complete(freshQr, freshNonce, revision), "1");
    assert.equal(complete(freshQr, freshNonce, revision), "0");
    terminalize(freshQr, "confirmed");
    assert.equal(complete(freshQr, freshNonce, revision + 1), "0");
    revision++;
  });
  await check("confirmed/expired/failed QR rows clear secrets and cannot be modified or reopened", () => {
    for (const status of ["confirmed", "expired", "failed"]) {
      const request = randomUUID();
      insertQr(request, revision);
      terminalize(request, status);
      yes(`SELECT status=${q(status)} AND qr_key_encrypted IS NULL AND qr_payload_encrypted IS NULL AND operation_nonce IS NULL AND operation_expires_at IS NULL FROM platform_login_requests WHERE id=${q(request)}`);
      for (const fields of ["status='pending'", "qr_payload_encrypted='replayed'", "updated_at=updated_at+interval '1 second'"])
        rejects(`UPDATE platform_login_requests SET ${fields} WHERE id=${q(request)}`, /platform_login_terminal/);
      db.sql(`UPDATE platform_login_requests SET status=status WHERE id=${q(request)}`);
    }
  });

  await check("native anonymous and exact own-account source authorization are positive", () => {
    yes(allowed(resource()));
    yes(nativeAllowed(resource()));
    yes(allowed(resource("own_account", String(revision))));
    no(`SELECT playback_source_allowed(${q(native)},'{"encrypted":"synthetic"}'::jsonb)`);
  });
  await check("malformed, cross-scope, stale and alternate-pipeline native contexts fail closed", () => {
    const base = resource();
    for (const value of [null, [], {}, { ...base, native_platform_context: null },
      { ...base, native_platform_context: [] }, { ...base, auth_context: null },
      { ...base, auth_context: { ...base.auth_context, login_hash: sha("missing login") } },
      { ...base, auth_context: { ...base.auth_context, membership_epoch: randomUUID() } },
      { ...base, auth_context: { ...base.auth_context, unexpected: true } }]) no(nativeAllowed(value));
    for (const [key, value] of Object.entries({ version: 2, provider: "other", media_id: otherNative,
      room_id: otherRoom, user_id: other, entry_revision: "2", credential_mode: "unknown",
      account_id: account, account_revision: String(revision), unexpected: true }))
      no(allowed({ ...base, native_platform_context: { ...base.native_platform_context, [key]: value } }));
    for (const key of Object.keys(base.native_platform_context)) {
      const context = { ...base.native_platform_context }; delete context[key];
      no(allowed({ ...base, native_platform_context: context }));
    }
    for (const key of ["http_file_context", "static_hls_capture_id", "static_hls_input", "url", "source_url", "root", "headers"])
      no(allowed({ ...base, [key]: null }));
    const own = resource("own_account", String(revision));
    for (const fields of [{ account_revision: String(revision - 1) }, { account_id: otherAccount },
      { account_id: null }, { account_revision: null }])
      no(allowed({ ...own, native_platform_context: { ...own.native_platform_context, ...fields } }));
    no(allowed(base, ordinary));
    db.sql(`UPDATE media_items SET available=false WHERE id=${q(native)}`);
    no(allowed(base));
    db.sql(`UPDATE media_items SET available=true WHERE id=${q(native)}`);
    db.sql(`UPDATE platform_accounts SET credential_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 WHERE id=${q(account)}`);
    revision++;
    no(allowed(resource("own_account", String(revision))));
    yes(allowed(resource()));
    db.sql(`UPDATE platform_accounts SET credential_expires_at=NULL,revision=revision+1 WHERE id=${q(account)}`);
    revision++;
  });
  await check("native grant insert binds exact request login and rejects unauthorized scope", () => {
    const anonymous = resource(); delete anonymous.auth_context;
    const own = resource("own_account", String(revision)); delete own.auth_context;
    db.sql(requestSQL(anonymousSession) + grantSQL(anonymousSession, native, anonymous) +
      requestSQL(ownSession) + grantSQL(ownSession, native, own));
    yes(`SELECT auth_login_hash=${q(login)} AND auth_membership_epoch=${q(membership)} AND resource->'auth_context'->>'login_hash'=${q(login)} AND playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=${q(ownSession)}`);
    no(`SELECT playback_caller_allowed(resource,user_id,${q(alternate)}) FROM playback_sessions WHERE id=${q(ownSession)}`);
    for (const fields of [{ room_id: otherRoom }, { user_id: other }, { media_id: ordinary }]) {
      const session = randomUUID();
      const bad = { ...anonymous, native_platform_context: { ...anonymous.native_platform_context, ...fields } };
      rejects(`BEGIN;${requestSQL(session)}${grantSQL(session, native, bad)}COMMIT;`, /native_platform_grant_scope/);
      assert.equal(db.sql(`SELECT count(*) FROM playback_requests WHERE session_id=${q(session)}`), "0");
    }
    const denied = randomUUID();
    rejects(`BEGIN;${requestSQL(denied)}${grantSQL(denied, native, { ...anonymous, native_platform_context: { ...anonymous.native_platform_context, entry_revision: "2" } })}COMMIT;`, /native_platform_source_denied/);
  });
  await check("native sealed resource/identity cannot change or be retrofitted onto ordinary grants", () => {
    for (const fields of ["resource=resource-'native_platform_context'", "resource=jsonb_set(resource,'{encrypted}','\"changed\"')", "resource=resource||'{\"url\":\"synthetic\"}'::jsonb",
      `media_id=${q(ordinary)}`, "generation=generation+1", "lifecycle_epoch=lifecycle_epoch+1",
      `viewer_id=${q(viewer)},plan_generation=1`, "delivery_token_hash='changed-ticket'"])
      rejects(`UPDATE playback_sessions SET ${fields} WHERE id=${q(anonymousSession)}`, /native_platform_grant_immutable/);
    for (const fields of [`id=${q(randomUUID())}`, `user_id=${q(other)}`, `room_id=${q(otherRoom)}`])
      rejects(`UPDATE playback_sessions SET ${fields} WHERE id=${q(anonymousSession)}`, /media_login_origin_immutable|playback_room_identity_immutable|native_platform_grant_immutable/);
    rejects(`UPDATE playback_sessions SET resource=${json(resource())} WHERE id=${q(ordinarySession)}`, /native_platform_grant_immutable/);
    const original = db.sql(`SELECT resource FROM playback_sessions WHERE id=${q(anonymousSession)}`);
    db.sql(`UPDATE playback_sessions SET resource=resource-'auth_context' WHERE id=${q(anonymousSession)}`);
    assert.equal(db.sql(`SELECT resource FROM playback_sessions WHERE id=${q(anonymousSession)}`), original);
  });
  await check("grant expiry only shortens; retirement stays writable after authority loss and cannot resurrect", () => {
    rejects(`UPDATE playback_sessions SET expires_at=expires_at+interval '1 second' WHERE id=${q(ownSession)}`, /native_platform_grant_immutable/);
    db.sql(`UPDATE playback_sessions SET expires_at=expires_at-interval '1 minute' WHERE id=${q(ownSession)};
      UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,revision=revision+1 WHERE id=${q(account)}`);
    no(`SELECT playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=${q(ownSession)}`);
    yes(`SELECT playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=${q(anonymousSession)}`);
    db.sql(`DELETE FROM sessions WHERE token_hash=${q(login)}`);
    no(`SELECT playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=${q(anonymousSession)}`);
    db.sql(`UPDATE playback_sessions SET stopped=true,expires_at=clock_timestamp()-interval '1 second' WHERE id IN (${q(ownSession)},${q(anonymousSession)})`);
    for (const session of [ownSession, anonymousSession]) {
      yes(`SELECT stopped AND expires_at<clock_timestamp() FROM playback_sessions WHERE id=${q(session)}`);
      rejects(`UPDATE playback_sessions SET stopped=false WHERE id=${q(session)}`, /native_platform_grant_immutable/);
      rejects(`UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=${q(session)}`, /native_platform_grant_immutable/);
    }
  });
  await check("inputs did not change during this SQL run", async () => {
    for (const input of report.inputs) assert.equal(sha(await readFile(resolve(repo, input.path))), input.sha256, input.path);
  });
  report.result = "passed";
} catch (error) {
  failure = error;
  report.result = "failed";
  report.error = String(error.stack ?? error);
} finally {
  try { await db.stop(); report.cleanup = await db.verifyStopped(); }
  catch (error) {
    report.result = "failed"; report.cleanup = { error: String(error.stack ?? error) }; failure ??= error;
  }
  report.finished_at = new Date().toISOString();
  await checkpoint();
}
console.log(`Evidence: ${resolve(root, "report.json")}`);
if (failure) throw failure;
console.log(`PASS: ${report.checks.length} synthetic PostgreSQL checks; owned cluster stopped and closure verified`);
