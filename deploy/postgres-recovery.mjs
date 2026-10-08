// Isolated PostgreSQL recovery tooling. No down migration, DROP, --clean,
// overwriting archive or restoring over an existing database is supported.
// Authentication stays in inherited env/libpq; reports never contain a DSN.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const magic = Buffer.from("RNSBAK1\n");
const headerBytes = magic.length + 12;
const tagBytes = 16;
const identifier = (name) => {
  assert.match(
    name,
    /^[a-z][a-z0-9_]{0,62}$/,
    "invalid generated database name",
  );
  return name;
};

export function localConnection(connection) {
  assert.ok(connection, "DATABASE_URL is required through the environment");
  let url;
  try {
    url = new URL(connection);
  } catch {
    throw Error("invalid PostgreSQL connection URI");
  }
  assert.ok(
    ["postgres:", "postgresql:"].includes(url.protocol),
    "PostgreSQL URI required",
  );
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "recovery tooling requires an isolated loopback PostgreSQL instance",
  );
  // URI host override parameters can redirect libpq despite a loopback hostname.
  for (const key of url.searchParams.keys())
    assert.ok(
      ["sslmode", "connect_timeout", "application_name"].includes(key),
      "unsupported PostgreSQL connection parameter",
    );
  assert.ok(
    url.pathname !== "/" && url.pathname.length > 1,
    "database name required",
  );
  return url;
}

function pgInvocation(program, connection) {
  const url = localConnection(connection);
  const binary = process.env.RAINSYNC_NATIVE_POSTGRES_BIN
    ? resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, program)
    : program;
  const inherited = { ...process.env };
  for (const name of ["PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR", "PGOPTIONS"])
    delete inherited[name];
  return {
    binary,
    env: {
      ...inherited,
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
      PGCONNECT_TIMEOUT: "5",
      PGAPPNAME: "rainsync-isolated-recovery",
    },
  };
}

