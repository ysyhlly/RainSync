// Exercise the real recovery/upgrade wrappers with owned substituted fixtures.
// No Cargo, PostgreSQL, browser, container or deployment process is started.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

if (typeof vm.SourceTextModule !== 'function') {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(child.stdout ?? '');
  assert.equal(child.status, 0, 'pure recovery wrapper child must pass; inspect its safe case report');
} else {
const root = path.resolve(process.env.RAINSYNC_RECOVERY_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url)));
const output = process.env.RAINSYNC_RECOVERY_PROBE_ROOT
  ? path.resolve(process.env.RAINSYNC_RECOVERY_PROBE_ROOT)
  : await fs.mkdtemp(path.join(tmpdir(), 'rainsync-recovery-probes-'));
const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
assert.match(expectedHead, /^[a-f0-9]{40}$/);
await fs.mkdir(output, {recursive: true});
const sentinel = 'P23_SYNTHETIC_SECRET_NEVER_SERIALIZE';
const errors = Object.fromEntries(['primary', 'stop', 'verify', 'write', 'rename', 'remove'].map(name => [name, new Error(`${sentinel}_${name}`)]));
const cases = [
  {name: 'success'},
  {name: 'body-failure', primary: 'body', value: errors.primary},
  {name: 'start-failure', primary: 'start', value: errors.primary},
  {name: 'body-stop-failure', primary: 'body', value: errors.primary, stop: true, verify: true},
  {name: 'start-stop-failure', primary: 'start', value: errors.primary, stop: true, verify: true},
  {name: 'verifier-failure', verify: true},
  {name: 'report-write-failure', write: 'initial'},
  {name: 'final-write-failure', write: 'final'},
  {name: 'final-rename-failure', rename: true},
  {name: 'root-removal-failure', remove: true},
  {name: 'stop-failure-positive-verification', stop: true},
  {name: 'wrong-root-guard', wrongRoot: true},
  {name: 'symlinked-temp-ancestor', symlinkAncestor: true},
  {name: 'symlink-leaf-guard', symlinkLeaf: true},
  {name: 'artifact-alias-inside-disposable-root', artifactSymlink: true},
  {name: 'report-inside-disposable-root', reportInside: true},
  {name: 'receipt-omits-raw-diagnostics', rawReceipt: true},
  {name: 'body-final-write-failure', primary: 'body', value: errors.primary, write: 'final'},
  {name: 'body-removal-failure', primary: 'body', value: errors.primary, remove: true},
  ...[['undefined', undefined], ['null', null], ['false', false], ['zero', 0], ['empty-string', '']].flatMap(([label, value]) => [
    {name: `falsy-${label}`, primary: 'body', value},
    {name: `falsy-${label}-stop`, primary: 'body', value, stop: true, verify: true},
  ]),
];
const results = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const under = (parent, candidate) => candidate === parent || candidate.startsWith(parent + path.sep);
const sourcePaths = ['tests/recovery-integrity.test.mjs', 'tests/current-baseline-upgrade.test.mjs'];
const sources = await Promise.all(sourcePaths.map(async name => ({path: name, bytes: await fs.readFile(path.join(root, name), 'utf8')})));
const sourceManifest = sources.map(({path: name, bytes}) => ({path: name, sha256: digest(bytes)}));
const helperPath = 'tests/fixtures/upgrade-recovery-evidence.mjs';
const helperBytes = await fs.readFile(path.join(root, helperPath), 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
if (helperBytes) sourceManifest.push({path: helperPath, sha256: digest(helperBytes)});
const migrationNames = (await fs.readdir(path.join(root, 'migrations'))).filter(name => /^\d+_[^.]+\.sql$/.test(name)).sort();
const migrations = migrationNames.map(name => ({version: Number(name.split('_')[0]), checksum: 'owned-probe-checksum'}));
const baselineMigrations = migrations.filter(row => row.version <= 86);

for (const source of sources) {
  const kind = source.path.includes('current-baseline') ? 'upgrade' : 'integrity';
  for (const scenario of cases) {
    const caseRoot = path.join(output, kind, scenario.name);
    await fs.mkdir(caseRoot, {recursive: true});
    const artifactRoot = path.join(caseRoot, 'artifacts');
    await fs.mkdir(artifactRoot);
    const calls = [], writes = [], registered = [], reportPaths = new Set();
    let initialDocument;
    let fixtureRoot, verified = false, caught, rejected = false, bodyEntered = false, preflightCalls = 0;
    const body = () => {
      if (bodyEntered) return;
      bodyEntered = true;
      calls.push('body');
      if (scenario.primary === 'body') throw scenario.value;
    };
    const fixture = {
      url: 'postgres://owned:synthetic@127.0.0.1:1/owned',
      async start() { calls.push('start'); if (scenario.primary === 'start') throw scenario.value; },
      sql(sql) {
        body();
        if (sql.startsWith('SELECT json_build_object')) return '{"owned":"retained"}';
        if (sql.startsWith('SELECT bool_and') || sql.startsWith('SELECT NOT COALESCE')) return 't';
        if (sql.startsWith('SELECT count(*) FROM room_guest_access')) return '0';
        return '';
      },
      async stop() { calls.push('stop'); if (scenario.stop) throw errors.stop; },
      async verifyStopped() {
        calls.push('verify');
        if (scenario.verify) throw errors.verify;
        verified = true;
        return {kind: 'native', stopped: true, process_close_observed: true, pid_absent: true, pg_ctl_status: 3, port_closed: true, ...(scenario.rawReceipt ? {error: sentinel, stack: sentinel, cause: sentinel, message: sentinel, private_data: sentinel} : {})};
      },
    };
    const fixtureFactory = ({root: ownedRoot}) => {
      fixtureRoot = path.resolve(ownedRoot);
      assert.ok(under(caseRoot, fixtureRoot));
      if (scenario.reportInside) process.env.RAINSYNC_ARTIFACT_DIR = path.join(fixtureRoot, 'evidence');
      return fixture;
    };
    const checkWrite = input => {
      const resolved = path.resolve(input instanceof URL ? fileURLToPath(input) : input);
      assert.ok(under(caseRoot, resolved), 'probe writes only inside its owned case root');
      return resolved;
    };
    const fakeFs = {
      ...fs,
      async readFile(input, ...args) {
        const resolved = path.resolve(input instanceof URL ? fileURLToPath(input) : input);
        assert.ok(under(root, resolved) || under(caseRoot, resolved));
        return fs.readFile(resolved, ...args);
      },
      async readdir(input, ...args) {
        const resolved = path.resolve(root, input instanceof URL ? fileURLToPath(input) : input);
        assert.ok(under(root, resolved) || under(caseRoot, resolved));
        return fs.readdir(resolved, ...args);
      },
      async mkdir(input, ...args) { return fs.mkdir(checkWrite(input), ...args); },
      async mkdtemp(prefix, ...args) {
        let selected = scenario.wrongRoot ? path.join(caseRoot, 'unowned-fixture-') : prefix;
        if (scenario.symlinkAncestor) {
          const physical = path.join(caseRoot, 'physical');
          const alias = path.join(caseRoot, 'temp-alias');
          await fs.mkdir(physical);
          await fs.symlink(physical, alias, 'dir');
          selected = path.join(alias, path.basename(prefix));
        }
        const created = await fs.mkdtemp(checkWrite(selected), ...args);
        if (scenario.symlinkLeaf) {
          const physical = `${created}-physical`;
          await fs.rename(created, physical);
          await fs.symlink(physical, created, 'dir');
        }
        if (scenario.artifactSymlink) {
          const inside = path.join(created, 'evidence');
          const alias = path.join(caseRoot, 'artifact-alias');
          await fs.mkdir(inside);
          await fs.symlink(inside, alias, 'dir');
          process.env.RAINSYNC_ARTIFACT_DIR = alias;
        }
        return created;
      },
      async writeFile(input, bytes, ...args) {
        const resolved = checkWrite(input);
        const isInitial = under(artifactRoot, resolved) && resolved.endsWith('.json');
        const isFinal = under(artifactRoot, resolved) && resolved.endsWith('.tmp');
        if (isInitial || isFinal) {
          calls.push(isInitial ? 'report' : 'final-write');
          if (isInitial) {
            reportPaths.add(resolved);
            initialDocument = JSON.parse(String(bytes));
          }
          if (scenario.write === (isInitial ? 'initial' : 'final')) throw errors.write;
          writes.push({path: path.relative(caseRoot, resolved), text: String(bytes)});
        }
        return fs.writeFile(resolved, bytes, ...args);
      },
      async rename(input, destination) {
        const from = checkWrite(input), to = checkWrite(destination);
        assert.ok(under(artifactRoot, from) && under(artifactRoot, to));
        assert.ok(from.endsWith('.tmp') && to.endsWith('.json'));
        calls.push('rename');
        if (scenario.rename) throw errors.rename;
        return fs.rename(from, to);
      },
      async rm(input, ...args) {
        const resolved = checkWrite(input);
        assert.equal(resolved, fixtureRoot, 'wrapper can remove only its fixture root');
        assert.equal(verified, true, 'never delete an unverified-live fixture');
        calls.push('remove');
        if (scenario.remove) throw errors.remove;
        return fs.rm(resolved, ...args);
      },
    };
    const fakeRecovery = {
      async backup() { return {}; },
      async restore({backupDirectory}) { return {database: backupDirectory.endsWith('baseline-backup') ? 'restored_baseline' : 'restored_candidate'}; },
      async preflight(connection) {
        if (String(connection).includes('restored_baseline')) return {migrations: baselineMigrations};
        if (String(connection).includes('restored_candidate')) return {migrations};
        preflightCalls++;
        return preflightCalls === 1 ? {migrations: baselineMigrations, candidate_migrations: {pending_versions: [87,88]}} : {migrations};
      },
      async matchMigrationBaseline() { throw new Error('installed migration absent'); },
      async pg() { return '{"owned":"retained"}'; },
      async withDatabaseSnapshot() { throw new Error('unselected recovery body must not run'); },
      readTransaction() { throw new Error('unselected recovery body must not run'); },
    };
    const fakeSet = Object.fromEntries(['createRecoverySet','decryptSource','verifyMaterials'].map(name => [name, () => {throw new Error('unselected recovery body must not run');}]));
    // Use the current realm so native strict assertions keep their original
    // array/prototype semantics. This standalone process owns its environment.
    const context = undefined;
    process.env.RAINSYNC_NATIVE_POSTGRES_BIN = '/owned/substituted/pg';
    process.env.RAINSYNC_ARTIFACT_DIR = artifactRoot;
    const modules = new Map();
    const synth = (id, values) => {
      const names = Object.keys(values);
      return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, values[name]); }, {context, identifier: id});
    };
    const linker = async specifier => {
      if (modules.has(specifier)) return modules.get(specifier);
      if (specifier === './fixtures/upgrade-recovery-evidence.mjs') {
        assert.ok(helperBytes, 'actual candidate helper source required');
        const helper = new vm.SourceTextModule(helperBytes, {context,
          identifier: pathToFileURL(path.join(root, helperPath)).href});
        modules.set(specifier, helper);
        await helper.link(linker);
        return helper;
      }
      let values;
      if (specifier === 'node:test') values = {test: (...args) => registered.push({name: args[0], run: args.at(-1)})};
      else if (specifier === 'node:fs/promises') values = fakeFs;
      else if (specifier === 'node:os') values = {...await import('node:os'), tmpdir: () => caseRoot};
      else if (specifier === 'node:child_process') values = {
        execFileSync(command, args, options) {
          assert.equal(command, 'git');
          assert.ok(['rev-parse','ls-tree','show'].includes(args[0]));
          return execFileSync(command, args, {...options, cwd: root});
        },
        execFile() { throw new Error('subprocess execution is forbidden in pure wrapper probe'); },
      };
      else if (specifier === './fixtures/postgres.mjs') values = {isolatedPostgres: fixtureFactory};
      else if (specifier === '../deploy/postgres-recovery.mjs') values = fakeRecovery;
      else if (specifier === '../deploy/recovery-set.mjs') values = fakeSet;
      else if (specifier === './fixtures/safe-failure.mjs') values = {safeFailure: () => 'verification_failed'};
      else if (['node:assert/strict','node:crypto','node:path','node:util'].includes(specifier)) values = await import(specifier);
      else throw new Error(`Unexpected import is blocked: ${specifier}`);
      const module = synth(specifier, values); modules.set(specifier, module); return module;
    };
    // Append only an export of the existing private wrapper. Its source body is
    // byte-for-byte unchanged. Upgrade runs the real registered callback.
    const code = source.bytes + (kind === 'integrity' ? '\nexport { fixtureRun as __probeFixtureRun };\n' : '');
    const module = new vm.SourceTextModule(code, {context, identifier: pathToFileURL(path.join(root, source.path)).href, initializeImportMeta(meta) {meta.url = pathToFileURL(path.join(root, source.path)).href;}});
    await module.link(linker);
    await module.evaluate();
    try {
      if (kind === 'integrity') await module.namespace.__probeFixtureRun(async () => body());
      else {
        const selected = registered.find(row => row.name.startsWith('populated recent baseline upgrades'));
        assert.ok(selected, 'actual current upgrade callback must be selected');
        await selected.run();
      }
    } catch (error) {rejected = true; caught = error;}
    if (!calls.includes('start')) console.log(`HARNESS_BOUNDARY_NOT_REACHED ${kind}/${scenario.name} ${caught?.name ?? 'primitive'} ${caught?.code ?? ''}`);
    // Only the final invocation-specific path is trusted; provisional snapshots
    // and sibling .tmp files never count as completed evidence.
    const reports = [];
    for (const reportPath of reportPaths) {
      try { reports.push(JSON.parse(await fs.readFile(reportPath, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const check = (name, passed) => ({name, passed: Boolean(passed)});
    const expectedFailure = Boolean(scenario.primary || scenario.stop || scenario.verify || scenario.write || scenario.rename || scenario.remove || scenario.wrongRoot || scenario.symlinkLeaf || scenario.reportInside || scenario.artifactSymlink);
    const incomplete = scenario.write === 'final' || scenario.rename;
    const unavailable = scenario.write === 'initial' || scenario.reportInside || scenario.artifactSymlink;
    const checks = [
      check('actual-wrapper-reached', calls.includes('start')),
      check('failure-status-preserved', rejected === expectedFailure),
      check('stop-attempted', calls.filter(x => x === 'stop').length === 1),
      check('positive-verification-attempted-independently', calls.filter(x => x === 'verify').length === 1),
      check('never-remove-unverified-root', !calls.includes('remove') || verified),
      check('stop-before-verification', calls.indexOf('verify') > calls.indexOf('stop')),
      check('no-report-inside-disposable-root', [...reportPaths].every(name => !under(fixtureRoot, name))),
      check('one-invocation-specific-report', reportPaths.size === (scenario.reportInside || scenario.artifactSymlink ? 0 : 1)),
      check('raw-diagnostics-never-serialized', writes.every(row => !row.text.includes(sentinel) && !/"(?:error|stack|cause|message|private_data)"\s*:/.test(row.text))),
      check('all-final-disk-documents-nonpassed-on-failure', !expectedFailure || reports.every(row => row.result !== 'passed')),
    ];
    if (!scenario.reportInside && !scenario.artifactSymlink) checks.push(check('initial-receipt-explicitly-incomplete-and-nonpassed', initialDocument?.state === 'incomplete' && initialDocument?.result === 'failed'));
    if (unavailable) checks.push(check('initial-failure-retains-root-without-trusted-pass', !calls.includes('remove') && reports.every(row => row.result !== 'passed')));
    else {
      checks.push(check('retained-final-path-receipt', reports.length === 1));
      checks.push(check('receipt-result-matches-outcome', reports.length === 1 && reports[0].result === (expectedFailure ? 'failed' : 'passed')));
      checks.push(check('receipt-state-matches-finalization', reports.length === 1 && reports[0].state === (incomplete ? 'incomplete' : 'complete')));
      checks.push(check('positive-cleanup-or-explicit-unconfirmed-receipt', reports.length === 1 && reports[0].cleanup?.completed === !scenario.verify));
    }
    const originals = [...(scenario.primary ? [scenario.value] : []), ...(scenario.stop ? [errors.stop] : []), ...(scenario.verify ? [errors.verify] : []), ...(scenario.remove ? [errors.remove] : []), ...(scenario.write ? [errors.write] : []), ...(scenario.rename ? [errors.rename] : [])];
    if (originals.length) {
      const actual = Array.isArray(caught?.errors) ? caught.errors : rejected ? [caught] : [];
      checks.push(check('all-original-failures-preserved-in-order-including-falsy', originals.length === actual.length && originals.every((value, index) => Object.is(value, actual[index]))));
    }
    const visibleCategories = [
      ...(scenario.primary ? ['fixture_failed'] : []),
      ...(scenario.stop ? ['cleanup_failed'] : []),
      ...(scenario.verify ? ['cleanup_verification_failed'] : []),
      ...(scenario.wrongRoot || scenario.symlinkLeaf ? ['fixture_ownership_failed'] : []),
      ...(!incomplete && scenario.remove ? ['fixture_removal_failed'] : []),
    ];
    if (!unavailable) checks.push(check('persisted-receipt-preserves-known-failure-categories', reports.length === 1 && visibleCategories.every(category => reports[0].failures?.includes(category))));
    if (scenario.remove) checks.push(check('removal-failure-does-not-claim-retention', reports.length === 1 && reports[0].disposal?.outcome === 'unknown' && reports[0].disposal?.retained !== true));
    if (scenario.verify || scenario.wrongRoot || scenario.symlinkLeaf) checks.push(check('unconfirmed-or-unowned-root-not-removed', !calls.includes('remove')));
    if (!expectedFailure) {
      checks.push(check('success-cleanup-order-unchanged', ['stop','verify','report','remove','final-write','rename'].every((name,index,array) => calls.includes(name) && (index === 0 || calls.indexOf(name) > calls.indexOf(array[index-1])))));
      checks.push(check('atomic-finalization-is-last-fallible-success-step', calls.at(-1) === 'rename'));
    }
    let exists = false;
    if (fixtureRoot) { try {await fs.stat(fixtureRoot); exists = true;} catch(error) {if(error.code !== 'ENOENT') throw error;} }
    const observed = {wrapper: kind, scenario: scenario.name, passed: checks.every(row => row.passed), rejected, calls, fixture_root_retained: exists, checks, reports: writes.map(({path: name}) => name)};
    results.push(observed);
    console.log(`${observed.passed ? 'PASS' : 'FAIL'} ${kind}/${scenario.name}: ${checks.filter(row => !row.passed).map(row => row.name).join(', ') || 'all contract expectations satisfied'}`);
  }
}
for (const input of sourceManifest) assert.equal(digest(await fs.readFile(path.join(root, input.path))), input.sha256, 'source changed during pure probes');
const summary = {schema_version: 1, kind: 'pure-actual-wrapper-fault-probes', claim: 'Actual current wrapper execution with task-owned substituted fixtures; not PostgreSQL or deployment acceptance', source_root: root, source_commit: expectedHead, node: process.version, source_manifest: sourceManifest, actual_fixture_processes_started: 0, source_inputs_unchanged_during_probe: true, total_scenarios: results.length, passed_scenarios: results.filter(row => row.passed).length, failed_scenarios: results.filter(row => !row.passed).length, results};
await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({total: summary.total_scenarios, passed: summary.passed_scenarios, failed: summary.failed_scenarios, report: path.join(output, 'summary.json')}));
process.exitCode = summary.failed_scenarios ? 1 : 0;

}
