import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";
const source = randomUUID(),
  media = randomUUID();
await isolatedServer(
  "media-migration-upgrade",
  async (f) => {
    const admin = f.client();
    await admin.login();
    const item = await admin.request(`/media/${media}`);
    assert.equal(item.original_title, "legacy title");
    assert.equal(item.title, "legacy title");
    assert.equal(item.shared_title_revision, "0");
    assert.equal(item.cover.status, "missing");
    assert.equal(
      f.sql("SELECT count(*) FROM _sqlx_migrations WHERE version IN (23,24)"),
      "2",
    );
    await admin.request(`/media/${media}/personal-title`, "PUT", {
      title: "retained after upgrade",
      expected_revision: "0",
    });
    await f.startServer();
    assert.equal(
      (await admin.request(`/media/${media}`)).title,
      "retained after upgrade",
    );
    console.log(
      "PASS: actual migrations 1–22 + legacy media upgraded to 23/24, titles retained after restart",
    );
  },
  {
    beforeStart: async (f) => {
      f.sql(
        `CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)`,
      );
      for (const name of (await readdir("migrations"))
        .filter((n) => n.endsWith(".sql") && Number(n.split("_")[0]) <= 22)
        .sort()) {
        const bytes = await readFile("migrations/" + name),
          version = Number(name.split("_")[0]),
          description = name
            .replace(/^\d+_/, "")
            .replace(/\.sql$/, "")
            .replaceAll("_", " "),
          hash = createHash("sha384").update(bytes).digest("hex");
        f.sql(
          "BEGIN;" +
            bytes.toString() +
            `;INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${version},'${description}',true,decode('${hash}','hex'),0);COMMIT;`,
        );
      }
      f.sql(
        `INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','legacy','local','fixture');INSERT INTO media_items(id,source_id,title,resource) VALUES('${media}','${source}','legacy title','legacy.mp4')`,
      );
    },
  },
);
