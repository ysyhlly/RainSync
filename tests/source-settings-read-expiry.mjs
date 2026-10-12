// An owned source-settings read must recheck exact-login expiry after its row wait.
import assert from "node:assert/strict";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { catalogFixture, holdSource } from "./fixtures/catalog-evidence.mjs";
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--reproduce-before"));
const baseline = args.length > 0;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
await catalogFixture({
  name: "source-settings-read-expiry", coordinator: "tests/source-settings-read-expiry.mjs",
  baseline, baselineResult: "baseline_post_wait_expiry_gap_reproduced", timeout: 60000,
}, async (f, report, signal) => {
    const client = f.client(), independentLogin = f.client();
    await client.login(); await independentLogin.login();
    const source = await client.request("/sources", "POST", { name: "Read expiry fixture", kind: "http", config: { url: "https://media.example.test/fixture.mp4", headers: { "X-Fixture": "synthetic-private-value" } } });
    const path = `/sources/${source.id}`;
    const initial = await client.request(path);
    assert.equal(initial.credentials.headers_configured, true);
    const state = () => f.sql(`SELECT row_to_json(s) FROM sources s WHERE id=${quote(source.id)}`);
    const before = state();
    const login = testLoginHash(f, client);
    const release = await holdSource(f, source.id, signal);
    try {
      f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=${quote(login)}`);
      const pending = client.raw(path); pending.catch(() => {});
      await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM sources WHERE id=%FOR SHARE'", "1");
      await f.waitForSql(`SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=${quote(login)}`, "t");
      await release();
      const response = await pending, value = await response.json();
      assert.equal(response.status, baseline ? 200 : 401);
      assert.doesNotMatch(JSON.stringify(value), /synthetic-private-value/);
      if (!baseline) {
        assert.equal(value.error.code, "SESSION_EXPIRED");
        assert.equal(value.credentials, undefined);
      }
      report.checks.push({ name: "exact login expires naturally while the source lock is held", status: response.status });
    } finally { await release(); }
    assert.equal(state(), before, "a rejected read cannot mutate source configuration");
    const current = await independentLogin.request(path);
    assert.deepEqual(current, initial, "another live login for the same administrator remains usable");
    report.checks.push({ name: "source unchanged and independent exact login still allowed", verified: true });
});
