// Pure domain orchestration. All commands are Node/shell or substituted callbacks;
// fake PostgreSQL tool files are hashed/read but never executed.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertBindingsUnchanged, bindingSourceFiles, captureBindings, collectReceipts, coherentVersions, createInvocation,
  gateNames, inspectReceipt, leaves, nativeArgs, observeNativePair, orchestrate, parseGateResults, pgTools,
  publishedBaseline, resolvePgConfig, saveReport, validateHistory, validateSelection,
} from '../scripts/verification/upgrade-recovery.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Sanitized retained Node 24 native-pass TAP; no raw diagnostics or durations.
const actualTap = "TAP version 13\n# Subtest: full immutable migration history is checked against the recent published baseline and candidate SHA\nok 1 - full immutable migration history is checked against the recent published baseline and candidate SHA\n# Subtest: populated recent baseline upgrades and restores separately while old-schema preflight remains closed\nok 2 - populated recent baseline upgrades and restores separately while old-schema preflight remains closed\n# Subtest: source and platform encrypted fields use one fixed startup/recovery inventory\nok 3 - source and platform encrypted fields use one fixed startup/recovery inventory\n# Subtest: private malformed input and arbitrary assertion diagnostics never leave safe error boundaries\nok 4 - private malformed input and arbitrary assertion diagnostics never leave safe error boundaries\n# Subtest: every encrypted field rejects wrong keys and corrupt bytes before backup output exists\nok 5 - every encrypted field rejects wrong keys and corrupt bytes before backup output exists\n# Subtest: pairing and revocation between material validation and dump preserve the captured recovery point\nok 6 - pairing and revocation between material validation and dump preserve the captured recovery point\n# Subtest: recovery ciphertext validation rejects noncanonical base64 and invalid UTF-8\nok 7 - recovery ciphertext validation rejects noncanonical base64 and invalid UTF-8\n# Subtest: lost snapshot exporter cannot produce a complete backup manifest\nok 8 - lost snapshot exporter cannot produce a complete backup manifest\n1..8\n# tests 8\n# suites 0\n# pass 8\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const source = { head: 'a'.repeat(40), migrations: [] };
async function owned(t) {
  const root = await fs.mkdtemp(resolve(tmpdir(), 'rainsync-layer-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const validReceipt = fixture => ({ schema_version: 1, fixture, state: 'complete', result: 'passed',
  test_outcome: 'passed', cleanup_outcome: 'verified', failures: [],
  cleanup: { kind: 'native', completed: true, stopped: true, process_close_observed: true,
    pid_absent: true, pg_ctl_status: 3, port_closed: true, exit_code: 0, signal: null },
  disposal: { outcome: 'removed', removed: true, retained: false },
  ...(fixture === 'current-baseline-upgrade' ? { baseline_commit: publishedBaseline, candidate_commit: source.head,
    migrations: [], application_acceptance: false } : {}),
});

test('retained real TAP proves eight exact gates with no skipped native cases', () => {
  const result = parseGateResults(actualTap); assert.equal(result.counts.tests, 8);
  assert.deepEqual(result.names.toSorted(), [...gateNames].toSorted());
  assert.deepEqual(nativeArgs('/owned/node'), ['--signal=TERM', '--kill-after=15s', '180s', '/owned/node', '--test', '--test-reporter=tap', ...leaves]);
});
const badTaps = {
  unknownName: text => text.replaceAll(gateNames[0], 'unknown gate'),
  duplicateName: text => text.replaceAll(gateNames[0], gateNames[1]),
  missingName: text => text.replace(/^ok 1 - .+$/m, ''),
  failed: text => text.replace(/^ok 1 -/m, 'not ok 1 -'),
  skip: text => text.replace(/^ok 1 - (.+)$/m, 'ok 1 - $1 # SKIP missing PG'),
  todo: text => text.replace('# todo 0', '# todo 1'),
  cancelled: text => text.replace('# cancelled 0', '# cancelled 1'),
  duplicateSummary: text => text + '# tests 8\n',
  malformedSummary: text => text + '# tests invalid\n',
  malformedResult: text => text + 'ok invalid - unknown\n',
  wrongPlan: text => text + '1..9\n',
  wrongHeader: text => text + 'TAP version 14\n',
  truncated: text => text.replace('# pass 8', ''),
  overflow: () => 'x'.repeat(4 * 1024 * 1024 + 1),
};
for (const [name, alter] of Object.entries(badTaps)) test(`TAP rejects ${name}`, () => assert.throws(() => parseGateResults(alter(actualTap))));

test('actual checks shell accepts only success/success with Actions fail-fast flags', async () => {
  const workflow = await fs.readFile(resolve(repo, '.github/workflows/ci.yml'), 'utf8');
  const job = workflow.split('  checks:\n')[1].split('  # Independent')[0];
  assert.match(job, /needs: \[core-checks, upgrade-recovery\]/); assert.match(job, /if: always\(\)/);
  assert.match(job, /shell: bash/);
  const body = job.split('        run: |\n')[1].split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
  assert.equal(body, 'test "$CORE_RESULT" = success\ntest "$RECOVERY_RESULT" = success');
  const outcomes = ['success', 'failure', 'cancelled', 'skipped', '', 'unknown'];
  for (const core of outcomes) for (const recovery of outcomes) {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body], {
      env: { PATH: '/usr/bin:/bin', CORE_RESULT: core, RECOVERY_RESULT: recovery }, timeout: 1000, encoding: 'utf8',
    });
    assert.equal(result.status === 0, core === 'success' && recovery === 'success', `${core}/${recovery}`);
  }
});
test('routing owns each new entry once and leaves owner and unrelated native chains independent', async () => {
  const workflow = await fs.readFile(resolve(repo, '.github/workflows/ci.yml'), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(resolve(repo, 'package.json')));
  const core = workflow.split('  core-checks:\n')[1].split('  upgrade-recovery:\n')[0];
  const recovery = workflow.split('  upgrade-recovery:\n')[1].split('  checks:\n')[0];
  const owner = workflow.slice(workflow.indexOf('  owner-gates:\n'));
  for (const name of ['test:upgrade-recovery-contracts', 'test:verification-contracts']) {
    assert.equal(workflow.split(`npm run ${name}`).length - 1, 1); assert.ok(core.includes(`npm run ${name}`));
  }
  assert.equal(workflow.split('npm run test:upgrade-recovery\n').length - 1, 1);
  assert.doesNotMatch(recovery, /needs:|continue-on-error|paths-ignore|paths:/);
  assert.match(recovery, /fetch-depth: 0/); assert.match(recovery, /timeout-minutes: 4/);
  assert.match(recovery, /if: always\(\)/); assert.doesNotMatch(recovery, /path:.*receipts-private/);
  assert.doesNotMatch(recovery.split('          path: |\n')[1], /receipts-private|runtime|\*\*|\.log/);
  for (const leaf of leaves) assert.ok(!workflow.includes(leaf));
  assert.ok(packageJson.scripts['test:parallel-integration'].includes('tests/postgres-recovery.test.mjs'));
  for (const name of ['test:parallel-integration', 'test:owner-gate-contracts', 'test:backend-contracts'])
    for (const leaf of leaves) assert.ok(!packageJson.scripts[name].includes(leaf));
  assert.ok(owner.includes('npm run test:owner-gate-contracts'));
  assert.ok(!owner.includes('test:upgrade-recovery'));
  assert.equal(packageJson.scripts['test:upgrade-recovery'], 'node scripts/verification/upgrade-recovery.mjs');
});

