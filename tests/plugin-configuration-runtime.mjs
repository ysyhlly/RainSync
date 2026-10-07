import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";

// Uses only disposable PostgreSQL, synthetic media metadata and fixture accounts.
await isolatedServer("plugin-configuration-lifecycle", async (f) => {
  const admin = f.client();
  await admin.login();
  await admin.request("/users", "POST", {
    username: "plugin-viewer",
    password: f.password,
  });
  const viewer = f.client();
  await viewer.login("plugin-viewer", f.password);
  const source = randomUUID(),
    media = randomUUID();
  f.sql(
    `INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','synthetic plugin source','local','fixture-only'); INSERT INTO media_items(id,source_id,title,resource,duration_ms,source_version) VALUES('${media}','${source}','Synthetic plugin title','fixture-only.mp4',60000,'fixture-v1');`,
  );
  const duration = "metadata.duration-badge",
    label = "metadata.title-label";
  const path = `/admin/plugins/${duration}`;
  const configure = (expected, patch = {}) => ({
    version: "1.0.0",
    enabled: true,
    config: { format: "clock" },
    granted_permissions: ["metadata:read"],
    expected_revision: expected,
    ...patch,
  });
  const metadata = () => admin.request(`/media/${media}/plugin-metadata`);
  await admin.request(path, "DELETE", { expected_revision: "0" }, 404);
  await admin.request(
    "/admin/plugins/not-in-catalog",
    "DELETE",
    { expected_revision: "0" },
    404,
  );
  let saved = await admin.request(path, "PUT", configure("0"));
  assert.equal(saved.revision, "1");
  saved = await admin.request(
    path,
    "PUT",
    configure("1", { config: { format: "minutes" } }),
  );
  assert.equal(saved.can_rollback, true);
  await admin.request(
    `/admin/plugins/${label}`,
    "PUT",
    configure("0", { config: { label: "Synthetic private operator text" } }),
  );
  assert.equal((await metadata()).extensions.length, 2);
  const auditBefore = (await admin.request("/admin/plugins/audit")).items
    .length;
  await viewer.request(path, "DELETE", { expected_revision: "2" }, 403);
  await f.client().request(path, "DELETE", { expected_revision: "2" }, 401);
  await admin.request(path, "DELETE", { expected_revision: "2" }, 403, {
    "x-csrf-token": "wrong",
  });
  for (const revision of ["-1", " 2", "two", "9223372036854775807"]) {
    await admin.request(path, "DELETE", { expected_revision: revision }, 400);
  }
  await admin.request(path, "DELETE", { expected_revision: "1" }, 409);
  assert.equal(
    (await admin.request("/admin/plugins/audit")).items.length,
    auditBefore,
  );
  const result = await admin.raw(path, {
    method: "DELETE",
    body: { expected_revision: "2" },
  });
  assert.equal(result.status, 200);
  assert.ok(result.headers.get("cache-control")?.split(/\s*,\s*/).includes("no-store"));
  assert.deepEqual(await result.json(), {
    id: duration,
    removed: true,
    revision: "3",
  });
  let catalog = await admin.request("/admin/plugins");
  assert.equal(
    catalog.catalog.length,
    2,
    "compiled-in catalog remains available",
  );
  assert.deepEqual(
    catalog.installed.map((p) => p.id),
    [label],
  );
  assert.equal(catalog.configuration_revisions[duration], "3");
  assert.equal(
    f.sql(
      `SELECT removed AND NOT enabled AND config='{}'::jsonb AND granted_permissions='[]'::jsonb AND previous_state IS NULL FROM rainsync_plugins WHERE id='${duration}'`,
    ),
    "t",
  );
  assert.equal(
    (await metadata()).extensions.some((e) => e.plugin_id === duration),
    false,
  );
  assert.equal(
    (await metadata()).extensions.some((e) => e.plugin_id === label),
    true,
  );
  assert.equal(
    f.sql(
      `SELECT title||'/'||duration_ms FROM media_items WHERE id='${media}'`,
    ),
    "Synthetic plugin title/60000",
  );
  await admin.request(
    `${path}/rollback`,
    "POST",
    { expected_revision: "3" },
    409,
  );
  await admin.request(path, "PUT", configure("2"), 409);
  await admin.request(path, "PUT", configure("0"), 409);
  await admin.request(
    path,
    "PUT",
    configure("3", { granted_permissions: [] }),
    400,
  );
  const afterDelete = (await admin.request("/admin/plugins/audit")).items;
  assert.equal(afterDelete.length, auditBefore + 1);
  assert.equal(afterDelete.filter((e) => e.action === "remove").length, 1);
  await admin.request(path, "DELETE", { expected_revision: "2" }, 409);
  assert.deepEqual(
    await admin.request(path, "DELETE", { expected_revision: "3" }),
    { id: duration, removed: true, revision: "3" },
  );
  assert.equal(
    (await admin.request("/admin/plugins/audit")).items.length,
    afterDelete.length,
  );
  saved = await admin.request(path, "PUT", configure("3", { enabled: false }));
  assert.equal(saved.revision, "4");
  assert.equal(
    saved.can_rollback,
    false,
    "reinstall cannot resurrect deleted previous configuration",
  );
  assert.equal(saved.enabled, false);
  assert.equal((await metadata()).extensions.length, 1);
  // Both contenders start from the same revision. Exactly one may mutate it.
  const races = await Promise.all([
    admin.raw(path, { method: "DELETE", body: { expected_revision: "4" } }),
    admin.raw(path, { method: "PUT", body: configure("4") }),
  ]);
  assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
  catalog = await admin.request("/admin/plugins");
  assert.equal(catalog.configuration_revisions[duration], "5");
  const durationAudits = (
    await admin.request("/admin/plugins/audit")
  ).items.filter((a) => a.plugin_id === duration);
  assert.deepEqual(
    durationAudits.map((a) => Number(a.revision)).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
  // Deletion erases free-text settings as well as the previous snapshot.
  await admin.request(
    `/admin/plugins/${label}`,
    "PUT",
    configure("1", { config: { label: "Synthetic replacement" } }),
  );
  await admin.request(`/admin/plugins/${label}`, "DELETE", {
    expected_revision: "2",
  });
  assert.equal(
    f.sql(
      `SELECT config='{}'::jsonb AND previous_state IS NULL AND granted_permissions='[]'::jsonb FROM rainsync_plugins WHERE id='${label}'`,
    ),
    "t",
  );
  assert.equal(
    JSON.stringify(await admin.request("/admin/plugins/audit")).includes(
      "Synthetic private operator text",
    ),
    false,
  );
  assert.throws(
    () => f.sql(`UPDATE rainsync_plugins SET enabled=true WHERE id='${label}'`),
    /rainsync_plugin_state_valid/,
  );
  assert.throws(
    () =>
      f.sql(
        `UPDATE rainsync_plugins SET config='{"label":"restore"}' WHERE id='${label}'`,
      ),
    /rainsync_plugin_state_valid/,
  );
  assert.throws(
    () =>
      f.sql(
        `UPDATE rainsync_plugins SET previous_state='{}' WHERE id='${label}'`,
      ),
    /rainsync_plugin_state_valid/,
  );
  // Recheck an expiring login after waiting for the same mutation lock.
  await admin.request(
    `/admin/plugins/${label}`,
    "PUT",
    configure("3", { config: { label: "Expiry fixture" } }),
  );
  const expiring = f.client();
  await expiring.login();
  const lock = f.sqlProcess(
    `BEGIN; SELECT pg_advisory_xact_lock(hashtext('rainsync:plugin:${label}')); SELECT pg_sleep(0.7); COMMIT;`,
  );
  await f.waitForSql(
    "SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%rainsync:plugin:metadata.title-label%'",
    "1",
  );
  f.sql(
    `UPDATE sessions SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE csrf='${expiring.csrf}'`,
  );
  await expiring.request(
    `/admin/plugins/${label}`,
    "DELETE",
    { expected_revision: "4" },
    401,
  );
  await lock.done;
  assert.equal(
    (await admin.request("/admin/plugins")).configuration_revisions[label],
    "4",
  );
  console.log(
    "Plugin config removal, audit/reinstall revisions, authorization, runtime output, races and tombstone constraints passed",
  );
});
