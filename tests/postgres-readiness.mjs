// Command-level regression only. This does not launch or validate real Docker.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

const root = await mkdtemp(resolve(tmpdir(), "rainsync-postgres-readiness-"));
const originalPath = process.env.PATH;
const originalNative = process.env.RAINSYNC_NATIVE_POSTGRES_BIN;
const state = resolve(root, "commands.json");
const executable = resolve(root, "docker");
await writeFile(state, JSON.stringify({ probes: 0, commands: [] }));
await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(path));
const args = process.argv.slice(2);
state.commands.push(args);
let result = '', status = 0;
if(args[0] === 'run') result = 'mock-owned-container';
else if(args[0] === 'port') result = '127.0.0.1:54321';
else if(args[0] === 'inspect') result = 'mock-identity';
else if(args[0] === 'rm' || args[0] === 'ps') {}
else if(args[0] === 'exec' && args[2] === 'pg_isready') {
  state.probes++;
  // First the temporary socket-only server, then its shutdown gap, then TCP.
  status = state.probes < 3 ? 1 : 0;
} else if(args[0] === 'exec' && args[2] === 'psql') {
  const query = args.at(-1);
  if(query === 'SELECT 1') result = '1'; // Temporary Unix server would answer.
  else if(query === 'SELECT version()') {
    if(state.probes < 3) status = 2; // Its socket disappears during restart.
    else result = 'mock-final-postgres';
  } else status = 99;
} else status = 99;
fs.writeFileSync(path, JSON.stringify(state));
if(result) process.stdout.write(result + '\\n');
process.exit(status);
`, { mode: 0o700 });
let database;
try {
  process.env.PATH = `${root}:${originalPath}`;
  delete process.env.RAINSYNC_NATIVE_POSTGRES_BIN;
  database = isolatedPostgres({ root: resolve(root, "fixture"), name: "readiness-unit" });
  await database.start();
  assert.equal(database.diagnostics().server_version, "mock-final-postgres");
  assert.equal(database.diagnostics().ready, true);
  const actual = JSON.parse(await readFile(state, "utf8"));
  assert.equal(actual.probes, 3);
  const probes = actual.commands.filter(args => args[2] === "pg_isready");
  for (const args of probes) {
    assert.equal(args[args.indexOf("-h") + 1], "127.0.0.1");
    assert.equal(args[args.indexOf("-p") + 1], "5432");
    assert.equal(args.includes(database.password), false);
  }
  const firstSql = actual.commands.findIndex(args => args[2] === "psql");
  const lastReady = actual.commands.findLastIndex(args => args[2] === "pg_isready");
  assert.ok(firstSql > lastReady, "SQL readiness cannot accept the temporary Unix postmaster");
  assert.deepEqual(actual.commands.filter(args => args[2] === "psql").map(args => args.at(-1)), ["SELECT 1", "SELECT version()"]);
  console.log("PASS: command-level readiness retries temporary/socket-only and stopped phases, then checks SQL/version only after final TCP; no password added to CLI (mock Docker, not a container run)");
} finally {
  if (database) await database.stop();
  process.env.PATH = originalPath;
  if (originalNative === undefined) delete process.env.RAINSYNC_NATIVE_POSTGRES_BIN;
  else process.env.RAINSYNC_NATIVE_POSTGRES_BIN = originalNative;
  await rm(root, { recursive: true, force: true });
}
