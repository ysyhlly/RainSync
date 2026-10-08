import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createRecoverySet,
  decryptSource,
  verifyMaterials,
} from "../deploy/recovery-set.mjs";
import {
  backup,
  restore,
  withDatabaseSnapshot,
  readTransaction,
} from "../deploy/postgres-recovery.mjs";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
import { safeFailure } from "./fixtures/safe-failure.mjs";

const execute = promisify(execFile);
const inventory = JSON.parse(
  await readFile(
    new URL("../apps/server/src/source-key-inventory.json", import.meta.url),
    "utf8",
  ),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function material() {
  return {
    schema_version: 1,
    configuration: {},
    source_key: randomBytes(32).toString("base64"),
    source_key_version: "synthetic",
    original_media_policy: "Owned generated fixture only",
    agents: [],
  };
}
function encrypt(key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    nonce,
  );
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify({ synthetic: "private-fixture" })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
const native = {
  skip: !process.env.RAINSYNC_NATIVE_POSTGRES_BIN
    ? "requires owned native PostgreSQL fixture"
    : false,
  timeout: 120000,
};
async function fixtureRun(run) {
  const root = await mkdtemp(resolve(tmpdir(), "rainsync-recovery-integrity-"));
  const fixture = isolatedPostgres({ root, name: "recovery-integrity" });
  try {
    await fixture.start();
    await run(fixture, root);
  } finally {
    await fixture.stop();
    await fixture.verifyStopped();
    await rm(root, { recursive: true, force: true });
  }
}

test("source and platform encrypted fields use one fixed startup/recovery inventory", async () => {
  assert.deepEqual(
    inventory.map(({ table, column }) => `${table}.${column}`),
    [
      "sources.config_encrypted",
      "source_access_policy_snapshots.config_encrypted",
      "platform_accounts.credential_encrypted",
      "platform_oauth_accounts.token_encrypted",
      "platform_oauth_requests.secret_encrypted",
      "platform_account_renewals.refresh_encrypted",
      "platform_login_requests.qr_key_encrypted",
      "platform_login_requests.qr_payload_encrypted",
    ],
  );
  const rust = await readFile(
    new URL("../apps/server/src/source_key_check.rs", import.meta.url),
    "utf8",
  );
  assert.match(rust, /include_str!\([\s\S]*?source-key-inventory\.json/);
  for (const field of inventory) {
    for (const name of [field.table, field.column, field.id_column])
      assert.match(name, /^[a-z_]+$/);
  }
  assert.throws(
    () => readTransaction("postgres://user:fixture@localhost/owned", {}),
    /not active/,
  );
});

test("private malformed input and arbitrary assertion diagnostics never leave safe error boundaries", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "rainsync-private-input-"));
  const sentinel = "SYNTHETIC_SECRET_DO_NOT_REPORT_12345";
  try {
    const input = resolve(root, "input.json");
    await writeFile(input, `{"source_key": ${sentinel}}`, { mode: 0o600 });
    await assert.rejects(
      execute(
        process.execPath,
        [
          "deploy/recovery-set.mjs",
          "backup",
          `--database=${root}/database`,
          `--materials=${root}/material`,
        ],
        {
          env: { ...process.env, RAINSYNC_RECOVERY_INPUT_FILE: input },
          timeout: 10000,
        },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.ok(!(error.stdout + error.stderr).includes(sentinel));
        assert.match(error.stderr, /recovery JSON is invalid/);
        return true;
      },
    );
    const backupDirectory = resolve(root, "malformed-backup");
    await mkdir(backupDirectory);
    await writeFile(
      resolve(backupDirectory, "backup.json"),
      `{"archive": ${sentinel}}`,
    );
    await assert.rejects(
      execute(
        process.execPath,
        [
          "deploy/postgres-recovery.mjs",
          "restore",
          `--backup=${backupDirectory}`,
          `--output=${root}/restore`,
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: "postgres://fixture:synthetic@127.0.0.1/postgres",
          },
          timeout: 10000,
        },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.ok(!(error.stdout + error.stderr).includes(sentinel));
        assert.match(error.stderr, /recovery JSON is invalid/);
        return true;
      },
    );
    let failure;
    try {
      assert.equal(sentinel, "expected-fixture", "safe assertion label");
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure.message.includes(sentinel),
      "regression exercises a genuine assertion diff",
    );
    assert.equal(safeFailure(failure), "assertion_failed");
    assert.equal(
      safeFailure(new Error(`postgres://${sentinel}@localhost/private`)),
      "verification_failed",
    );
    assert.ok(
      !JSON.stringify({ error: safeFailure(failure) }).includes(sentinel),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "every encrypted field rejects wrong keys and corrupt bytes before backup output exists",
  native,
  async () =>
    fixtureRun(async (fixture, root) => {
      const tables = new Map();
      for (const field of inventory) {
        if (!tables.has(field.table))
          tables.set(
            field.table,
            new Set([`${field.id_column} uuid PRIMARY KEY`]),
          );
        tables.get(field.table).add(`${field.column} text`);
      }
      tables.get("platform_login_requests").add("status text");
      tables.get("platform_login_requests").add("expires_at timestamptz");
      for (const [table, columns] of tables)
        fixture.sql(`CREATE TABLE ${table} (${[...columns].join(",")})`);
      fixture.sql(
        "CREATE TABLE agents(id uuid PRIMARY KEY, token_hash text, revoked boolean)",
      );
      const saved = material();
      const databaseKeyFile = resolve(root, "database-key"),
        materialKeyFile = resolve(root, "material-key");
      await writeFile(databaseKeyFile, randomBytes(32), { mode: 0o600 });
      await writeFile(materialKeyFile, randomBytes(32), { mode: 0o600 });
      for (const [index, field] of inventory.entries()) {
        const { table, column, id_column: id } = field;
        const login = table === "platform_login_requests";
        fixture.sql(
          `INSERT INTO ${table}(${id},${column}${login ? ",status,expires_at" : ""}) VALUES('${randomUUID()}','${encrypt(saved.source_key)}'${login ? ",'pending',clock_timestamp()+interval '1 hour'" : ""})`,
        );
        const checked = await verifyMaterials(fixture.url, saved);
        assert.equal(
          checked.source_records_decrypted + checked.platform_records_decrypted,
          1,
          `field ${index} included`,
        );
        for (const corrupt of [false, true]) {
          if (corrupt)
            fixture.sql(`UPDATE ${table} SET ${column}='corrupt-synthetic'`);
          const databaseOutput = resolve(root, `db-${index}-${corrupt}`),
            materialOutput = resolve(root, `material-${index}-${corrupt}`);
          await assert.rejects(
            createRecoverySet({
              connection: fixture.url,
              materials: corrupt
                ? saved
                : { ...saved, source_key: randomBytes(32).toString("base64") },
              databaseOutput,
              materialOutput,
              databaseKeyFile,
              materialKeyFile,
            }),
            /source_key_mismatch_or_corrupt_ciphertext/,
          );
          await assert.rejects(stat(databaseOutput), { code: "ENOENT" });
          await assert.rejects(stat(materialOutput), { code: "ENOENT" });
        }
        fixture.sql(`TRUNCATE ${table}`);
      }
      // Match startup null/expiry/status selection, without reviving expired requests.
      fixture.sql(
        `INSERT INTO platform_login_requests VALUES('${randomUUID()}','corrupt','corrupt','pending',clock_timestamp()-interval '1 hour'),('${randomUUID()}','corrupt','corrupt','confirmed',clock_timestamp()+interval '1 hour'),('${randomUUID()}',NULL,NULL,'pending',clock_timestamp()+interval '1 hour')`,
      );
      assert.equal(
        (await verifyMaterials(fixture.url, saved)).platform_records_decrypted,
        0,
      );
      // Cross a page boundary while all preceding data is valid.
      fixture.sql(
        `INSERT INTO platform_accounts SELECT gen_random_uuid(),'${encrypt(saved.source_key)}' FROM generate_series(1,101)`,
      );
      assert.equal(
        (await verifyMaterials(fixture.url, saved)).platform_records_decrypted,
        101,
      );
      fixture.sql(
        `INSERT INTO platform_accounts VALUES('ffffffff-ffff-ffff-ffff-ffffffffffff','corrupt-synthetic')`,
      );
      await assert.rejects(
        verifyMaterials(fixture.url, saved),
        /source_key_mismatch/,
      );
    }),
);

test(
  "pairing and revocation between material validation and dump preserve the captured recovery point",
  native,
  async () =>
    fixtureRun(async (fixture, root) => {
      fixture.sql(
        "CREATE TABLE agents(id uuid PRIMARY KEY, token_hash text, revoked boolean)",
      );
      const keyFile = resolve(root, "database-key");
      await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
      const maintenance = new URL(fixture.url);
      maintenance.pathname = "/postgres";
      for (const change of ["pair", "revoke"]) {
        fixture.sql("TRUNCATE agents");
        const saved = material();
        const agent = {
          id: randomUUID(),
          credential: { token: randomBytes(32).toString("hex") },
          drained_receipts: [],
        };
        if (change === "revoke") {
          saved.agents.push(agent);
          fixture.sql(
            `INSERT INTO agents VALUES('${agent.id}','${sha(agent.credential.token)}',false)`,
          );
        }
        const output = resolve(root, `backup-${change}`);
        let held;
        await withDatabaseSnapshot(fixture.url, async (snapshot) => {
          held = snapshot;
          await verifyMaterials(fixture.url, saved, { snapshot });
          if (change === "pair")
            fixture.sql(
              `INSERT INTO agents VALUES('${agent.id}','${sha(agent.credential.token)}',false)`,
            );
          else
            fixture.sql(
              `UPDATE agents SET revoked=true WHERE id='${agent.id}'`,
            );
          await assert.rejects(
            verifyMaterials(fixture.url, saved),
            /all and only/,
          );
          const captured = await backup({
            connection: fixture.url,
            output,
            keyFile,
            snapshot,
          });
          assert.equal(captured.snapshot_started_at, snapshot.started_at);
        });
        assert.throws(() => readTransaction(fixture.url, held), /not active/);
        const restored = await restore({
          connection: maintenance.href,
          backupDirectory: output,
          output: resolve(root, `restore-${change}`),
          keyFile,
        });
        const target = new URL(fixture.url);
        target.pathname = `/${restored.database}`;
        assert.equal(
          (await verifyMaterials(target.href, saved))
            .active_agent_credentials_matched,
          saved.agents.length,
        );
      }
    }),
);

test("recovery ciphertext validation rejects noncanonical base64 and invalid UTF-8", () => {
  const saved = material();
  const value = encrypt(saved.source_key);
  assert.doesNotThrow(() => decryptSource(value, saved.source_key));
  assert.throws(
    () => decryptSource(value.replace(/=+$/, ""), saved.source_key),
    /source_key_mismatch/,
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(saved.source_key, "base64"),
    nonce,
  );
  const malformed = Buffer.concat([
    nonce,
    cipher.update(Buffer.from([0x22, 0xff, 0x22])),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  assert.throws(
    () => decryptSource(malformed, saved.source_key),
    /source_key_mismatch/,
  );
});

test(
  "lost snapshot exporter cannot produce a complete backup manifest",
  native,
  async () =>
    fixtureRun(async (fixture, root) => {
      fixture.sql(
        "CREATE TABLE agents(id uuid PRIMARY KEY, token_hash text, revoked boolean)",
      );
      const keyFile = resolve(root, "key");
      const output = resolve(root, "interrupted-backup");
      await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
      await assert.rejects(
        withDatabaseSnapshot(fixture.url, async (snapshot) => {
          await verifyMaterials(fixture.url, material(), { snapshot });
          assert.equal(
            fixture.sql(
              "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='rainsync-isolated-recovery' AND state='idle in transaction'",
            ),
            "t",
            "terminates only this owned fixture's snapshot exporter",
          );
          await backup({ connection: fixture.url, output, keyFile, snapshot });
        }),
        /snapshot|psql|pg_dump/,
      );
      await assert.rejects(stat(resolve(output, "backup.json")), {
        code: "ENOENT",
      });
    }),
);
