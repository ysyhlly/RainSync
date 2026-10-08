// Disposable real Server/PostgreSQL login admission and cookie regressions.
import assert from "node:assert/strict";
import { isolatedServer } from "./fixtures/server.mjs";

let owned;
await isolatedServer("login-admission-regressions", async (f) => {
  owned = f;
  const login = (username, password, source) => f.client().raw("/auth/login", {
    method: "POST", body: { username, password }, headers: { "x-forwarded-for": source },
  });
  for (let i = 0; i < 12; i++) assert.equal((await login("admin", f.password, "198.51.100.1")).status, 200);
  assert.equal(f.sql("SELECT count(*) FROM login_attempts"), "0", "success spends no failed-login quota");
  for (let i = 0; i < 10; i++) assert.equal((await login(`missing-${i}`, "wrong", "198.51.100.2")).status, 401);
  assert.equal((await login("admin", "wrong", "198.51.100.2")).status, 429);
  assert.equal(f.sql("SELECT count(*) FROM login_attempts"), "1", "random names share one source window");
  assert.equal((await login("admin", f.password, "198.51.100.3")).status, 200, "another caller can log into the targeted account");
  f.sql("DELETE FROM login_attempts; INSERT INTO login_attempts(username_hash,attempts) SELECT md5(n::text),10 FROM generate_series(1,1000) n");
  assert.equal((await login("admin", f.password, "198.51.100.4")).status, 200, "full anonymous bookkeeping does not block a new account caller");
  assert.equal((await login("missing", "wrong", "198.51.100.5")).status, 401);
  assert.equal(f.sql("SELECT count(*) FROM login_attempts"), "1000");
  f.sql("DELETE FROM login_attempts");

  await f.startServer({ TRUSTED_PROXY_CIDRS: "" });
  for (let i = 0; i < 10; i++) assert.equal((await login(`untrusted-${i}`, "wrong", `198.51.100.${20 + i}`)).status, 401);
  assert.equal(f.sql("SELECT count(*) FROM login_attempts"), "1", "untrusted forwarding cannot invent sources");
  assert.equal((await login("admin", f.password, "198.51.100.90")).status, 429);
  f.sql("DELETE FROM login_attempts");

  // Header contract only; the fixture's client is not a browser cookie store.
  for (const publicOrigin of [f.origin, "https://secure.fixture.invalid"]) {
    await f.startServer({ PUBLIC_ORIGIN: publicOrigin });
    const client = f.client();
    const set = await client.raw("/auth/login", { method: "POST", body: { username: "admin", password: f.password }, headers: { Origin: publicOrigin } });
    assert.equal(set.status, 200);
    client.csrf = (await set.json()).csrf;
    const cleared = await client.raw("/auth/logout", { method: "POST", headers: { Origin: publicOrigin } });
    assert.equal(cleared.status, 200);
    assert.match(cleared.headers.get("set-cookie"), /Max-Age=0/);
    assert.match(cleared.headers.get("set-cookie"), /Path=\//);
    assert.equal(cleared.headers.get("set-cookie").includes("; Secure"), set.headers.get("set-cookie").includes("; Secure"));
    assert.equal(cleared.headers.get("set-cookie").includes("; Secure"), publicOrigin.startsWith("https://"));
  }
}, { env: { TRUSTED_PROXY_CIDRS: "127.0.0.1/32" } });
await owned.verifyStopped();
console.log("PASS: success quota, source isolation, unknown-account admission, bounded slots, proxy trust, logout Secure attributes, owned cleanup");