test('selection rejects missing, relative, foreign-platform and external database/recovery inputs', () => {
  const env = { RAINSYNC_NATIVE_POSTGRES_BIN: '/owned/pg', RAINSYNC_ARTIFACT_DIR: '/owned/artifacts', RAINSYNC_RUNTIME_ROOT: '/owned/runtime' };
  validateSelection(env, 'linux');
  for (const key of Object.keys(env)) for (const value of [undefined, '', 'relative', '/bad\npath'])
    assert.throws(() => validateSelection({ ...env, [key]: value }, 'linux'));
  assert.throws(() => validateSelection(env, 'darwin'));
  assert.throws(() => validateSelection(env, 'linux', '22.1.0'));
  for (const key of ['DATABASE_URL', 'RAINSYNC_RECOVERY_INPUT_FILE']) assert.throws(() => validateSelection({ ...env, [key]: 'SYNTHETIC_SECRET' }, 'linux'));
});
test('version coherence adds no major pin and history fails closed', () => {
  for (const version of ['16.3', '17.11', '18.1']) assert.equal(coherentVersions([`PostgreSQL ${version}`, ...pgTools.map(name => `${name} (PostgreSQL) ${version}`)]), version);
  for (const versions of [[], Array(8).fill('invalid'), ['PostgreSQL 17.11', ...pgTools.map(name => `${name} (PostgreSQL) 18.1`)]]) assert.throws(() => coherentVersions(versions));
  validateHistory({ head: source.head, shallow: 'false', ancestor: true });
  for (const change of [{ head: '' }, { shallow: 'true' }, { ancestor: false }]) assert.throws(() => validateHistory({ head: source.head, shallow: 'false', ancestor: true, ...change }));
});
test('actual CLI rejects foreign input before allocating anything or starting a fixture', async t => {
  const root = await owned(t), artifacts = resolve(root, 'artifacts'), runtime = resolve(root, 'runtime');
  const result = spawnSync(process.execPath, ['scripts/verification/upgrade-recovery.mjs'], { cwd: repo, timeout: 3000, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', RAINSYNC_NATIVE_POSTGRES_BIN: resolve(root, 'missing'), RAINSYNC_ARTIFACT_DIR: artifacts,
      RAINSYNC_RUNTIME_ROOT: runtime, DATABASE_URL: 'SYNTHETIC_SECRET' } });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stderr + result.stdout, /SYNTHETIC_SECRET/);
  await assert.rejects(fs.stat(artifacts)); await assert.rejects(fs.stat(runtime));
});

