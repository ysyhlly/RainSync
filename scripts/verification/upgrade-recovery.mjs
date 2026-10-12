// Domain-owned verification only. No application/deployment operation is exposed.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const publishedBaseline = 'bc0f9f1d8683ee27be581661d0e9dde36088fe55';
export const leaves = Object.freeze(['tests/recovery-integrity.test.mjs', 'tests/current-baseline-upgrade.test.mjs']);
export const gateNames = Object.freeze([
  'source and platform encrypted fields use one fixed startup/recovery inventory',
  'private malformed input and arbitrary assertion diagnostics never leave safe error boundaries',
  'every encrypted field rejects wrong keys and corrupt bytes before backup output exists',
  'pairing and revocation between material validation and dump preserve the captured recovery point',
  'recovery ciphertext validation rejects noncanonical base64 and invalid UTF-8',
  'lost snapshot exporter cannot produce a complete backup manifest',
  'full immutable migration history is checked against the recent published baseline and candidate SHA',
  'populated recent baseline upgrades and restores separately while old-schema preflight remains closed',
]);
export const pgTools = Object.freeze(['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore', 'createdb']);
export const nativeArgs = node => ['--signal=TERM', '--kill-after=15s', '180s', node, '--test', '--test-reporter=tap', ...leaves];
export const bindingSourceFiles = [...leaves, 'tests/fixtures/postgres.mjs', 'tests/fixtures/unused-port.mjs',
  'tests/fixtures/safe-failure.mjs', 'tests/fixtures/upgrade-recovery-evidence.mjs',
  'deploy/postgres-recovery.mjs', 'deploy/recovery-set.mjs',
  'apps/server/src/source-key-inventory.json', 'apps/server/src/source_key_check.rs',
  'scripts/verification/upgrade-recovery.mjs', 'tests/verification-layers.test.mjs',
  'package.json', '.github/workflows/ci.yml'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = (value, allowed) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(Object.keys(value).every(key => allowed.includes(key)));
};
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
const bool = value => assert.equal(typeof value, 'boolean');
const oneOf = (value, allowed) => assert.ok(allowed.includes(value));

