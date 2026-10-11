// Pure fixture assertions. Importing this module never creates a process/socket.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseAccountSnapshot, assertNewImportRateWindow} from './short-platform-account-snapshot.mjs';
export {parseAccountSnapshot};
export const requiredChecks = Object.freeze([
  'startup_opt_in_and_private_ten_field_dto',
  'exact_login_guest_csrf_json_precedence',
  'netscape_caps_consent_revision_rate_and_cipher',
  'status_exact_login_expiry_account_wait',
  'mutations_exact_login_expiry_account_wait',
  'mutations_exact_login_expiry_final_update_wait',
  'credential_expiry_replacement_tombstone_overflow',
  'precommit_commit_reject_and_owned_cleanup',
]);
export const SQL = Object.freeze({
  status: "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='youtube' FOR UPDATE",
  account: 'SELECT id FROM platform_accounts WHERE user_id=$1 AND provider=$2 FOR UPDATE',
  import: "UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=to_timestamp($8::double precision/1000),revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND provider=$6 AND playback_login_allowed($5,$7)",
  unlink: "UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider='youtube' AND playback_login_allowed($4,$5)",
});
export const notCovered = Object.freeze([
  'unknown_commit_disconnect_outcome',
  'forced_system_time_or_encryption_failure_and_cipher_call_counts',
  'physical_media_drain_browser_provider_network_and_p08_p09',
  'get_body_limit_without_json_extraction',
  'readiness_health_body_eof_in_shared_server_infrastructure',
  'all_parser_combinations_principal_deactivation_races_and_lock_topologies',
]);
// Shared cleanup treats primaryError by truthiness. A caught rejection can be
// any JavaScript value, including undefined, so preserve it in a truthy wrapper.
export function caseFailure(reason) {
  return new AggregateError([reason], 'youtube_case_failed');
}
export function expiryFailure(action, boundary) {
  assert.ok(['status', 'import', 'unlink'].includes(action));
  assert.ok(['account', 'final'].includes(boundary));
  // YouTube unlink has no new pre-UPDATE live guard: the SQL predicate wins.
  return action === 'unlink' && boundary === 'account'
    ? {status: 409, code: 'PLATFORM_ACCOUNT_CHANGED'}
    : {status: 401, code: 'SESSION_EXPIRED'};
}
// An inner gate cannot witness its own future process exit or independently
// bound shutdown. This declaration remains pending until the outer runner joins
// an actual bounded-supervisor receipt; a finite inner pass is not qualification.
export const outerQualification = Object.freeze({
  result: 'requires_outer_receipt',
  requirements: Object.freeze([
    'outer_runner_exit_code_0_and_signal_null',
    'bounded_external_supervisor_without_escalation',
    'complete_outer_receipt_bound_to_this_inner_report_and_inputs',
    'all_owned_server_postgres_holder_processes_and_ports_closed',
  ]),
  shared_shutdown: 'postgres_and_log_stream_waits_are_not_intrinsically_bounded',
});
export function assertOwnedCleanExit(receipt) {
  assert.equal(receipt.completed, true);
  assert.equal(receipt.server_port_closed, true);
  assert.ok(Array.isArray(receipt.servers));
  // A failed startup may have zero or one Server record. Validate every actual
  // record; only the successful two-launch fixture is allowed to require two.
  for (const server of receipt.servers) {
    assert.ok(server.closed_at, 'Server close event is required');
    assert.equal(server.pid_absent, true);
    assert.equal(server.exit_code, 0, 'Owned Server must exit cleanly');
    assert.equal(server.signal, null, 'Signal-terminated Server is unqualified');
  }
  const pg = receipt.postgres;
  assert.equal(pg.kind, 'native');
  assert.equal(pg.stopped, true);
  assert.equal(pg.process_close_observed, true);
  assert.equal(pg.pid_absent, true);
  assert.equal(pg.pg_ctl_status, 3);
  assert.equal(pg.port_closed, true);
  assert.equal(pg.exit_code, 0, 'Owned PostgreSQL must exit cleanly');
  assert.equal(pg.signal, null, 'Signal-terminated PostgreSQL is unqualified');
}
export const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export function uuid(value) {
  assert.match(value, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  return quote(value);
}
export function exactLoginHash(f, client) {
  assert.ok(f?.id && typeof f.sql === 'function');
  assert.equal(client?.fixture, f);
  const match = /^rainsync_session=([0-9a-f]{64})$/.exec(client.cookie);
  assert.ok(match, 'Explicit fixture client session required');
  return createHash('sha256').update(match[1]).digest('hex');
}
export function cookieLine(name, expires = 0, value = 'owned-youtube-synthetic-session-only') {
  return `.youtube.com\tTRUE\t/\tTRUE\t${expires}\t${name}\t${value}\n`;
}
export function cookieFile(expires = 0) {
  return '# Netscape HTTP Cookie File\n' + cookieLine('LOGIN_INFO', expires) + cookieLine('SAPISID', expires);
}
export function assertDto(value, {available = true, state = 'revoked', revision = null, id = null, expiry = null} = {}) {
  assert.deepEqual(value, {id, provider: 'youtube', revision, state,
    credential_expires_at: expiry, login_method: 'netscape_cookie_import',
    qr_available: false, verification: state === 'connected' ? 'unverified' : 'none',
    account_import_available: available,
    availability_reason: available ? null : 'server_opt_in_required'});
}
export function assertChecks(checks) {
  assert.deepEqual(checks, requiredChecks.map(name => ({name, result: 'passed'})),
    'All eight frozen checks must complete once, in order');
}
export function assertSafeText(text, secrets) {
  for (const secret of secrets) if (secret) assert.equal(text.includes(secret), false, 'Secret in public HTTP response or Server log');
}
export function assertYoutubeRateIncrement(beforeRaw, afterRaw, user, clocks) {
  const before = parseAccountSnapshot(beforeRaw), after = parseAccountSnapshot(afterRaw);
  const scope = 'youtube-cookie-import';
  const key = createHash('sha256').update(`account-rate:${scope}:${user}`).digest('hex');
  const order = rows => {
    const keys = rows.map(r => {assert.equal(typeof r.scope, 'string'); assert.equal(typeof r.key_hash, 'string'); return JSON.stringify([r.scope, r.key_hash]);});
    assert.equal(new Set(keys).size, keys.length, 'Duplicate rate primary key');
    return rows.map((r, i) => [keys[i], r]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, r]) => r);
  };
  before.account_rate_limits = order(before.account_rate_limits);
  after.account_rate_limits = order(after.account_rate_limits);
  const match = r => r.scope === scope && r.key_hash === key;
  const old = before.account_rate_limits.find(match), now = after.account_rate_limits.find(match);
  assert.ok(now, 'Committed YouTube import limiter required');
  assert.deepEqual(Object.keys(now).sort(), ['attempts', 'expires_at', 'key_hash', 'scope', 'window_started']);
  assert.equal(typeof now.attempts, 'bigint');
  if (old) {
    assert.equal(typeof old.attempts, 'bigint');
    assert.ok(old.attempts < 11n, 'Use a non-saturated bucket for increment evidence');
    old.attempts += 1n;
  } else {
    assert.equal(now.attempts, 1n);
    assertNewImportRateWindow(now, clocks);
    before.account_rate_limits.push(now);
    before.account_rate_limits = order(before.account_rate_limits);
  }
  assert.deepEqual(after, before);
}
