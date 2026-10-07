import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) =>
  readFileSync(
    new URL(`../apps/server/src/${name}.rs`, import.meta.url),
    "utf8",
  );
const section = (text, start, end) => {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const until = text.indexOf(end, from + start.length);
  assert.notEqual(until, -1, `missing ${end}`);
  return text.slice(from, until);
};
const inOrder = (text, parts) => {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered ${part}`);
    previous = found;
  }
};

test("anonymous JSON admission keeps Origin and exact MIME validation before account work", () => {
  const helper = section(
    source("account_security"),
    "pub fn anonymous_json_request(",
    "#[derive(Clone)]",
  );
  inOrder(helper, [
    "origin(app, h)?",
    "header::CONTENT_TYPE",
    "str::trim",
    'Some("application/json")',
  ]);
  assert.ok(helper.includes("split(';')"));
  assert.match(
    helper,
    /StatusCode::UNSUPPORTED_MEDIA_TYPE,\s*"unsupported_media_type"/,
  );
  const registration = source("registration_auth");
  assert.equal(
    (registration.match(/anonymous_json_request\(&app, &h\)\?/g) ?? []).length,
    2,
  );
  inOrder(section(registration, "pub async fn register(", "let source ="), [
    "anonymous_json_request(&app, &h)?",
    "cookie(&h)",
  ]);
  inOrder(
    section(
      source("guests"),
      "pub async fn enter(",
      "account_security::guest_rate_limit(",
    ),
    ["anonymous_json_request(&app, &h)?", "cookie(&h)"],
  );
});

test("password verification callers retain their distinct worker-failure mapping", () => {
  const security = source("account_security");
  const login = section(
    security,
    "pub async fn password_verify(",
    "pub fn password_verification_worker(",
  );
  inOrder(login, [
    "password_verification_worker(security, stored, password)?",
    ".await",
    'StatusCode::INTERNAL_SERVER_ERROR, "hash_failed"',
  ]);
  const worker = section(
    security,
    "pub fn password_verification_worker(",
    "#[cfg(test)]",
  );
  inOrder(worker, [
    "try_acquire_owned()",
    "limited(1)",
    "spawn_blocking(move ||",
    "let _permit = permit",
    "PasswordHash::new",
    "verify_password",
  ]);
  const retirement = source("account_exit");
  inOrder(retirement, [
    "let expected = stored.clone()",
    "password_verification_worker(",
    ".await",
    ".unwrap_or(false)",
    'StatusCode::UNAUTHORIZED, "invalid_credentials"',
    "let mut tx = app.db.begin()",
    'current.get::<String, _>("password_hash") != expected',
  ]);
});

test("chat insertion and replay share only their final login check and commit", () => {
  const chat = section(
    source("rooms"),
    "async fn persist_chat(",
    "pub async fn socket(",
  );
  assert.equal(
    (chat.match(/SELECT playback_login_allowed\(\$1,\$2\)/g) ?? []).length,
    1,
  );
  assert.equal((chat.match(/tx\.commit\(\)/g) ?? []).length, 1);
  inOrder(chat, [
    "room_lifecycle::lock_active",
    "FOR KEY SHARE",
    "lock_login",
    "check_mute",
    "ON CONFLICT (room_id,user_id,client_message_id) DO NOTHING RETURNING",
    "if let Some(row) = inserted",
    "SELECT id,body,body_digest",
    'return Err("invalid_request")',
    'existing.get("deleted")',
    "SELECT playback_login_allowed($1,$2)",
    'return Err("session_expired")',
    "tx.commit()",
    "Ok(result)",
  ]);
});

test("chat history branches retain their filters, limits and opposite inner/outer order", () => {
  const rooms = source("rooms");
  const projection = section(
    rooms,
    "fn chat_message_select(",
    "pub async fn messages(",
  );
  assert.match(projection, /if include_created_at/);
  assert.match(projection, /"c\.created_at,"/);
  for (const part of [
    "CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END AS body",
    "c.deleted_at IS NOT NULL AS deleted",
    "COALESCE(g.display_name,p.display_name,u.username)",
    "LEFT JOIN guest_principals",
    "LEFT JOIN user_profiles",
    "LEFT JOIN user_avatars",
  ])
    assert.ok(projection.includes(part), part);
  const history = section(
    rooms,
    "pub async fn messages(",
    "async fn persist_chat(",
  );
  assert.ok(history.includes("c.id=ANY($2) ORDER BY c.created_at,c.id"));
  assert.ok(
    history.includes(
      "NOT EXISTS(SELECT 1 FROM chat_messages WHERE id=$2 AND room_id=$1) OR",
    ),
  );
  assert.ok(history.includes("ORDER BY c.created_at,c.id LIMIT 100"));
  assert.ok(
    history.includes(
      "ORDER BY c.created_at DESC,c.id DESC LIMIT 100) history ORDER BY created_at,id",
    ),
  );
  assert.equal(
    (history.match(/chat_message_select\(false\)/g) ?? []).length,
    2,
  );
  assert.equal((history.match(/chat_message_select\(true\)/g) ?? []).length, 1);
});

test("presence conversion preserves checked acquisition and publish timing", () => {
  const presence = source("room_presence");
  const checked = section(presence, "async fn snapshot_for(", "#[cfg(test)]");
  inOrder(checked, [
    "checked_snapshot(&checked, &authorized, Instant::now())",
    "self.publish(&mut state)",
    "protocol_snapshot(self.room, snapshot)",
  ]);
  const broadcast = section(presence, "fn publish(", "fn fence(");
  inOrder(broadcast, [
    "state.leases.snapshot(Instant::now())",
    "state.sessions.retain",
    "protocol_snapshot(self.room, snapshot)",
    "self.bus.send_presence",
  ]);
});

test("permission updates discard epochs and commit authority before notification; kick remains separate", () => {
  const permissions = source("room_permissions");
  assert.equal(
    (
      permissions.match(
        /finish_permissions_change\(&app, tx, authority, room, target\)/g,
      ) ?? []
    ).length,
    2,
  );
  const finish = section(
    permissions,
    "async fn finish_permissions_change(",
    "pub async fn kick(",
  );
  inOrder(finish, [
    "DELETE FROM control_epochs",
    "authority.commit(tx).await?",
    "broadcast_timeline(",
    '"ROOM_PERMISSIONS_CHANGED"',
  ]);
  const kick = permissions.slice(permissions.indexOf("pub async fn kick("));
  assert.ok(kick.includes("commit_controller(tx, &h).await?"));
  assert.ok(!kick.includes("finish_permissions_change("));
});
