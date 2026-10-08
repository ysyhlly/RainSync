import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";

// Real HTTP and admission locks in an owned database. Terminal synthetic rows
// need no QR capability, credential encryption or calls to Bilibili.
await isolatedServer("platform-login-rate-limit", async (f) => {
  const client = f.client();
  const user = await client.login();
  const account = randomUUID(),
    request = randomUUID();
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const login = hash(client.cookie.split("=")[1]);
  const rateKey = hash(`account-rate:platform-login-start:${user.id}`);
  const path = "/platform-accounts/bilibili/login";
  const body = (id = request) => ({
    idempotency_key: id,
    consent_to_store: true,
  });
  f.sql(`INSERT INTO platform_accounts(id,user_id,provider,state) VALUES
    ('${account}','${user.id}','bilibili','revoked');
    INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,
      expires_at,next_poll_at,account_id,account_revision) VALUES
    ('${request}','${user.id}','${login}','bilibili','failed',
      clock_timestamp()+interval '4 minutes',clock_timestamp(),'${account}',1);
    INSERT INTO account_rate_limits(scope,key_hash,window_started,expires_at,attempts) VALUES
    ('platform-login-start','${rateKey}',clock_timestamp(),clock_timestamp()+interval '10 minutes',10)`);
  const window = () =>
    f.sql(`SELECT attempts || ':' || expires_at FROM account_rate_limits
    WHERE scope='platform-login-start' AND key_hash='${rateKey}'`);
  const before = window();
  for (let i = 0; i < 12; i++) {
    const value = await client.request(path, "POST", body());
    assert.equal(value.id, request);
    assert.equal(value.status, "failed");
    assert.equal(value.qr_payload, null);
  }
  const resumed = await Promise.all(
    Array.from({ length: 12 }, () => client.request(path, "POST", body())),
  );
  assert.ok(
    resumed.every((value) => value.id === request && value.status === "failed"),
  );
  assert.equal(
    window(),
    before,
    "serial and concurrent reads consume no creation attempts or extend the window",
  );

  await client.request(
    path,
    "POST",
    { ...body(), consent_to_renew: true },
    409,
  );
  await client.request(
    path,
    "POST",
    { ...body(), consent_to_store: false },
    400,
  );
  const alternateLogin = f.client();
  await alternateLogin.login();
  assert.equal(
    (await alternateLogin.request(path, "POST", body(), 409)).error.code,
    "PLATFORM_LOGIN_REQUEST_CONFLICT",
  );
  await client.request("/users", "POST", {
    username: "other-qr-viewer",
    password: f.password,
  });
  const other = f.client();
  await other.login("other-qr-viewer");
  await other.request(path, "POST", body(), 409);
  assert.equal(
    window(),
    before,
    "consent conflicts and a different user or exact login cannot bypass request binding",
  );

  const denials = await Promise.all(
    Array.from({ length: 4 }, () =>
      client.raw(path, { method: "POST", body: body(randomUUID()) }),
    ),
  );
  for (const response of denials) {
    assert.equal(
      response.status,
      429,
      "new QR admissions remain bounded after idempotent reads",
    );
    const value = await response.json();
    assert.equal(value.error.code, "RATE_LIMITED");
    assert.ok(
      value.error.retry_after_ms > 0 && value.error.retry_after_ms <= 600000,
    );
    assert.equal(
      Number(response.headers.get("retry-after")) * 1000,
      value.error.retry_after_ms,
    );
  }
  assert.equal(
    f.sql("SELECT count(*) FROM platform_login_requests"),
    "1",
    "denials do not create pending QR requests",
  );
  assert.equal(
    window().split(":")[0],
    "11",
    "denied attempts stay bounded and durable",
  );
  assert.equal(
    window().slice(3),
    before.slice(3),
    "denials do not extend the fixed window",
  );
  await f.startServer();
  assert.equal((await client.request(path, "POST", body())).id, request);
  assert.equal(
    window().split(":")[0],
    "11",
    "restart preserves limits and the same exact-login replay",
  );
  console.log(
    "PASS: real QR admission rate limit, concurrent idempotent replay, consent/exact-login/user guards, Retry-After and restart; no provider requests",
  );
});