export function parseGateResults(text) {
  assert.equal(typeof text, 'string');
  assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024);
  assert.deepEqual(text.split('\n').filter(line => line.startsWith('TAP version ')), ['TAP version 13']);
  assert.deepEqual(text.split('\n').filter(line => /^\d+\.\./.test(line)), ['1..8']);
  const rows = [...text.matchAll(/^(ok|not ok) (\d+) - (.+)$/gm)];
  assert.equal(rows.length, 8);
  assert.equal(text.split('\n').filter(line => /^(?:ok|not ok)\b/.test(line)).length, rows.length);
  assert.deepEqual(rows.map(row => Number(row[2])), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(rows.every(row => row[1] === 'ok'));
  assert.deepEqual(rows.map(row => row[3]).toSorted(), [...gateNames].toSorted());
  assert.doesNotMatch(text, /^\s*(?:not ok\b|(?:ok|not ok)\b.*#\s*(?:SKIP|TODO)\b)/m);
  const counts = {};
  for (const [key, value] of Object.entries({ tests: 8, suites: 0, pass: 8, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    assert.deepEqual(text.split('\n').filter(line => line.startsWith(`# ${key} `)), [`# ${key} ${value}`]);
    const found = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    assert.equal(found.length, 1); assert.equal(Number(found[0][1]), value); counts[key] = value;
  }
  return { names: rows.map(row => row[3]), counts };
}

export function validateSelection(env, platform = process.platform, nodeVersion = process.versions.node) {
  assert.equal(platform, 'linux'); assert.match(nodeVersion, /^24\./);
  for (const key of ['RAINSYNC_NATIVE_POSTGRES_BIN', 'RAINSYNC_ARTIFACT_DIR', 'RAINSYNC_RUNTIME_ROOT'])
    assert.ok(typeof env[key] === 'string' && isAbsolute(env[key]) && !/[\0\r\n]/.test(env[key]));
  assert.ok(!env.DATABASE_URL && !env.RAINSYNC_RECOVERY_INPUT_FILE);
}
export function coherentVersions(versions) {
  assert.equal(versions.length, pgTools.length + 1);
  const parsed = versions.map(value => {
    const found = /^(?:PostgreSQL|[a-z_]+ \(PostgreSQL\)) (\d+(?:\.\d+){1,2})(?:\s[^\r\n]*)?$/.exec(value.trim());
    assert.ok(found); return found[1];
  });
  // Coherence, not a new PG major pin: the existing prerequisite chooses it.
  assert.ok(parsed.every(value => value === parsed[0])); return parsed[0];
}
export function validateHistory({ head, shallow, ancestor }) {
  assert.match(head, /^[a-f0-9]{40}$/); assert.equal(shallow, 'false'); assert.equal(ancestor, true);
}

const receiptFailures = ['fixture_failed', 'cleanup_failed', 'cleanup_verification_failed',
  'fixture_ownership_failed', 'fixture_removal_failed', 'evidence_write_failed'];
export function inspectReceipt(value, fixture, source) {
  keys(value, ['schema_version', 'fixture', 'state', 'result', 'test_outcome', 'cleanup_outcome',
    'failures', 'cleanup', 'disposal', 'baseline_commit', 'candidate_commit', 'migrations', 'application_acceptance', 'scope']);
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, fixture);
  oneOf(value.state, ['incomplete', 'complete']); oneOf(value.result, ['passed', 'failed']);
  oneOf(value.test_outcome, ['passed', 'failed']); oneOf(value.cleanup_outcome, ['verified', 'failed']);
  assert.ok(Array.isArray(value.failures) && value.failures.every(code => receiptFailures.includes(code)));
  keys(value.cleanup, ['completed', 'kind', 'stopped', 'process_close_observed', 'pid_absent', 'pg_ctl_status', 'port_closed', 'exit_code', 'signal', 'removed']);
  for (const [key, val] of Object.entries(value.cleanup)) {
    if (key === 'kind') oneOf(val, ['native', 'docker']);
    else if (key === 'pg_ctl_status') assert.ok(val === null || (Number.isInteger(val) && val >= 0 && val <= 255));
    else if (key === 'exit_code') assert.ok(val === null || (Number.isInteger(val) && val >= -255 && val <= 255));
    else if (key === 'signal') oneOf(val, [null, 'SIGINT', 'SIGTERM', 'SIGKILL']);
    else bool(val);
  }
  keys(value.disposal, ['outcome', 'removed', 'retained']);
  oneOf(value.disposal.outcome, ['not_attempted', 'removed', 'unknown']);
  for (const key of ['removed', 'retained']) if (value.disposal[key] !== undefined && value.disposal[key] !== null) bool(value.disposal[key]);
  if (fixture === 'current-baseline-upgrade') {
    assert.equal(value.baseline_commit, publishedBaseline); assert.equal(value.candidate_commit, source.head);
    assert.equal(value.application_acceptance, false); assert.deepEqual(value.migrations, source.migrations);
    if (value.scope !== undefined) assert.equal(value.scope, 'synthetic populated schema/checksum upgrade 0086→0088 and separate original/candidate encrypted restore; no executable or real deployment acceptance');
  } else {
    for (const key of ['baseline_commit', 'candidate_commit', 'migrations', 'application_acceptance', 'scope']) assert.equal(value[key], undefined);
  }
  const cleanup = { ...value.cleanup }, disposal = { ...value.disposal };
  const safe = { schema_version: 1, fixture, state: value.state, result: value.result,
    test_outcome: value.test_outcome, cleanup_outcome: value.cleanup_outcome,
    failures: [...value.failures], cleanup, disposal };
  if (fixture === 'current-baseline-upgrade') Object.assign(safe, {
    baseline_commit: value.baseline_commit, candidate_commit: value.candidate_commit, application_acceptance: false,
  });
  const passed = value.state === 'complete' && value.result === 'passed' && value.test_outcome === 'passed'
    && value.cleanup_outcome === 'verified' && value.failures.length === 0 && cleanup.kind === 'native'
    && ['completed', 'stopped', 'process_close_observed', 'pid_absent', 'port_closed'].every(key => cleanup[key] === true)
    && cleanup.pg_ctl_status === 3 && disposal.outcome === 'removed' && disposal.removed === true && disposal.retained === false;
  return { safe, passed };
}

export async function collectReceipts(directory, source) {
  const exports = [], counts = { 'recovery-integrity': 0, 'current-baseline-upgrade': 0 }, failures = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const match = /^(recovery-integrity|current-baseline-upgrade)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.exec(name);
    if (!match) { failures.push('receipt_inventory_failed'); continue; }
    const fixture = match[1], file = resolve(directory, name); counts[fixture]++;
    let digest;
    try {
      const stat = await fs.lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
      const bytes = await fs.readFile(file); digest = sha(bytes);
      const after = await fs.lstat(file); assert.equal(stat.dev, after.dev); assert.equal(stat.ino, after.ino);
      const { safe, passed } = inspectReceipt(JSON.parse(bytes), fixture, source);
      exports.push({ name: `${fixture}-${counts[fixture]}.json`, value: { ...safe, source_sha256: digest } });
      if (!passed) failures.push('fixture_cleanup_or_test_failed');
    } catch {
      failures.push('receipt_invalid');
      exports.push({ name: `${fixture}-${counts[fixture]}.json`, value: {
        schema_version: 1, fixture, result: 'failed', category: 'receipt_invalid', ...(digest ? { source_sha256: digest } : {}),
      } });
    }
  }
  if (counts['recovery-integrity'] !== 3 || counts['current-baseline-upgrade'] !== 1) failures.push('receipt_inventory_failed');
  return { exports, counts, failures };
}

async function regularFile(path, signal) {
  signal?.throwIfAborted(); const before = await fs.lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink());
  const bytes = await fs.readFile(path, { signal }); const after = await fs.lstat(path);
  assert.equal(before.dev, after.dev); assert.equal(before.ino, after.ino);
  return { path, sha256: sha(bytes) };
}
async function executable(path) {
  const canonical = await fs.realpath(path); await fs.access(canonical, constants.X_OK);
  assert.ok((await fs.stat(canonical)).isFile()); return canonical;
}
async function fromPath(name, env) {
  for (const part of (env.PATH ?? '').split(':').filter(isAbsolute)) {
    try { return await executable(resolve(part, name)); } catch { /* continue the actual PATH search */ }
  }
  throw Error('tool_selection_failed');
}
async function command(program, args, env, signal, cwd = repository) {
  const result = await execute(program, args, { cwd, env, signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  return result.stdout.trim();
}
async function resourceInventory(root, signal) {
  const rows = []; let bytes = 0;
  async function visit(directory) {
    signal.throwIfAborted();
    for (const name of (await fs.readdir(directory)).sort()) {
      const path = resolve(directory, name), stat = await fs.lstat(path);
      assert.ok(rows.length < 10000); bytes += stat.size; assert.ok(bytes <= 128 * 1024 * 1024);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isSymbolicLink()) {
        const canonical = await fs.realpath(path); assert.ok((await fs.stat(canonical)).isFile());
        rows.push({ ...(await regularFile(canonical, signal)), path, link: await fs.readlink(path), canonical });
      } else rows.push(await regularFile(path, signal));
    }
  }
  await visit(root); return rows;
}
// Debian postgresql-common's fixed dispatcher and generated metadata provider.
// Primary source: https://salsa.debian.org/postgresql/postgresql-common
// Only these reviewed code shapes avoid ldd; every ELF ldd failure stays fatal.
const codeLines = text => text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
const elf = bytes => bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
const metadataOptions = ['--version', '--bindir', '--sharedir', '--pkglibdir'];
export async function resolvePgConfig(selector, env, runCommand = command, signal = AbortSignal.timeout(20000), cwd = repository) {
  const extraTools = [], scriptPaths = [], modules = [], candidates = [];
  let provider = selector, kind = 'elf';
  const bytes = await fs.readFile(selector, { signal });
  if (!elf(bytes)) {
    assert.ok(bytes.length <= 1024 * 1024);
    const text = bytes.toString('utf8');
    if (text.startsWith('#!/bin/sh\n')) {
      const base = /^PGBINROOT="(\/[A-Za-z0-9_./-]+\/)"$/m.exec(text);
      const fallback = /^\s*if \[ -x (\/[A-Za-z0-9_./-]+) \]; then$/m.exec(text);
      assert.ok(base && fallback);
      const normalized = text.replaceAll(base[1], '@ROOT@').replaceAll(fallback[1], '@FALLBACK@');
      assert.equal(sha(codeLines(normalized)), '7f0d392e263f8c9ced24ea9bd4715e1254b53e4b2aef60dc560eb28e83df3f52');
      const shell = await executable('/bin/sh'), ls = await fromPath('ls', env), tail = await fromPath('tail', env);
      extraTools.push({ name: 'pg_config_shell', path: shell }, { name: 'pg_config_ls', path: ls }, { name: 'pg_config_tail', path: tail });
      scriptPaths.push(selector); kind = 'debian-dispatcher';
      let entries;
      try { entries = await fs.readdir(base[1]); } catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
      for (const entry of entries.sort()) {
        // Match the shell's complete non-dot glob. Do not filter by executable:
        // a broken/non-executable highest item must fail, never select an older one.
        if (entry.startsWith('.')) continue;
        const path = resolve(base[1], entry, 'bin/pg_config');
        try { await fs.lstat(path); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
        const canonical = await fs.realpath(path), stat = await fs.stat(canonical);
        assert.ok(stat.isFile());
        candidates.push({ path, canonical, mode: stat.mode, ...(await regularFile(canonical, signal)) });
        candidates.at(-1).path = path;
      }
      let selected = fallback[1];
      if (candidates.length) {
        // Reuse the actual selected ls -v / tail -n1 behavior, not JS ordering.
        selected = await runCommand(shell, ['-c', 'ls=$1; tail=$2; shift 2; "$ls" -v "$@" | "$tail" -n1',
          'pg-config-selection', ls, tail, ...candidates.map(item => item.path)], env, signal, cwd);
        assert.ok(candidates.some(item => item.path === selected));
      }
      provider = await executable(selected);
    }
  }
  const providerBytes = await fs.readFile(provider, { signal });
  if (!elf(providerBytes)) {
    assert.ok(providerBytes.length <= 1024 * 1024);
    const text = providerBytes.toString('utf8'), sections = text.split('\n__DATA__\n');
    assert.equal(sections.length, 2); assert.ok(text.startsWith('#!/usr/bin/perl\n'));
    assert.equal(sha(codeLines(sections[0])), 'f87267ef892aa5c3d9a3a9eea1acb92abe03f56d8f74cac470eaa93e2c7b5b82');
    // DATA stays data: only the real provider interprets/query-selects it.
    const perl = await executable('/usr/bin/perl');
    extraTools.push({ name: 'pg_config_perl', path: perl }); scriptPaths.push(provider);
    kind = kind === 'debian-dispatcher' ? 'debian-dispatcher-perl' : 'debian-perl';
    const paths = (await runCommand(perl, ['-e', 'use strict; use warnings; print "$INC{q(strict.pm)}\\n$INC{q(warnings.pm)}\\n";'], env, signal, cwd)).split('\n');
    assert.equal(paths.length, 2);
    for (const path of paths) { assert.ok(isAbsolute(path)); modules.push(await regularFile(await fs.realpath(path), signal)); }
  }
  if (provider !== selector) extraTools.push({ name: 'pg_config_provider', path: provider });
  for (const item of extraTools) if (!scriptPaths.includes(item.path)) assert.ok(elf(await fs.readFile(item.path, { signal })));
  const metadata = {};
  for (const option of metadataOptions) {
    metadata[option] = await runCommand(selector, [option], env, signal, cwd);
    if (provider !== selector) assert.equal(await runCommand(provider, [option], env, signal, cwd), metadata[option]);
  }
  return { kind, selector, provider, candidates, metadata, extraTools, scriptPaths: [...new Set(scriptPaths)], modules };
}

export async function captureBindings(root, env, runCommand = command) {
  const signal = AbortSignal.timeout(20000);
  const selected = { node: await executable(process.execPath), git: await fromPath('git', env),
    timeout: await fromPath('timeout', env), pg_config: await fromPath('pg_config', env), ldd: await fromPath('ldd', env) };
  const bindir = await fs.realpath(env.RAINSYNC_NATIVE_POSTGRES_BIN);
  for (const name of pgTools) selected[name] = await executable(resolve(bindir, name));
  const pgConfig = await resolvePgConfig(selected.pg_config, env, runCommand, signal, root);
  assert.equal(await fs.realpath(pgConfig.metadata['--bindir']), bindir);
  const versions = [];
  versions.push(pgConfig.metadata['--version']);
  for (const name of pgTools) versions.push(await runCommand(selected[name], ['--version'], env, signal, root));
  const pgVersion = coherentVersions(versions);
  const head = await runCommand(selected.git, ['rev-parse', 'HEAD'], env, signal, root);
  const shallow = await runCommand(selected.git, ['rev-parse', '--is-shallow-repository'], env, signal, root);
  await runCommand(selected.git, ['cat-file', '-e', `${publishedBaseline}^{commit}`], env, signal, root);
  await runCommand(selected.git, ['merge-base', '--is-ancestor', publishedBaseline, head], env, signal, root);
  validateHistory({ head, shallow, ancestor: true });
  const migrationNames = (await fs.readdir(resolve(root, 'migrations'))).filter(name => /^\d+_[^.]+\.sql$/.test(name)).sort();
  const files = [], migrations = [];
  for (const path of [...bindingSourceFiles, ...migrationNames.map(name => `migrations/${name}`)].sort())
    files.push({ ...(await regularFile(resolve(root, path), signal)), path });
  for (const name of migrationNames) migrations.push({ name, version: Number(name.split('_')[0]),
    checksum: createHash('sha384').update(await fs.readFile(resolve(root, 'migrations', name), { signal })).digest('hex') });
  const versionsByTool = { node: process.version, pg_config: pgVersion, ...Object.fromEntries(pgTools.map(name => [name, pgVersion])) };
  for (const [name, expression] of [['git', /^git version (\d+(?:\.\d+)+)/], ['timeout', /^timeout \(GNU coreutils\) (\d+(?:\.\d+)+)/], ['ldd', /^ldd [^\r\n]* (\d+\.\d+)(?:\n|$)/]]) {
    const match = expression.exec(await runCommand(selected[name], ['--version'], env, signal, root));
    assert.ok(match); versionsByTool[name] = match[1];
  }
  const tools = [], libraries = new Set();
  for (const [name, path] of [...Object.entries(selected), ...pgConfig.extraTools.map(item => [item.name, item.path])]) {
    const row = { name, version: versionsByTool[name], ...(await regularFile(path, signal)) };
    // ldd is commonly a shell script; bind its bytes rather than running ldd on it.
    if (name !== 'ldd' && !pgConfig.scriptPaths.includes(path)) {
      const output = await runCommand(selected.ldd, [path], env, signal, root);
      assert.ok(!output.includes('not found'));
      const dependencies = [];
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/), value = parts[1] === '=>' ? parts[2] : parts[0];
        if (value?.startsWith('/')) dependencies.push(await fs.realpath(value));
      }
      row.dependencies = [...new Set(dependencies)].sort();
      for (const path of row.dependencies) libraries.add(path);
    }
    tools.push(row);
  }
  const resources = [];
  for (const option of ['--sharedir', '--pkglibdir']) {
    const path = await fs.realpath(pgConfig.metadata[option]);
    resources.push({ option, path, files: await resourceInventory(path, signal) });
  }
  const resolvedLibraries = [];
  for (const path of [...libraries].sort()) resolvedLibraries.push(await regularFile(path, signal));
  signal.throwIfAborted();
  return { schema_version: 1, source: { head, published_baseline: publishedBaseline, files, migrations },
    selected, pg_config_binding: pgConfig, pg_version: pgVersion, tools, libraries: resolvedLibraries, resources };
}

export function assertBindingsUnchanged(actual, expected) { assert.deepEqual(actual, expected); }

export async function createInvocation(env) {
  const bases = [];
  for (const key of ['RAINSYNC_ARTIFACT_DIR', 'RAINSYNC_RUNTIME_ROOT']) {
    await fs.mkdir(env[key], { recursive: true });
    const stat = await fs.lstat(env[key]); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    bases.push(await fs.realpath(env[key]));
  }
  assert.ok(!inside(bases[0], bases[1]) && !inside(bases[1], bases[0]));
  const id = randomUUID(), artifacts = resolve(bases[0], id), runtime = resolve(bases[1], id);
  await fs.mkdir(artifacts); await fs.mkdir(runtime);
  const paths = { artifacts, runtime, receipts: resolve(artifacts, 'receipts-private'),
    exports: resolve(artifacts, 'safe-fixtures'), scratch: resolve(runtime, 'scratch'), home: resolve(runtime, 'home') };
  for (const name of ['receipts', 'exports', 'scratch', 'home']) await fs.mkdir(paths[name]);
  return paths;
}
export async function saveReport(directory, report, final, io = fs) {
  const path = resolve(directory, 'report.json');
  if (!final) return io.writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await io.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await io.rename(temporary, path);
}
export async function orchestrate(operations) {
  const report = { schema_version: 1, kind: 'upgrade-recovery-verification', state: 'incomplete', result: 'failed',
    started_at: new Date().toISOString(), failures: [], application_acceptance: false };
  let initial = false, prepared = false, invoked = false;
  const attempt = async (phase, action) => {
    try { await action(); return true; }
    catch { report.failures.push(phase); return false; }
  };
  initial = await attempt('initial_evidence_failed', () => operations.save(report, false));
  if (initial) prepared = await attempt('prerequisites_or_binding_failed', () => operations.prepare(report));
  if (prepared) { invoked = true; await attempt('native_gate_failed', () => operations.invoke(report)); }
  if (invoked) await attempt('fixture_receipts_failed', () => operations.receipts(report));
  if (prepared) await attempt('final_binding_failed', () => operations.verify(report));
  await attempt('safe_export_failed', () => operations.exports(report));
  report.finished_at = new Date().toISOString(); report.state = 'complete'; report.result = report.failures.length ? 'failed' : 'passed';
  if (!await attempt('final_evidence_failed', () => operations.save(report, true))) {
    report.state = 'incomplete'; report.result = 'failed';
  }
  return report;
}

export async function observeNativePair({ timeout, node, root, env, runtime }, run = execute) {
  let result, executionFailure, executionFailed = false;
  try {
    result = await run(timeout, nativeArgs(node), {
      cwd: root, env, timeout: 197000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    });
  } catch (error) { executionFailed = true; executionFailure = error; }
  if (runtime) {
    try {
      // Private runtime evidence only: no exception message/stack, arguments or environment
      // enter the receipt or safe CI exports. execFile can return partial output on failure.
      const directory = resolve(runtime, 'native-invoke-private');
      await fs.mkdir(directory, { mode: 0o700 });
      const captured = executionFailed ? executionFailure : result;
      const stdout = typeof captured?.stdout === 'string' ? captured.stdout : '';
      const stderr = typeof captured?.stderr === 'string' ? captured.stderr : '';
      const receipt = {
        schema_version: 1, execution: executionFailed ? 'failed' : 'completed',
        exit_code: executionFailed ? (Number.isInteger(executionFailure?.code) ? executionFailure.code : null) : 0,
        signal: ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(executionFailure?.signal) ? executionFailure.signal : null,
        killed: executionFailure?.killed === true,
        stdout_available: typeof captured?.stdout === 'string', stderr_available: typeof captured?.stderr === 'string',
        stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr),
        stdout_sha256: sha(stdout), stderr_sha256: sha(stderr),
        timeout_ms: 197000, max_buffer_bytes: 4 * 1024 * 1024,
        complete: !executionFailed,
        completeness: executionFailed ? 'unconfirmed_exec_failure_may_include_timeout_or_buffer_limit' : 'captured_completed_exec_output',
      };
      const writes = await Promise.allSettled([
        fs.writeFile(resolve(directory, 'stdout.log'), stdout, { flag: 'wx', mode: 0o600 }),
        fs.writeFile(resolve(directory, 'stderr.log'), stderr, { flag: 'wx', mode: 0o600 }),
        fs.writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }),
      ]);
      const failed = writes.filter(value => value.status === 'rejected').map(value => value.reason);
      if (failed.length) throw new AggregateError(failed, 'private_invocation_evidence_write_failed');
    } catch (error) {
      if (executionFailed) throw new AggregateError([executionFailure, error], 'native_invocation_and_evidence_failed');
      throw error;
    }
  }
  if (executionFailed) throw executionFailure;
  return parseGateResults(result.stdout);
}

