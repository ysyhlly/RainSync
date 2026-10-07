// Exact-commit schema upgrade and restore receipt. This intentionally does not
// claim old/new executable, login, playback, device or production acceptance.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
import {
  backup,
  restore,
  preflight,
  matchMigrationBaseline,
  pg,
} from "../deploy/postgres-recovery.mjs";
const baselineSha = "bc0f9f1d8683ee27be581661d0e9dde36088fe55";
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
const checksum = (value) => createHash("sha384").update(value).digest("hex");
async function inventory() {
  const candidateSha = git("rev-parse", "HEAD").trim();
  assert.match(candidateSha, /^[a-f0-9]{40}$/);
  const names = (await readdir("migrations"))
    .filter((name) => /^\d+_[^.]+\.sql$/.test(name))
    .sort();
  const baselineNames = git(
    "ls-tree",
    "--name-only",
    baselineSha,
    "migrations/",
  )
    .trim()
    .split("\n")
    .map((path) => path.replace(/^migrations\//, ""));
  const candidateNames = git(
    "ls-tree",
    "--name-only",
    candidateSha,
    "migrations/",
  )
    .trim()
    .split("\n")
    .map((path) => path.replace(/^migrations\//, ""));
  assert.deepEqual(
    names,
    candidateNames,
    "candidate migration inventory must equal its bound commit",
  );
  const candidate = [];
  for (const name of names) {
    const bytes = await readFile(resolve("migrations", name), "utf8");
    assert.equal(
      checksum(bytes),
      checksum(git("show", `${candidateSha}:migrations/${name}`)),
      "candidate migration bytes differ from bound commit",
    );
    if (baselineNames.includes(name))
      assert.equal(
        checksum(bytes),
        checksum(git("show", `${baselineSha}:migrations/${name}`)),
        "published baseline migration changed",
      );
    candidate.push({
      name,
      version: Number(name.split("_")[0]),
      checksum: checksum(bytes),
      bytes,
    });
  }
  assert.ok(
    baselineNames.every((name) => names.includes(name)),
    "published migration removed or renamed",
  );
  const baseline = candidate.filter(({ name }) => baselineNames.includes(name));
  assert.equal(
    baseline.at(-1).version,
    86,
    "fixture is the recent pre-settings baseline",
  );
  return { baselineSha, candidateSha, baseline, candidate };
}

test("full immutable migration history is checked against the recent published baseline and candidate SHA", async () => {
  const found = await inventory();
  assert.deepEqual(
    found.candidate
      .filter(({ version }) => version > 86)
      .map(({ version }) => version),
    [87, 88],
  );
});

test(
  "populated recent baseline upgrades and restores separately while old-schema preflight remains closed",
  {
    skip: !process.env.RAINSYNC_NATIVE_POSTGRES_BIN
      ? "requires owned native PostgreSQL fixture"
      : false,
    timeout: 120000,
  },
  async () => {
    const found = await inventory();
    const root = await mkdtemp(resolve(tmpdir(), "rainsync-current-upgrade-"));
    const fixture = isolatedPostgres({ root, name: "current-upgrade" });
    const baselineDirectory = resolve(root, "baseline-migrations");
    await mkdir(baselineDirectory);
    const report = {
      result: "failed",
      baseline_commit: found.baselineSha,
      candidate_commit: found.candidateSha,
      migrations: found.candidate.map(({ name, version, checksum }) => ({
        name,
        version,
        checksum,
      })),
      application_acceptance: false,
    };
    try {
      await fixture.start();
      fixture.sql(
        "CREATE TABLE _sqlx_migrations(version bigint PRIMARY KEY, success boolean NOT NULL, checksum bytea NOT NULL)",
      );
      const apply = ({ bytes, version, checksum }) =>
        fixture.sql(
          `BEGIN; ${bytes}\nINSERT INTO _sqlx_migrations VALUES(${version},true,decode('${checksum}','hex')); COMMIT;`,
        );
      for (const migration of found.baseline) {
        apply(migration);
        await writeFile(
          resolve(baselineDirectory, migration.name),
          migration.bytes,
        );
      }
      const user = randomUUID(),
        room = randomUUID(),
        source = randomUUID(),
        media = randomUUID();
      fixture.sql(
        `INSERT INTO users(id,username,password_hash,admin) VALUES('${user}','owned-upgrade-user','synthetic-password-hash',true); INSERT INTO user_profiles(user_id,display_name) VALUES('${user}','Retained profile'); INSERT INTO rooms(id,name,owner_id) VALUES('${room}','Retained room','${user}'); INSERT INTO room_members(room_id,user_id) VALUES('${room}','${user}'); INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','Retained source','local','synthetic-not-runtime-ciphertext'); INSERT INTO media_items(id,source_id,title,resource) VALUES('${media}','${source}','Retained media','owned-generated-fixture'); INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES('${"a".repeat(64)}','${user}','synthetic-csrf',clock_timestamp()+interval '1 day');`,
      );
      const preservedQuery = `SELECT json_build_object('user',(SELECT row_to_json(t) FROM (SELECT id,username,password_hash,admin FROM users WHERE id='${user}') t),'profile',(SELECT row_to_json(t) FROM user_profiles t WHERE user_id='${user}'),'room',(SELECT row_to_json(t) FROM rooms t WHERE id='${room}'),'membership',(SELECT row_to_json(t) FROM room_members t WHERE room_id='${room}' AND user_id='${user}'),'source',(SELECT row_to_json(t) FROM sources t WHERE id='${source}'),'media',(SELECT row_to_json(t) FROM media_items t WHERE id='${media}'),'session',(SELECT row_to_json(t) FROM sessions t WHERE user_id='${user}'))`;
      const preserved = fixture.sql(preservedQuery);
      const before = await preflight(fixture.url, {
        migrationsDirectory: resolve("migrations"),
      });
      assert.deepEqual(before.candidate_migrations.pending_versions, [87, 88]);
      const keyFile = resolve(root, "key");
      await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
      const baselineBackup = resolve(root, "baseline-backup");
      await backup({
        connection: fixture.url,
        output: baselineBackup,
        keyFile,
      });
      for (const migration of found.candidate.filter(
        ({ version }) => version > 86,
      ))
        apply(migration);
      assert.equal(
        fixture.sql(preservedQuery),
        preserved,
        "upgrade preserves populated account/session/room/library records",
      );
      assert.equal(
        fixture.sql("SELECT bool_and(principal_kind='account') FROM users"),
        "t",
      );
      assert.equal(
        fixture.sql(
          "SELECT NOT COALESCE(guests_enabled,false) FROM admin_settings WHERE singleton",
        ),
        "t",
      );
      assert.equal(
        fixture.sql("SELECT count(*) FROM room_guest_access WHERE enabled"),
        "0",
      );
      const after = await preflight(fixture.url, {
        migrationsDirectory: resolve("migrations"),
      });
      assert.deepEqual(
        after.migrations.filter(({ version }) => version <= 86),
        before.migrations,
      );
      await assert.rejects(
        matchMigrationBaseline(after.migrations, baselineDirectory),
        /installed migration absent/,
      );
      const candidateBackup = resolve(root, "candidate-backup");
      await backup({
        connection: fixture.url,
        output: candidateBackup,
        keyFile,
      });
      const maintenance = new URL(fixture.url);
      maintenance.pathname = "/postgres";
      for (const [
        label,
        backupDirectory,
        expectedVersion,
        migrationsDirectory,
      ] of [
        ["baseline", baselineBackup, 86, baselineDirectory],
        ["candidate", candidateBackup, 88, resolve("migrations")],
      ]) {
        const restored = await restore({
          connection: maintenance.href,
          backupDirectory,
          output: resolve(root, `restore-${label}`),
          keyFile,
        });
        const target = new URL(fixture.url);
        target.pathname = `/${restored.database}`;
        assert.equal(
          (await preflight(target.href, { migrationsDirectory })).migrations.at(
            -1,
          ).version,
          expectedVersion,
        );
        assert.equal(
          await pg("psql", ["-X", "-qAtw", "-c", preservedQuery], target.href),
          preserved,
        );
      }
      report.result = "passed";
      report.scope =
        "synthetic populated schema/checksum upgrade 0086→0088 and separate original/candidate encrypted restore; no executable or real deployment acceptance";
    } finally {
      await fixture.stop();
      await fixture.verifyStopped();
      if (process.env.RAINSYNC_ARTIFACT_DIR) {
        await mkdir(process.env.RAINSYNC_ARTIFACT_DIR, { recursive: true });
        await writeFile(
          resolve(
            process.env.RAINSYNC_ARTIFACT_DIR,
            `current-baseline-upgrade-${randomUUID()}.json`,
          ),
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
