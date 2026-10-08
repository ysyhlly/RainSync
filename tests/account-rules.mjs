import assert from "node:assert/strict";
import { isolatedServer } from "./fixtures/server.mjs";

await isolatedServer("accounts", async (f) => {
  const admin = f.client();
  await admin.login();
  // Existing Server rejects this approved eight-character password. The rule
  // test must turn red before the account implementation changes.
  const first = await admin.request("/users", "POST", { username: "Eight_1.-", password: " pass 12", display_name: "雨😀" });
  const newUser = f.client();
  const identity = await newUser.login("Eight_1.-", " pass 12");
  assert.equal(identity.id, first.id);
  assert.equal(identity.admin, false);
  await newUser.request("/auth/login", "POST", { username: "Eight_1.-", password: "pass 12" }, 401);
  for (const username of ["", "中文", "a b", "a/b", "x".repeat(81)]) {
    await admin.request("/users", "POST", { username, password: "password123" }, 400);
  }
  for (const password of ["1234567", "中文密码1234", "line\nbreak", "tab\tpass", "x".repeat(1025)]) {
    await admin.request("/users", "POST", { username: "invalid", password }, 400);
  }
  await admin.request("/users", "POST", { username: "len80_" + "a".repeat(74), password: "x".repeat(1024), display_name: "😀".repeat(50) });
  await admin.request("/users", "POST", { username: "repeat-nickname", password: "12345678", display_name: "雨😀" });
  await admin.request("/users", "POST", { username: "badnickname", password: "12345678", display_name: "😀".repeat(51) }, 400);
  await admin.request("/users", "POST", { username: "admin-injection", password: "12345678", admin: true }, 422);
  await admin.request("/users", "POST", { username: "Eight_1.-", password: "12345678" }, 409);
  await newUser.request("/users", "POST", { username: "forbidden", password: "12345678" }, 403);
  assert.equal(f.sql("SELECT count(*) FROM users WHERE admin"), "1");
  assert.equal(f.sql("SELECT count(*) FROM user_profiles WHERE display_name='雨😀'"), "2");
  // Guest principals intentionally add one defensive account-kind column;
  // normal account creation must preserve the original role/schema boundary.
  assert.equal(
    f.sql("SELECT string_agg(column_name,',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='users'"),
    "admin,id,password_hash,principal_kind,username",
  );
  assert.equal(f.sql("SELECT count(*) FROM users WHERE principal_kind IS DISTINCT FROM 'account'"), "0");
  assert.equal(f.sql("SELECT count(*) FROM information_schema.columns WHERE table_name='sessions'"), "4");
  await f.startServer();
  assert.equal((await newUser.request("/auth/me")).id, first.id, "existing session survives migration and restart");
  console.log("PASS: real account creation, ASCII/length/nickname boundaries, preserved password spaces, whitelist, ordinary role, duplicate and restart compatibility");
});

await isolatedServer("bootstrap",async(f)=>{
  const client=f.client();
  const user=await client.login("init_1.-","        ");
  assert.equal(user.admin,true);
  await f.startServer({ADMIN_PASSWORD:"x",ADMIN_USERNAME:"invalid legacy replacement"});
  assert.equal((await client.request("/auth/me")).username,"init_1.-");
  assert.equal((await f.client().login("init_1.-","        ")).id,user.id);
  console.log("PASS: fresh administrator uses the eight-character/space rules; existing administrator and sessions are not renamed or reset by later environment changes");
},{env:{ADMIN_USERNAME:"init_1.-",ADMIN_PASSWORD:"        "}});