async function fakeInstallation(t) {
  const root = await owned(t), bin = resolve(root, 'bin'), shared = resolve(root, 'shared'), libraries = resolve(root, 'libraries'), src = resolve(root, 'source');
  for (const path of [bin, shared, libraries, src]) await fs.mkdir(path);
  for (const name of ['git', 'timeout', 'pg_config', 'ldd', ...pgTools]) await fs.writeFile(resolve(bin, name), Buffer.from('\x7fELFowned non-executed tool bytes'), { mode: 0o700 });
  await fs.writeFile(resolve(shared, 'postgres.bki'), 'owned initialization data');
  const library = resolve(libraries, 'owned.so'); await fs.writeFile(library, 'owned dynamic library bytes');
  for (const path of [...bindingSourceFiles, 'migrations/0001_owned.sql']) {
    await fs.mkdir(dirname(resolve(src, path)), { recursive: true }); await fs.writeFile(resolve(src, path), 'owned input bytes');
  }
  const calls = [];
  const runCommand = async (program, args) => {
    calls.push([program, args]);
    if (args[0] === '--bindir') return bin;
    if (args[0] === '--sharedir') return shared;
    if (args[0] === '--pkglibdir') return libraries;
    if (args[0] === '--version') {
      if (program === resolve(bin, 'git')) return 'git version 2.47.3';
      if (program === resolve(bin, 'timeout')) return 'timeout (GNU coreutils) 9.7';
      if (program === resolve(bin, 'ldd')) return 'ldd (owned GLIBC) 2.41';
      return 'PostgreSQL 17.11';
    }
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? source.head : 'false';
    if (args[0] === 'cat-file' || args[0] === 'merge-base') return '';
    if (program === resolve(bin, 'ldd')) return `${library} (0x0001)`;
    assert.fail('unexpected pure binding command');
  };
  return { root, bin, shared, libraries, src, library, calls, runCommand, env: { PATH: bin, RAINSYNC_NATIVE_POSTGRES_BIN: bin } };
}
for (const name of [...pgTools, 'git', 'timeout', 'pg_config', 'ldd']) test(`missing ${name} fails actual binding before any tool is executed`, async t => {
  const fixture = await fakeInstallation(t); await fs.rm(resolve(fixture.bin, name));
  await assert.rejects(captureBindings(fixture.src, fixture.env, fixture.runCommand)); assert.deepEqual(fixture.calls, []);
});
test('actual binding snapshots detect source, tool, resolved library, shared-resource and HEAD drift', async t => {
  const fixture = await fakeInstallation(t), take = command => captureBindings(fixture.src, fixture.env, command ?? fixture.runCommand);
  const before = await take(); assert.equal(before.pg_version, '17.11');
  for (const path of [resolve(fixture.src, bindingSourceFiles[0]), resolve(fixture.bin, 'postgres'), fixture.library, resolve(fixture.shared, 'postgres.bki')]) {
    const original = await fs.readFile(path); await fs.writeFile(path, 'changed owned bytes');
    const changed = await take(); assert.throws(() => assertBindingsUnchanged(changed, before)); await fs.writeFile(path, original);
  }
  const alternate = async (program, args, ...rest) => args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'b'.repeat(40) : fixture.runCommand(program, args, ...rest);
  const changed = await take(alternate); assert.throws(() => assertBindingsUnchanged(changed, before)); assertBindingsUnchanged(await take(), before);
});