export async function runUpgradeRecovery({ root = repository, env = process.env } = {}) {
  validateSelection(env);
  const paths = await createInvocation(env);
  const clean = { PATH: env.PATH, HOME: paths.home, TMPDIR: paths.scratch, LANG: 'C', LC_ALL: 'C',
    RAINSYNC_NATIVE_POSTGRES_BIN: env.RAINSYNC_NATIVE_POSTGRES_BIN, RAINSYNC_ARTIFACT_DIR: paths.receipts,
    ...(env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: env.LD_LIBRARY_PATH } : {}) };
  let binding, receiptExports = [];
  return orchestrate({
    save: (report, final) => saveReport(paths.artifacts, report, final),
    async prepare(report) {
      clean.RAINSYNC_NATIVE_POSTGRES_BIN = await fs.realpath(clean.RAINSYNC_NATIVE_POSTGRES_BIN);
      const directories = [dirname(await executable(process.execPath))];
      for (const name of ['git', 'timeout', 'pg_config', 'ldd']) directories.push(dirname(await fromPath(name, clean)));
      clean.PATH = [...new Set([...directories, clean.RAINSYNC_NATIVE_POSTGRES_BIN, '/usr/bin', '/bin'])].join(':');
      binding = await captureBindings(root, clean);
      const bytes = JSON.stringify(binding, null, 2) + '\n';
      await fs.writeFile(resolve(paths.artifacts, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
      report.manifest_sha256 = sha(bytes); report.source_commit = binding.source.head;
      report.published_baseline = publishedBaseline;
    },
    async invoke(report) {
      report.gates = await observeNativePair({ timeout: binding.selected.timeout, node: binding.selected.node, root, env: clean, runtime: paths.runtime });
    },
    async receipts(report) {
      const receipt = await collectReceipts(paths.receipts, binding.source); receiptExports = receipt.exports;
      report.fixture_counts = receipt.counts;
      assert.deepEqual(receipt.failures, []);
      const retained = (await fs.readdir(paths.scratch)).filter(name => /^(?:rainsync-recovery-integrity-|rainsync-current-upgrade-)/.test(name));
      assert.deepEqual(retained, []);
      report.native_cases = 4; report.fixture_cleanup = 'verified';
    },
    async verify(report) {
      assertBindingsUnchanged(await captureBindings(root, clean), binding);
      assert.equal(sha(await fs.readFile(resolve(paths.artifacts, 'manifest.json'))), report.manifest_sha256);
      report.inputs_unchanged = true;
    },
    async exports(report) {
      for (const item of receiptExports) await fs.writeFile(resolve(paths.exports, item.name), JSON.stringify(item.value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      report.safe_fixture_exports = receiptExports.map(({ name, value }) => ({ name, source_sha256: value.source_sha256 ?? null }));
    },
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assert.equal(process.argv.length, 2); const report = await runUpgradeRecovery(); process.exitCode = report.result === 'passed' ? 0 : 1; }
  catch { console.error('upgrade_recovery_verification_failed'); process.exitCode = 1; }
}
