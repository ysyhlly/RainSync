// A pending library retirement must not starve the pre-existing source cleanup.
// Only owned exact-login-bound synthetic sessions and a held PostgreSQL row are used.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { delay } from "./fixtures/server.mjs";
import { catalogFixture } from "./fixtures/catalog-evidence.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--reproduce-unbounded"));
const baseline = args.length > 0;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

await catalogFixture({
  name: "library-retirement-maintenance", coordinator: "tests/library-retirement-maintenance.mjs",
  baseline, baselineResult: "unbounded_receipt_draft_starvation_reproduced", timeout: 90000,
  env: { PRIVATE_LIBRARIES_ENABLED: "true" },
  limitations: ["The negative mode targets the new unbounded receipt draft, not the original repository", "Logical row retirement only; no physical disposal claim"],
}, async (f, report, signal) => {
  const admin = f.client(), owner = f.client(); await admin.login();
  const ownerId = (await admin.request("/users", "POST", { username: "maintenance-owner", password: f.password })).id;
  await owner.login("maintenance-owner");
  const library = await owner.request("/libraries", "POST", { name: "Owned maintenance library" });
  const privateSource = await owner.request(`/libraries/${library.id}/sources`, "POST", { name: "Private metadata only", kind: "http", config: { url: "https://media.example.test/private.mp4" } });
  const sharedSource = await admin.request("/sources", "POST", { name: "Shared metadata only", kind: "http", config: { url: "https://media.example.test/shared.mp4" } });
  async function seed(source, privateScope) {
    const media = randomUUID(), session = randomUUID();
    f.sql(`INSERT INTO media_items(id,source_id,title,resource) VALUES(${quote(media)},${quote(source)},'Synthetic retirement metadata','https://media.example.test/unused.mp4')`);
    const room = await owner.request("/rooms", "POST", { name: privateScope ? "Private maintenance" : "Independent source maintenance" });
    if (privateScope) await owner.request(`/libraries/${library.id}/room-shares`, "POST", { room_id: room.id, media_id: media, mode: "room_members", expires_in_minutes: 60, expected_revision: f.sql(`SELECT revision FROM private_libraries WHERE id=${quote(library.id)}`) });
    f.sql(`UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}',${quote(JSON.stringify(media))}::jsonb),'{media_generation}','1') WHERE room_id=${quote(room.id)}`);
    const resource = { source_id: source, source_policy_revision: Number(f.sql(`SELECT access_policy_revision FROM sources WHERE id=${quote(source)}`)) };
    withPlaybackAdmission(f, { client: owner, user: ownerId, room: room.id, session },
      `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(session)},${quote(ownerId)},${quote(room.id)},${quote(media)},1,${quote(hash(randomUUID()))},${quote(JSON.stringify(resource))}::jsonb,clock_timestamp()+interval '10 minutes')`);
    assert.equal(f.sql(`SELECT NOT stopped AND playback_library_session_allowed(id) FROM playback_sessions WHERE id=${quote(session)}`), "t");
    return session;
  }
  const blocked = await seed(privateSource.id, true), independent = await seed(sharedSource.id, false);
  const marker = `library_held_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "", released = false;
  const ready = new Promise((done, reject) => {
    child.stdout.on("data", (bytes) => { output += bytes; if (output.includes(marker)) done(); });
    child.once("error", reject); child.done.then(() => reject(new Error("owned holder exited before admission")), reject);
  });
  const bounded = async (work) => {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned holder deadline")), 12000); })]); }
    finally { clearTimeout(timer); }
  };
  async function release() {
    if (released) return;
    released = true; child.stdin.end("COMMIT;\n\\q\n"); await bounded(child.done);
  }
  const holderActive = () => f.sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(marker)} AND state='idle in transaction'`) === "1";
  child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; SELECT id FROM playback_sessions WHERE id=${quote(blocked)} FOR UPDATE;\n\\echo ${marker}\n`);
  try {
    await bounded(ready); signal.throwIfAborted();
    // Durable test-only fences avoid invoking the eager HTTP retirement path.
    f.sql(`UPDATE private_libraries SET permission_epoch=permission_epoch+1,revision=revision+1 WHERE id=${quote(library.id)}`);
    await f.waitForSql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE playback_sessions SET stopped=true WHERE NOT stopped AND NOT playback_library_session_allowed(id)%')", "t", 8000);
    assert.equal(holderActive(), true);
    report.checks.push({ name: "the actual library maintenance UPDATE is observed waiting on the owned row", verified: true });
    // This source is synthetic and never read/decrypted. Its changed revision
    // specifically belongs to the existing source-policy retirement operation.
    f.sql(`UPDATE sources SET config_encrypted='owned-maintenance-revision-fence' WHERE id=${quote(sharedSource.id)}`);
    const stopped = `SELECT stopped FROM playback_sessions WHERE id=${quote(independent)}`;
    let progressed = false;
    const waitStarted = performance.now(), deadline = waitStarted + 6500;
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      // SQL/transport failures propagate; only the observed deadline is a
      // legitimate no-progress result for the unbounded-draft negative case.
      if (f.sql(stopped) === "t") { progressed = true; break; }
      await delay(Math.min(30, Math.max(0, deadline - performance.now())));
    }
    const waitElapsedMs = performance.now() - waitStarted;
    if (!progressed) assert.ok(waitElapsedMs >= 6500);
    assert.equal(f.sql(stopped), progressed ? "t" : "f");
    assert.equal(progressed, !baseline, "independent old cleanup must progress within the bounded attempt window");
    assert.equal(holderActive(), true, "the private lock is still held when independent progress is checked");
    assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id=${quote(blocked)}`), "f", "a blocked attempt did not commit partial retirement");
    report.checks.push({ name: "older source cleanup proceeds before the private holder is released", progressed, wait_elapsed_ms: waitElapsedMs, private_holder_active: true, private_retirement_committed: false });
  } finally { await release(); }
  await f.waitForSql(`SELECT stopped FROM playback_sessions WHERE id=${quote(blocked)}`, "t", 8000);
  await f.waitForSql(`SELECT stopped FROM playback_sessions WHERE id=${quote(independent)}`, "t", 8000);
  report.checks.push({ name: "library retirement converges after the owned lock is released", retired: true });
});
