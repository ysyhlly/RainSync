import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { isolatedServer } from "./fixtures/server.mjs";

await isolatedServer("registration", async (f) => {
  const admin = f.client(); await admin.login();
  const legacyId = randomUUID();
  const legacyHash = f.legacyPasswordHash("短\n旧");
  f.sql(`INSERT INTO users VALUES('${legacyId}','历史账号','${legacyHash}',false)`);
  const legacy = f.client();
  assert.equal((await legacy.login("历史账号", "短\n旧")).id, legacyId);
  const legacyProfile = await legacy.request("/users/me/profile");
  assert.equal(legacyProfile.display_name, "历史账号");
  assert.equal(legacyProfile.custom_display_name, null);
  const invite = async () => (await admin.request("/admin/registration-invites", "POST", { batch_id: randomUUID() }, 201)).items[0];
  const makeBody = (code, username, display_name = "同名😀") => ({ code, username, display_name, password: " pass 12" });
  const unused = (id) => assert.equal(f.sql(`SELECT used_at IS NULL FROM registration_invites WHERE id='${id}'`), "t");
  const first = await invite();
  const anonymous = f.client();
  for (let i = 0; i < 3; i++) {
    const validation = await anonymous.request("/auth/registration-invites/validate", "POST", { code: ` ${first.code.toLowerCase()} ` });
    assert.equal(validation.code_suffix, first.code_suffix);
    assert.equal(anonymous.cookie, ""); unused(first.id);
  }
  const user = f.client();
  const successResponse = await user.raw("/auth/register", { method: "POST", body: makeBody(first.code, "registered") });
  assert.equal(successResponse.status, 201);
  assert.equal(successResponse.headers.get("cache-control"), "no-store");
  assert.match(successResponse.headers.get("set-cookie"), /HttpOnly.*SameSite=Strict/);
  const identity = await successResponse.json(); user.csrf = identity.csrf;
  assert.equal(identity.admin, false); assert.equal(identity.username, "registered"); assert.equal(identity.display_name, "同名😀");
  assert.equal((await user.request("/auth/me")).id, identity.id);
  assert.deepEqual(await user.request("/rooms"), []);
  assert.equal(f.sql(`SELECT used_by FROM registration_invites WHERE id='${first.id}'`), identity.id);
  await anonymous.request("/auth/register", "POST", makeBody(first.code, "second-use"), 400);
  assert.equal((await user.request("/auth/register", "POST", makeBody(first.code, "switch"), 409)).error.code, "ALREADY_AUTHENTICATED");
  for (const extra of [{ admin: true }, { user_id: randomUUID() }, { role: "admin" }]) {
    await anonymous.request("/auth/register", "POST", { ...makeBody(first.code, "injected"), ...extra }, 422);
  }
  const repeated = await invite();
  assert.equal((await anonymous.request("/auth/register", "POST", makeBody(repeated.code, "registered"), 409)).error.code, "USERNAME_TAKEN");
  unused(repeated.id);
  const friend = f.client();
  const friendIdentity = await friend.request("/auth/register", "POST", makeBody(repeated.code, "friend"), 201); friend.csrf = friendIdentity.csrf;
  assert.equal(friendIdentity.display_name, identity.display_name);
  for (const name of ["changed", "", "<b>中文😀</b>", "😀".repeat(50)]) {
    const p = await user.request("/users/me/profile", "PATCH", { display_name: name });
    assert.equal(p.username, "registered"); assert.equal(p.display_name, name || "registered");
    assert.equal(p.custom_display_name, name || null);
  }
  await user.request("/users/me/profile", "PATCH", { display_name: "😀".repeat(51) }, 400);
  for (const field of ["username", "admin", "user_id", "avatar_url"]) {
    await user.request("/users/me/profile", "PATCH", { display_name: "safe", [field]: "changed" }, 422);
  }
  await user.request("/users/me/profile", "PATCH", {}, 422);
  await user.request("/users/me/profile", "PATCH", { display_name: "聊天室昵称" });
  const room = await user.request("/rooms", "POST", { name: "nickname-room" });
  const socket = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", { headers: { Origin: f.origin, Cookie: user.cookie } });
  const messages = [];
  socket.on("message", (bytes) => messages.push(JSON.parse(bytes)));
  await new Promise((done, reject) => { socket.once("open", done); socket.once("error", reject); });
  const receive = async (type) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const index = messages.findIndex((m) => m.type === type); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise((done) => setTimeout(done, 20)); }
    throw new Error(`Missing ${type} response`);
  };
  try {
    socket.send(JSON.stringify({ type: "JOIN", room_id: room.id })); await receive("SNAPSHOT");
    socket.send(JSON.stringify({ type: "CHAT", body: "profile identity", client_message_id: randomUUID() }));
    const chat = await receive("CHAT");
    assert.equal(chat.user_id, identity.id); assert.equal(chat.username, "registered"); assert.equal(chat.display_name, "聊天室昵称");
    await user.request("/users/me/profile", "PATCH", { display_name: "新昵称" });
    const history = await user.request(`/rooms/${room.id}/messages`);
    assert.equal(history[0].user_id, identity.id); assert.equal(history[0].display_name, "新昵称");
  } finally { socket.terminate(); }
  await anonymous.request("/auth/login", "POST", { username: "新昵称", password: " pass 12" }, 401);
  const recovered = f.client(); await recovered.login("registered", " pass 12");
  assert.equal((await recovered.request("/users/me/profile")).username, "registered");
  for (const table of ["users", "user_profiles", "registration_invites", "sessions"]) {
    const code = await invite(); const username = `fail_${table}`;
    f.sql(`ALTER TABLE ${table} ADD CONSTRAINT fixture_fail CHECK(false) NOT VALID`);
    try { await anonymous.request("/auth/register", "POST", makeBody(code.code, username), 500); }
    finally { f.sql(`ALTER TABLE ${table} DROP CONSTRAINT fixture_fail`); }
    unused(code.id);
    assert.equal(f.sql(`SELECT count(*) FROM users WHERE username='${username}'`), "0");
  }
  const race = await invite();
  const racers = [f.client(), f.client()];
  const results = await Promise.all(racers.map((c, i) => c.raw("/auth/register", { method: "POST", body: makeBody(race.code, `racer${i}`) })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]); await Promise.all(results.map((r) => r.arrayBuffer()));
  assert.equal(f.sql("SELECT count(*) FROM users WHERE username IN('racer0','racer1')"), "1");
  const contested = await invite();
  const both = await Promise.all([
    f.client().raw("/auth/register", { method: "POST", body: makeBody(contested.code, "revoke_race") }),
    admin.raw(`/admin/registration-invites/${contested.id}`, { method: "DELETE" }),
  ]);
  assert.ok((both[0].status === 201 && both[1].status === 409) || (both[0].status === 400 && both[1].status === 200));
  await Promise.all(both.map((r) => r.arrayBuffer()));
  assert.equal(f.sql(`SELECT count(*) FROM registration_invites WHERE id='${contested.id}' AND used_at IS NOT NULL AND revoked_at IS NOT NULL`), "0");
  const committedRace=await invite();
  f.sql("CREATE FUNCTION fixture_registration_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.username='registration_lock_winner' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_registration_pause BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION fixture_registration_pause()");
  try {
    const registering=f.client().raw("/auth/register",{method:"POST",body:makeBody(committedRace.code,"registration_lock_winner")});
    await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'INSERT INTO users%'","1");
    const revoking=admin.raw(`/admin/registration-invites/${committedRace.id}`,{method:"DELETE"});
    const registrationWinner=await registering; assert.equal(registrationWinner.status,201); await registrationWinner.arrayBuffer();
    const revokeLoser=await revoking; assert.equal(revokeLoser.status,409); assert.equal((await revokeLoser.json()).error.code,"REGISTRATION_INVITE_ALREADY_USED");
  } finally { f.sql("DROP TRIGGER fixture_registration_pause ON users; DROP FUNCTION fixture_registration_pause()"); }
  const expiring = await invite();
  // The coarse read sees the committed future expiry while hashing; the locked
  // row receives an expiry that passes during the wait. This avoids depending
  // on machine speed before Argon2 starts and still catches transaction now().
  const locked = f.sqlProcess(`BEGIN; SELECT id FROM registration_invites WHERE id='${expiring.id}' FOR UPDATE; UPDATE registration_invites SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id='${expiring.id}'; SELECT pg_sleep(4); COMMIT;`);
  await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${expiring.id}%'`, "1");
  const expiresDuringWait = f.client().raw("/auth/register", { method: "POST", body: makeBody(expiring.code, "expired_while_locked") });
  await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM registration_invites%'", "1");
  await locked.done;
  const rejected = await expiresDuringWait; assert.equal(rejected.status, 400); await rejected.arrayBuffer(); unused(expiring.id);
  assert.equal(f.sql("SELECT count(*) FROM users WHERE username='expired_while_locked'"), "0");
  const revoked = await invite(); await admin.request(`/admin/registration-invites/${revoked.id}`, "DELETE");
  for (const code of ["made-up", first.code, expiring.code, revoked.code, "a".repeat(64)]) {
    const error = await anonymous.request("/auth/registration-invites/validate", "POST", { code }, 400);
    assert.equal(error.error.code, "REGISTRATION_INVITE_INVALID");
    assert.equal(JSON.stringify(error).includes(identity.id), false);
  }
  const lost = await invite();
  const discarded = await f.client().raw("/auth/register", { method: "POST", body: makeBody(lost.code, "response_lost") });
  assert.equal(discarded.status, 201); await discarded.body.cancel();
  const afterLoss = f.client(); const found = await afterLoss.login("response_lost", " pass 12");
  assert.equal(found.username, "response_lost");
  assert.equal(f.sql("SELECT count(*) FROM users WHERE username='response_lost'"), "1");
  const guard = await invite();
  for (const path of ["/auth/registration-invites/validate", "/auth/register"]) {
    const body = path.endsWith("validate") ? { code: guard.code } : makeBody(guard.code, "guarded");
    await anonymous.request(path, "POST", body, 403, { Origin: "https://wrong.invalid" });
    await anonymous.request(path, "POST", body, 415, { "Content-Type": "text/plain" });
  }
  unused(guard.id);
  for (const invalid of [{ username: "不合法" }, { password: "1234567" }, { password: "中文密码1234" }, { password: "line\nbreak" }]) {
    await anonymous.request("/auth/register", "POST", { ...makeBody(guard.code, "valid-but-rejected"), ...invalid }, 400);
    unused(guard.id);
  }
  const defaultProfile = f.client();
  const defaultIdentity = await defaultProfile.request("/auth/register", "POST", { code: guard.code, username: "x".repeat(80), password: "        " }, 201);
  defaultProfile.csrf = defaultIdentity.csrf;
  assert.equal(defaultIdentity.display_name, "x".repeat(80));
  assert.equal((await defaultProfile.request("/users/me/profile")).custom_display_name, null);
  const guardForLimits = await invite();
  await f.startServer({ REGISTRATION_VALIDATE_PER_MINUTE: "2", REGISTRATION_PER_TEN_MINUTES: "2" });
  f.sql("DELETE FROM account_rate_limits");
  for (const ip of ["198.51.100.1", "198.51.100.2"]) await anonymous.request("/auth/registration-invites/validate", "POST", { code: guardForLimits.code }, 200, { "X-Forwarded-For": ip });
  const limited = await anonymous.raw("/auth/registration-invites/validate", { method: "POST", body: { code: guardForLimits.code }, headers: { "X-Forwarded-For": "198.51.100.3" } });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.ok((await limited.json()).error.retry_after_ms > 0);
  await f.startServer({ REGISTRATION_VALIDATE_PER_MINUTE: "2" });
  await anonymous.request("/auth/registration-invites/validate", "POST", { code: guardForLimits.code }, 429);
  f.sql("UPDATE account_rate_limits SET expires_at=clock_timestamp()-interval '1 second'");
  await anonymous.request("/auth/registration-invites/validate", "POST", { code: guardForLimits.code });
  f.sql("DELETE FROM account_rate_limits");
  await f.startServer({ REGISTRATION_PER_TEN_MINUTES: "2" });
  for (let i=0;i<2;i++) await anonymous.request("/auth/register", "POST", makeBody("invalid", "rate-limited"), 400);
  const registerLimited = await anonymous.raw("/auth/register", { method:"POST", body:makeBody(guardForLimits.code,"must-not-hash") });
  assert.equal(registerLimited.status,429); assert.ok((await registerLimited.json()).error.retry_after_ms > 0); unused(guardForLimits.id);
  await f.startServer({ TRUSTED_PROXY_CIDRS: "127.0.0.1/32", REGISTRATION_VALIDATE_PER_MINUTE: "1" });
  f.sql("DELETE FROM account_rate_limits");
  await anonymous.request("/auth/registration-invites/validate", "POST", { code: guardForLimits.code }, 200, { "X-Forwarded-For": "1.2.3.4, 198.51.100.1" });
  await anonymous.request("/auth/registration-invites/validate", "POST", { code: guardForLimits.code }, 429, { "X-Forwarded-For": "5.6.7.8, 198.51.100.1" });
  await anonymous.request("/auth/registration-invites/validate", "POST", { code: guardForLimits.code }, 200, { "X-Forwarded-For": "198.51.100.2" });
  assert.equal((await legacy.request("/auth/me")).username, "历史账号");
  assert.equal((await user.request("/auth/me")).display_name, "新昵称");
  assert.equal(f.sql("SELECT count(*) FROM users WHERE admin"), "1");
  console.log("PASS: real invited registration/auto-session/profile/chat, non-consuming validation, lost response, all transaction rollback stages, same-code/revoke/expiry-lock races, immutable username, ordinary role, Origin/JSON, shared restart-persistent limits and trusted proxy chain");
}, { env: { REGISTRATION_VALIDATE_PER_MINUTE: "200", REGISTRATION_PER_TEN_MINUTES: "200" } });
