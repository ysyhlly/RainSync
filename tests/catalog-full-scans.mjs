// External draft: owned adaptation of the existing libraryScans scenarios.
// The broad integration and unavailable pg-module private matrix are not run.
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { catalogFixture } from "./fixtures/catalog-evidence.mjs";
import { finishOwnedFixture } from "./fixtures/server.mjs";
import { verifyClosedPort } from "./fixtures/postgres.mjs";

const baseline = process.argv.includes("--baseline");
await catalogFixture({
  name: "catalog-full-scans", coordinator: "tests/catalog-full-scans.mjs",
  baseline, baselineResult: "passed", timeout: 120000,
  limitations: [
    "Existing libraryScans Jellyfin/Emby partial-list, batch-failure, reconciliation and pagination scenarios only",
    "No shared S3 restart/count-alias dispatch or new login-expiry/concurrent-scan scenario",
    "The broad integration.mjs and unavailable pg-module private-library-native matrix are not executed",
    "Owned Server/PostgreSQL and synthetic loopback upstream only; no real account, Worker, playback or NAS process",
  ],
}, async (f, report, signal) => {
  const admin = f.client(), sql = f.sql;
  await admin.login();
  const record = (name) => report.checks.push({ name, result: "passed" });
  let mode = "valid", requests = 0;
  let port, listening = false, closeObserved = false, endpointFailed = false;
  let primaryError, primaryFailed = false;
  const ids = [];
  const upstream = http.createServer((req, res) => {
    requests++;
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
  upstream.once("listening", () => { listening = true; port = upstream.address().port; });
  upstream.once("close", () => { closeObserved = true; });
  upstream.on("error", () => { endpointFailed = true; });
  try {
    signal.throwIfAborted();
    await new Promise((done, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", done);
    });
    signal.throwIfAborted();
    for (const kind of ["jellyfin", "emby"]) {
      signal.throwIfAborted();
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
        signal.throwIfAborted();
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
        record(`${kind}: ${mode} fails without publishing a partial catalog`);
      }
      mode = "valid";
      // Fail the second batch: the first 32 must survive and stale entries must
      // remain available until a complete scan reaches reconciliation.
      sql(`CREATE FUNCTION test_scan_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_id='${source.id}' AND NEW.resource='item-40' THEN RAISE EXCEPTION 'injected scan failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_scan_failure BEFORE INSERT ON media_items FOR EACH ROW EXECUTE FUNCTION test_scan_failure()`);
      let batchError, batchFailed = false, batchCleanupError, batchCleanupFailed = false;
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
        record(`${kind}: second batch rollback preserves the first 32 and old sentinel`);
      } catch (error) { batchError = error; batchFailed = true; }
      finally {
        try {
          sql(
            "DROP TRIGGER test_scan_failure ON media_items; DROP FUNCTION test_scan_failure()",
          );
        } catch (error) { batchCleanupError = error; batchCleanupFailed = true; }
      }
      if (batchCleanupFailed) throw new AggregateError([...(batchFailed ? [batchError] : []), batchCleanupError], "owned_batch_fixture_cleanup_failed");
      if (batchFailed) throw batchError;
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
      record(`${kind}: complete 65-item reconciliation retires only the old sentinel`);
    }
    const source = ids[0];
    sql(
      `INSERT INTO media_items(id,source_id,title,resource) SELECT gen_random_uuid(),'${source}','pagination-fixture-'||n,'page-'||n FROM generate_series(1,350) n`,
    );
    assert.equal((await admin.request("/media")).length, 100);
    assert.equal((await admin.request("/media?limit=9999")).length, 200);
    record("flat listing keeps its default and maximum limits");
    let after = "";
    const seen = [];
    for (;;) {
      signal.throwIfAborted();
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
    record("350 searchable items paginate in exact unique ID order");
    assert.equal((await admin.request("/media?search=sentinel")).length, 0);
    record("retired sentinels are absent from flat search");
    console.log(
      "PASS: invalid upstream totals preserve library; batch rollback preserves prior progress; bounded searchable pagination has no omissions or duplicates",
    );
    if (endpointFailed) throw new Error("owned_catalog_endpoint_error");
  } catch (error) { primaryError = error; primaryFailed = true; }
  finally {
    await finishOwnedFixture({
      primaryError, primaryFailed,
      cleanup: async () => {
        const errors = [];
        // Keep SQL fixture cleanup before endpoint closure, while attempting
        // closure even if an earlier fixture-owned SQL cleanup fails.
        for (const id of ids) {
          try {
            sql(
              `DELETE FROM media_items WHERE source_id='${id}'; DELETE FROM sources WHERE id='${id}'`,
            );
          } catch (error) { errors.push(error); }
        }
        try {
          upstream.closeAllConnections();
          if (listening || upstream.listening) {
            let timer;
            try {
              await Promise.race([
                new Promise((done, reject) => upstream.close((error) => error ? reject(error) : done())),
                new Promise((_, reject) => { timer = setTimeout(() => reject(Error("owned_catalog_endpoint_close_deadline")), 5000); }),
              ]);
            } finally { clearTimeout(timer); }
          }
        } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "owned_catalog_endpoint_cleanup_failed");
      },
      verifyStopped: async () => {
        if (!listening) return { started: false, close_observed: closeObserved, port: null, port_closed: null };
        assert.equal(closeObserved, true);
        const closed = await verifyClosedPort(port);
        assert.equal(closed, true);
        return { started: true, close_observed: true, port, port_closed: closed, endpoint_error: endpointFailed };
      },
      save: async (receipt) => {
        report.synthetic_endpoint = { ...receipt, requests, endpoint_error: endpointFailed };
      },
    });
  }
});
