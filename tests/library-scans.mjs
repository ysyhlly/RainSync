import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

export async function libraryScans({ admin, sql }) {
  let mode = "valid";
  const upstream = http.createServer((req, res) => {
    const start = Number(
      new URL(req.url, "http://localhost").searchParams.get("StartIndex"),
    );
    const count = mode === "valid" ? 65 : 350;
    const items = Array.from(
      { length: Math.min(200, count - start) },
      (_, n) => ({
        Id: `item-${start + n}`,
        Name: `scan-fixture-${start + n}`,
      }),
    );
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        Items: mode === "empty-page" && start ? [] : items,
        ...(mode === "missing" || (mode === "missing-later" && start)
          ? {}
          : {
              TotalRecordCount: mode === "string" ? "350" : count,
            }),
      }),
    );
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const ids = [];
  try {
    for (const kind of ["jellyfin", "emby"]) {
      const source = await admin.request("/sources", "POST", {
        name: "scan-regression",
        kind,
        config: {
          url: `http://127.0.0.1:${upstream.address().port}`,
          token: "fixture",
          user_id: "fixture",
        },
      });
      ids.push(source.id);
      const sentinel = randomUUID();
      sql(
        `INSERT INTO media_items(id,source_id,title,resource) VALUES('${sentinel}','${source.id}','sentinel','sentinel')`,
      );
      for (mode of ["missing", "string", "missing-later", "empty-page"]) {
        const failure = await admin.request(
          `/sources/${source.id}/test`,
          "POST",
          undefined,
          502,
        );
        assert.equal(failure.error.code, "SOURCE_SCAN_FAILED");
        assert.equal(
          sql(
            `SELECT count(*) FROM media_items WHERE source_id='${source.id}' AND available`,
          ),
          "1",
        );
      }
      mode = "valid";
      // Fail the second batch: the first 32 must survive and stale entries must
      // remain available until a complete scan reaches reconciliation.
      sql(`CREATE FUNCTION test_scan_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_id='${source.id}' AND NEW.resource='item-40' THEN RAISE EXCEPTION 'injected scan failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_scan_failure BEFORE INSERT ON media_items FOR EACH ROW EXECUTE FUNCTION test_scan_failure()`);
      try {
        await admin.request(
          `/sources/${source.id}/test`,
          "POST",
          undefined,
          500,
        );
        assert.equal(
          sql(
            `SELECT count(*) FROM media_items WHERE source_id='${source.id}' AND available`,
          ),
          "33",
        );
        assert.equal(
          sql(`SELECT available FROM media_items WHERE id='${sentinel}'`),
          "t",
        );
      } finally {
        sql(
          "DROP TRIGGER test_scan_failure ON media_items; DROP FUNCTION test_scan_failure()",
        );
      }
      await admin.request(`/sources/${source.id}/test`, "POST");
      assert.equal(
        sql(
          `SELECT count(*) FROM media_items WHERE source_id='${source.id}' AND available`,
        ),
        "65",
      );
      assert.equal(
        sql(`SELECT available FROM media_items WHERE id='${sentinel}'`),
        "f",
      );
    }
    const source = ids[0];
    sql(
      `INSERT INTO media_items(id,source_id,title,resource) SELECT gen_random_uuid(),'${source}','pagination-fixture-'||n,'page-'||n FROM generate_series(1,350) n`,
    );
    assert.equal((await admin.request("/media")).length, 100);
    assert.equal((await admin.request("/media?limit=9999")).length, 200);
    let after = "";
    const seen = [];
    for (;;) {
      const page = await admin.request(
        `/media?search=pagination-fixture&limit=100${after ? `&after=${after}` : ""}`,
      );
      seen.push(...page.map((v) => v.id));
      if (page.length < 100) break;
      after = page.at(-1).id;
    }
    assert.equal(seen.length, 350);
    assert.equal(new Set(seen).size, 350);
    assert.deepEqual(seen, [...seen].sort());
    assert.equal((await admin.request("/media?search=sentinel")).length, 0);
    console.log(
      "PASS: invalid upstream totals preserve library; batch rollback preserves prior progress; bounded searchable pagination has no omissions or duplicates",
    );
  } finally {
    for (const id of ids)
      sql(
        `DELETE FROM media_items WHERE source_id='${id}'; DELETE FROM sources WHERE id='${id}'`,
      );
    await new Promise((r) => upstream.close(r));
  }
}