test('receipt inspection binds successful native cleanup to exact source and emits safe fields', () => {
  for (const fixture of ['recovery-integrity', 'current-baseline-upgrade']) assert.equal(inspectReceipt(validReceipt(fixture), fixture, source).passed, true);
});
const receiptMutations = {
  incomplete: value => value.state = 'incomplete', failed: value => value.result = 'failed', primary: value => value.test_outcome = 'failed',
  cleanupFailed: value => value.cleanup_outcome = 'failed', nativeSkip: value => value.cleanup.kind = 'docker',
  noClose: value => value.cleanup.process_close_observed = false, noPid: value => value.cleanup.pid_absent = false,
  noPort: value => value.cleanup.port_closed = false, noCtl: value => value.cleanup.pg_ctl_status = null,
  noCompleted: value => value.cleanup.completed = false, noStopped: value => value.cleanup.stopped = false,
  noDisposal: value => value.disposal.outcome = 'unknown', retained: value => value.disposal.retained = true,
  wrongBaseline: value => value.baseline_commit = 'b'.repeat(40), wrongHead: value => value.candidate_commit = 'b'.repeat(40),
  wrongMigrations: value => value.migrations = [{ name: '0001_wrong.sql', version: 1, checksum: 'bad' }],
};
for (const [name, alter] of Object.entries(receiptMutations)) test(`receipt rejects ${name}`, () => {
  const value = validReceipt('current-baseline-upgrade'); alter(value);
  let accepted = false; try { accepted = inspectReceipt(value, 'current-baseline-upgrade', source).passed; } catch { /* invalid is rejected */ }
  assert.equal(accepted, false);
});
for (const location of ['top', 'cleanup', 'disposal']) test(`unknown secret fields at ${location} never enter safe receipt export`, async t => {
  const root = await owned(t), value = validReceipt('recovery-integrity');
  (location === 'top' ? value : value[location]).error = 'SYNTHETIC_SECRET';
  await fs.writeFile(resolve(root, `recovery-integrity-${randomUUID()}.json`), JSON.stringify(value));
  const result = await collectReceipts(root, source); assert.ok(result.failures.includes('receipt_invalid'));
  assert.doesNotMatch(JSON.stringify(result.exports), /SYNTHETIC_SECRET|"error"|"stack"|"cause"/);
});
async function receiptSet(root) {
  const paths = [];
  for (const fixture of ['recovery-integrity', 'recovery-integrity', 'recovery-integrity', 'current-baseline-upgrade']) {
    const path = resolve(root, `${fixture}-${randomUUID()}.json`); await fs.writeFile(path, JSON.stringify(validReceipt(fixture))); paths.push(path);
  }
  return paths;
}
test('only one invocation exact 3+1 fixture inventory passes', async t => {
  const root = await owned(t), paths = await receiptSet(root); const good = await collectReceipts(root, source);
  assert.deepEqual(good.failures, []); assert.equal(good.exports.length, 4);
  await fs.writeFile(resolve(root, 'unfinished.json.tmp'), '{}'); assert.ok((await collectReceipts(root, source)).failures.length);
  await fs.rm(resolve(root, 'unfinished.json.tmp')); await fs.rm(paths[0]);
  assert.ok((await collectReceipts(root, source)).failures.includes('receipt_inventory_failed'));
});
test('symlink and wrong-fixture receipts cannot be trusted or uploaded verbatim', async t => {
  const root = await owned(t), paths = await receiptSet(root); await fs.rm(paths[0]); await fs.symlink(paths[1], paths[0]);
  assert.ok((await collectReceipts(root, source)).failures.includes('receipt_invalid'));
  await fs.rm(paths[0]); await fs.writeFile(paths[0], JSON.stringify(validReceipt('current-baseline-upgrade')));
  assert.ok((await collectReceipts(root, source)).failures.includes('receipt_invalid'));
});
test('invocations accept symlinked ancestors but reject symlink leaves and artifact/runtime aliases', async t => {
  const root = await owned(t), physical = resolve(root, 'physical'), alias = resolve(root, 'alias');
  await fs.mkdir(physical); await fs.symlink(physical, alias);
  const env = { RAINSYNC_ARTIFACT_DIR: resolve(alias, 'artifacts'), RAINSYNC_RUNTIME_ROOT: resolve(alias, 'runtime') };
  const paths = await createInvocation(env); assert.ok(paths.artifacts.startsWith(physical));
  await assert.rejects(createInvocation({ ...env, RAINSYNC_RUNTIME_ROOT: resolve(alias, 'artifacts', 'inside') }));
  await assert.rejects(createInvocation({ ...env, RAINSYNC_ARTIFACT_DIR: alias }));
});

async function operationFixture(t, options = {}) {
  const root = await owned(t), calls = [], original = Error('SYNTHETIC_SECRET');
  const operation = name => async report => { calls.push(name); if (options.fail === name || options.failures?.includes(name)) throw Object.hasOwn(options, 'value') ? options.value : original; report[name] = true; };
  const io = { ...fs,
    async writeFile(path, bytes, settings) { if (options.write === (String(path).endsWith('.tmp') ? 'final' : 'initial')) throw original; return fs.writeFile(path, bytes, settings); },
    async rename(...args) { if (options.rename) throw original; return fs.rename(...args); },
  };
  const operations = Object.fromEntries(['prepare', 'invoke', 'receipts', 'verify', 'exports'].map(name => [name, operation(name)]));
  operations.save = async (report, final) => { calls.push(final ? 'final-save' : 'initial-save'); return saveReport(root, report, final, io); };
  const report = await orchestrate(operations); let disk;
  try { disk = JSON.parse(await fs.readFile(resolve(root, 'report.json'), 'utf8')); } catch { /* no final path on initial failure */ }
  assert.doesNotMatch(JSON.stringify({ report, disk }), /SYNTHETIC_SECRET|"error"|"message"|"stack"|"cause"/);
  return { root, calls, report, disk };
}
test('successful orchestration finalizes only after all verification/export work', async t => {
  const result = await operationFixture(t); assert.equal(result.report.result, 'passed'); assert.equal(result.disk.result, 'passed');
  assert.deepEqual(result.calls, ['initial-save', 'prepare', 'invoke', 'receipts', 'verify', 'exports', 'final-save']);
});
for (const phase of ['prepare', 'invoke', 'receipts', 'verify', 'exports']) test(`orchestration ${phase} failure persists independently`, async t => {
  const result = await operationFixture(t, { fail: phase }); assert.equal(result.report.result, 'failed'); assert.equal(result.disk.result, 'failed');
  assert.ok(result.calls.includes('exports')); assert.equal(result.calls.at(-1), 'final-save');
  if (phase === 'prepare') assert.ok(!result.calls.includes('invoke'));
  else assert.ok(result.calls.includes('verify'));
});
for (const options of [{ write: 'initial' }, { write: 'final' }, { rename: true }, { fail: 'invoke', write: 'final' }]) test(`on-disk final report stays nonpassed on ${JSON.stringify(options)}`, async t => {
  const result = await operationFixture(t, options); assert.equal(result.report.result, 'failed');
  assert.ok(!result.disk || result.disk.result === 'failed');
  if (options.write === 'initial') assert.ok(!result.calls.includes('invoke'));
  else assert.equal(result.disk.state, 'incomplete');
});

