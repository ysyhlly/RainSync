// AUTHORIZATION REQUIRED: native owned PostgreSQL and loopback HTTP, never a pure test.
// No provider requests, media, real credentials, browser, P08, or P09 are exercised.
import assert from 'node:assert/strict';
import {randomUUID, createDecipheriv} from 'node:crypto';
import {readFile, writeFile, readdir, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {youtubeNativeOwnerGate as nativeOwnerGate} from './fixtures/youtube-platform-account-gate.mjs';
import {sha256} from '../scripts/native-owner-binding.mjs';
import {trackResponseBody, cleanupShortAccountCase, privateFailureDetails} from './fixtures/short-platform-account-response.mjs';
import {ownedYoutubeHolder} from './fixtures/youtube-platform-account-holder.mjs';
import {requiredChecks, notCovered, SQL, caseFailure, expiryFailure, quote, uuid, exactLoginHash, cookieLine, cookieFile,
  parseAccountSnapshot, assertDto, assertChecks, assertSafeText, assertYoutubeRateIncrement} from './fixtures/youtube-platform-account-contract.mjs';

assert.equal(process.argv.length, 2);
assert.notEqual(process.platform, 'win32', 'The existing trusted-executable configuration supports POSIX only');
assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT, '1', 'Require error-sticky owned fixture cleanup');
for (const name of ['RAINSYNC_YTDLP_BIN', 'RAINSYNC_YTDLP_DENO_BIN', 'RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES', 'RAINSYNC_OTHER_LIVE_ENABLED'])
  assert.equal(process.env[name], undefined, 'Reject inherited provider/extractor configuration');
process.umask(0o077);
const route = action => `/platform-accounts/youtube${action === 'import' ? '/credential' : ''}`;
const method = action => action === 'status' ? 'GET' : action === 'import' ? 'PUT' : 'DELETE';
const payload = (revision = null, cookie = cookieFile()) => ({cookie_file: cookie, consent_to_store: true, expected_revision: revision});
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;