export async function pg(program, args, connection, timeout = 60000) {
  const { binary, env } = pgInvocation(program, connection);
  try {
    return (
      await execute(binary, args, {
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch (error) {
    // libpq errors may repeat usernames/hostnames/URI; do not persist them.
    throw Error(
      `${program} failed (exit ${typeof error.code === "number" ? error.code : "unavailable"}); inspect the isolated PostgreSQL service`,
    );
  }
}

// Only this module can issue a live snapshot handle. Importers must use the
// same database and finish while its exporting read-only transaction is held.
const snapshots = new WeakMap();
function snapshotState(connection, snapshot) {
  const state = snapshots.get(snapshot);
  assert.ok(
    state && state.connection === connection && state.active,
    "database snapshot is not active for this connection",
  );
  return state;
}
export function readTransaction(connection, snapshot) {
  if (!snapshot) return "BEGIN READ ONLY;";
  const { id } = snapshotState(connection, snapshot);
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${id}';`;
}
export async function withDatabaseSnapshot(connection, run) {
  const { binary, env } = pgInvocation("psql", connection);
  const child = spawn(binary, ["-X", "-qAtw", "-v", "ON_ERROR_STOP=1"], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let active = true;
  let state;
  let output = "";
  let readyResolve, readyReject;
  const ready = new Promise((done, reject) => {
    readyResolve = done;
    readyReject = reject;
  });
  const failure = () =>
    Error(
      "database snapshot could not be held; no complete recovery set accepted",
    );
  const done = new Promise((resolve) => {
    child.once("close", (code) => {
      active = false;
      if (state) state.active = false;
      readyReject(failure());
      resolve(code);
    });
  });
  child.once("error", () => readyReject(failure()));
  child.stdin.on("error", () => readyReject(failure()));
  // Never collect stderr: libpq diagnostics can contain authentication data.
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 4096) {
      readyReject(failure());
      child.kill("SIGKILL");
      return;
    }
    const newline = output.indexOf("\n");
    if (newline < 0) return;
    try {
      const value = JSON.parse(output.slice(0, newline));
      assert.match(value.id, /^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/);
      assert.ok(Number.isFinite(Date.parse(value.started_at)));
      readyResolve(value);
    } catch {
      readyReject(failure());
    }
  });
  const startupTimer = setTimeout(() => {
    readyReject(failure());
    child.kill("SIGKILL");
  }, 10000);
  const lifetimeTimer = setTimeout(() => child.kill("SIGKILL"), 40 * 60 * 1000);
  child.stdin.write(
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n" +
      "SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='40min';\n" +
      "SELECT json_build_object('id',pg_export_snapshot(),'started_at',transaction_timestamp());\n",
  );
  try {
    const value = await ready;
    clearTimeout(startupTimer);
    assert.ok(active, "database snapshot exporter closed before validation");
    const handle = Object.freeze({
      started_at: new Date(value.started_at).toISOString(),
    });
    state = { ...value, connection, active: true };
    snapshots.set(handle, state);
    return await run(handle);
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(lifetimeTimer);
    if (state) state.active = false;
    if (active) child.stdin.end("ROLLBACK;\n\\q\n");
    const stopTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await done;
    } finally {
      clearTimeout(stopTimer);
    }
  }
}

export async function matchMigrationBaseline(installed, migrationsDirectory) {
  const expected = new Map();
  for (const name of await readdir(migrationsDirectory)) {
    const match = /^(\d+)_[^.]+\.sql$/.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    assert.ok(
      Number.isSafeInteger(version) && !expected.has(version),
      "duplicate or invalid frozen migration version",
    );
    const checksum = createHash("sha384")
      .update(await readFile(resolve(migrationsDirectory, name)))
      .digest("hex");
    expected.set(version, checksum);
  }
  assert.ok(expected.size > 0, "frozen migration set is empty");
  const present = new Set();
  for (const row of installed) {
    assert.ok(
      !present.has(row.version),
      "duplicate installed migration version",
    );
    present.add(row.version);
    assert.ok(row.success, "failed installed migration");
    assert.ok(
      expected.has(row.version),
      "installed migration absent from frozen candidate; old binary compatibility is unproven",
    );
    assert.equal(
      row.checksum,
      expected.get(row.version),
      "installed migration checksum differs from immutable frozen migration",
    );
  }
  return {
    installed_checksums_verified: true,
    pending_versions: [...expected.keys()]
      .filter((version) => !present.has(version))
      .sort((a, b) => a - b),
    scope:
      "checksum/version preflight only; no SQL applied and no old-binary compatibility approval",
  };
}

export async function preflight(
  connection,
  { migrationsDirectory, snapshot } = {},
) {
  localConnection(connection);
  const existing = await pg(
    "psql",
    [
      "-X",
      "-qAtw",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `${readTransaction(connection, snapshot)} SET LOCAL statement_timeout='5s'; SELECT json_build_object('server_version', current_setting('server_version'), 'schema_present', to_regclass('public._sqlx_migrations') IS NOT NULL); ROLLBACK;`,
    ],
    connection,
  );
  const result = JSON.parse(existing);
  result.migrations = [];
  if (result.schema_present) {
    result.migrations = JSON.parse(
      await pg(
        "psql",
        [
          "-X",
          "-qAtw",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `${readTransaction(connection, snapshot)} SET LOCAL statement_timeout='5s'; SELECT COALESCE(json_agg(json_build_object('version',version,'success',success,'checksum',encode(checksum,'hex')) ORDER BY version),'[]'::json) FROM _sqlx_migrations; ROLLBACK;`,
        ],
        connection,
      ),
    );
    assert.ok(
      result.migrations.every((item) => item.success),
      "failed SQLx migration blocks the recovery baseline",
    );
  }
  result.scope =
    "read-only isolated database; no migration applied; no rollback compatibility claim";
  result.required_separate_material = [
    "source encryption key and its version in separate secure custody",
    "deployment configuration and required Agent credentials in separate secure custody",
    "authorized original media backup policy; cache is rebuildable",
  ];
  if (migrationsDirectory)
    result.candidate_migrations = await matchMigrationBaseline(
      result.migrations,
      migrationsDirectory,
    );
  return result;
}

async function keyMaterial(keyFile) {
  assert.ok(
    keyFile,
    "RAINSYNC_BACKUP_KEY_FILE must name a separately protected 32-byte binary key",
  );
  const key = await readFile(keyFile);
  assert.equal(
    key.length,
    32,
    "backup key file must contain exactly 32 binary bytes",
  );
  if (process.platform !== "win32") {
    const mode = (await stat(keyFile)).mode;
    assert.equal(
      mode & 0o077,
      0,
      "backup key file must not be group/world accessible",
    );
  }
  return key;
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

function fileSink(handle) {
  // Pipeline owns/destroys the Writable, while this function's caller owns the
  // FileHandle. This keeps authenticated-decryption failures from closing the
  // descriptor twice and masking the actual authentication failure.
  return new Writable({
    write(chunk, _encoding, callback) {
      (async () => {
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(
            chunk,
            written,
            chunk.length - written,
          );
          assert.ok(
            result.bytesWritten > 0,
            "backup file write made no progress",
          );
          written += result.bytesWritten;
        }
      })().then(() => callback(), callback);
    },
  });
}

export async function encryptArchive(plaintext, encrypted, keyFile) {
  const key = await keyMaterial(keyFile);
  const nonce = randomBytes(12);
  const header = Buffer.concat([magic, nonce]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const output = await open(encrypted, "wx", 0o600);
  try {
    await output.write(header);
    await pipeline(createReadStream(plaintext), cipher, fileSink(output));
    await output.write(
      cipher.getAuthTag(),
      0,
      tagBytes,
      (await stat(encrypted)).size,
    );
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(encrypted, { force: true });
    throw error;
  } finally {
    key.fill(0);
  }
  await output.close();
}

export async function decryptArchive(encrypted, plaintext, keyFile) {
  const key = await keyMaterial(keyFile);
  const input = await open(encrypted, "r");
  const output = await open(plaintext, "wx", 0o600);
  try {
    const size = (await input.stat()).size;
    assert.ok(size > headerBytes + tagBytes, "truncated backup envelope");
    const header = Buffer.alloc(headerBytes),
      tag = Buffer.alloc(tagBytes);
    await input.read(header, 0, headerBytes, 0);
    await input.read(tag, 0, tagBytes, size - tagBytes);
    assert.ok(
      header.subarray(0, magic.length).equals(magic),
      "unsupported backup envelope",
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(magic.length),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(encrypted, {
        start: headerBytes,
        end: size - tagBytes - 1,
      }),
      decipher,
      fileSink(output),
    );
    await output.sync();
  } catch {
    await output.close();
    await rm(plaintext, { force: true });
    throw Error("backup authentication/decryption failed; no database created");
  } finally {
    await input.close();
    key.fill(0);
  }
  await output.close();
}

async function privateDirectory(path) {
  // A new directory is mandatory. Existing evidence and backups are preserved.
  await mkdir(path, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function backup({ connection, output, keyFile, snapshot }) {
  if (!snapshot)
    return withDatabaseSnapshot(connection, (held) =>
      backup({ connection, output, keyFile, snapshot: held }),
    );
  const { id: snapshotId } = snapshotState(connection, snapshot);
  localConnection(connection);
  await keyMaterial(keyFile).then((key) => key.fill(0));
  const baseline = await preflight(connection, { snapshot });
  await privateDirectory(output);
  const plain = resolve(output, "database.dump.tmp"),
    encrypted = resolve(output, "database.dump.aesgcm");
  try {
    await pg(
      "pg_dump",
      [
        "-w",
        "-Fc",
        "--no-owner",
        "--no-acl",
        `--snapshot=${snapshotId}`,
        "-f",
        plain,
      ],
      connection,
      1800000,
    );
    await chmod(plain, 0o600);
    // Verify pg_dump produced a readable custom archive before encryption.
    await pg("pg_restore", ["-l", plain], connection);
    const afterDump = await preflight(connection);
    assert.deepEqual(
      afterDump.migrations,
      baseline.migrations,
      "migration baseline changed during backup; pause migrations and create a new backup",
    );
    await encryptArchive(plain, encrypted, keyFile);
    const manifest = {
      schema_version: 1,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      snapshot_started_at: snapshot.started_at,
      consistency: "exported PostgreSQL repeatable-read snapshot",
      encryption: "AES-256-GCM",
      archive: "database.dump.aesgcm",
      archive_sha256: await digest(encrypted),
      archive_bytes: (await stat(encrypted)).size,
      postgres: baseline,
      custody:
        "The encryption key and source decryption keys are not included. This is not a full application recovery claim.",
    };
    await writeFile(
      resolve(output, "backup.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } finally {
    await rm(plain, { force: true });
  }
}

export async function restore({
  connection,
  backupDirectory,
  output,
  keyFile,
}) {
  const maintenance = localConnection(connection);
  assert.ok(
    ["postgres", "template1"].includes(
      decodeURIComponent(maintenance.pathname.slice(1)),
    ),
    "restore requires a loopback maintenance database, never an application database",
  );
  const manifest = JSON.parse(
    await readFile(resolve(backupDirectory, "backup.json"), "utf8"),
  );
  assert.equal(manifest.schema_version, 1, "unsupported backup manifest");
  assert.equal(manifest.archive, "database.dump.aesgcm", "unsafe archive path");
  assert.equal(manifest.encryption, "AES-256-GCM");
  assert.match(manifest.archive_sha256, /^[a-f0-9]{64}$/);
  const archive = resolve(backupDirectory, manifest.archive);
  assert.equal(
    await digest(archive),
    manifest.archive_sha256,
    "encrypted backup checksum mismatch",
  );
  await privateDirectory(output);
  const plain = resolve(output, "restore.dump.tmp");
  const database = identifier(
    `rainsync_restore_${randomUUID().replaceAll("-", "")}`,
  );
  let created = false;
  const result = {
    schema_version: 1,
    database,
    result: "failed",
    backup_id: manifest.id,
    archive_sha256: manifest.archive_sha256,
    started_at: new Date().toISOString(),
    isolated_new_database: true,
    production_recovery_accepted: false,
  };
  try {
    // Authenticate the complete archive before any database mutation.
    await decryptArchive(archive, plain, keyFile);
    await pg("pg_restore", ["-l", plain], connection);
    await pg(
      "createdb",
      [
        "-w",
        "--maintenance-db=" + maintenance.pathname.slice(1),
        "--template=template0",
        database,
      ],
      connection,
    );
    created = true;
    const restored = new URL(maintenance);
    restored.pathname = "/" + database;
    await pg(
      "pg_restore",
      [
        "-w",
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-acl",
        "-d",
        database,
        plain,
      ],
      restored.href,
      1800000,
    );
    result.postgres = await preflight(restored.href);
    assert.deepEqual(
      result.postgres.migrations,
      manifest.postgres.migrations,
      "restored migration baseline differs from archive evidence",
    );
    result.result = "passed";
    result.application_checks_pending = [
      "source decryption with correct/wrong key",
      "login",
      "Agent reconnect",
      "browse",
      "play/seek/stop",
      "approved old-version migration/rollback",
    ];
    return result;
  } finally {
    await rm(plain, { force: true });
    result.database_created = created;
    result.finished_at = new Date().toISOString();
    await writeFile(
      resolve(output, "restore.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    // A failed new database is retained for diagnosis; existing DBs are untouched.
  }
}

async function cli() {
  const [action, ...args] = process.argv.slice(2);
  const options = new Map();
  for (const arg of args) {
    const match = /^--(output|backup|migrations)=(.+)$/.exec(arg);
    assert.ok(
      match && !options.has(match[1]),
      "unsupported or duplicate argument",
    );
    options.set(match[1], resolve(match[2]));
  }
  const connection = process.env.DATABASE_URL,
    keyFile = process.env.RAINSYNC_BACKUP_KEY_FILE;
  if (action === "preflight") {
    assert.ok(
      options.size === 0 || (options.size === 1 && options.has("migrations")),
    );
    console.log(
      JSON.stringify(
        await preflight(connection, {
          migrationsDirectory: options.get("migrations"),
        }),
        null,
        2,
      ),
    );
  } else if (action === "backup") {
    assert.ok(
      options.has("output") && options.size === 1,
      "backup requires --output=<new-directory>",
    );
    await backup({ connection, keyFile, output: options.get("output") });
    console.log(
      "PASS: encrypted backup created; source keys remain in separate custody",
    );
  } else if (action === "restore") {
    assert.ok(
      options.has("output") && options.has("backup") && options.size === 2,
      "restore requires --backup=<directory> --output=<new-directory>",
    );
    const result = await restore({
      connection,
      keyFile,
      output: options.get("output"),
      backupDirectory: options.get("backup"),
    });
    console.log(
      `PASS: isolated new database ${result.database}; application recovery checks remain pending`,
    );
  } else
    throw Error(
      "use preflight, backup or restore; authentication is provided only through environment/libpq",
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  cli().catch((error) => {
    console.error(
      error instanceof SyntaxError
        ? "recovery JSON is invalid; inspect private input without publishing its contents"
        : "recovery failed; inspect private connection, key and archive validation",
    );
    process.exitCode = 1;
  });