for (const value of [undefined, null, false, 0, '']) test(`falsy ${String(value)} command rejection stays failed and still verifies`, async t => {
  const result = await operationFixture(t, { fail: 'invoke', value });
  assert.equal(result.report.result, 'failed'); assert.equal(result.disk.result, 'failed'); assert.ok(result.calls.includes('verify'));
});
test('child, final-binding, export and finalization failures are independent observations', async t => {
  const result = await operationFixture(t, { failures: ['invoke', 'verify', 'exports'], rename: true });
  assert.deepEqual(result.report.failures, ['native_gate_failed', 'final_binding_failed', 'safe_export_failed', 'final_evidence_failed']);
  assert.equal(result.disk.state, 'incomplete'); assert.equal(result.disk.result, 'failed');
});
for (const name of pgTools) test(`non-executable ${name} is rejected before tool execution`, async t => {
  const fixture = await fakeInstallation(t), path = resolve(fixture.bin, name);
  await fs.rm(path); await fs.writeFile(path, 'owned non-executable bytes', { mode: 0o600 });
  await assert.rejects(captureBindings(fixture.src, fixture.env, fixture.runCommand)); assert.deepEqual(fixture.calls, []);
});
test('each invocation has a unique empty receipt directory; old reports cannot satisfy a new run', async t => {
  const root = await owned(t), env = { RAINSYNC_ARTIFACT_DIR: resolve(root, 'artifacts'), RAINSYNC_RUNTIME_ROOT: resolve(root, 'runtime') };
  const first = await createInvocation(env); await receiptSet(first.receipts);
  const second = await createInvocation(env); assert.notEqual(first.receipts, second.receipts);
  assert.deepEqual(await fs.readdir(second.receipts), []);
  assert.ok((await collectReceipts(second.receipts, source)).failures.includes('receipt_inventory_failed'));
});

async function fakePair(t, body) {
  const root = await owned(t); await fs.mkdir(resolve(root, 'tests'));
  for (let index = 0; index < leaves.length; index++) {
    await fs.writeFile(resolve(root, leaves[index]), `import test from 'node:test';\n${body(index)}\n`);
  }
  return { root, timeout: '/usr/bin/timeout', node: process.execPath, env: { PATH: '/usr/bin:/bin', LANG: 'C' } };
}
test('actual bounded command observer reads complete child TAP from owned no-service leaves', async t => {
  const fixture = await fakePair(t, index => gateNames.slice(index * 4, (index + 1) * 4).map(name => `test(${JSON.stringify(name)}, () => {});`).join('\n'));
  assert.equal((await observeNativePair(fixture)).counts.pass, 8);
});
test('actual bounded command observer rejects child failure, not a fabricated green summary', async t => {
  const fixture = await fakePair(t, () => `test('owned negative control', () => { throw Error('SYNTHETIC_SECRET'); });`);
  await assert.rejects(observeNativePair(fixture));
});
test('actual bounded command observer rejects zero tests and overflow', async t => {
  const empty = await fakePair(t, () => ''); await assert.rejects(observeNativePair(empty));
  const verbose = await fakePair(t, () => `process.stdout.write('x'.repeat(5 * 1024 * 1024));`);
  await assert.rejects(observeNativePair(verbose));
});
test('command timeout, signal and spawn rejection cannot yield parsed successful gates', async () => {
  for (const failure of [{ code: 124 }, { signal: 'SIGTERM' }, { code: 'ENOENT' }]) {
    let captured;
    await assert.rejects(observeNativePair({ timeout: '/owned/timeout', node: '/owned/node', root: '/owned', env: {} }, async (...args) => {
      captured = args; throw Object.assign(Error('SYNTHETIC_SECRET'), failure);
    }));
    assert.deepEqual(captured[1], nativeArgs('/owned/node'));
    assert.equal(captured[2].timeout, 197000); assert.equal(captured[2].maxBuffer, 4 * 1024 * 1024);
  }
});
test('actual CLI missing owned utilities records failure before running any test leaf', async t => {
  const fixture = await fakeInstallation(t); await fs.rm(resolve(fixture.bin, 'postgres'));
  const artifacts = resolve(fixture.root, 'artifacts'), runtime = resolve(fixture.root, 'runtime');
  const result = spawnSync(process.execPath, ['scripts/verification/upgrade-recovery.mjs'], {
    cwd: repo, timeout: 3000, encoding: 'utf8', env: { PATH: fixture.bin, RAINSYNC_NATIVE_POSTGRES_BIN: fixture.bin,
      RAINSYNC_ARTIFACT_DIR: artifacts, RAINSYNC_RUNTIME_ROOT: runtime },
  });
  assert.equal(result.status, 1);
  const ids = await fs.readdir(artifacts); assert.equal(ids.length, 1);
  const report = JSON.parse(await fs.readFile(resolve(artifacts, ids[0], 'report.json')));
  assert.equal(report.result, 'failed'); assert.deepEqual(report.failures, ['prerequisites_or_binding_failed']);
  assert.equal(report.gates, undefined); assert.deepEqual(await fs.readdir(resolve(artifacts, ids[0], 'receipts-private')), []);
  assert.doesNotMatch(JSON.stringify(report), /"error"|"message"|"stack"|"cause"/);
});

