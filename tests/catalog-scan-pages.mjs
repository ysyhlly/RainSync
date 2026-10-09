// Owned adaptation of the existing private-library-native two-page S3
// failure/resume case. The old pg-module matrix is not imported or executed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { catalogFixture } from "./fixtures/catalog-evidence.mjs";
import { finishOwnedFixture } from "./fixtures/server.mjs";
import { verifyClosedPort } from "./fixtures/postgres.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const baseline = process.argv.includes("--baseline");

await catalogFixture({
  name: "catalog-scan-pages",
  coordinator: "tests/catalog-scan-pages.mjs",
  baseline, baselineResult: "passed", timeout: 120000,
  env: {
    PRIVATE_LIBRARIES_ENABLED: "true",
    RAINSYNC_S3_SYNTH_ACCESS: "SYNTHETICACCESS",
    RAINSYNC_S3_SYNTH_SECRET: "synthetic-owned-local-secret",
  },
  limitations: [
    "Existing synthetic two-page failure/resume scenario only; no new login-expiry or concurrent-scan experiment",
    "Signature-header presence is observed; this endpoint does not independently recompute SigV4",
    "The unavailable pg-module private-library-native matrix is not executed",
    "Owned Server/PostgreSQL and loopback S3 list/HEAD only; no real bucket, Worker, playback or NAS process",
  ],
}, async (f, report, signal) => {
  const record = (name) => report.checks.push({ name, result: "passed" });
  const objects = Array.from({ length: 101 }, (_, i) => `allowed/media-${String(i).padStart(3, "0")}.mp4`);
  let failNextPage = true, signedRequests = 0, listRequests = 0, headRequests = 0;
  let port, listening = false, closeObserved = false, primaryError, primaryFailed = false;
  const upstream = createServer((req, res) => {
    if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
      res.writeHead(403); res.end(); return;
    }
    signedRequests++;
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.searchParams.get("list-type") === "2") {
      listRequests++;
      const start = Number(url.searchParams.get("continuation-token") || 0);
      if (start === 100 && failNextPage) {
        failNextPage = false;
        res.writeHead(503); res.end("synthetic-page-failure"); return;
      }
      const slice = objects.slice(start, start + 100), next = start + slice.length, more = next < objects.length;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(`<ListBucketResult><Name>synthetic-bucket</Name><Prefix>allowed%2F</Prefix><IsTruncated>${more}</IsTruncated><KeyCount>${slice.length}</KeyCount><EncodingType>url</EncodingType>${slice.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key><ETag>\"synthetic-etag\"</ETag><Size>4</Size><LastModified>2026-10-05T00:00:00Z</LastModified></Contents>`).join("")}${more ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`);
      return;
    }
    const key = decodeURIComponent(url.pathname.replace("/synthetic-bucket/", ""));
    if (!objects.includes(key)) { res.writeHead(404); res.end(); return; }
    if (req.method === "HEAD") headRequests++;
    res.writeHead(200, { ETag: '\"synthetic-etag\"', "Content-Length": "4", "Last-Modified": "Mon, 05 Oct 2026 00:00:00 GMT", "x-amz-version-id": "synthetic-version-v1" });
    res.end(req.method === "HEAD" ? undefined : "test");
  });
  try {
    await new Promise((done, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", done);
    });
    listening = true;
    port = upstream.address().port;
    signal.throwIfAborted();
    const endpoint = `http://127.0.0.1:${port}`;
    const config = {
      url: endpoint,
      access_policy: { schema_version: 1, origins: [{ origin: endpoint, cidrs: ["127.0.0.1/32"] }] },
      s3: {
        region: "us-east-1", bucket: "synthetic-bucket", prefix: "allowed/", addressing_style: "path",
        credential_ref: { access_key_id_env: "RAINSYNC_S3_SYNTH_ACCESS", secret_access_key_env: "RAINSYNC_S3_SYNTH_SECRET" },
      },
    };
    const admin = f.client(); await admin.login();
    await admin.request("/users", "POST", { username: "scan-page-owner", password: f.password });
    const member = f.client(); await member.login("scan-page-owner");
    const memberLibrary = await member.request("/libraries", "POST", { name: "Owned non-admin scan library" });
    await member.request(`/libraries/${memberLibrary.id}/sources`, "POST", { name: "attempted-binding", kind: "s3", config }, 403);
    record("non-administrator S3 credential-reference binding remains denied");

    const library = await admin.request("/libraries", "POST", { name: "Owned synthetic S3 page library" });
    const source = (await admin.request(`/libraries/${library.id}/sources`, "POST", { name: "Synthetic S3", kind: "s3", config })).id;
    const path = `/libraries/${library.id}/sources/${source}/scan`;
    const first = await admin.request(path, "POST", { restart: true });
    assert.equal(first.item_count, 100); assert.equal(first.page_count, 1); assert.equal(first.status, "running"); assert.equal(first.has_more, true);
    const firstIds = JSON.parse(f.sql(`SELECT json_agg(id ORDER BY resource) FROM media_items WHERE source_id=${quote(source)} AND available`));
    assert.equal(firstIds.length, 100);
    assert.equal(f.sql(`SELECT count(*) FROM s3_index_scan_seen WHERE source_id=${quote(source)} AND scan_id=${quote(first.scan_id)}`), "100");
    record("first S3 page atomically checkpoints one hundred visible objects");

    const stale = randomUUID();
    f.sql(`INSERT INTO media_items(id,source_id,title,resource) VALUES(${quote(stale)},${quote(source)},'preexisting-unseen','allowed/deleted.mp4')`);
    const failure = await admin.request(path, "POST", { restart: false }, 502);
    assert.equal(failure.error.code, "S3_SCAN_FAILED");
    const failed = await admin.request(path);
    assert.equal(failed.scan_id, first.scan_id); assert.equal(failed.item_count, 100); assert.equal(failed.page_count, 1); assert.equal(failed.status, "failed"); assert.equal(failed.has_more, true);
    assert.equal(f.sql(`SELECT generation::text FROM source_scans WHERE source_id=${quote(source)}`), first.scan_id);
    record("failed second page retains the same durable scan, cursor and committed progress");
    assert.equal(f.sql(`SELECT available FROM media_items WHERE id=${quote(stale)}`), "t");
    record("failed partial scan leaves unseen old media available");

    const done = await admin.request(path, "POST", { restart: false });
    assert.equal(done.scan_id, first.scan_id); assert.equal(done.item_count, 101); assert.equal(done.page_count, 2); assert.equal(done.status, "completed"); assert.equal(done.has_more, false);
    const finalIds = JSON.parse(f.sql(`SELECT json_agg(id ORDER BY resource) FROM media_items WHERE source_id=${quote(source)} AND available`));
    assert.equal(finalIds.length, 101); assert.deepEqual(finalIds.slice(0, 100), firstIds);
    record("same scan resumes after failure and retains first-page media identities");
    assert.equal(f.sql(`SELECT available FROM media_items WHERE id=${quote(stale)}`), "f");
    assert.equal(f.sql(`SELECT count(*) FROM media_items WHERE id=${quote(stale)}`), "1");
    record("only successful final reconciliation retires unseen availability while keeping its row");
    assert.ok(signedRequests >= 104); assert.ok(listRequests >= 3); assert.ok(headRequests >= 101);
    record("actual list and HEAD requests carry the expected signature-header prefix");
    assert.ok(!JSON.stringify(await admin.request(`/libraries/${library.id}`)).includes("synthetic-owned-local-secret"));
    record("private-library management does not return the synthetic credential secret");
    assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
    assert.equal(f.sql("SELECT count(*) FROM media_jobs"), "0");
    assert.equal(f.sql("SELECT count(*) FROM media_previews"), "0");
    record("scan pages create no playback, media-job or preview work");
  } catch (error) { primaryError = error; primaryFailed = true; }
  finally {
    await finishOwnedFixture({
      primaryError, primaryFailed,
      cleanup: async () => {
        upstream.closeAllConnections();
        if (!listening && !upstream.listening) return;
        let timer;
        try {
          await Promise.race([
            new Promise((done, reject) => upstream.close((error) => { if (error) reject(error); else { closeObserved = true; done(); } })),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error("owned_s3_endpoint_close_deadline")), 5000); }),
          ]);
        } finally { clearTimeout(timer); }
      },
      verifyStopped: async () => {
        if (!listening) return { started: false, close_observed: false, port: null, port_closed: null };
        assert.equal(closeObserved, true);
        const closed = await verifyClosedPort(port);
        assert.equal(closed, true);
        return { started: true, close_observed: true, port, port_closed: closed };
      },
      save: async (receipt) => {
        report.synthetic_endpoint = { ...receipt, signed_requests: signedRequests, list_requests: listRequests, head_requests: headRequests };
      },
    });
  }
});