await nativeOwnerGate('youtube-platform-account-authority-native', async (f, {report, check, signal, binding}) => {
  report.scope = 'Eight finite YouTube account groups. Real source/binary-bound Server, owned native PostgreSQL, loopback HTTP, synthetic Netscape cookies. No upstream validity or playback claim.';
  report.not_covered = [...notCovered];
  report.expected_groups = [...requiredChecks];
  report.groups = [];
  let serial = 0;
  const secrets = new Set([f.env.SOURCE_ENCRYPTION_KEY, 'owned-youtube-synthetic-session-only']);
  const sentinel = resolve(f.root, 'owned-extractor-placeholder.sh');
  const invoked = resolve(f.root, 'extractor-invocation.private.txt');
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // Config validates this existing absolute file and its mode without executing it.
  // A regression invoking it produces a private marker and exits; it cannot resolve media.
  const sentinelBytes = `#!/bin/sh\nprintf '%s\\n' unexpected-invocation >> ${shellQuote(invoked)}\nexit 97\n`;
  await writeFile(sentinel, sentinelBytes, {mode: 0o700, flag: 'wx'});
  assert.equal((await stat(sentinel)).mode & 0o777, 0o700);
  report.extractor_placeholder = {sha256: sha256(sentinelBytes), mode: '0700', invocation_observed: false};
  async function noExtractor() {
    try { await stat(invoked); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    report.extractor_placeholder.invocation_observed = true;
    throw Error('youtube_extractor_unexpected_invocation');
  }
  async function privateFile(label, suffix, bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const path = resolve(f.root, `${label}.${suffix}`);
    await writeFile(path, buffer, {flag: 'wx', mode: 0o600});
    return {path, bytes: buffer.length, sha256: sha256(buffer)};
  }
  async function receipt(label, suffix, value) {
    const item = await privateFile(label, suffix, JSON.stringify(value) + '\n');
    report.active?.receipts.push(item);
    return item;
  }
  async function bounded(work, ms = 10000) {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('youtube_fixture_deadline')), ms);})]); }
    finally { clearTimeout(timer); }
  }
  async function waitSql(sql) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {signal.throwIfAborted(); if (f.sql(sql) === 't') return; await new Promise(done => setTimeout(done, 25));}
    throw Error('youtube_sql_witness_deadline');
  }
  async function http(label, pending, status, code, body = trackResponseBody(pending)) {
    const response = await bounded(pending);
    const text = await bounded(body.read());
    assert.equal(body.bodyDrained, true);
    await receipt(label, 'http.private.json', {status: response.status, headers: [...response.headers], body_base64: Buffer.from(text).toString('base64'), body_drained: true});
    assertSafeText(text, secrets);
    const value = JSON.parse(text);
    assert.equal(response.status, status);
    if (code) assert.equal(value?.error?.code, code);
    if (status === 200) {
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(typeof value.account_import_available, 'boolean');
      assert.ok(['connected', 'revoked', 'expired'].includes(value.state));
      if (value.id !== null) uuid(value.id);
      if (value.revision !== null) assert.match(value.revision, /^[1-9][0-9]*$/);
      assert.ok(value.credential_expires_at === null || Number.isSafeInteger(value.credential_expires_at));
      assertDto(value, {available: value.account_import_available, state: value.state,
        revision: value.revision, id: value.id, expiry: value.credential_expires_at});
    }
    await noExtractor();
    return {value, response};
  }
  async function group(name, run) {
    assert.equal(name, requiredChecks[report.groups.length]);
    const active = {name, phase: 'setup', receipts: [], result: 'running'};
    report.active = active;
    report.groups.push(active);
    try {await run(); await noExtractor(); active.result = 'passed'; check(name);}
    catch (error) {
      active.result = 'failed'; active.failure = {code: 'youtube_group_failed', phase: active.phase};
      try {active.first_failure = await receipt(name, 'first-failure.private.json', privateFailureDetails(error));}
      catch (evidenceError) {throw new AggregateError([error, evidenceError], 'youtube_first_failure_and_evidence_failed');}
      throw Error('youtube_group_failed');
    } finally {delete report.active;}
  }
  const admin = f.client();
  async function person() {
    const username = `youtube-account-${++serial}`;
    await admin.request('/users', 'POST', {username, password: f.password});
    const client = f.client(), live = f.client();
    const id = (await client.login(username)).id;
    await live.login(username);
    assert.notEqual(exactLoginHash(f, client), exactLoginHash(f, live));
    return {id, client, live};
  }
  async function snapshot(s, label) {
    const filters = {users: `id=${uuid(s.id)}`, sessions: `user_id=${uuid(s.id)}`, user_profiles: `user_id=${uuid(s.id)}`,
      platform_accounts: `user_id=${uuid(s.id)}`, platform_login_requests: `user_id=${uuid(s.id)}`, account_rate_limits: 'true'};
    const pairs = Object.entries(filters).map(([table, where]) => `${quote(table)},COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM ${table} x WHERE ${where}),'[]'::jsonb)`);
    const captured = f.sql(`SELECT jsonb_build_object('rows',jsonb_build_object(${pairs.join(',')})::text,'clock',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text`);
    const capture = JSON.parse(captured);
    assert.equal(typeof capture.rows, 'string'); assert.match(capture.clock, ISO_MICROS);
    report.active.receipts.push(await privateFile(label, 'rows.private.json', captured + '\n'));
    return {raw: capture.rows, value: parseAccountSnapshot(capture.rows), databaseClock: capture.clock};
  }
  const account = rows => rows.value.platform_accounts.find(row => row.provider === 'youtube');
  function rateChange(before, after, s) {assertYoutubeRateIncrement(before.raw, after.raw, s.id, {before: before.databaseClock, after: after.databaseClock});}
  function decrypt(row) {
    secrets.add(row.credential_encrypted);
    const bytes = Buffer.from(row.credential_encrypted, 'base64');
    assert.ok(bytes.length > 28);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, 'base64'), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]));
  }
  function envelope(s, row, cookie, revision = '2') {
    assert.deepEqual(decrypt(row), {version: 1, user_id: s.id, provider: 'youtube', account_id: row.id, revision, cookies: cookie});
  }
  async function imported(s, label, cookie = cookieFile(), expiry = null) {
    const response = await http(label, s.client.raw(route('import'), {method: 'PUT', body: payload(null, cookie)}), 200);
    const row = account(await snapshot(s, label + '.stored'));
    assertDto(response.value, {state: 'connected', revision: '2', id: row.id, expiry});
    envelope(s, row, cookie);
    return row;
  }
  async function trigger(label, row, {deferred = false, fail = false, skip = false, lock = false} = {}) {
    const suffix = randomUUID().replaceAll('-', '');
    const name = `zz_youtube_${suffix}`, fn = `youtube_${suffix}`, sequence = `youtube_witness_${suffix}`;
    const marker = `owned_youtube_rejection_${suffix}`;
    const action = fail ? `PERFORM nextval('${sequence}'); RAISE EXCEPTION '${marker}';`
      : skip ? 'RETURN NULL;' : lock ? 'PERFORM pg_advisory_xact_lock(284617391);' : '';
    const ddl = `${fail ? `CREATE SEQUENCE ${sequence};` : ''} CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${uuid(row.id)} THEN ${action} END IF; RETURN NEW; END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER ${name} ${deferred ? 'AFTER' : 'BEFORE'} UPDATE ON platform_accounts ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION ${fn}()`;
    await receipt(label, 'trigger-ddl.private.json', {ddl, deferred, fail, skip, lock});
    f.sql(ddl);
    return {marker, sequence, async drop() {f.sql(`DROP TRIGGER ${name} ON platform_accounts; DROP FUNCTION ${fn}(); ${fail ? `DROP SEQUENCE ${sequence};` : ''}`); await receipt(label, 'trigger-drop.private.json', {dropped: true});}};
  }
  async function witnessWait(h, exact, label, isSettled) {
    const where = `a.wait_event_type='Lock' AND a.query=${quote(exact)} AND ${h.backend}=ANY(pg_blocking_pids(a.pid)) AND EXISTS(SELECT 1 FROM pg_stat_activity held WHERE held.pid=${h.backend} AND held.application_name=${quote(h.marker)})`;
    const pids = () => JSON.parse(f.sql(`SELECT COALESCE(jsonb_agg(a.pid ORDER BY a.pid),'[]'::jsonb)::text FROM pg_stat_activity a WHERE ${where}`));
    await waitSql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${where})`);
    const ids = pids(); assert.equal(ids.length, 1); assert.notEqual(ids[0], h.backend);
    return async suffix => {
      assert.deepEqual(pids(), ids); assert.equal(isSettled(), false);
      const raw = f.sql(`SELECT jsonb_build_object('clock',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'holder',(SELECT to_jsonb(x) FROM (SELECT pid,backend_start,application_name,state,query FROM pg_stat_activity WHERE pid=${h.backend}) x),'blocked',(SELECT to_jsonb(x) FROM (SELECT pid,backend_start,wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${ids[0]}) x))::text`);
      const v = JSON.parse(raw);
      assert.match(v.clock, ISO_MICROS); assert.equal(v.holder.pid, h.backend); assert.equal(v.holder.application_name, h.marker);
      assert.equal(v.blocked.pid, ids[0]); assert.equal(v.blocked.query, exact); assert.equal(v.blocked.wait_event_type, 'Lock'); assert.deepEqual(v.blocked.blockers, [h.backend]);
      report.active.receipts.push(await privateFile(label + '.' + suffix, 'witness.private.json', raw + '\n'));
      return v;
    };
  }
  async function expiryCase(action, boundary) {
    const label = `${action}.${boundary}`, s = await person(), row = await imported(s, label + '.seed');
    // A rejected GET must actually roll back an attempted credential normalization.
    if (action === 'status') f.sql(`UPDATE platform_accounts SET credential_expires_at=clock_timestamp()-interval '1 second' WHERE id=${uuid(row.id)}`);
    let h, pending, body, injection, failure, observed = false;
    try {
      if (boundary === 'final') injection = await trigger(label, row, {lock: true});
      h = await ownedYoutubeHolder({f, row, boundary, label, bounded, privateFile});
      const login = exactLoginHash(f, s.client), selector = `FROM sessions WHERE user_id=${uuid(s.id)} AND token_hash=${quote(login)}`;
      f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(s.id)} AND token_hash=${quote(login)}`);
      const expiry = f.sql(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ${selector}`);
      assert.match(expiry, ISO_MICROS);
      const before = await snapshot(s, label + '.before');
      report.active.phase = 'pending';
      let settled = false;
      pending = s.client.raw(route(action), {method: method(action), body: action === 'import' ? payload('2') : action === 'unlink' ? {expected_revision: '2'} : undefined});
      body = trackResponseBody(pending); pending.then(() => {settled = true;}, () => {settled = true;});
      const exact = boundary === 'final' ? SQL[action] : action === 'status' ? SQL.status : SQL.account;
      const witness = await witnessWait(h, exact, label, () => settled);
      const first = await witness('initial'); assert.ok(first.clock < expiry);
      await waitSql(`SELECT clock_timestamp()>expires_at ${selector}`);
      assert.equal(f.sql(`SELECT expires_at=${quote(expiry)}::timestamptz AND clock_timestamp()>expires_at ${selector}`), 't');
      const second = await witness('expired'); assert.ok(second.clock > expiry);
      assert.equal(first.holder.backend_start, second.holder.backend_start); assert.equal(first.blocked.backend_start, second.blocked.backend_start);
      await receipt(label, 'deadline.private.json', {expiry, first, second});
      await h.release();
      const rejected = expiryFailure(action, boundary);
      await http(label, pending, rejected.status, rejected.code, body); observed = true;
      const after = await snapshot(s, label + '.after');
      if (action === 'import') rateChange(before, after, s); else assert.equal(after.raw, before.raw);
      const sibling = await http(label + '.sibling', s.live.raw(route('status')), 200);
      assert.equal(sibling.value.id, row.id);
      assert.equal(sibling.value.state, action === 'status' ? 'expired' : 'connected');
      await http(label + '.expired-repeat', s.client.raw(route('status')), 401, 'SESSION_EXPIRED');
    } catch (error) {failure = caseFailure(error);}
    finally {
      await cleanupShortAccountCase({pending, body, wait: bounded, primaryError: failure,
        release: h ? async () => {await receipt(label, 'holder-cleanup.private.json', await h.release());} : undefined,
        record: !observed ? async (response, text) => {await receipt(label, 'cleanup-http.private.json', {status: response.status, body: text, body_drained: body.bodyDrained});} : undefined,
        drop: injection ? () => injection.drop() : undefined});
    }
  }
  try {
    await admin.login();
    assert.equal(f.sql('SELECT count(*) FROM control_cluster_activation'), '0');
    await group(requiredChecks[0], async () => {
      const s = await person(), before = await snapshot(s, 'disabled.before');
      await http('disabled.anonymous-import', f.client().raw(route('import'), {method: 'PUT', body: payload()}), 401, 'LOGIN_REQUIRED');
      assertDto((await http('disabled.status', s.client.raw(route('status')), 200)).value, {available: false});
      for (const invalid of [payload(), {...payload(), consent_to_store: false, expected_revision: '02', cookie_file: 'invalid'}])
        await http(`disabled.import.${++serial}`, s.client.raw(route('import'), {method: 'PUT', body: invalid}), 503, 'SERVICE_UNAVAILABLE');
      assert.equal((await snapshot(s, 'disabled.after')).raw, before.raw);
      const v = (await http('disabled.unlink', s.client.raw(route('unlink'), {method: 'DELETE', body: {expected_revision: null}}), 200)).value;
      assertDto(v, {available: false, id: v.id, revision: '2'});
      await noExtractor();
      await f.startServer({RAINSYNC_YTDLP_BIN: sentinel, RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES: '1'}, binding.server);
      await noExtractor();
      assertDto((await http('enabled.status', s.client.raw(route('status')), 200)).value, {id: v.id, revision: '2'});
      assertDto((await http('enabled.unlink', s.client.raw(route('unlink'), {method: 'DELETE', body: {expected_revision: '2'}}), 200)).value, {id: v.id, revision: '3'});
    });
    await group(requiredChecks[1], async () => {
      const s = await person(), anonymous = f.client();
      const before = await snapshot(s, 'auth.before');
      for (const action of ['status', 'import', 'unlink']) {
        const body = action === 'import' ? payload() : action === 'unlink' ? {expected_revision: null} : undefined;
        await http(`${action}.anonymous`, anonymous.raw(route(action), {method: method(action), body}), 401, 'LOGIN_REQUIRED');
      }
      for (const action of ['import', 'unlink']) {
        const body = action === 'import' ? payload() : {expected_revision: null};
        await http(`${action}.origin`, s.client.raw(route(action), {method: method(action), body, headers: {Origin: 'https://invalid.example'}}), 403);
        await http(`${action}.csrf`, s.client.raw(route(action), {method: method(action), body, headers: {'x-csrf-token': ''}}), 403);
        for (const malformed of [{}, {...body, unknown: true}])
          await http(`${action}.json.${++serial}`, anonymous.raw(route(action), {method: method(action), body: malformed}), 422, 'INVALID_REQUEST');
        await http(`${action}.malformed`, anonymous.raw(route(action), {method: method(action), body: Buffer.from('{')}), 400, 'INVALID_REQUEST');
        await http(`${action}.cap`, anonymous.raw(route(action), {method: method(action), body: Buffer.from(JSON.stringify({...body, padding: 'x'.repeat(action === 'import' ? 64 * 1024 : 1024)}))}), 413);
      }
      assertDto((await http('read.origin-csrf', s.client.raw(route('status'), {headers: {Origin: 'https://invalid.example', 'x-csrf-token': ''}}), 200)).value);
      assertDto((await http('read.live-sibling', s.live.raw(route('status')), 200)).value);
      assert.equal((await snapshot(s, 'auth.after')).raw, before.raw);
      const room = await admin.request('/rooms', 'POST', {name: 'YouTube synthetic guest'});
      const invite = await admin.request(`/rooms/${room.id}/invites`, 'POST', {max_uses: 2});
      const settings = await admin.request('/admin/settings');
      await admin.request('/admin/settings', 'PATCH', {expected_revision: settings.revision, changes: {guests_enabled: true}});
      await admin.request(`/rooms/${room.id}/guest-access`, 'PUT', {enabled: true});
      const guest = f.client(); guest.csrf = (await guest.request(`/rooms/${room.id}/guest-session`, 'POST', {token: invite.token, display_name: 'Synthetic YouTube guest'}, 201)).csrf;
      for (const action of ['status', 'import', 'unlink'])
        await http(`${action}.guest`, guest.raw(route(action), {method: method(action), body: action === 'import' ? payload() : action === 'unlink' ? {expected_revision: null} : undefined}), 403, 'GUEST_RESTRICTED');
    });
    await group(requiredChecks[2], async () => {
      const s = await person(), before = await snapshot(s, 'ingress.before');
      await http('consent.priority', s.client.raw(route('import'), {method: 'PUT', body: {...payload(), consent_to_store: false, expected_revision: '02', cookie_file: 'bad'}}), 400, 'PLATFORM_STORAGE_CONSENT_REQUIRED');
      for (const revision of [2, '02', '+2', ' 2', '0', '-2', '9223372036854775808', true, {}])
        await http(`revision.${++serial}`, s.client.raw(route('import'), {method: 'PUT', body: payload(revision)}), 400);
      const valid = cookieFile();
      for (const invalid of ['', 'SID=header-cookie-not-netscape', valid.replaceAll('.youtube.com', '.google.com'), valid.replaceAll('.youtube.com', '.youtube.com.attacker.test'), valid + cookieLine('LOGIN_INFO'), valid.replaceAll('\t/\t', '\t/private\t'), valid.replaceAll('owned-youtube-synthetic-session-only', 'short'), valid.replaceAll('\t0\t', '\t1\t'), valid.replaceAll('\t0\t', '\t-1\t'), valid.replaceAll('session-only', 'session;injected=1'), valid + '\u0000', valid + 'é', '# Netscape HTTP Cookie File\n' + cookieLine('SID'), valid + cookieLine('HSID', 0, 'x'.repeat(4097)), valid + Array.from({length: 31}, (_, i) => cookieLine(`ignored_${i}`)).join(''), valid + '#' + 'x'.repeat(32 * 1024)])
        await http(`cookie.invalid.${++serial}`, s.client.raw(route('import'), {method: 'PUT', body: payload(null, invalid)}), 400, 'PLATFORM_CREDENTIAL_INVALID');
      const capBase = payload(null, '');
      const exact64 = JSON.stringify({...capBase, cookie_file: 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(capBase)))});
      assert.equal(Buffer.byteLength(exact64), 64 * 1024);
      await http('json.exact-64k', s.client.raw(route('import'), {method: 'PUT', body: Buffer.from(exact64)}), 400, 'PLATFORM_CREDENTIAL_INVALID');
      await http('json.over-64k', s.client.raw(route('import'), {method: 'PUT', body: Buffer.from(exact64 + ' ')}), 413);
      assert.equal((await snapshot(s, 'ingress.after')).raw, before.raw);
      const normalizedInput = '# HTTP Cookie File\r\n# comment\r\n#HttpOnly_' + cookieLine('SAPISID').replace('\t/\tTRUE\t', '\t/\tFALSE\t') + cookieLine('LOGIN_INFO') + cookieLine('VISITOR_INFO1_LIVE', 1);
      const response = await http('cookie.normalized', s.client.raw(route('import'), {method: 'PUT', body: payload(null, normalizedInput)}), 200);
      const row = account(await snapshot(s, 'cookie.normalized.stored'));
      assertDto(response.value, {state: 'connected', revision: '2', id: row.id}); envelope(s, row, valid);
      let prev = await snapshot(s, 'null-existing.before');
      await http('null-existing', s.client.raw(route('import'), {method: 'PUT', body: payload()}), 409, 'PLATFORM_ACCOUNT_CHANGED');
      rateChange(prev, await snapshot(s, 'null-existing.after'), s);
      const replaced = await http('replace', s.client.raw(route('import'), {method: 'PUT', body: payload('2')}), 200);
      const next = account(await snapshot(s, 'replace.stored'));
      assertDto(replaced.value, {state: 'connected', revision: '3', id: row.id}); envelope(s, next, valid, '3');
      assert.notEqual(next.credential_encrypted, row.credential_encrypted);
      assert.notDeepEqual(Buffer.from(next.credential_encrypted, 'base64').subarray(0, 12), Buffer.from(row.credential_encrypted, 'base64').subarray(0, 12));
      prev = await snapshot(s, 'reordered.before');
      await http('reordered-stale', s.client.raw(route('import'), {method: 'PUT', body: payload('2')}), 409, 'PLATFORM_ACCOUNT_CHANGED');
      rateChange(prev, await snapshot(s, 'reordered.after'), s);
      for (const auth of ['__Secure-1PAPISID', '__Secure-3PAPISID']) {
        const alt = await person(), cookie = '# Netscape HTTP Cookie File\n' + cookieLine('LOGIN_INFO') + cookieLine(auth);
        await imported(alt, `allowlist.${auth}`, cookie);
      }
      const capped = await person();
      const atCap = valid + '#' + 'x'.repeat(32 * 1024 - valid.length - 1);
      assert.equal(Buffer.byteLength(atCap), 32 * 1024);
      await http('cookie.exact-32k', capped.client.raw(route('import'), {method: 'PUT', body: payload(null, atCap)}), 200);
      envelope(capped, account(await snapshot(capped, 'cookie.exact-32k.stored')), valid);
      const limited = await person();
      // Failed CAS still commits the external limiter. The eleventh valid import is denied.
      for (let attempt = 1; attempt <= 11; attempt++) {
        prev = await snapshot(limited, `limit.${attempt}.before`);
        const v = await http(`limit.${attempt}`, limited.client.raw(route('import'), {method: 'PUT', body: payload('1')}), attempt <= 10 ? 409 : 429, attempt <= 10 ? 'PLATFORM_ACCOUNT_CHANGED' : 'RATE_LIMITED');
        rateChange(prev, await snapshot(limited, `limit.${attempt}.after`), limited);
        if (attempt === 11) assert.ok(Number(v.response.headers.get('retry-after')) > 0);
      }
      // The parser's original SystemTime sample is not refreshed after an account wait.
      const clockUser = await person();
      const tombstone = (await http('clock.tombstone', clockUser.client.raw(route('unlink'), {method: 'DELETE', body: {expected_revision: null}}), 200)).value;
      const expires = Number(f.sql("SELECT floor(extract(epoch FROM clock_timestamp()))::bigint")) + 4;
      const cookie = cookieFile(expires), label = 'cookie-clock-account-wait';
      let h, pending, body, failure;
      try {
        h = await ownedYoutubeHolder({f, row: tombstone, boundary: 'account', label, bounded, privateFile});
        let settled = false;
        pending = clockUser.client.raw(route('import'), {method: 'PUT', body: payload('2', cookie)});
        body = trackResponseBody(pending); pending.then(() => {settled = true;}, () => {settled = true;});
        const witness = await witnessWait(h, SQL.account, label, () => settled);
        const first = await witness('initial');
        const deadline = f.sql(`SELECT to_char(to_timestamp(${expires}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
        assert.ok(first.clock < deadline);
        await waitSql(`SELECT clock_timestamp()>to_timestamp(${expires})`);
        const second = await witness('expired'); assert.ok(second.clock > deadline);
        assert.equal(first.holder.backend_start, second.holder.backend_start); assert.equal(first.blocked.backend_start, second.blocked.backend_start);
        await receipt(label, 'deadline.private.json', {expiry: deadline, first, second});
        await h.release();
        const value = (await http(label, pending, 200, undefined, body)).value;
        assertDto(value, {state: 'connected', id: tombstone.id, revision: '3', expiry: expires * 1000});
        envelope(clockUser, account(await snapshot(clockUser, label + '.stored')), cookie, '3');
      } catch (error) {failure = caseFailure(error);}
      finally {await cleanupShortAccountCase({pending, body, wait: bounded, primaryError: failure,
        release: h ? async () => {await receipt(label, 'holder-cleanup.private.json', await h.release());} : undefined});}
    });
    await group(requiredChecks[3], () => expiryCase('status', 'account'));
    await group(requiredChecks[4], async () => {await expiryCase('import', 'account'); await expiryCase('unlink', 'account');});
    await group(requiredChecks[5], async () => {await expiryCase('import', 'final'); await expiryCase('unlink', 'final');});
    await group(requiredChecks[6], async () => {
      const s = await person(), row = await imported(s, 'expiry.seed');
      f.sql(`UPDATE platform_accounts SET credential_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 WHERE id=${uuid(row.id)}`);
      const before = await snapshot(s, 'expiry.before');
      const v = await http('expiry.status', s.client.raw(route('status')), 200);
      const after = await snapshot(s, 'expiry.after'), now = account(after), prior = account(before);
      const expected = structuredClone(before.value);
      Object.assign(expected.platform_accounts.find(x => x.id === row.id), {state: 'expired', revision: 4n, credential_encrypted: null, updated_at: now.updated_at});
      assert.deepEqual(after.value, expected); assert.equal(now.credential_expires_at, prior.credential_expires_at);
      const expiry = Number(f.sql(`SELECT floor(extract(epoch FROM credential_expires_at)*1000)::bigint FROM platform_accounts WHERE id=${uuid(row.id)}`));
      assertDto(v.value, {state: 'expired', revision: '4', id: row.id, expiry});
      const replacement = await http('expiry.replacement', s.client.raw(route('import'), {method: 'PUT', body: payload('4')}), 200);
      assertDto(replacement.value, {state: 'connected', revision: '5', id: row.id});
      envelope(s, account(await snapshot(s, 'expiry.replacement.stored')), cookieFile(), '5');
      for (const revision of ['5', '6']) assertDto((await http(`unlink.${revision}`, s.client.raw(route('unlink'), {method: 'DELETE', body: {expected_revision: revision}}), 200)).value, {id: row.id, revision: String(Number(revision) + 1)});
      const absent = await person(); const missing = await snapshot(absent, 'missing.before');
      assertDto((await http('missing.status', absent.client.raw(route('status')), 200)).value);
      assert.equal((await snapshot(absent, 'missing.after')).raw, missing.raw);
      await http('missing.string', absent.client.raw(route('unlink'), {method: 'DELETE', body: {expected_revision: '1'}}), 409, 'PLATFORM_ACCOUNT_CHANGED');
      assert.equal((await snapshot(absent, 'missing.string.after')).raw, missing.raw);
      const tombstone = (await http('missing.null', absent.client.raw(route('unlink'), {method: 'DELETE', body: {expected_revision: null}}), 200)).value;
      assertDto(tombstone, {id: tombstone.id, revision: '2'});
      const expiredImport = await person(), expiredRow = await imported(expiredImport, 'expired-import.seed');
      f.sql(`UPDATE platform_accounts SET credential_expires_at=clock_timestamp()-interval '1 second' WHERE id=${uuid(expiredRow.id)}`);
      const expiredBefore = await snapshot(expiredImport, 'expired-import.stale.before');
      await http('expired-import.stale', expiredImport.client.raw(route('import'), {method: 'PUT', body: payload('2')}), 409, 'PLATFORM_ACCOUNT_CHANGED');
      rateChange(expiredBefore, await snapshot(expiredImport, 'expired-import.stale.after'), expiredImport);
      const expiredReplacement = await http('expired-import.normalized-cas', expiredImport.client.raw(route('import'), {method: 'PUT', body: payload('3')}), 200);
      assertDto(expiredReplacement.value, {id: expiredRow.id, state: 'connected', revision: '4'});
      envelope(expiredImport, account(await snapshot(expiredImport, 'expired-import.replaced')), cookieFile(), '4');
      const known = await person(), seconds = Number(f.sql("SELECT floor(extract(epoch FROM clock_timestamp()))::bigint")) + 3600;
      const input = '# Netscape HTTP Cookie File\n' + cookieLine('LOGIN_INFO', 0) + cookieLine('SAPISID', seconds) + cookieLine('SID', seconds + 60);
      await imported(known, 'known-expiry', input, seconds * 1000);
      const overflow = await person(), id = randomUUID();
      f.sql(`INSERT INTO platform_accounts(id,user_id,provider,state,revision) VALUES(${uuid(id)},${uuid(overflow.id)},'youtube','revoked',9223372036854775807)`);
      for (const action of ['import', 'unlink']) {
        const prev = await snapshot(overflow, `overflow.${action}.before`);
        await http(`overflow.${action}`, overflow.client.raw(route(action), {method: method(action), body: action === 'import' ? payload('9223372036854775807') : {expected_revision: '9223372036854775807'}}), 500, 'PLATFORM_CREDENTIAL_INVALID');
        const next = await snapshot(overflow, `overflow.${action}.after`);
        if (action === 'import') rateChange(prev, next, overflow); else assert.equal(next.raw, prev.raw);
      }
      // Returning NULL from an owned BEFORE UPDATE trigger gives a real zero-row receipt.
      for (const action of ['import', 'unlink']) {
        const label = `rows-affected.${action}`, s = await person(), row = await imported(s, label + '.seed');
        const injection = await trigger(label, row, {skip: true}); let pending, body, failure;
        try {
          const prev = await snapshot(s, label + '.before');
          pending = s.client.raw(route(action), {method: method(action), body: action === 'import' ? payload('2') : {expected_revision: '2'}}); body = trackResponseBody(pending);
          await http(label, pending, 409, 'PLATFORM_ACCOUNT_CHANGED', body);
          const next = await snapshot(s, label + '.after');
          if (action === 'import') rateChange(prev, next, s); else assert.equal(next.raw, prev.raw);
        } catch (error) {failure = caseFailure(error);}
        finally {await cleanupShortAccountCase({pending, body, wait: bounded, primaryError: failure, drop: () => injection.drop()});}
      }
    });
    await group(requiredChecks[7], async () => {
      for (const deferred of [false, true]) for (const action of ['status', 'import', 'unlink']) {
        const label = `${deferred ? 'commit' : 'precommit'}.${action}`, s = await person(), row = await imported(s, label + '.seed');
        if (action === 'status') f.sql(`UPDATE platform_accounts SET credential_expires_at=clock_timestamp()-interval '1 second' WHERE id=${uuid(row.id)}`);
        const injection = await trigger(label, row, {deferred, fail: true}); let pending, body, failure;
        try {
          const prev = await snapshot(s, label + '.before');
          assert.equal(f.sql(`SELECT is_called FROM ${injection.sequence}`), 'f');
          pending = s.client.raw(route(action), {method: method(action), body: action === 'import' ? payload('2') : action === 'unlink' ? {expected_revision: '2'} : undefined}); body = trackResponseBody(pending);
          const v = await http(label, pending, 500, 'INTERNAL_ERROR', body);
          assertSafeText(JSON.stringify(v.value), [injection.marker]);
          const witness = f.sql(`SELECT jsonb_build_object('last_value',last_value::text,'is_called',is_called)::text FROM ${injection.sequence}`);
          assert.deepEqual(JSON.parse(witness), {last_value: '1', is_called: true});
          report.active.receipts.push(await privateFile(label, 'trigger-fired.private.json', witness + '\n'));
          const next = await snapshot(s, label + '.after');
          if (action === 'import') rateChange(prev, next, s); else assert.equal(next.raw, prev.raw);
        } catch (error) {failure = caseFailure(error);}
        finally {await cleanupShortAccountCase({pending, body, wait: bounded, primaryError: failure, drop: () => injection.drop()});}
      }
      await noExtractor();
      const stopped = await f.stopServer();
      assert.equal(stopped.observed_close, true);
      await noExtractor();
      await receipt('final-server-stop', 'process.private.json', stopped);
      report.extractor_placeholder.final_server_close_observed = true;
      // Dedicated gate awaits shared teardown/stream flush before the mandatory audit below.
    });
    assertChecks(report.checks);
    return async () => {
      // All server log streams are closed by isolatedServer before this hook runs.
      const final = report.groups.at(-1);
      try {
        await noExtractor();
        report.cleanup = await f.verifyStopped();
        assert.equal(report.cleanup.completed, true);
        assert.equal(report.cleanup.servers.length, 2);
        for (const server of report.cleanup.servers) assert.equal(server.binary, binding.server);
        const expectedLogs = report.cleanup.servers.map(server => `server-${server.launch}.log`).sort();
        const logs = (await readdir(f.root)).filter(name => /^server-\d+\.log$/.test(name)).sort();
        assert.deepEqual(logs, expectedLogs);
        for (const name of logs) {
          const bytes = await readFile(resolve(f.root, name));
          assertSafeText(bytes.toString(), secrets);
          final.receipts.push(await receipt(name, 'log-audit.private.json', {sha256: sha256(bytes), bytes: bytes.length, checked_secrets: true, stream_closed: true}));
        }
        report.extractor_placeholder.post_teardown_invocation_absent = true;
        final.receipts.push(await receipt('owned-cleanup', 'private.json', report.cleanup));
      } catch (error) {final.result = 'failed'; throw error;}
    };
  } catch (error) {
    try {report.private_failure = await privateFile('youtube-original-failure', 'private.json', JSON.stringify(privateFailureDetails(error)) + '\n');}
    catch (evidenceError) {
      report.failure_evidence = {result: 'failed', code: 'private_failure_write_failed'};
      throw new AggregateError([error, evidenceError], 'youtube_native_original_and_evidence_failure');
    }
    throw caseFailure(error);
  }
});
