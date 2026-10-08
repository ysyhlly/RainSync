// Historical account/profile rollout fixture (0019→0022), not current release evidence.
import { requireHistoricalCompatibility } from "./fixtures/historical-compatibility.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer } from "./fixtures/server.mjs";
import { png } from "./fixtures/png.mjs";

await requireHistoricalCompatibility();

const manifest=JSON.parse(await readFile(resolve(process.env.RAINSYNC_ARTIFACT_DIR,"compatibility/latest.json"),"utf8"));
const binary=resolve(manifest.baselineTarget,"debug",`rainsync-server${process.platform==="win32"?".exe":""}`);
await isolatedServer("upgrade",async(f)=>{
  assert.equal(f.sql("SELECT max(version) FROM _sqlx_migrations"),"19");
  const admin=f.client();const adminBefore=await admin.login("旧管理员","旧密码12345678");
  const old=await admin.request("/users","POST",{username:"历史中文账号",password:"original-password"});
  const hash=f.legacyPasswordHash("短");f.sql(`UPDATE users SET password_hash='${hash}' WHERE id='${old.id}'`);
  const user=f.client();await user.login("历史中文账号","短");
  const room=await user.request("/rooms","POST",{name:"retained room"});
  const roomInvite=await user.request(`/rooms/${room.id}/invites`,"POST");
  const before=f.sql("SELECT string_agg(version||':'||encode(checksum,'hex'),',' ORDER BY version) FROM _sqlx_migrations");
  await f.startServer({ADMIN_USERNAME:"do-not-rename",ADMIN_PASSWORD:"invalid-for-creation"});
  assert.equal(f.sql("SELECT max(version) FROM _sqlx_migrations"),"22");
  assert.equal(f.sql("SELECT string_agg(version||':'||encode(checksum,'hex'),',' ORDER BY version) FROM _sqlx_migrations WHERE version<=19"),before);
  assert.equal((await admin.request("/auth/me")).id,adminBefore.id);
  const profile=await user.request("/users/me/profile");
  assert.equal(profile.id,old.id);assert.equal(profile.username,"历史中文账号");assert.equal(profile.display_name,"历史中文账号");
  assert.equal(profile.custom_display_name,null);assert.equal(profile.avatar_url,null);assert.equal(profile.avatar_version,null);
  assert.equal((await user.request("/rooms"))[0].id,room.id);
  assert.equal((await f.client().login("历史中文账号","短")).id,old.id);
  await user.request("/users/me/profile","PATCH",{display_name:"升级后昵称😀"});
  const avatar=await user.raw("/users/me/avatar",{method:"PUT",body:png(),headers:{"Content-Type":"image/png","If-Match":"\"none\"","x-avatar-operation-id":randomUUID()}});
  assert.equal(avatar.status,200);await avatar.arrayBuffer();
  const code=(await admin.request("/admin/registration-invites","POST",{batch_id:randomUUID()},201)).items[0].code;
  const created=f.client();const identity=await created.request("/auth/register","POST",{code,username:"after-upgrade",password:"12345678"},201);created.csrf=identity.csrf;
  assert.deepEqual(await created.request("/rooms"),[]);
  await created.request(`/rooms/${room.id}/join`,"POST",{token:roomInvite.token});
  assert.equal((await created.request("/rooms"))[0].id,room.id);
  console.log("PASS: actual untouched baseline starts at migration 0019, issues legacy sessions and room invitations; historical 0022 Server applies 0020/0021/0022 without changing old checksums/users/credentials/membership, then supports nickname/avatar/registration independently");
},{binary,env:{ADMIN_USERNAME:"旧管理员",ADMIN_PASSWORD:"旧密码12345678"}});
