import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import {
  withPlaybackAdmission,
  testLoginHash,
} from "./fixtures/playback-admission.mjs";

await isolatedServer(
  "account-exit",
  async (f) => {
    const admin = f.client();
    await admin.login();
    const user = async (username) => {
      await admin.request("/users", "POST", {
        username,
        password: f.password,
        display_name: `name-${username}`,
      });
      const client = f.client(),
        identity = await client.login(username);
      return { client, identity };
    };
    const alice = await user("alice"),
      bob = await user("bob"),
      carol = await user("carol");
    const secondDevice = f.client();
    await secondDevice.login("alice");
    const room = await alice.client.request("/rooms", "POST", {
      name: "retained shared room",
    });
    const invite = await alice.client.request(
      `/rooms/${room.id}/invites`,
      "POST",
    );
    for (const u of [bob, carol])
      await u.client.request(`/rooms/${room.id}/join`, "POST", {
        token: invite.token,
      });
    const library = await alice.client.request("/libraries", "POST", {
      name: "retained private library",
    });
    const body = { password: f.password, confirmation: "DELETE" };
    async function withTableLock(table, run) {
      const marker = `account_race_${randomUUID().replaceAll("-", "")}`;
      const holder = f.sqlProcess(
        `SET application_name='${marker}'; BEGIN; LOCK TABLE ${table} IN SHARE MODE; SELECT pg_sleep(30); COMMIT;`,
      );
      await f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}' AND wait_event='PgSleep'`,
        "1",
      );
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        assert.equal(
          f.sql(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='${marker}'`,
          ),
          "t",
        );
        await holder.done.catch(() => {});
        await f.waitForSql(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}'`,
          "0",
        );
      };
      try {
        await run(release);
      } finally {
        await release();
      }
    }
    let preview = await alice.client.request("/users/me/deletion");
    assert.equal(preview.can_delete, false);
    assert.equal(preview.rooms[0].id, room.id);
    assert.equal(preview.libraries[0].id, library.id);
    assert.equal(
      (await alice.client.request("/users/me/deletion", "POST", body, 409))
        .error.code,
      "ACCOUNT_OWNERSHIP_REQUIRED",
    );
    assert.equal(
      (
        await alice.client.request(
          "/users/me/deletion",
          "POST",
          { ...body, password: "wrong-password" },
          401,
        )
      ).error.code,
      "INVALID_CREDENTIALS",
    );
    await alice.client.request(
      "/users/me/deletion",
      "POST",
      { ...body, confirmation: "no" },
      400,
    );
    await alice.client.request("/users/me/deletion", "POST", body, 403, {
      "x-csrf-token": "wrong",
    });
    const state = JSON.parse(
      f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`),
    );
    await alice.client.request(`/rooms/${room.id}/owner`, "POST", {
      owner_id: bob.identity.id,
      expected_revision: state.revision,
    });
    await alice.client.request(`/libraries/${library.id}/transfer`, "POST", {
      username: "bob",
      expected_revision: library.revision,
    });
    preview = await alice.client.request("/users/me/deletion");
    assert.equal(preview.can_delete, true);
    // A uses B's room; C's shared playback and history must survive A's exit.
    const media = sourceMedia(f, {
      kind: "local",
      root: f.root,
      resource: "owned-fixture",
    });
    f.sql(
      `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}',to_jsonb('${media}'::text)) WHERE room_id='${room.id}'`,
    );
    const sessionA = randomUUID(),
      sessionC = randomUUID(),
      chatA = randomUUID(),
      chatC = randomUUID();
    for (const [u, session] of [
      [alice, sessionA],
      [carol, sessionC],
    ]) {
      withPlaybackAdmission(
        f,
        { client: u.client, user: u.identity.id, room: room.id, session },
        `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES('${session}','${u.identity.id}','${room.id}','${media}',0,'${session}','{}',now()+interval '1 hour')`,
      );
    }
    f.sql(
      `INSERT INTO chat_messages(id,room_id,user_id,body) VALUES('${chatA}','${room.id}','${alice.identity.id}','A shared message'),('${chatC}','${room.id}','${carol.identity.id}','C shared message')`,
    );
    const platformAccount = randomUUID(),
      oauthAccount = randomUUID(),
      registrationBatch = randomUUID(),
      registrationInvite = randomUUID();
    f.sql(
      `INSERT INTO platform_accounts(id,user_id,provider,state,credential_encrypted) VALUES('${platformAccount}','${alice.identity.id}','bilibili','connected','owned-test-credential')`,
    );
    f.sql(
      `INSERT INTO platform_account_renewals(account_id,credential_revision,consent_login_hash,refresh_encrypted,state) VALUES('${platformAccount}',1,'${testLoginHash(f, alice.client)}','owned-refresh-secret','scheduled')`,
    );
    f.sql(
      `INSERT INTO platform_oauth_accounts(id,user_id,provider,state,token_encrypted,access_expires_at,refresh_expires_at,config_binding) VALUES('${oauthAccount}','${alice.identity.id}','douyin','connected','owned-oauth-token',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day','${"b".repeat(64)}')`,
    );
    f.sql(
      `INSERT INTO registration_invite_batches(id,created_by,count,valid_days) VALUES('${registrationBatch}','${alice.identity.id}',1,1)`,
    );
    f.sql(
      `INSERT INTO registration_invites(id,batch_id,code_hash,code_suffix,expires_at) VALUES('${registrationInvite}','${registrationBatch}','${"a".repeat(64)}','gone',clock_timestamp()+interval '1 day')`,
    );
    const oldCookie = secondDevice.cookie,
      oldCsrf = secondDevice.csrf;
    await alice.client.request("/users/me/deletion", "POST", body);
    assert.equal(
      f.sql(
        `SELECT count(*) FROM account_exits WHERE user_id='${alice.identity.id}'`,
      ),
      "1",
    );
    assert.equal(
      f.sql(
        `SELECT password_hash || ':' || admin FROM users WHERE id='${alice.identity.id}'`,
      ),
      "!:false",
    );
    assert.equal(
      f.sql(
        `SELECT display_name FROM user_profiles WHERE user_id='${alice.identity.id}'`,
      ),
      "已注销用户",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM sessions WHERE user_id='${alice.identity.id}'`,
      ),
      "0",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM room_members WHERE user_id='${alice.identity.id}'`,
      ),
      "0",
    );
    assert.equal(
      f.sql(`SELECT stopped FROM playback_sessions WHERE id='${sessionA}'`),
      "t",
    );
    assert.equal(
      f.sql(`SELECT stopped FROM playback_sessions WHERE id='${sessionC}'`),
      "f",
    );
    assert.equal(
      f.sql(
        `SELECT state || ':' || (credential_encrypted IS NULL) FROM platform_accounts WHERE user_id='${alice.identity.id}'`,
      ),
      "revoked:true",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM platform_account_renewals WHERE account_id='${platformAccount}'`,
      ),
      "0",
    );
    assert.equal(
      f.sql(
        `SELECT state || ':' || (token_encrypted IS NULL) || ':' || auto_renew FROM platform_oauth_accounts WHERE id='${oauthAccount}'`,
      ),
      "revoked:true:false",
    );
    assert.equal(
      f.sql(
        `SELECT revoked_at IS NOT NULL FROM registration_invites WHERE id='${registrationInvite}'`,
      ),
      "t",
    );
    assert.equal(
      f.sql(`SELECT owner_id FROM rooms WHERE id='${room.id}'`),
      bob.identity.id,
    );
    assert.equal(
      f.sql(`SELECT owner_id FROM private_libraries WHERE id='${library.id}'`),
      bob.identity.id,
    );
    const history = await bob.client.request(`/rooms/${room.id}/messages`);
    assert.equal(
      history.find((m) => m.id === chatA).display_name,
      "已注销用户",
    );
    assert.equal(history.find((m) => m.id === chatA).body, "A shared message");
    assert.equal(
      history.find((m) => m.id === chatC).display_name,
      "name-carol",
    );
    secondDevice.cookie = oldCookie;
    secondDevice.csrf = oldCsrf;
    await secondDevice.request("/auth/me", "GET", undefined, 401);
    await secondDevice.request(
      "/rooms",
      "POST",
      { name: "late creation" },
      401,
    );
    await f
      .client()
      .request(
        "/auth/login",
        "POST",
        { username: "alice", password: f.password },
        401,
      );
    // Old components/database writers cannot recreate sessions, memberships or
    // authority for an anonymous principal, even using its known UUID.
    for (const sql of [
      `INSERT INTO sessions VALUES('late-session','${alice.identity.id}','csrf',now()+interval '1 hour')`,
      `INSERT INTO room_members(room_id,user_id) VALUES('${room.id}','${alice.identity.id}')`,
      `UPDATE private_libraries SET owner_id='${alice.identity.id}' WHERE id='${library.id}'`,
      `UPDATE users SET admin=true WHERE id='${alice.identity.id}'`,
      `DELETE FROM user_profiles WHERE user_id='${alice.identity.id}'`,
      `INSERT INTO registration_invite_batches(id,created_by,count,valid_days) VALUES('${randomUUID()}','${alice.identity.id}',1,1)`,
      `INSERT INTO registration_invites(id,batch_id,code_hash,code_suffix,expires_at) VALUES('${randomUUID()}','${registrationBatch}','${"c".repeat(64)}','late',clock_timestamp()+interval '1 day')`,
      `UPDATE platform_oauth_accounts SET revision=revision+1,state='expired',token_encrypted='late-oauth-token' WHERE id='${oauthAccount}'`,
      `INSERT INTO platform_account_renewals(account_id,credential_revision,consent_login_hash,refresh_encrypted,state) VALUES('${platformAccount}',2,'${"d".repeat(64)}','late-refresh-secret','scheduled')`,
    ])
      assert.throws(() => f.sql(sql), /account_inactive/);
    await f.startServer();
    await secondDevice.request("/auth/me", "GET", undefined, 401);
    assert.equal(
      (await bob.client.request(`/rooms/${room.id}/messages`)).find(
        (m) => m.id === chatA,
      ).display_name,
      "已注销用户",
    );
    // A login admitted before a lock wait is insufficient when it expires while
    // waiting. No destructive cleanup may commit after that natural deadline.
    const tag = `exit-expiry-${randomUUID()}`;
    const lock = f.sqlProcess(
      `BEGIN; SELECT room_id FROM room_snapshots WHERE room_id='${room.id}' FOR UPDATE; SELECT pg_sleep(2) /* ${tag} */; COMMIT;`,
    );
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${tag}%'`,
      "1",
    );
    f.sql(
      `UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash='${testLoginHash(f, carol.client)}'`,
    );
    const expired = carol.client.request(
      "/users/me/deletion",
      "POST",
      body,
      401,
    );
    await lock.done;
    assert.equal((await expired).error.code, "SESSION_EXPIRED");
    assert.equal(
      f.sql(
        `SELECT count(*) FROM account_exits WHERE user_id='${carol.identity.id}'`,
      ),
      "0",
    );
    assert.equal(
      f.sql(`SELECT username FROM users WHERE id='${carol.identity.id}'`),
      "carol",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM room_members WHERE room_id='${room.id}' AND user_id='${carol.identity.id}'`,
      ),
      "1",
    );
    // The creation holds the principal lock before a room exists. Exit must
    // re-read ownership after that lock wait, rather than trust its earlier scan.
    const creating = await user("creating-before-exit");
    await withTableLock("room_creation_requests", async (release) => {
      const created = creating.client.request(
        "/rooms",
        "POST",
        { name: "created during exit" },
        200,
        { "Idempotency-Key": randomUUID() },
      );
      created.catch(() => {});
      await f.waitForSql(
        "SELECT count(*)>=1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO room_creation_requests%'",
        "t",
      );
      const exiting = creating.client.request(
        "/users/me/deletion",
        "POST",
        body,
        409,
      );
      exiting.catch(() => {});
      await f.waitForSql(
        "SELECT count(*)>=1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id,admin,password_hash FROM users%'",
        "t",
      );
      await release();
      const result = await created;
      assert.equal((await exiting).error.code, "ACCOUNT_OWNERSHIP_REQUIRED");
      assert.equal(
        f.sql(`SELECT owner_id FROM rooms WHERE id='${result.id}'`),
        creating.identity.id,
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM account_exits WHERE user_id='${creating.identity.id}'`,
        ),
        "0",
      );
    });

    // In the other ordering, a create authenticated before retirement must
    // re-check its exact session after the principal lock becomes available.
    const retiring = await user("exiting-before-create");
    await withTableLock("account_exits", async (release) => {
      const exiting = retiring.client.request(
        "/users/me/deletion",
        "POST",
        body,
      );
      exiting.catch(() => {});
      await f.waitForSql(
        "SELECT count(*)>=1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO account_exits%'",
        "t",
      );
      const key = randomUUID();
      const created = retiring.client.request(
        "/rooms",
        "POST",
        { name: "refused after exit" },
        401,
        { "Idempotency-Key": key },
      );
      created.catch(() => {});
      await f.waitForSql(
        "SELECT count(*)>=1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE id=$1 FOR SHARE%'",
        "t",
      );
      await release();
      await exiting;
      await created;
      assert.equal(
        f.sql(
          `SELECT count(*) FROM rooms WHERE owner_id='${retiring.identity.id}'`,
        ),
        "0",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM room_creation_requests WHERE user_id='${retiring.identity.id}'`,
        ),
        "0",
      );
    });
    assert.equal((await admin.request("/users/me/deletion")).last_admin, true);
    assert.equal(
      (await admin.request("/users/me/deletion", "POST", body, 409)).error.code,
      "ACCOUNT_LAST_ADMIN",
    );
    console.log(
      "PASS: ownership preflight and both creation/exit lock orders, password/CSRF/confirmation, all-device revocation, playback isolation, credential and registration retirement, anonymous shared history, old-writer rejection, restart and last-admin protection",
    );
  },
  { env: { PRIVATE_LIBRARIES_ENABLED: "true" } },
);
