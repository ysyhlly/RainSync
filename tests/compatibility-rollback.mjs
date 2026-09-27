import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer } from "./fixtures/server.mjs";
import { png } from "./fixtures/png.mjs";

const manifest=JSON.parse(await readFile(resolve(process.env.RAINSYNC_ARTIFACT_DIR,"compatibility/latest.json"),"utf8"));
const binary=resolve(manifest.target,"debug",`rainsync-server${process.platform==="win32"?".exe":""}`);
await isolatedServer("rollback",async(f)=>{
  const admin=f.client(); await admin.login();
  const batch=await admin.request("/admin/registration-invites","POST",{batch_id:randomUUID(),count:2},201);
  const user=f.client();
  const identity=await user.request("/auth/register","POST",{code:batch.items[0].code,username:"rollback-user",password:" pass 12",display_name:"保留的昵称😀"},201); user.csrf=identity.csrf;
  const operation=randomUUID();
  const avatarResponse=await user.raw("/users/me/avatar",{method:"PUT",body:png(),headers:{"Content-Type":"image/png","If-Match":"\"none\"","x-avatar-operation-id":operation}});
  assert.equal(avatarResponse.status,200); const avatar=await avatarResponse.json();
  const beforeBytes=Buffer.from(await (await user.raw(avatar.avatar_url.replace("/api/v1",""))).arrayBuffer());
  const room=await user.request("/rooms","POST",{name:"rollback viewing room"});
  const preserved=()=>({
    profile:f.sql(`SELECT display_name FROM user_profiles WHERE user_id='${identity.id}'`),
    avatar:f.sql(`SELECT version||':'||md5(content) FROM user_avatars WHERE user_id='${identity.id}'`),
    invites:f.sql(`SELECT id||':'||COALESCE(used_by::text,'unused') FROM registration_invites WHERE batch_id='${batch.batch_id}' ORDER BY id`),
    operations:f.sql(`SELECT count(*) FROM avatar_operations WHERE user_id='${identity.id}'`),
  });
  const data=preserved();
  await f.startServer({},binary);
  assert.equal((await user.request("/auth/me")).id,identity.id,"new session accepted by compatibility binary");
  assert.equal((await user.request("/rooms"))[0].id,room.id);
  const relogin=f.client(); assert.equal((await relogin.login("rollback-user"," pass 12")).id,identity.id);
  await relogin.request(`/rooms/${room.id}/messages`);
  await relogin.request("/users/me/profile","GET",undefined,404);
  await admin.request("/admin/registration-invites","GET",undefined,404);
  assert.deepEqual(preserved(),data,"old behavior must leave additive data intact");
  await f.startServer();
  assert.equal((await user.request("/auth/me")).display_name,"保留的昵称😀");
  assert.equal((await user.request("/users/me/profile")).avatar_version,avatar.avatar_version);
  const afterBytes=Buffer.from(await (await user.raw(avatar.avatar_url.replace("/api/v1",""))).arrayBuffer());
  assert.deepEqual(afterBytes,beforeBytes);
  assert.deepEqual(preserved(),data);
  const docker=(args)=>execFileSync("docker",["exec",f.container,...args],{timeout:60000,stdio:["ignore","pipe","pipe"],windowsHide:true});
  docker(["pg_dump","-U","rainsync","-Fc","-f","/tmp/rollback.dump","rainsync"]);
  docker(["createdb","-U","rainsync","rainsync_restore"]);
  docker(["pg_restore","-U","rainsync","-d","rainsync_restore","/tmp/rollback.dump"]);
  await f.startServer({DATABASE_URL:f.env.DATABASE_URL.replace("/rainsync?","/rainsync_restore?")});
  assert.equal((await user.request("/users/me/profile")).avatar_version,avatar.avatar_version);
  assert.equal((await user.request("/auth/me")).display_name,"保留的昵称😀");
  assert.equal((await admin.request(`/admin/registration-invites?batch_id=${batch.batch_id}`)).items.length,2);
  assert.deepEqual(Buffer.from(await (await user.raw(avatar.avatar_url.replace("/api/v1",""))).arrayBuffer()),beforeBytes);
  console.log("PASS: baseline Server with retained SQLx migrations accepts newly registered credentials/session and rooms; account/profile/avatar/invite records unchanged across rollback and forward restart; pg_dump/pg_restore preserves avatar bytes and sessions");
});