// Exact upstream packaging fixtures, including their license notices.
// https://salsa.debian.org/postgresql/postgresql-common/-/blob/master/pg_config
const debianDispatcher = "#!/bin/sh\n\n# If postgresql-server-dev-* is installed, call pg_config from the latest\n# available one. Otherwise fall back to libpq-dev's version.\n#\n# (C) 2011 Martin Pitt <mpitt@debian.org>\n# (C) 2014-2018 Christoph Berg <myon@debian.org>\n#\n#  This program is free software; you can redistribute it and/or modify\n#  it under the terms of the GNU General Public License as published by\n#  the Free Software Foundation; either version 2 of the License, or\n#  (at your option) any later version.\n#\n#  This program is distributed in the hope that it will be useful,\n#  but WITHOUT ANY WARRANTY; without even the implied warranty of\n#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the\n#  GNU General Public License for more details.\n\nset -e\nPGBINROOT=\"/usr/lib/postgresql/\"\n#redhat# PGBINROOT=\"/usr/pgsql-\"\nLATEST_SERVER_DEV=`ls -v $PGBINROOT*/bin/pg_config 2>/dev/null|tail -n1`\n\nif [ -n \"$LATEST_SERVER_DEV\" ]; then\n    exec \"$LATEST_SERVER_DEV\" \"$@\"\nelse\n    if [ -x /usr/bin/pg_config.libpq-dev ]; then\n\texec /usr/bin/pg_config.libpq-dev \"$@\"\n    else\n\techo \"You need to install postgresql-server-dev-NN for building a server-side extension or libpq-dev for building a client-side application.\" >&2\n\texit 1\n    fi\nfi\n";
// https://salsa.debian.org/postgresql/postgresql-common/-/blob/master/server/pg_config.pl
const debianProviderPrefix = "#!/usr/bin/perl\n\n# Perl reimplementation of PostgreSQL's pg_config binary.\n# We provide this as /usr/bin/pg_config to support cross-compilation using\n# libpq-dev. Also, this makes the two installed pg_config copies not conflict\n# via their debugging symbols.\n#\n# This code is released under the terms of the PostgreSQL License.\n# Portions Copyright (c) 1996-2017, PostgreSQL Global Development Group\n# Author: Christoph Berg\n\nuse strict;\nuse warnings;\n\n# no arguments, print all items\nif (@ARGV == 0) {\n\twhile (<DATA>) {\n\t\tlast if /^$/; # begin of help section\n\t\tprint;\n\t}\n\texit 0;\n}\n\n# --help or -?\nif (grep {$_ =~ /^(--help|-\\?)$/} @ARGV) {\n\twhile (<DATA>) {\n\t\tlast if /^$/; # begin of help section\n\t}\n\tprint; # include empty line in output\n\twhile (<DATA>) {\n\t\tnext if /^Report bugs/; # Skip bug address in the perl version\n\t\tprint;\n\t}\n\texit 0;\n}\n\n# specific value(s) requested\nmy %options;\nmy $help;\nwhile (<DATA>) {\n\tlast if /^$/; # begin of help section\n\t/^(\\S+) = (.*)/ or die \"malformatted data item\";\n\t$options{'--' . lc $1} = $2;\n}\n\nforeach my $arg (@ARGV) {\n\tunless ($options{$arg}) {\n\t\tprint \"pg_config: invalid argument: $arg\\n\";\n\t\tprint \"Try \\\"pg_config --help\\\" for more information.\\n\";\n\t\texit 1;\n\t}\n\tprint \"$options{$arg}\\n\";\n}\n\nexit 0;\n\n# The DATA section consists of the `pg_config` output (one KEY = value item per\n# line), and the `pg_config --help` text. The first --help line is empty, which\n# we use to detect the beginning of the help section.\n\n__DATA__\n";

