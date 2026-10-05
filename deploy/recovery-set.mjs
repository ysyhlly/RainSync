// Full encrypted recovery material set. DB and application material use different
// keys and separate destinations. This CLI never targets an existing database.
import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  realpath,
} from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backup,
  restore,
  encryptArchive,
  decryptArchive,
  localConnection,
  pg,
} from "./postgres-recovery.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateMaterials(materials) {
  assert.equal(
    materials.schema_version,
    1,
    "unsupported application material schema",
  );
  assert.ok(
    materials.configuration &&
      typeof materials.configuration === "object" &&
      !Array.isArray(materials.configuration),
    "configuration object required",
  );
  for (const [key, value] of Object.entries(materials.configuration)) {
    assert.match(key, /^[A-Z][A-Z0-9_]*$/, "invalid configuration name");
    assert.equal(
      typeof value,
      "string",
      "configuration values must be strings",
    );
    assert.ok(
      !["SOURCE_ENCRYPTION_KEY", "AGENT_TOKEN", "PAIR_CODE", "RAINSYNC_CONTROL_PEER_TOKEN"].includes(key),
      "source key, Agent credentials and cluster peer token must not be ordinary recovery configuration",
    );
  }
  assert.match(
    materials.source_key_version ?? "",
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "source key version required",
  );
  assert.match(
    materials.source_key ?? "",
    /^[A-Za-z0-9+/]{43}=$/,
    "source key must encode 32 bytes",
  );
  assert.ok(
    typeof materials.original_media_policy === "string" &&
      materials.original_media_policy.trim().length > 0 &&
      materials.original_media_policy.length <= 4000,
    "original media backup/restore policy required",
  );
  assert.ok(
    Array.isArray(materials.agents),
    "necessary Agent credential inventory required (explicit [] if none)",
  );
  const ids = new Set();
  for (const agent of materials.agents) {
    assert.match(agent.id ?? "", uuid, "invalid Agent identity");
    assert.ok(!ids.has(agent.id), "duplicate Agent material");
    ids.add(agent.id);
    assert.ok(
      agent.credential &&
        typeof agent.credential.token === "string" &&
        agent.credential.token.length > 0,
      "Agent credential token required",
    );
    assert.ok(
      Array.isArray(agent.drained_receipts) &&
        agent.drained_receipts.length <= 4096 &&
        agent.drained_receipts.every(
          (id) => typeof id === "string" && uuid.test(id),
        ),
      "invalid existing Agent drained-receipt file",
    );
  }
  return materials;
}
export function decryptSource(value, encodedKey) {
  try {
    assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/);
    const data = Buffer.from(value, "base64"),
      key = Buffer.from(encodedKey, "base64");
    assert.equal(key.length, 32);
    assert.ok(data.length >= 28);
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(12, -16)),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw Error(
      "source_key_mismatch_or_corrupt_ciphertext: restore the matching source key and version; source is not an empty library",
    );
  }
}
async function rows(connection, query) {
  return JSON.parse(
    await pg(
      "psql",
      [
        "-X",
        "-qAtw",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; ${query}; ROLLBACK;`,
      ],
      connection,
    ),
  );
}
export async function verifyMaterials(connection, raw) {
  localConnection(connection);
  const materials = validateMaterials(raw);
  let checked = 0;
  for (const table of ["sources", "source_access_policy_snapshots"]) {
    const present = await rows(
      connection,
      `SELECT to_json(to_regclass('public.${table}') IS NOT NULL)`,
    );
    if (!present) continue;
    const idColumn = table === "sources" ? "id" : "source_id";
    let after = null;
    while (true) {
      const batch = await rows(
        connection,
        `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT ${idColumn} AS id,config_encrypted FROM ${table} WHERE ${after === null ? "TRUE" : `${idColumn}>'${after}'::uuid`} ORDER BY ${idColumn} LIMIT 100) t`,
      );
      for (const row of batch) {
        assert.match(row.id, uuid);
        decryptSource(row.config_encrypted, materials.source_key);
        checked++;
      }
      if (batch.length < 100) break;
      after = batch.at(-1).id;
    }
  }
  const agents = await rows(
    connection,
    "SELECT COALESCE(json_agg(json_build_object('id',id,'token_hash',token_hash,'revoked',revoked)), '[]'::json) FROM agents",
  );
  const active = agents.filter((agent) => !agent.revoked && agent.token_hash);
  assert.equal(
    materials.agents.length,
    active.length,
    "all and only active paired Agent credentials must be present",
  );
  for (const saved of materials.agents) {
    const actual = agents.find((agent) => agent.id === saved.id);
    assert.ok(
      actual &&
        !actual.revoked &&
        actual.token_hash &&
        actual.token_hash === sha(saved.credential.token),
      "Agent credential mismatch or revoked credential; re-pair under separate authorization, never revive revoked credentials",
    );
  }
  return {
    source_records_decrypted: checked,
    active_agent_credentials_matched: active.length,
    receipt_scope:
      "existing persisted receipt bytes preserved only; no historical process release proof inferred",
  };
}
async function separateKeys(a, b) {
  assert.notEqual(
    await realpath(a),
    await realpath(b),
    "database and material encryption keys must be separately held",
  );
  const first = await readFile(a),
    second = await readFile(b);
  try {
    assert.equal(first.length, 32);
    assert.equal(second.length, 32);
    assert.ok(
      !first.equals(second),
      "database and material encryption keys must differ",
    );
  } finally {
    first.fill(0);
    second.fill(0);
  }
}
function separateDestinations(a, b) {
  const isChild = (parent, child) => {
    const part = relative(resolve(parent), resolve(child));
    return !part || (!part.startsWith("..") && !isAbsolute(part));
  };
  assert.ok(
    !isChild(a, b) && !isChild(b, a),
    "database and material destinations must be separate non-nested directories",
  );
}
export async function createRecoverySet({
  connection,
  materials,
  databaseOutput,
  materialOutput,
  databaseKeyFile,
  materialKeyFile,
}) {
  separateDestinations(databaseOutput, materialOutput);
  await separateKeys(databaseKeyFile, materialKeyFile);
  const checked = await verifyMaterials(connection, materials);
  // All preflight authentication checks precede creating a backup.
  const database = await backup({
    connection,
    output: databaseOutput,
    keyFile: databaseKeyFile,
  });
  await mkdir(materialOutput, { mode: 0o700 });
  const temporary = resolve(materialOutput, "materials.tmp"),
    archive = resolve(materialOutput, "materials.aesgcm");
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        ...materials,
        database_backup_id: database.id,
        database_archive_sha256: database.archive_sha256,
      }),
      { mode: 0o600, flag: "wx" },
    );
    await encryptArchive(temporary, archive, materialKeyFile);
    const manifest = {
      schema_version: 1,
      id: randomUUID(),
      database_backup_id: database.id,
      archive: "materials.aesgcm",
      archive_sha256: sha(await readFile(archive)),
      checked,
      custody:
        "separate encrypted material archive; keep this archive and its key under access control independent of the database archive/key",
      production_recovery_accepted: false,
    };
    await writeFile(
      resolve(materialOutput, "materials.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return manifest;
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function restoreRecoverySet({
  connection,
  databaseDirectory,
  materialDirectory,
  output,
  databaseKeyFile,
  materialKeyFile,
}) {
  const maintenance = localConnection(connection);
  assert.ok(
    ["postgres", "template1"].includes(
      decodeURIComponent(maintenance.pathname.slice(1)),
    ),
    "recovery set requires a maintenance database",
  );
  await separateKeys(databaseKeyFile, materialKeyFile);
  const databaseManifest = JSON.parse(
    await readFile(resolve(databaseDirectory, "backup.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(resolve(materialDirectory, "materials.json"), "utf8"),
  );
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.archive, "materials.aesgcm");
  const archive = resolve(materialDirectory, manifest.archive);
  assert.equal(
    sha(await readFile(archive)),
    manifest.archive_sha256,
    "material archive checksum mismatch",
  );
  await mkdir(output, { mode: 0o700 });
  const temporary = resolve(output, "materials.tmp");
  const result = {
    schema_version: 1,
    result: "failed",
    production_recovery_accepted: false,
  };
  try {
    await decryptArchive(archive, temporary, materialKeyFile);
    const materials = validateMaterials(
      JSON.parse(await readFile(temporary, "utf8")),
    );
    assert.equal(
      materials.database_backup_id,
      databaseManifest.id,
      "material/database backup identity mismatch",
    );
    assert.equal(
      materials.database_archive_sha256,
      databaseManifest.archive_sha256,
      "material/database archive binding mismatch",
    );
    const restored = await restore({
      connection,
      backupDirectory: databaseDirectory,
      output: resolve(output, "database"),
      keyFile: databaseKeyFile,
    });
    const target = new URL(maintenance);
    target.pathname = "/" + restored.database;
    result.database = restored.database;
    result.checked = await verifyMaterials(target.href, materials);
    // New empty cache and new private files only. Never replace active config,
    // a credential, a media mount, or any existing target database.
    await mkdir(resolve(output, "cache"), { mode: 0o700 });
    await mkdir(resolve(output, "agents"), { mode: 0o700 });
    const save = (path, value) =>
      writeFile(resolve(output, path), JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    await save("configuration.json", {
      ...materials.configuration,
      DATABASE_URL: target.href,
      CACHE_ROOT: resolve(output, "cache"),
    });
    await save("source-key.json", {
      version: materials.source_key_version,
      key: materials.source_key,
    });
    for (const agent of materials.agents) {
      await save(`agents/${agent.id}.json`, agent.credential);
      await save(
        `agents/${agent.id}.json.drained.json`,
        agent.drained_receipts,
      );
    }
    await save("media-policy.json", {
      policy: materials.original_media_policy,
    });
    result.result = "passed";
    result.application_checks_pending = [
      "login",
      "existing-room recovery",
      "real Agent reconnect",
      "real-library browse",
      "direct/transcoded playback",
      "seek",
      "stop",
      "cache rebuild",
      "old/new image compatibility",
    ];
    return result;
  } finally {
    await rm(temporary, { force: true });
    await writeFile(
      resolve(output, "recovery.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
}
async function cli() {
  const [action, ...raw] = process.argv.slice(2),
    options = new Map();
  for (const arg of raw) {
    const match = /^--(materials|database|output)=(.+)$/.exec(arg);
    assert.ok(match && !options.has(match[1]), "unsupported/duplicate option");
    options.set(match[1], resolve(match[2]));
  }
  const common = {
    connection: process.env.DATABASE_URL,
    databaseKeyFile: process.env.RAINSYNC_BACKUP_KEY_FILE,
    materialKeyFile: process.env.RAINSYNC_MATERIAL_KEY_FILE,
  };
  assert.ok(
    options.has("materials") && options.has("database"),
    "--materials and --database are required",
  );
  if (action === "backup") {
    assert.equal(options.size, 2);
    assert.ok(
      process.env.RAINSYNC_RECOVERY_INPUT_FILE,
      "RAINSYNC_RECOVERY_INPUT_FILE must identify authorized private application material JSON",
    );
    const file = process.env.RAINSYNC_RECOVERY_INPUT_FILE;
    if (process.platform !== "win32")
      assert.equal(
        (await stat(file)).mode & 0o077,
        0,
        "recovery input must be private",
      );
    await createRecoverySet({
      ...common,
      materials: JSON.parse(await readFile(file, "utf8")),
      databaseOutput: options.get("database"),
      materialOutput: options.get("materials"),
    });
    console.log(
      "PASS: separate encrypted database and application material archives created; real application recovery remains unverified",
    );
  } else if (action === "restore") {
    assert.ok(options.has("output") && options.size === 3);
    const report = await restoreRecoverySet({
      ...common,
      databaseDirectory: options.get("database"),
      materialDirectory: options.get("materials"),
      output: options.get("output"),
    });
    console.log(JSON.stringify(report, null, 2));
  } else throw Error("use backup or restore");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  cli().catch((error) => {
    console.error(
      error.code
        ? "recovery I/O failed; inspect private paths and access"
        : error.message,
    );
    process.exitCode = 1;
  });
