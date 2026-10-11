// Source seam guards only. Real PostgreSQL waits, trigger rollback, and natural
// expiry still require the identical native fixture on original and candidate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = (path) => readFileSync(new URL(`../apps/server/src/${path}.rs`, import.meta.url), "utf8");
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
const queryStrings = (text) => [...text.matchAll(/sqlx::query(?:_scalar)?\(\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
const core = source("room_guest_access_operations");
const get = section(core, "pub(crate) async fn access(", "pub(crate) async fn set_access(");
const put = section(core, "pub(crate) async fn set_access(", "#[cfg(test)]");

test("guest policy adapters retain extraction and private response ownership", () => {
  const adapters = section(source("guests"), "pub use rooms::guest_access_operations::Access;", "/// Room-owned cleanup");
  assert.match(source("rooms"), /#\[path = "room_guest_access_operations\.rs"\]\s*pub\(crate\) mod guest_access_operations;/);
  assert.match(source("bootstrap/routes"), /"\/api\/v1\/rooms\/\{id\}\/guest-access",\s*get\(guests::access\)\.put\(guests::set_access\)/);
  assert.match(adapters, /Json\(body\): Json<Access>/);
  inOrder(adapters, [
    "rooms::guest_access_operations::access(app.identity_context(), &h, room).await?",
    "responses::private_json(StatusCode::OK, value)",
    "rooms::guest_access_operations::set_access(app.identity_context(), &h, room, body).await?",
    "responses::private_json(StatusCode::OK, value)",
  ]);
  assert.doesNotMatch(adapters, /sqlx::|\.begin\(|\.commit\(/);
  assert.doesNotMatch(core, /\b(?:App|State|Response|Json)\b|responses::|broadcast|\.rooms/);
  assert.match(core, /#\[serde\(deny_unknown_fields\)\]\s*pub struct Access \{\s*enabled: bool,\s*\}/);
  assert.equal((core.match(/context: RequestContext<'_>/g) ?? []).length, 2);
});

test("guest policy GET preserves entry-only authentication and all three ordered reads", () => {
  assert.deepEqual(queryStrings(get), [
    "SELECT owner_id FROM rooms WHERE id=$1",
    "SELECT EXISTS(SELECT 1 FROM room_guest_access WHERE room_id=$1 AND enabled)",
    "SELECT EXISTS(SELECT 1 FROM admin_settings WHERE singleton AND COALESCE(guests_enabled,false))",
  ]);
  inOrder(get, [
    "request::authenticate(context, h, false, false).await?",
    "SELECT owner_id FROM rooms WHERE id=$1",
    "if owner.is_none()",
    'err(StatusCode::NOT_FOUND, "not_found")',
    "if !user.admin && owner != Some(user.id)",
    'err(StatusCode::FORBIDDEN, "forbidden")',
    "FROM room_guest_access",
    "FROM admin_settings",
    '"session_ttl_seconds":7200,"invite_required":true',
  ]);
  assert.equal((get.match(/request::authenticate/g) ?? []).length, 1);
  assert.doesNotMatch(get, /\.begin\(|\.commit\(|FOR (?:UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)|request::member|lock_active|owner_authority/);
});

test("guest policy PUT retains one authority transaction and the exact trigger-producing write", () => {
  assert.deepEqual(queryStrings(put), [
    "INSERT INTO room_guest_access(room_id,enabled,updated_by) VALUES($1,$2,$3) ON CONFLICT(room_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()",
  ]);
  inOrder(put, [
    "crate::rooms::permission_operations::owner_authority(context, h, room).await?",
    "INSERT INTO room_guest_access",
    ".bind(room).bind(body.enabled).bind(actor).execute(&mut *tx).await?",
    "authority.commit(tx).await?",
    'Ok(json!({"enabled":body.enabled}))',
  ]);
  assert.equal((put.match(/owner_authority\(/g) ?? []).length, 1);
  assert.equal((put.match(/authority\.commit\(/g) ?? []).length, 1);
  assert.doesNotMatch(put, /\.begin\(|request::authenticate|DELETE FROM|UPDATE guest_principals|broadcast/);
});

test("shared guest policy authority keeps room-first locks and final exact-login expiry", () => {
  const authority = section(source("room_permission_operations"), "pub(crate) async fn owner_authority", "pub(crate) async fn permissions(");
  inOrder(authority, [
    "request::authenticate(context, h, true, false)",
    "db.begin().await?",
    "SELECT owner_id FROM rooms WHERE id=$1 FOR NO KEY UPDATE",
    "persistence::room_lifecycle::lock_active",
    "SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE",
    "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    "management_authority::Authority::admit(",
    "Ok((tx, authority, user.id))",
  ]);
  const management = source("room_management_authority");
  const commit = section(management, "pub(crate) async fn commit(", "fn require_live_login(");
  inOrder(commit, [
    "token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()",
    ".bind(&self.login_hash)",
    ".bind(self.user_id)",
    "require_live_login(valid)?",
    "tx.commit().await?",
  ]);
});

test("native selected-row snapshot keeps more than 50 keys with two arguments per object", () => {
  const fixture = readFileSync(new URL("./room-guest-access-authority-native.mjs", import.meta.url), "utf8");
  // Evaluate only the exact pure SQL-generation statements, never fixture
  // imports, database calls, nativeOwnerGate, or an independently copied builder.
  const builder = section(fixture, "const objectSql=", ",raw=f.sql(sql)");
  const keys = Array.from({ length: 64 }, (_, i) => `selected_table_${i}`);
  const values = keys.map((key) => `COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM "${key}" x WHERE room_id='00000000-0000-0000-0000-000000000000'),'[]'::jsonb)`);
  const pairs = keys.map((key, i) => `'${key}',${values[i]}`);
  const sql = runInNewContext(`${builder}; sql`, { pairs }, { timeout: 1000 });
  assert.ok(sql.startsWith("SELECT (") && sql.endsWith(")::text"));
  assert.ok(!sql.includes(";"), "snapshot remains one SQL statement");
  const objects = sql.slice("SELECT (".length, -")::text".length).split(" || ");
  assert.equal(objects.length, keys.length, "no selected table is dropped or truncated");

  // Count actual top-level arguments, allowing nested aggregate/subquery calls
  // and quoted commas inside SQL literals or identifiers.
  const argumentsOf = (call) => {
    assert.ok(call.startsWith("jsonb_build_object(") && call.endsWith(")"));
    const args = call.slice("jsonb_build_object(".length, -1);
    const result = [];
    let start = 0, depth = 0, quote;
    for (let i = 0; i < args.length; i++) {
      const c = args[i];
      if (quote) {
        if (c === quote) {
          if (args[i + 1] === quote) i++;
          else quote = undefined;
        }
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        result.push(args.slice(start, i));
        start = i + 1;
      }
    }
    assert.equal(depth, 0);
    assert.equal(quote, undefined);
    result.push(args.slice(start));
    return result;
  };
  objects.forEach((object, i) => {
    const args = argumentsOf(object);
    assert.equal(args.length, 2, "each object constructor is below the PostgreSQL argument limit");
    assert.equal(args[0], `'${keys[i]}'`);
    assert.equal(args[1], values[i], "complete WHERE and row ordering stay unchanged");
  });
});