async function metadataFixture(t) {
  const root = await owned(t), providers = resolve(root, 'versions'), bin = resolve(root, 'bin');
  await fs.mkdir(providers); await fs.mkdir(bin);
  for (const name of ['ls', 'tail']) await fs.symlink(`/usr/bin/${name}`, resolve(bin, name));
  const metadata = { '--version': 'PostgreSQL 17.11', '--bindir': bin, '--sharedir': root, '--pkglibdir': root };
  const data = Object.entries(metadata).map(([key, value]) => `${key.slice(2).toUpperCase()} = ${value}`).join('\n') + '\n\nowned help\n';
  const body = debianProviderPrefix + data;
  const targets = [];
  for (const version of ['9', '10']) {
    const path = resolve(providers, version, 'bin/pg_config'); await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, body, { mode: 0o700 }); targets.push(path);
  }
  const fallback = resolve(root, 'pg_config.libpq-dev'); await fs.writeFile(fallback, body, { mode: 0o700 });
  const selector = resolve(bin, 'pg_config');
  await fs.writeFile(selector, debianDispatcher.replaceAll('/usr/lib/postgresql/', `${providers}/`).replaceAll('/usr/bin/pg_config.libpq-dev', fallback), { mode: 0o700 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C' };
  const run = async (program, args) => {
    const result = spawnSync(program, args, { env, cwd: root, timeout: 2000, encoding: 'utf8' });
    assert.equal(result.status, 0); return result.stdout.trim();
  };
  const take = callback => resolvePgConfig(selector, env, callback ?? run, AbortSignal.timeout(10000), root);
  return { root, providers, bin, targets, fallback, selector, env, metadata, run, take };
}
test('actual Debian dispatcher selects natural highest provider and binds real Perl/modules/metadata', async t => {
  const f = await metadataFixture(t), result = await f.take();
  assert.equal(result.kind, 'debian-dispatcher-perl'); assert.equal(result.provider, f.targets[1]);
  assert.deepEqual(result.metadata, f.metadata); assert.equal(result.candidates.length, 2);
  assert.equal(result.modules.length, 2); assert.equal(result.scriptPaths.length, 2);
  assert.deepEqual(result.extraTools.map(item => item.name), ['pg_config_shell', 'pg_config_ls', 'pg_config_tail', 'pg_config_perl', 'pg_config_provider']);
  const ldd = spawnSync('/usr/bin/ldd', [f.selector], { env: f.env, timeout: 2000, encoding: 'utf8' });
  assert.notEqual(ldd.status, 0); // Actual regression against v1's unconditional ldd.
});
test('actual Debian fallback handles absent version root and generated metadata provider', async t => {
  const f = await metadataFixture(t); await fs.rename(f.providers, `${f.providers}-unused`);
  const result = await f.take(); assert.equal(result.provider, f.fallback); assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.metadata, f.metadata);
});
test('direct recognized Perl provider and direct ELF selector retain distinct bindings', async t => {
  const f = await metadataFixture(t);
  const perl = await resolvePgConfig(f.fallback, f.env, f.run, AbortSignal.timeout(10000), f.root);
  assert.equal(perl.kind, 'debian-perl'); assert.equal(perl.modules.length, 2);
  const elf = await resolvePgConfig(process.execPath, f.env, async (_, args) => f.metadata[args[0]]);
  assert.equal(elf.kind, 'elf'); assert.deepEqual(elf.scriptPaths, []); assert.deepEqual(elf.extraTools, []);
});
for (const scenario of ['nonexecutable-highest', 'broken-highest', 'missing-fallback', 'unknown-shell', 'unknown-perl', 'wrong-shebang', 'metadata-mismatch', 'missing-module', 'missing-dispatch-tool']) {
  test(`pg_config resolver rejects ${scenario} without falling back or starting a service`, async t => {
    const f = await metadataFixture(t); let run = f.run;
    if (scenario === 'nonexecutable-highest') await fs.chmod(f.targets[1], 0o600);
    if (scenario === 'broken-highest') { await fs.rm(f.targets[1]); await fs.symlink(resolve(f.root, 'absent'), f.targets[1]); }
    if (scenario === 'missing-fallback') { await fs.rename(f.providers, `${f.providers}-unused`); await fs.rm(f.fallback); }
    if (scenario === 'unknown-shell') await fs.appendFile(f.selector, '\necho unknown\n');
    if (scenario === 'unknown-perl') await fs.writeFile(f.targets[1], (await fs.readFile(f.targets[1], 'utf8')).replace('use strict;', 'use strict; print "bad";'));
    if (scenario === 'wrong-shebang') await fs.writeFile(f.selector, (await fs.readFile(f.selector, 'utf8')).replace('#!/bin/sh', '#!/usr/bin/env sh'));
    if (scenario === 'metadata-mismatch') run = (program, args) => program === f.selector && args[0] === '--version' ? Promise.resolve('PostgreSQL 18.1') : f.run(program, args);
    if (scenario === 'missing-module') run = (program, args) => args[0] === '-e' ? Promise.resolve(`${f.root}/missing-strict.pm\n${f.root}/missing-warnings.pm`) : f.run(program, args);
    if (scenario === 'missing-dispatch-tool') { await fs.rm(resolve(f.bin, 'ls')); f.env.PATH = f.bin; }
    await assert.rejects(f.take(run));
  });
}
test('pg_config snapshot binds full candidate inventory and provider/module dependencies', async t => {
  const f = await metadataFixture(t), before = await f.take();
  const lower = await fs.readFile(f.targets[0]); await fs.appendFile(f.targets[0], '\nunused data change\n');
  const changed = await f.take(); assert.throws(() => assertBindingsUnchanged(changed, before));
  await fs.writeFile(f.targets[0], lower); assertBindingsUnchanged(await f.take(), before);
  await fs.writeFile(f.targets[1], (await fs.readFile(f.targets[1], 'utf8')).replace('PostgreSQL 17.11', 'PostgreSQL 18.1'));
  const providerChanged = await f.take(); assert.throws(() => assertBindingsUnchanged(providerChanged, before));
});
test('actual CLI missing absolute PG directory finalizes a safe failed report before any leaf', async t => {
  const root = await owned(t), artifacts = resolve(root, 'artifacts'), runtime = resolve(root, 'runtime');
  const result = spawnSync(process.execPath, ['scripts/verification/upgrade-recovery.mjs'], {
    cwd: repo, timeout: 3000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin',
      RAINSYNC_NATIVE_POSTGRES_BIN: resolve(root, 'missing'), RAINSYNC_ARTIFACT_DIR: artifacts, RAINSYNC_RUNTIME_ROOT: runtime } });
  assert.equal(result.status, 1);
  const ids = await fs.readdir(artifacts); assert.equal(ids.length, 1);
  const report = JSON.parse(await fs.readFile(resolve(artifacts, ids[0], 'report.json')));
  assert.equal(report.result, 'failed'); assert.equal(report.state, 'complete');
  assert.ok(report.failures.includes('prerequisites_or_binding_failed')); assert.equal(report.gates, undefined);
  assert.deepEqual(await fs.readdir(resolve(runtime, ids[0], 'scratch')), []);
  assert.doesNotMatch(JSON.stringify(report), /"error"|"message"|"stack"|"cause"/);
});
test('ELF ldd failures remain fatal in actual binding', async t => {
  const f = await fakeInstallation(t);
  await assert.rejects(captureBindings(f.src, f.env, async (program, args, ...rest) => {
    if (program === resolve(f.bin, 'ldd') && args[0] === resolve(f.bin, 'pg_config')) throw Error('owned ldd failure');
    return f.runCommand(program, args, ...rest);
  }));
});
test('full binding accepts recognized dispatcher while binding its ELF dependencies and failing their ldd errors', async t => {
  const f = await metadataFixture(t), sourceFixture = await fakeInstallation(t);
  for (const name of ['git', 'timeout', 'ldd', ...pgTools]) await fs.writeFile(resolve(f.bin, name), Buffer.from('\x7fELFowned non-executed tool bytes'), { mode: 0o700 });
  const run = async (program, args) => {
    if ([f.selector, ...f.targets, f.fallback, await fs.realpath('/bin/sh'), await fs.realpath('/usr/bin/perl')].includes(program)) return f.run(program, args);
    if (program === resolve(f.bin, 'ldd') && args[0] !== '--version') return `${sourceFixture.library} (0x0001)`;
    return sourceFixture.runCommand(resolve(sourceFixture.bin, program.split('/').at(-1)), args);
  };
  const env = { ...f.env, RAINSYNC_NATIVE_POSTGRES_BIN: f.bin };
  const before = await captureBindings(sourceFixture.src, env, run);
  assert.equal(before.pg_config_binding.kind, 'debian-dispatcher-perl');
  assert.ok(before.tools.find(row => row.name === 'pg_config_perl').dependencies.includes(sourceFixture.library));
  assert.equal(before.tools.find(row => row.name === 'pg_config').dependencies, undefined);
  assert.equal(before.tools.find(row => row.name === 'pg_config_provider').dependencies, undefined);
  await assert.rejects(captureBindings(sourceFixture.src, env, async (program, args) => {
    if (program === resolve(f.bin, 'ldd') && args[0] === await fs.realpath('/usr/bin/perl')) throw Error('owned interpreter dependency failure');
    return run(program, args);
  }));
});
