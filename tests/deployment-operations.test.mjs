import assert from "node:assert/strict";
import { test } from "node:test";
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
  writeFile,
  rm,
  symlink,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { origin, configuration, endpointChecks } from "../deploy/diagnose.mjs";
import {
  decryptSource,
  validateMaterials,
  verifyMaterials,
  createRecoverySet,
  restoreRecoverySet,
} from "../deploy/recovery-set.mjs";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
import { pg } from "../deploy/postgres-recovery.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const encrypted = (value, key) => {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
};
const materials = () => ({
  schema_version: 1,
  configuration: {
    PUBLIC_ORIGIN: "http://127.0.0.1:8088",
    MEDIA_ROOT: "/isolated-media",
  },
  source_key: randomBytes(32).toString("base64"),
  source_key_version: "synthetic-preview-1",
  original_media_policy:
    "Owned generated synthetic media; regenerate. No real media was backed up.",
  agents: [],
});

test("origin/root checks reject unsafe configuration without leaking values", async () => {
  for (const value of [
    "https://user:SECRET@host",
    "https://host/path",
    "https://host?SECRET=1",
    "https://host#SECRET",
    "ftp://host",
    "http://[::]:8080",
    "http://host:0",
  ]) {
    assert.throws(
      () => origin("PUBLIC_ORIGIN", value),
      (error) => !error.message.includes("SECRET"),
    );
  }
  assert.equal(
    origin("PUBLIC_ORIGIN", "https://example.org:443/"),
    "https://example.org",
  );
  const root = await mkdtemp(resolve(tmpdir(), "rainsync-config-"));
  try {
    const media = resolve(root, "media"),
      cache = resolve(root, "cache");
    await mkdir(media);
    await mkdir(cache);
    const env = {
      SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      MEDIA_ROOT: media,
      CACHE_ROOT: cache,
    };
    assert.equal(
      (await configuration(env)).mediaOrigin,
      "http://localhost:8088",
    );
    assert.equal(
      (
        await configuration({
          ...env,
          PUBLIC_ORIGIN: "https://control.example.org",
          AGENT_DATA_ORIGIN: "http://private-data.example.org",
        })
      ).agentDataOrigin,
      "http://private-data.example.org",
    );
    await assert.rejects(
      configuration({ ...env, CACHE_ROOT: media }),
      /must not resolve/,
    );
    if (process.platform !== "win32") {
      await symlink(media, resolve(root, "alias"));
      await assert.rejects(
        configuration({ ...env, CACHE_ROOT: resolve(root, "alias") }),
        /must not resolve/,
      );
    }
    await assert.rejects(
      configuration({ ...env, SOURCE_ENCRYPTION_KEY: "bad" }),
      /32 bytes/,
    );
    await assert.rejects(
      configuration({
        ...env,
        PUBLIC_ORIGIN: "https://host",
        MEDIA_ORIGIN: "http://host",
      }),
      /split-origin|HTTPS/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("endpoint gate rejects SPA, redirects, stale checks and mismatched service identity", async () => {
  const endpoints = {
    publicOrigin: "http://server.test",
    mediaOrigin: "http://worker.test",
    agentDataOrigin: "http://agent.test",
  };
  const good = async (url) =>
    Response.json(
      url.endsWith("ready")
        ? { ready: true, checks: { database: "ready" } }
        : {
            live: true,
            service: url.startsWith(endpoints.publicOrigin)
              ? "rainsync-server"
              : "rainsync-worker",
          },
    );
  assert.equal(
    (await endpointChecks(endpoints, { fetchImpl: good })).result,
    "passed",
  );
  for (const fake of [
    () => new Response("SPA", { status: 200 }),
    () => new Response("", { status: 302 }),
    () => Response.json({ ready: true, checks: { database: "stale" } }),
    () => Response.json({ service: "other", live: true }),
    () =>
      new Response("x".repeat(20000), {
        headers: { "content-type": "application/json" },
      }),
  ]) {
    assert.equal(
      (await endpointChecks(endpoints, { fetchImpl: fake })).result,
      "failed",
    );
  }
});
test("source-key failures are explicit and never become an empty library", () => {
  const key = randomBytes(32).toString("base64"),
    input = encrypted({ kind: "http", fixture: true }, key);
  assert.deepEqual(decryptSource(input, key), { kind: "http", fixture: true });
  assert.throws(
    () => decryptSource(input, randomBytes(32).toString("base64")),
    /source_key_mismatch_or_corrupt_ciphertext/,
  );
  assert.throws(() => decryptSource("garbage", key), /not an empty library/);
  assert.throws(
    () =>
      validateMaterials({
        ...materials(),
        agents: [
          {
            id: randomUUID(),
            credential: { token: "synthetic" },
            drained_receipts: ["not-a-receipt"],
          },
        ],
      }),
    /receipt/,
  );
});
test(
  "separate encrypted recovery set authenticates sources/Agent credentials into a new database and empty cache",
  {
    skip: !process.env.RAINSYNC_NATIVE_POSTGRES_BIN
      ? "requires owned native PostgreSQL fixture"
      : false,
  },
  async () => {
    assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
    const root = resolve(
      process.env.RAINSYNC_ARTIFACT_DIR,
      "recovery-material-chain",
      randomUUID(),
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fixture = isolatedPostgres({ root, name: "recovery-material-chain" });
    const databaseKeyFile = resolve(root, "db-key"),
      materialKeyFile = resolve(root, "material-key");
    const report = {
      schema_version: 1,
      result: "failed",
      scope:
        "synthetic encrypted source and Agent credential fixture on real isolated PostgreSQL; no real application/Agent/media or historical upgrade acceptance",
      production_recovery_accepted: false,
    };
    try {
      await fixture.start();
      await writeFile(databaseKeyFile, randomBytes(32), { mode: 0o600 });
      await writeFile(materialKeyFile, randomBytes(32), { mode: 0o600 });
      const saved = materials(),
        id = randomUUID(),
        token = randomBytes(32).toString("hex");
      saved.agents.push({ id, credential: { token }, drained_receipts: [] });
      const value = encrypted(
        { kind: "local", root: "synthetic-owned-media" },
        saved.source_key,
      );
      fixture.sql(
        `CREATE TABLE sources(id uuid PRIMARY KEY, config_encrypted text); CREATE TABLE agents(id uuid PRIMARY KEY, token_hash text, revoked boolean); INSERT INTO sources VALUES('${randomUUID()}','${value}'); INSERT INTO agents VALUES('${id}','${sha(token)}',false);`,
      );
      const before = fixture.sql("SELECT count(*) FROM pg_database");
      assert.equal(
        (await verifyMaterials(fixture.url, saved)).source_records_decrypted,
        1,
      );
      await assert.rejects(
        verifyMaterials(fixture.url, {
          ...saved,
          source_key: randomBytes(32).toString("base64"),
        }),
        /source_key_mismatch/,
      );
      await assert.rejects(
        verifyMaterials(fixture.url, { ...saved, agents: [] }),
        /all and only/,
      );
      fixture.sql(`UPDATE agents SET revoked=true WHERE id='${id}'`);
      await assert.rejects(
        verifyMaterials(fixture.url, saved),
        /active paired/,
      );
      fixture.sql(`UPDATE agents SET revoked=false WHERE id='${id}'`); // owned synthetic fixture only
      const databaseOutput = resolve(root, "db-backup"),
        materialOutput = resolve(root, "material-backup");
      await assert.rejects(
        createRecoverySet({
          connection: fixture.url,
          materials: saved,
          databaseOutput,
          materialOutput,
          databaseKeyFile,
          materialKeyFile: databaseKeyFile,
        }),
        /separately/,
      );
      const manifest = await createRecoverySet({
        connection: fixture.url,
        materials: saved,
        databaseOutput,
        materialOutput,
        databaseKeyFile,
        materialKeyFile,
      });
      const maintenance = new URL(fixture.url);
      maintenance.pathname = "/postgres";
      const output = resolve(root, "restored");
      const restored = await restoreRecoverySet({
        connection: maintenance.href,
        databaseDirectory: databaseOutput,
        materialDirectory: materialOutput,
        output,
        databaseKeyFile,
        materialKeyFile,
      });
      assert.equal(restored.result, "passed");
      assert.notEqual(restored.database, fixture.database);
      assert.equal(
        Number(fixture.sql("SELECT count(*) FROM pg_database")),
        Number(before) + 1,
      );
      assert.deepEqual(await readdir(resolve(output, "cache")), []);
      const key = JSON.parse(
        await readFile(resolve(output, "source-key.json"), "utf8"),
      );
      assert.equal(key.key, saved.source_key);
      assert.deepEqual(
        JSON.parse(
          await readFile(resolve(output, "agents", id + ".json"), "utf8"),
        ),
        { token },
      );
      assert.equal(
        fixture.sql("SELECT config_encrypted FROM sources"),
        value,
        "source DB unchanged",
      );
      await assert.rejects(stat(resolve(output, "materials.tmp")), {
        code: "ENOENT",
      });
      assert.ok(!JSON.stringify(manifest).includes(token));
      assert.ok(!JSON.stringify(manifest).includes(saved.source_key));
      await assert.rejects(
        restoreRecoverySet({
          connection: maintenance.href,
          databaseDirectory: databaseOutput,
          materialDirectory: materialOutput,
          output,
          databaseKeyFile,
          materialKeyFile,
        }),
        { code: "EEXIST" },
      );
      const target = new URL(fixture.url);
      target.pathname = "/" + restored.database;
      assert.equal(
        await pg(
          "psql",
          ["-X", "-qAtw", "-c", "SELECT count(*) FROM sources"],
          target.href,
        ),
        "1",
      );
      report.result = "passed";
      report.checks = [
        "separate keys",
        "AES-GCM archives",
        "matching source key/version",
        "wrong-key diagnosis",
        "missing/revoked Agent rejection",
        "fresh database",
        "empty cache",
        "no source overwrite",
        "private credentials restored",
        "temporary plaintext removed",
      ];
    } finally {
      await fixture.stop();
      report.cleanup = await fixture.verifyStopped();
      // Never retain synthetic credentials or restored auth files in reports.
      for (const name of ["db-key", "material-key", "restored"])
        await rm(resolve(root, name), { recursive: true, force: true });
      await writeFile(
        resolve(root, "report.json"),
        JSON.stringify(report, null, 2),
        { mode: 0o600 },
      );
    }
  },
);

test("release locks refuse tags/missing architectures and measure actual daemon identity", async () => {
  const {
    validateLock,
    buildArguments,
    verifyInputs,
    measureRuntime,
    validateRuntimeEvidence,
  } = await import("../deploy/release-lock.mjs");
  const image = (role, arch) =>
    `official/${role}-${arch}@sha256:${sha(role + arch)}`;
  const lock = {
    schema_version: 1,
    source_manifest_sha256: sha("synthetic-source"),
    production_manifest_sha256: sha("synthetic-production"),
    debian_snapshot: "20261001T000000Z",
    ffmpeg_version: "7:5.1.8-0+deb12u1",
    ca_certificates_version: "20230311+deb12u1",
    platforms: Object.fromEntries(
      ["amd64", "arm64"].map((arch) => [
        arch,
        Object.fromEntries(
          ["rust", "debian", "node", "caddy", "postgres"].map((role) => [
            role,
            image(role, arch),
          ]),
        ),
      ]),
    ),
  };
  // These values are synthetic validator fixtures, not published release pins.
  assert.equal(validateLock(lock), lock);
  assert.ok(buildArguments(lock, "arm64").includes("--platform=linux/arm64"));
  assert.throws(
    () => validateLock({ ...lock, platforms: { amd64: lock.platforms.amd64 } }),
    /arm64/,
  );
  assert.throws(
    () =>
      validateLock({
        ...lock,
        platforms: {
          ...lock.platforms,
          amd64: { ...lock.platforms.amd64, rust: "rust:latest" },
        },
      }),
    /digest/,
  );
  const command = async (args) =>
    JSON.stringify({
      Id: "sha256:" + sha(args.at(-1)),
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [args.at(-1)],
    });
  assert.equal(
    Object.keys(await verifyInputs(lock, "amd64", command)).length,
    5,
  );
  await assert.rejects(verifyInputs(lock, "arm64", command), /architecture/);
  const reference = "sha256:" + sha("synthetic-runtime");
  const runtime = await measureRuntime(reference, "amd64", async (args) =>
    args[0] === "image"
      ? JSON.stringify({
          Id: reference,
          Os: "linux",
          Architecture: "amd64",
          RepoDigests: [],
        })
      : `${lock.ffmpeg_version}\nffmpeg version synthetic\nffprobe version synthetic\n${["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"].map((name) => `${sha(name)}  /usr/local/bin/${name}`).join("\n")}`,
  );
  assert.equal(runtime.ffmpeg_package_version, lock.ffmpeg_version);
  assert.equal(Object.keys(runtime.binary_sha256).length, 3);
  const observed = {
    ...runtime,
    image_source_manifest_sha256: lock.source_manifest_sha256,
    image_production_manifest_sha256: lock.production_manifest_sha256,
  };
  const binding = {
    ...observed,
    schema_version: 1,
    binding_kind: "frozen-source-build",
    lock_sha256: sha(JSON.stringify(lock)),
    source_manifest_sha256: lock.source_manifest_sha256,
    production_manifest_sha256: lock.production_manifest_sha256,
  };
  validateRuntimeEvidence(lock, observed, binding);
  assert.throws(
    () =>
      validateRuntimeEvidence(
        lock,
        { ...observed, image_source_manifest_sha256: sha("other-source") },
        binding,
      ),
    /source label/,
  );
  assert.throws(
    () =>
      validateRuntimeEvidence(
        lock,
        { ...observed, image_id: "sha256:" + sha("other-image") },
        binding,
      ),
    /candidate image/,
  );
  assert.throws(
    () =>
      validateRuntimeEvidence(
        lock,
        {
          ...observed,
          binary_sha256: {
            ...observed.binary_sha256,
            "rainsync-server": sha("different-binary"),
          },
        },
        binding,
      ),
    /binaries/,
  );
  assert.throws(
    () =>
      validateRuntimeEvidence(lock, observed, {
        ...binding,
        binding_kind: "operator-assertion",
      }),
    /original frozen-source/,
  );
});


test("transition checks minimum authorization contract before any service or migration", async () => {
  const { transitionAuthorizationGate } = await import("../deploy/preview-transition.mjs");
  const build = (path, bound) => ({ binding: { source: [{ path: bound ? "migrations/0041_media_login_binding.sql" : "migrations/0040_playback_metrics_v2.sql" }] }, binaries: { "rainsync-server": { path } } });
  const checked = [];
  const probe = async path => { checked.push(path); if (path === "old") throw new Error("Unsafe Server cutover"); return { result: "passed", path }; };
  assert.equal((await transitionAuthorizationGate(build("old",false),build("older",false),probe)).required,false);
  assert.deepEqual(checked,[]);
  await assert.rejects(transitionAuthorizationGate(build("old",false),build("new",true),probe),/Unsafe Server cutover/);
  assert.deepEqual(checked,["new","old"]);
  checked.length=0;
  await assert.rejects(transitionAuthorizationGate(build("new",true),build("old",false),probe),/Unsafe Server cutover/);
  assert.deepEqual(checked,["old"]);
  checked.length=0;
  const accepted = await transitionAuthorizationGate(build("compatible-rollback",true),build("compatible-candidate",true),probe);
  assert.equal(accepted.required,true);
  assert.deepEqual(checked,["compatible-candidate","compatible-rollback"]);
});


test("release entrypoint rejects old login or redirect readers before application startup", { skip: !process.env.RAINSYNC_OLD_AUTH_SERVER || !process.env.RAINSYNC_BOUND_AUTH_SERVER || !process.env.RAINSYNC_SOURCE_CONTRACT_SERVER ? "set owned old-login, old-source and current source-contract Server paths" : false }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const script = resolve("deploy/backend-entrypoint.sh");
  // Invalid app settings would fail any real initialization. Neither probe may
  // use them, and the old target is never exec'd with this environment.
  const env = { ...process.env, DATABASE_URL: "deliberately-not-a-database-url", ADMIN_PASSWORD: "owned-test-only", SOURCE_ENCRYPTION_KEY: "invalid-owned-test-key" };
  await assert.rejects(exec(script,[process.env.RAINSYNC_OLD_AUTH_SERVER,"--media-authorization-contract"],{env,timeout:8000}),error => error.code===78 && /Unsafe Server cutover/.test(error.stderr));
  await assert.rejects(exec(script,[process.env.RAINSYNC_BOUND_AUTH_SERVER,"--media-authorization-contract"],{env,timeout:15000}),error => error.code===78 && /Unsafe Server cutover/.test(error.stderr));
  const result=await exec(script,[process.env.RAINSYNC_SOURCE_CONTRACT_SERVER,"--media-authorization-contract"],{env,timeout:20000});
  assert.equal(JSON.parse(result.stdout).contract,"media-login-binding-v1");
});
