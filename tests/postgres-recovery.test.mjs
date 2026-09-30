import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  backup,
  decryptArchive,
  encryptArchive,
  localConnection,
  matchMigrationBaseline,
  pg,
  preflight,
  restore,
} from "../deploy/postgres-recovery.mjs";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

test("connection policy rejects remote and libpq host overrides", () => {
  assert.equal(
    localConnection("postgres://user:pass@127.0.0.1:1234/test?sslmode=disable")
      .port,
    "1234",
  );
  assert.throws(
    () => localConnection("postgres://user:pass@example.org/test"),
    /loopback/,
  );
  assert.throws(
    () =>
      localConnection(
        "postgres://user:pass@localhost/test?hostaddr=169.254.169.254",
      ),
    /parameter/,
  );
  assert.throws(
    () =>
      localConnection("postgres://user:pass@localhost/test?service=production"),
    /parameter/,
  );
});

test("migration preflight refuses unknown versions and edited immutable checksums", async () => {
  const root = resolve(
    tmpdir(),
    "rainsync-recovery-migrations-" + randomUUID(),
  );
  await mkdir(root);
  try {
    const sql = "-- synthetic fixture\nCREATE TABLE synthetic(id int);\n";
    await writeFile(resolve(root, "0001_synthetic.sql"), sql);
    await writeFile(resolve(root, "0002_future.sql"), "-- synthetic pending\n");
    const checksum = createHash("sha384").update(sql).digest("hex");
    assert.deepEqual(
      (
        await matchMigrationBaseline(
          [{ version: 1, success: true, checksum }],
          root,
        )
      ).pending_versions,
      [2],
    );
    await assert.rejects(
      matchMigrationBaseline([{ version: 9, success: true, checksum }], root),
      /absent/,
    );
    await assert.rejects(
      matchMigrationBaseline(
        [{ version: 1, success: true, checksum: "00" }],
        root,
      ),
      /checksum/,
    );
    await assert.rejects(
      matchMigrationBaseline([{ version: 1, success: false, checksum }], root),
      /failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming encryption roundtrips bytes and wrong key/tampering leave no plaintext", async () => {
  const root = resolve(tmpdir(), "rainsync-recovery-crypto-" + randomUUID());
  await mkdir(root, { mode: 0o700 });
  const key = resolve(root, "key"),
    wrongKey = resolve(root, "wrong-key");
  const plain = resolve(root, "plain"),
    encrypted = resolve(root, "encrypted");
  try {
    await writeFile(key, randomBytes(32), { mode: 0o600 });
    await writeFile(wrongKey, randomBytes(32), { mode: 0o600 });
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    await writeFile(plain, bytes, { mode: 0o600 });
    await encryptArchive(plain, encrypted, key);
    await decryptArchive(encrypted, resolve(root, "restored"), key);
    assert.ok((await readFile(resolve(root, "restored"))).equals(bytes));
    await assert.rejects(
      decryptArchive(encrypted, resolve(root, "bad-key-output"), wrongKey),
      /authentication/,
    );
    await assert.rejects(stat(resolve(root, "bad-key-output")), {
      code: "ENOENT",
    });
    const damaged = await readFile(encrypted);
    damaged[damaged.length - 20] ^= 0x80;
    await writeFile(resolve(root, "damaged"), damaged, { mode: 0o600 });
    await assert.rejects(
      decryptArchive(
        resolve(root, "damaged"),
        resolve(root, "damaged-output"),
        key,
      ),
      /authentication/,
    );
    await assert.rejects(stat(resolve(root, "damaged-output")), {
      code: "ENOENT",
    });
    await assert.rejects(encryptArchive(plain, encrypted, key), {
      code: "EEXIST",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "synthetic PostgreSQL backup restores only into a fresh database and preserves rows/migrations",
  {
    skip: !process.env.RAINSYNC_NATIVE_POSTGRES_BIN
      ? "set RAINSYNC_NATIVE_POSTGRES_BIN for an actual isolated PostgreSQL drill"
      : false,
  },
  async () => {
    assert.ok(
      process.env.RAINSYNC_ARTIFACT_DIR,
      "explicit owned artifact directory required",
    );
    const id = randomUUID(),
      root = resolve(
        process.env.RAINSYNC_ARTIFACT_DIR,
        "postgres-recovery",
        id,
      );
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fixture = isolatedPostgres({ root, name: "f-recovery", id });
    const keyFile = resolve(root, "temporary-backup-key");
    const report = {
      schema_version: 1,
      scope:
        "new isolated PostgreSQL with synthetic schema/data only; not a real old RainSync database",
      started_at: new Date().toISOString(),
      result: "failed",
    };
    try {
      await fixture.start();
      await writeFile(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
      fixture.sql(
        "CREATE TABLE _sqlx_migrations(version bigint PRIMARY KEY, success boolean NOT NULL, checksum bytea NOT NULL); INSERT INTO _sqlx_migrations VALUES(1,true,decode(repeat('ab',48),'hex')); CREATE TABLE recovery_sample(id int PRIMARY KEY, title text NOT NULL, encrypted_source bytea NOT NULL); INSERT INTO recovery_sample VALUES(1,'自有合成样本',decode('01ab00ff','hex')),(2,'second',decode('000102','hex')); ",
      );
      const query =
        "SELECT json_agg(json_build_object('id',id,'title',title,'encrypted_source',encode(encrypted_source,'hex')) ORDER BY id) FROM recovery_sample;";
      const before = fixture.sql(query);
      assert.equal((await preflight(fixture.url)).migrations.length, 1);
      const backupDirectory = resolve(root, "backup");
      const manifest = await backup({
        connection: fixture.url,
        output: backupDirectory,
        keyFile,
      });
      const maintenance = new URL(fixture.url);
      maintenance.pathname = "/postgres";
      const restored = await restore({
        connection: maintenance.href,
        backupDirectory,
        output: resolve(root, "restore"),
        keyFile,
      });
      const target = new URL(fixture.url);
      target.pathname = "/" + restored.database;
      const after = await pg(
        "psql",
        ["-X", "-qAtw", "-v", "ON_ERROR_STOP=1", "-c", query],
        target.href,
      );
      assert.equal(after, before);
      assert.equal(
        fixture.sql(query),
        before,
        "source database remains unchanged",
      );
      assert.deepEqual(
        restored.postgres.migrations,
        manifest.postgres.migrations,
      );
      await assert.rejects(
        restore({
          connection: fixture.url,
          backupDirectory,
          output: resolve(root, "refuse-app-db"),
          keyFile,
        }),
        /maintenance/,
      );
      const plaintextTemporary = [
        resolve(backupDirectory, "database.dump.tmp"),
        resolve(root, "restore", "restore.dump.tmp"),
      ];
      for (const path of plaintextTemporary)
        await assert.rejects(stat(path), { code: "ENOENT" });
      const damaged = await readFile(
        resolve(backupDirectory, manifest.archive),
      );
      damaged[30] ^= 1;
      await writeFile(resolve(backupDirectory, manifest.archive), damaged);
      // An unauthenticated modified manifest cannot authorize corrupted ciphertext.
      manifest.archive_sha256 = createHash("sha256")
        .update(damaged)
        .digest("hex");
      await writeFile(
        resolve(backupDirectory, "backup.json"),
        JSON.stringify(manifest),
      );
      const databasesBefore = fixture.sql("SELECT count(*) FROM pg_database;");
      await assert.rejects(
        restore({
          connection: maintenance.href,
          backupDirectory,
          output: resolve(root, "corrupt-restore"),
          keyFile,
        }),
        /authentication/,
      );
      assert.equal(
        fixture.sql("SELECT count(*) FROM pg_database;"),
        databasesBefore,
        "bad ciphertext creates no database",
      );
      report.result = "passed";
      report.rows_preserved = 2;
      report.migrations_preserved = 1;
      report.tampered_encrypted_backup_rejected = true;
    } finally {
      await rm(keyFile, { force: true });
      await fixture.stop();
      report.cleanup = await fixture.verifyStopped();
      report.finished_at = new Date().toISOString();
      await writeFile(
        resolve(root, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log("Recovery evidence: " + resolve(root, "report.json"));
    }
  },
);

test(
  "frozen RainSync 1-31 schema checksums survive an isolated empty-database recovery",
  {
    skip: !process.env.RAINSYNC_NATIVE_POSTGRES_BIN
      ? "set RAINSYNC_NATIVE_POSTGRES_BIN for isolated PostgreSQL"
      : false,
  },
  async () => {
    assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
    const id = randomUUID(),
      root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, "schema-recovery", id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fixture = isolatedPostgres({ root, name: "f-schema-recovery", id });
    const keyFile = resolve(root, "temporary-backup-key");
    const report = {
      schema_version: 1,
      result: "failed",
      scope:
        "fresh empty RainSync schema from frozen 1-31 files; not a real old production database or app acceptance",
      started_at: new Date().toISOString(),
    };
    try {
      await fixture.start();
      fixture.sql(
        "CREATE TABLE _sqlx_migrations(version bigint PRIMARY KEY, success boolean NOT NULL, checksum bytea NOT NULL);",
      );
      const directory = resolve("migrations");
      const migrations = (await readdir(directory))
        .filter((name) => /^\d+_[^.]+\.sql$/.test(name))
        .sort();
      assert.equal(
        migrations.length,
        31,
        "test must explicitly track controller migration baseline",
      );
      for (const name of migrations) {
        const sql = await readFile(resolve(directory, name), "utf8");
        const version = Number(name.split("_")[0]);
        const checksum = createHash("sha384").update(sql).digest("hex");
        fixture.sql(
          `BEGIN; ${sql}\nINSERT INTO _sqlx_migrations VALUES(${version},true,decode('${checksum}','hex')); COMMIT;`,
        );
      }
      const baseline = await preflight(fixture.url, {
        migrationsDirectory: directory,
      });
      assert.equal(baseline.migrations.at(-1).version, 31);
      assert.deepEqual(baseline.candidate_migrations.pending_versions, []);
      await writeFile(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
      const backupDirectory = resolve(root, "backup");
      await backup({
        connection: fixture.url,
        output: backupDirectory,
        keyFile,
      });
      const maintenance = new URL(fixture.url);
      maintenance.pathname = "/postgres";
      const restored = await restore({
        connection: maintenance.href,
        backupDirectory,
        output: resolve(root, "restore"),
        keyFile,
      });
      const target = new URL(fixture.url);
      target.pathname = "/" + restored.database;
      const actual = await preflight(target.href, {
        migrationsDirectory: directory,
      });
      assert.deepEqual(actual.migrations, baseline.migrations);
      assert.deepEqual(actual.candidate_migrations.pending_versions, []);
      report.result = "passed";
      report.installed_migration_count = actual.migrations.length;
      report.sqlx_sha384_checksums_verified = true;
    } finally {
      await rm(keyFile, { force: true });
      await fixture.stop();
      report.cleanup = await fixture.verifyStopped();
      report.finished_at = new Date().toISOString();
      await writeFile(
        resolve(root, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log("Schema recovery evidence: " + resolve(root, "report.json"));
    }
  },
);
