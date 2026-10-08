import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const root=new URL('../',import.meta.url),read=(p)=>readFileSync(new URL(p,root),'utf8');
const sql=read('migrations/0066_platform_account_renewal.sql'),oauth=read('apps/server/src/platform_accounts/oauth.rs'),renewal=read('apps/server/src/platform_accounts/renewal.rs'),runner=read('apps/server/src/platform_accounts/maintenance.rs');
test('OAuth API token custody is separate from every playback Cookie/account grant',()=>{assert.match(sql,/CREATE TABLE platform_oauth_accounts/);assert.match(sql,/CREATE TABLE platform_oauth_requests/);assert.doesNotMatch(sql,/ALTER TABLE platform_accounts ADD COLUMN.*token/);assert.match(oauth,/"playback_session":false|"playback_session": false/);assert.doesNotMatch(oauth,/UPDATE platform_accounts SET/);assert.match(sql,/exchange_started boolean NOT NULL DEFAULT false/);assert.match(sql,/platform_oauth_request_identity_immutable/);assert.match(sql,/platform_oauth_request_terminal_immutable/);});
test('Bili refresh starts only with a fresh explicit QR consent and exact revision',()=>{assert.match(sql,/ADD COLUMN consent_to_renew boolean NOT NULL DEFAULT false/);assert.match(sql,/credential_revision bigint NOT NULL CHECK/);assert.match(sql,/DELETE FROM platform_account_renewals WHERE account_id=OLD.id/);assert.match(renewal,/new_consented_qr_login/);assert.match(renewal,/consent_login_hash/);assert.match(renewal,/operation_nonce/);assert.match(renewal,/if !consent/);});
test('shutdown stops admission, awaits the operation, and positively drains without aborting token rotation',()=>{assert.match(runner,/Ordering::Release/);assert.match(runner,/task\.await/);assert.doesNotMatch(runner,/\.abort\(/);assert.match(runner,/statement_timeout='5s'/);assert.match(runner,/timeout\(Duration::from_secs\(5\), app\.db\.begin\(\)\)/);assert.match(runner,/refresh_due_inner/);assert.match(runner,/platform_renewal_drain_failed/);});
test('fixed provider transports omit challenge, fingerprint, and arbitrary target plumbing',()=>{const bili=read('crates/providers/src/platform/bilibili/renewal.rs'),http=read('crates/providers/src/platform/http/renewal_http.rs'),oauthHttp=read('crates/providers/src/platform/http/oauth_http.rs');assert.match(bili,/Oaep::new::<Sha256>/);assert.doesNotMatch(bili,/getbuvid|buvid3=|captcha.*send|msToken/);assert.match(http,/pinned_client/);assert.match(http,/is_redirection/);assert.match(oauthHttp,/pinned_client/);assert.doesNotMatch(oauthHttp,/header\(header::COOKIE/);});

test('web callback keeps Strict cookies and uses authenticated CSRF claim behind callback-specific CSP',()=>{const main=read('apps/server/src/main.rs'),routes=read('apps/server/src/bootstrap/routes.rs'),caddy=read('deploy/Caddyfile');assert.match(main,/SameSite=Strict/);assert.match(routes,/oauth\/claim/);assert.match(oauth,/history\.replaceState/);assert.match(oauth,/x-csrf-token/);assert.match(oauth,/pub async fn claim/);assert.match(oauth,/auth\(&app, &headers, true\)/);assert.match(caddy,/@standard_security/);assert.match(caddy,/not path \/api\/v1\/platform-accounts\/douyin\/oauth\/callback \/api\/v1\/platform-accounts\/tiktok\/oauth\/callback/);});
test('rotation owners reconcile issued results and never stop a whole runner for one account failure',()=>{const exchanges=read('apps/server/src/platform_accounts/exchanges.rs');assert.match(exchanges,/catch_unwind/);assert.match(exchanges,/unconfirmed/);assert.match(oauth,/exchange_owned/);assert.match(oauth,/persist_exchange/);assert.match(oauth,/publish_refresh/);assert.match(oauth,/actual\.storage_value\(\) == expected\.storage_value\(\)/);assert.match(renewal,/publish_bili/);assert.match(renewal,/actual_cookie\.expose_for_storage/);assert.match(runner,/let bili = renewal::refresh_due_inner/);assert.match(runner,/platform_renewal_pass_failed/);assert.doesNotMatch(runner,/refresh_due_inner\([^;]+\.await\?/);assert.match(runner,/platform_renewal_commit_unknown/);});
test('expired consent cleanup and nav owner checks are exact, while startup checks new encrypted columns',()=>{
 assert.match(oauth,/WHERE id=\$1 AND user_id=\$2 AND provider=\$3 AND revision=\$4 AND consent_login_hash=\$5 AND auto_renew AND renewal_state='scheduled'/);
 assert.match(oauth,/authority_expired/);
 assert.equal((renewal.match(/\.check_login\(/g)||[]).length,2);
 const key=read('apps/server/src/source_key_check.rs');
 // Production consumes this fixed inventory directly. Check its actual table /
 // column pairs and predicates, rather than expecting copied names in Rust.
 assert.match(key,/serde_json::from_str\(include_str!\("source-key-inventory\.json"\)\)/);
 assert.match(key,/SELECT to_regclass\(\$1\) IS NOT NULL/);
 assert.match(key,/SELECT \{column\} FROM \{table\} WHERE \{predicate\}/);
 const inventory=JSON.parse(read('apps/server/src/source-key-inventory.json'));
 assert.ok(Array.isArray(inventory));
 for(const [table,column] of [
  ['platform_oauth_accounts','token_encrypted'],
  ['platform_oauth_requests','secret_encrypted'],
  ['platform_account_renewals','refresh_encrypted'],
 ]) {
  const fields=inventory.filter(field=>field.table===table&&field.column===column);
  assert.equal(fields.length,1,`exact startup inventory for ${table}.${column}`);
  assert.equal(fields[0].predicate,`${column} IS NOT NULL`);
 }
});
test('OAuth refresh rechecks live originating login after claim and before rotating admission',()=>{
 const refresh=oauth.slice(oauth.indexOf('async fn refresh_one('),oauth.indexOf('async fn retire_refresh('));
 const claim=refresh.indexOf("SET renewal_state='running'");
 const fence=refresh.indexOf('guard_login_live(&mut tx, user, &login)',claim);
 const commit=refresh.indexOf('super::maintenance::commit(tx)',claim);
 const send=refresh.indexOf('.send(',commit);
 assert.ok(claim>=0&&fence>claim&&commit>fence&&send>commit,'lock-wait expiry must be fenced before OAuth refresh');
});
test('Bili exact-result reconciliation rechecks live login before positive confirmation admission',()=>{
 const publish=renewal.slice(renewal.indexOf('async fn publish_bili('),renewal.indexOf('async fn complete_bili('));
 const reconciliation=publish.slice(publish.indexOf('if current_scope == next'),publish.indexOf('if current_scope != old'));
 const fence=reconciliation.indexOf('guard_login_live(&mut tx, old.user_id, login)');
 const commit=reconciliation.indexOf('super::maintenance::commit(tx)');
 const ready=reconciliation.indexOf('return Ok(true)');
 assert.ok(fence>=0&&commit>fence&&ready>commit,'reconciled custody alone must not authorize consuming confirmation after login expiry');
});
