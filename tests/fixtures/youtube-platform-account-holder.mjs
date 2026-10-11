// Only runtime callers can create this owned SQL holder; no import-time effects.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyPidAbsent} from './postgres.mjs';
import {quote, uuid} from './youtube-platform-account-contract.mjs';
export async function ownedYoutubeHolder({f, row, boundary, label, bounded, privateFile, pidAbsent = verifyPidAbsent}) {
  const marker = `youtube_holder_${randomUUID().replaceAll('-', '')}`;
  const key = 284617391;
  const child = f.sqlProcess(undefined, {interactive: true});
  const stdout = [], stderr = [];
  let output = '', backend, backendStart, releasePromise;
  const record = {close_observed: false, exit_code: null, signal: null, pid_absent: false, backend_absent: false, forced: false};
  child.once('close', (code, signal) => Object.assign(record, {close_observed: true, exit_code: code, signal}));
  child.stdin.on('error', () => {});
  child.stderr.on('data', b => stderr.push(Buffer.from(b)));
  const ready = new Promise((done, reject) => {
    child.stdout.on('data', b => {stdout.push(Buffer.from(b)); output += b.toString(); if (output.includes(marker + '_ready')) done();});
    child.once('error', reject);
    child.done.then(() => reject(Error('youtube_holder_early_close')), reject);
  });
  const lock = boundary === 'final' ? `SELECT pg_advisory_xact_lock(${key})` : `SELECT id FROM platform_accounts WHERE id=${uuid(row.id)} FOR NO KEY UPDATE`;
  async function release() {
    return releasePromise ??= (async () => {
      const failures = [];
      try {
        child.stdin.end('COMMIT;\n\\q\n');
        await bounded(child.done, 12000);
        assert.equal(record.close_observed, true);
        assert.equal(record.exit_code, 0);
        assert.equal(record.signal, null);
      } catch (error) {
        failures.push(error);
        record.forced = true;
        // Terminate only this exact owned backend identity. Never target by query alone.
        try { if (backend) f.sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=${backend} AND backend_start=${quote(backendStart)}::timestamptz AND application_name=${quote(marker)}`); } catch (error) { failures.push(error); }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        try { await bounded(child.done.catch(() => {}), 12000); } catch (error) { failures.push(error); }
      }
      try {
        assert.equal(record.close_observed, true);
        record.pid_absent = pidAbsent(child.pid);
        assert.equal(record.pid_absent, true);
        record.backend_absent = f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(marker)}${backend ? ` OR (pid=${backend} AND backend_start=${quote(backendStart)}::timestamptz)` : ''})`) === 't';
        assert.equal(record.backend_absent, true);
      } catch (error) { failures.push(error); }
      for (const [field, bytes] of [['stdout', Buffer.concat(stdout)], ['stderr', Buffer.concat(stderr)]]) {
        try {record[field] = await privateFile(label, `holder.${field}.private.log`, bytes);}
        catch (error) {failures.push(error);}
      }
      try {await privateFile(label, 'holder-lifecycle.private.json', JSON.stringify(record) + '\n');}
      catch (error) {failures.push(error);}
      if (failures.length) throw new AggregateError(failures, 'youtube_holder_cleanup_failed');
      return record;
    })();
  }
  try {
  child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${lock};\n\\echo ${marker}_ready\n`);
    await bounded(ready);
    const rows = JSON.parse(f.sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,'backend_start',backend_start)),'[]'::jsonb)::text FROM pg_stat_activity WHERE application_name=${quote(marker)}`));
    assert.equal(rows.length, 1);
    ({pid: backend, backend_start: backendStart} = rows[0]);
    assert.ok(Number.isInteger(backend) && backend > 0);
  } catch (error) {
    try { await release(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'youtube_holder_setup_cleanup'); }
    throw error;
  }
  return {backend, marker, key, release, record};
}
