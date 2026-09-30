import assert from "node:assert/strict";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import {
  geometryCases,
  makeGeometry,
  measureCover,
  assertGeometry,
} from "./fixtures/preview-geometry.mjs";

// Explicit old binaries are required. Never downgrade a user database.
const oldTarget = process.env.RAINSYNC_BASELINE_BIN;
assert.ok(
  oldTarget,
  "Set RAINSYNC_BASELINE_BIN to the verified ae88f9f Server/Worker directory",
);
const exe = process.platform === "win32" ? ".exe" : "";
await isolatedMediaStack(
  "preview-forward-fix",
  async (f) => {
    const newTarget = f.target;
    f.target = oldTarget;
    const c = geometryCases[0];
    makeGeometry(f.root, [c]);
    const client = f.client();
    await client.login();
    const source = await client.request("/sources", "POST", {
      name: "forward fix",
      kind: "local",
      config: { root: f.root },
    });
    await client.request(`/sources/${source.id}/test`, "POST");
    const item = (await client.request("/media"))[0];
    await client.request(`/media/${item.id}/personal-title`, "PUT", {
      title: "preserved personal",
      expected_revision: "0",
    });
    await client.request(`/admin/media/${item.id}/shared-title`, "PUT", {
      title: "preserved shared",
      expected_revision: "0",
    });
    await f.startWorker();
    await client.request("/media/previews", "POST", { media_ids: [item.id] });
    const oldCover = await f.waitForPreview(item.id);
    const before = await measureCover(client, f.root, oldCover);
    assert.ok(
      before.width / before.height < 0.8,
      "baseline must reproduce the distortion",
    );
    assert.equal(f.sql("SELECT recipe_version FROM media_previews"), "1");
    const migrations = f.sql(
      "SELECT version,encode(checksum,'hex') FROM _sqlx_migrations ORDER BY version",
    );
    await f.stopWorker();
    await f.stopServer();
    f.target = newTarget;
    await f.startServer({}, resolve(newTarget, "rainsync-server" + exe));
    const after = await client.request(`/media/${item.id}`);
    assert.equal(after.personal_title, "preserved personal");
    assert.equal(after.shared_title, "preserved shared");
    assert.equal(after.personal_title_revision, "1");
    assert.equal(after.shared_title_revision, "1");
    assert.equal(
      after.cover.status,
      "missing",
      "old recipe must be invalidated without deleting names",
    );
    assert.equal(
      (await client.raw(oldCover.url.replace("/api/v1", ""))).status,
      409,
    );
    assert.equal(
      f.sql(
        "SELECT version,encode(checksum,'hex') FROM _sqlx_migrations ORDER BY version",
      ),
      migrations,
    );
    await f.startWorker();
    await client.request("/media/previews", "POST", { media_ids: [item.id] });
    const newCover = await f.waitForPreview(item.id);
    assert.notEqual(newCover.revision, oldCover.revision);
    const geometry = await measureCover(client, f.root, newCover);
    assertGeometry(c, geometry);
    assert.equal(f.sql("SELECT recipe_version FROM media_previews"), "2");
    assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
    console.log(
      "PASS: ae88f9f -> patched Server/Worker on the same isolated database; names, CAS revisions, migration checksums and session preserved; old cover rejected and regenerated",
      { before, after: geometry },
    );
  },
  { binary: resolve(oldTarget, "rainsync-server" + exe) },
);
