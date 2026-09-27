import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";

await isolatedServer("invites", async (f) => {
  const admin = f.client(); await admin.login();
  const batch_id = randomUUID();
  const body = { batch_id, count: 2, valid_days: 7, note: "测试批次" };
  const response = await admin.raw("/admin/registration-invites", { method: "POST", body });
  assert.equal(response.status, 201, "administrator can create a batch");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const batch = await response.json();
  assert.equal(batch.batch_id, batch_id);
  assert.equal(batch.items.length, 2);
  assert.notEqual(batch.items[0].code, batch.items[1].code);
  for (const item of batch.items) {
    assert.match(item.code, /^RS(?:-[0-9A-HJKMNP-TV-Z]{4}){8}$/);
    assert.equal(item.code_suffix, item.code.slice(-4));
    assert.ok(item.expires_at > Date.now() + 6 * 86400000);
    assert.ok(item.expires_at <= Date.now() + 7 * 86400000);
  }
  const duplicate = await admin.request("/admin/registration-invites", "POST", body, 409);
  assert.equal(duplicate.error.code, "REGISTRATION_BATCH_ALREADY_CREATED");
  assert.equal((await admin.request("/admin/registration-invites", "POST", { ...body, count: 3 }, 409)).error.code, "REGISTRATION_BATCH_CONFLICT");
  const recovered = await admin.request(`/admin/registration-invites?batch_id=${batch_id}`);
  assert.equal(recovered.items.length, 2);
  assert.ok(recovered.server_time <= Date.now());
  assert.equal(JSON.stringify(recovered).includes(batch.items[0].code), false);
  assert.equal(JSON.stringify(recovered).includes("code_hash"), false);
  assert.equal(recovered.items[0].status, "unused");
  const defaults = await admin.request("/admin/registration-invites", "POST", { batch_id: randomUUID() }, 201);
  assert.equal(defaults.items.length, 1);
  assert.ok(Math.abs(defaults.items[0].expires_at - Date.now() - 7 * 86400000) < 10000);
  for (const invalid of [{ count: 0 }, { count: 51 }, { valid_days: 2 }, { note: "x".repeat(61) }]) {
    await admin.request("/admin/registration-invites", "POST", { ...body, batch_id: randomUUID(), ...invalid }, 400);
  }
  const concurrentId = randomUUID();
  const raced = await Promise.all(Array.from({ length: 2 }, () => admin.raw("/admin/registration-invites", { method: "POST", body: { ...body, batch_id: concurrentId } })));
  assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409]);
  await Promise.all(raced.map((r) => r.arrayBuffer()));
  assert.equal(f.sql(`SELECT count(*) FROM registration_invites WHERE batch_id='${concurrentId}'`), "2");
  for (const valid_days of [1, 30]) {
    const value = await admin.request("/admin/registration-invites", "POST", { batch_id: randomUUID(), count: 50, valid_days }, 201);
    assert.equal(value.items.length, 50);
    assert.ok(Math.abs(value.items[0].expires_at - Date.now() - valid_days * 86400000) < 10000);
  }
  const id = batch.items[0].id;
  assert.equal((await admin.request(`/admin/registration-invites/${id}`, "DELETE")).status, "revoked");
  assert.equal((await admin.request(`/admin/registration-invites/${id}`, "DELETE")).status, "revoked");
  const otherId = batch.items[1].id;
  f.sql(`UPDATE registration_invites SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${otherId}'`);
  assert.equal((await admin.request(`/admin/registration-invites?status=expired&batch_id=${batch_id}`)).items[0].id, otherId);
  await admin.request(`/admin/registration-invites/${otherId}`, "DELETE", undefined, 409);
  const account = await admin.request("/users", "POST", { username: "ordinary", password: "12345678", display_name: "同名" });
  f.sql(`UPDATE registration_invites SET used_by='${account.id}',used_at=clock_timestamp() WHERE id='${otherId}'`);
  const used = (await admin.request(`/admin/registration-invites?status=used&batch_id=${batch_id}`)).items[0];
  assert.equal(used.used_by, account.id);
  assert.equal(used.used_by_username, "ordinary");
  assert.equal(used.used_by_display_name, "同名");
  assert.equal((await admin.request(`/admin/registration-invites/${otherId}`, "DELETE", undefined, 409)).error.code, "REGISTRATION_INVITE_ALREADY_USED");
  const seen = new Set(); let cursor;
  do {
    const page = await admin.request(`/admin/registration-invites?limit=7${cursor ? `&cursor=${cursor}` : ""}`);
    assert.ok(page.items.length <= 7);
    for (const item of page.items) { assert.equal(seen.has(item.id), false); seen.add(item.id); }
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.size, Number(f.sql("SELECT count(*) FROM registration_invites")));
  await admin.request("/admin/registration-invites?status=bogus", "GET", undefined, 400);
  await admin.request("/admin/registration-invites?limit=0", "GET", undefined, 400);
  const ordinary = f.client(); await ordinary.login("ordinary", "12345678");
  for (const client of [f.client(), ordinary]) {
    const expected = client.cookie ? 403 : 401;
    await client.request("/admin/registration-invites", "GET", undefined, expected);
    await client.request("/admin/registration-invites", "POST", { ...body, batch_id: randomUUID() }, expected);
    await client.request(`/admin/registration-invites/${id}`, "DELETE", undefined, expected);
  }
  await admin.request("/admin/registration-invites", "POST", { ...body, batch_id: randomUUID() }, 403, { "x-csrf-token": "wrong" });
  await admin.request("/admin/registration-invites", "POST", { ...body, batch_id: randomUUID() }, 403, { Origin: "https://wrong.invalid" });
  f.sql(`UPDATE users SET admin=true WHERE id='${account.id}'`);
  assert.equal((await ordinary.request("/admin/registration-invites", "POST", body, 409)).error.code, "REGISTRATION_BATCH_CONFLICT");
  f.sql("ALTER TABLE registration_invites ADD CONSTRAINT fixture_fail CHECK(false) NOT VALID");
  const failedBatch = randomUUID();
  try { await admin.request("/admin/registration-invites", "POST", { ...body, batch_id: failedBatch }, 500); }
  finally { f.sql("ALTER TABLE registration_invites DROP CONSTRAINT fixture_fail"); }
  assert.equal(f.sql(`SELECT count(*) FROM registration_invite_batches WHERE id='${failedBatch}'`), "0");
  await f.startServer();
  assert.equal((await admin.request(`/admin/registration-invites?batch_id=${batch_id}`)).items.length, 2);
  console.log("PASS: real batch creation, entropy format, defaults/limits/expiry, transaction rollback, concurrent idempotency, lost-response recovery, metadata-only cursor/status listing, revoke, CSRF/Origin/permissions and restart");
});
