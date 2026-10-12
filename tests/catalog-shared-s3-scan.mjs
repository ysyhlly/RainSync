// External draft: shared /sources/{id}/test dispatch through the existing
// checkpointed S3 page owner. This is distinct from private scan09 coverage.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { catalogFixture } from "./fixtures/catalog-evidence.mjs";
import { finishOwnedFixture } from "./fixtures/server.mjs";
import { verifyClosedPort } from "./fixtures/postgres.mjs";

const baseline = process.argv.includes("--baseline");
await catalogFixture({
  name: "catalog-shared-s3-scan", coordinator: "tests/catalog-shared-s3-scan.mjs",
  baseline, baselineResult: "passed", timeout: 120000,
  env: {
    PRIVATE_LIBRARIES_ENABLED: "true",
    RAINSYNC_S3_SHARED_SCAN_ACCESS: "SYNTHETICSHAREDSCAN",
    RAINSYNC_S3_SHARED_SCAN_SECRET: "synthetic-owned-shared-scan-secret",
  },
  limitations: [
    "Shared route restart/status/count-alias behavior only; distinct from private scan09 caller/checkpoint coverage",
    "No new login-expiry, race or concurrent-scan scenario",
    "Signature-header prefix is checked by the synthetic endpoint; SigV4 is not independently recomputed",
    "Broad integration and unavailable pg-module private matrix are not executed",
    "Owned Server/PostgreSQL and loopback list/HEAD only; no real account, Worker, playback or NAS process",
  ],
}, async (f, report, signal) => {
  const record = (name) => report.checks.push({ name, result: "passed" });
  const objects = Array.from({ length: 101 }, (_, i) => `allowed/media-${String(i).padStart(3, "0")}.mp4`);
  let failNextPage = true, signedRequests = 0, listRequests = 0, headRequests = 0;
  let port, listening = false, closeObserved = false, endpointFailed = false;
  let primaryError, primaryFailed = false;
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
  upstream.once("listening", () => { listening = true; port = upstream.address().port; });
  upstream.once("close", () => { closeObserved = true; });
  upstream.on("error", () => { endpointFailed = true; });
  try {
    signal.throwIfAborted();
    await new Promise((done, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", done);
    });
    const endpoint = `http://127.0.0.1:${port}`;
    const admin = f.client(); await admin.login();
    const library = (await admin.request("/libraries")).items.find((item) => item.visibility === "instance_shared");
    assert.ok(library);
    const source = await admin.request(`/libraries/${library.id}/sources`, "POST", {
      name: "Owned shared S3", kind: "s3",
      config: {
        url: endpoint,
        access_policy: { schema_version: 1, origins: [{ origin: endpoint, cidrs: ["127.0.0.1/32"] }] },
        s3: { region: "us-east-1", bucket: "synthetic-bucket", prefix: "allowed/", addressing_style: "path",
          credential_ref: { access_key_id_env: "RAINSYNC_S3_SHARED_SCAN_ACCESS", secret_access_key_env: "RAINSYNC_S3_SHARED_SCAN_SECRET" } },
      },
    });
    const path = `/sources/${source.id}/test`;
    const statusPath = `/libraries/${library.id}/sources/${source.id}/scan`;
    const page = (value, count, pages, status, more) => {
      assert.equal(value.count, value.item_count);
      assert.equal(value.count, count);
      assert.equal(value.page_count, pages);
      assert.equal(value.status, status);
      assert.equal(value.has_more, more);
    };

    const first = await admin.request(path, "POST");
    page(first, 100, 1, "running", true);
    record("missing checkpoint starts a shared page and returns count equal to item_count");

    const failedResponse = await admin.request(path, "POST", undefined, 502);
    assert.equal(failedResponse.error.code, "S3_SCAN_FAILED");
    const failed = await admin.request(statusPath);
    assert.equal(failed.scan_id, first.scan_id);
    assert.equal(failed.item_count, 100); assert.equal(failed.page_count, 1);
    assert.equal(failed.status, "failed"); assert.equal(failed.has_more, true);
    record("running checkpoint resumes its next page and preserves scan identity when that page fails");

    const completed = await admin.request(path, "POST");
    page(completed, 101, 2, "completed", false);
    assert.equal(completed.scan_id, first.scan_id);
    record("failed checkpoint resumes without restart and retains the legacy count alias");

    const restarted = await admin.request(path, "POST");
    page(restarted, 100, 1, "running", true);
    assert.notEqual(restarted.scan_id, first.scan_id);
    record("completed checkpoint starts a new scan with reset page and count values");

    const finished = await admin.request(path, "POST");
    page(finished, 101, 2, "completed", false);
    assert.equal(finished.scan_id, restarted.scan_id);
    record("running restarted scan resumes and completes with count equal to item_count");
    signal.throwIfAborted();
    if (endpointFailed) throw new Error("owned_shared_scan_endpoint_error");
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
            new Promise((done, reject) => upstream.close((error) => error ? reject(error) : done())),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error("owned_shared_scan_endpoint_close_deadline")), 5000); }),
          ]);
        } finally { clearTimeout(timer); }
      },
      verifyStopped: async () => {
        if (!listening) return { started: false, close_observed: closeObserved, port: null, port_closed: null };
        assert.equal(closeObserved, true);
        const closed = await verifyClosedPort(port);
        assert.equal(closed, true);
        return { started: true, close_observed: true, port, port_closed: closed, endpoint_error: endpointFailed };
      },
      save: async (receipt) => {
        report.synthetic_endpoint = { ...receipt, signed_requests: signedRequests,
          list_requests: listRequests, head_requests: headRequests, endpoint_error: endpointFailed };
      },
    });
  }
});
