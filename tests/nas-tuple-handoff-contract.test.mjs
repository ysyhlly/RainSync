// Pure Node contract tests. Execute the real connection-mode orchestration in a
// memory-only VM and inspect the SQL it produces. Real PostgreSQL lock behavior
// remains the responsibility of the native NAS metrics fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("./fixtures/nas-metric-identity-races.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("export async function queuedMetricIdentityRaces(");
assert.notEqual(start, -1, "actual fixture function is present");
const definition = source.slice(start).replace(/^export /, "");
const modes = 'for (const mode of ["connection", "token"])';
assert.ok(definition.includes(modes), "both native fixture variants remain present");
const connectionDefinition = definition.replace(modes, 'for (const mode of ["connection"])');

const ids = {
  target: "11111111-1111-4111-8111-111111111111",
  helper: "22222222-2222-4222-8222-222222222222",
  connection: "33333333-3333-4333-8333-333333333333",
  replacement: 701,
  receiver: 702,
};
const tuple = { database: 19001, relation: 19002, page: 4, tuple: 9, xid: "8001" };
const seen = "2026-10-12 23:00:00+00";
const replacementQuery = "UPDATE agents SET advanced_assets_version=0,advanced_assets_connection=$2,last_seen=clock_timestamp() WHERE id=$1 AND token_hash=$3 AND NOT revoked";
const receiverQuery = "SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND NOT revoked FOR SHARE";
const dispatchQuery = "UPDATE agent_transfer_runs SET dispatched_at=COALESCE(dispatched_at,clock_timestamp()) WHERE id=$1";
const roles = ["holder", "handoff", "activityGate", "replacementGate", "helperGate"];
const pids = Object.fromEntries(roles.map((role, i) => [role, 101 + i]));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

async function runFixture(options = {}, code = connectionDefinition) {
  const events = [], queries = {}, locks = [], peers = [];
  let sequence = 0, scrapes = 0;
  const record = (kind, fields = {}) => {
    const event = { kind, ...fields };
    events.push(event);
    return event;
  };
  const releases = () => Object.fromEntries(locks.map(lock => [lock.role, lock.released]));
  const peer = (role, connection = ids.connection) => {
    const object = {
      role, connection, record: { closed: false },
      send(value) { record("send", { role, value }); },
      async close() {
        record("close", { role, releases: releases() });
        object.record.closed = true;
      },
    };
    peers.push(object);
    return object;
  };
  const query = async (role, sql) => {
    record("query", { role, sql });
    if (sql === "SELECT pg_backend_pid()") return String(pids[role]);
    if (sql.startsWith("SELECT last_seen::text")) {
      queries.seen = { role, sql };
      return seen;
    }
    if (sql.includes("a.query='COMMIT'")) {
      queries.helperCommit = { role, sql };
      return options.helperCommitCount ?? "1";
    }
    if (sql.startsWith("SELECT EXISTS(SELECT 1 FROM agents")) {
      queries.committed = { role, sql };
      record("committedObservation");
      return Object.hasOwn(options, "committedValue") ? options.committedValue : "t";
    }
    if (sql.startsWith("SELECT id FROM agents") && sql.endsWith(" FOR UPDATE")) {
      queries.holder = { role, sql };
      record("holderAcquired");
      return ids.target;
    }
    if (sql.startsWith("SELECT json_build_object(")) {
      queries.targetTuple = { role, sql };
      return JSON.stringify({ ...tuple, ...options.tuple });
    }
    if (sql.startsWith("SELECT COALESCE(json_agg(a.pid)")) {
      const key = role === "helperGate" ? "replacement" : "receiver";
      queries[key] = { role, sql };
      record(key + "Pinned");
      return JSON.stringify(options[key + "Pids"] ?? [ids[key]]);
    }
    if (sql.startsWith("SELECT COALESCE(json_agg(pid)")) {
      queries.publication = { role, sql };
      return JSON.stringify(options.publicationPids ?? [ids.replacement]);
    }
    if (sql.startsWith("SELECT count(*) FROM pg_stat_activity a JOIN pg_locks")) {
      queries.postHolder = { role, sql };
      record("postHolderObserved");
      return options.postHolderCount ?? "1";
    }
    assert.fail(`Unexpected memory SQL on ${role}: ${sql}`);
  };
  const bindings = {
    assert, quote,
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    randomBytes: size => ({
      toString: () => "ab".repeat(size),
      readUInt32BE: () => ++sequence,
    }),
    digest: () => "cd".repeat(32),
    delay: async () => {},
    waitUntil: async (probe, label) => {
      record("probe", { label });
      const value = await probe();
      if (!value) throw Error(`Deadline: ${label}`);
      return value;
    },
    fixtureLock: async (_f, statement) => {
      const role = roles[locks.length];
      assert.ok(role, "only expected owned lock sessions are created");
      const lock = {
        role, marker: `memory_${role}`, released: false,
        query: sql => query(role, sql),
        async finish(commit = true) {
          record("releaseStarted", { role, commit });
          // A missing await must be visible at the subsequent DDL/socket boundary.
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          lock.released = true;
          record("released", { role, commit });
        },
      };
      locks.push(lock);
      record("lock", { role, statement });
      return lock;
    },
  };
  // No imports, process, timers, native sockets or database implementation enter
  // this context. Only the actual fixture function and explicit memory stubs do.
  const invoke = runInNewContext(`(${code})`, bindings, { timeout: 1000 });
  const input = {
    f: {
      sql(sql) {
        const kind = sql.startsWith("INSERT INTO agent_transfers") ? "dispatchInserted"
          : /^(DROP|DELETE)/.test(sql) ? "cleanupSql" : "sql";
        record(kind, { sql, releases: releases() });
        return "[]";
      },
    },
    admin: { request: async () => [{ id: ids.target, connected: true, drain_receipts: null }] },
    pair: async label => ({ id: label.includes("controls handoff") ? ids.helper : ids.target, token: "memory-token" }),
    raw: async () => peer(peers.length ? "recovered" : "old"),
    scrape: async () => ({ stale: scrapes++ ? 1 : 0, unavailable: options.unavailable ?? 0 }),
    stable: async () => { record("stable"); },
    accept: async () => { record("accepted"); },
    metric: (rows, _name, labels) => rows[labels.reason] ?? 0,
    packet: (connection, seq, totals) => ({ connection, seq, totals }),
    completedTotals: bytes => ({ bytes }),
    connectReplacement: async identity => {
      const role = identity.id === ids.helper ? "helper" : "replacement";
      record("connect", { role });
      return peer(role, "replacement-connection");
    },
  };
  let result, error;
  try { result = await invoke(input); } catch (caught) { error = caught; }
  return { result, error, events, queries, locks, peers };
}

function contains(sql, parts) {
  for (const part of parts) assert.ok(sql.includes(part), `missing SQL guard: ${part}\n${sql}`);
}
function ordered(events, predicates) {
  let previous = -1;
  for (const [label, predicate] of predicates) {
    const next = events.findIndex((event, i) => i > previous && predicate(event));
    assert.ok(next > previous, `missing or reordered event: ${label}`);
    previous = next;
  }
}
function releasedBeforeCleanup(run) {
  const boundaries = run.events.filter(event => event.kind === "cleanupSql" || event.kind === "close");
  assert.ok(boundaries.length, "cleanup actually ran");
  for (const event of boundaries) {
    for (const role of roles) {
      assert.equal(event.releases[role], true, `${role} must finish before ${event.kind}`);
    }
  }
}
function evidenceContract(run) {
  assert.ifError(run.error);
  const q = run.queries;
  assert.equal(q.helperCommit.role, "helperGate");
  contains(q.helperCommit.sql, ["a.datname=current_database()", "a.query='COMMIT'", "l.locktype='advisory'", "NOT l.granted", `${pids.helperGate}=ANY(pg_blocking_pids(a.pid))`]);
  assert.equal(q.committed.role, "helperGate", "activity is observed from an independent transaction");
  contains(q.committed.sql, [`id='${ids.target}'`, `advanced_assets_connection='${ids.connection}'::uuid`, "AND NOT revoked", `last_seen IS DISTINCT FROM '${seen}'::timestamptz`]);
  assert.equal(q.holder.sql, `SELECT id FROM agents WHERE id='${ids.target}' FOR UPDATE`);
  contains(q.targetTuple.sql, ["'database',(SELECT oid FROM pg_database WHERE datname=current_database())", "'relation','agents'::regclass::oid", "'page',split_part(trim(both '()' from ctid::text),',',1)::bigint", "'tuple',split_part(trim(both '()' from ctid::text),',',2)::integer", "'xid',pg_current_xact_id()::text", `WHERE id='${ids.target}'`]);
  const targetTuple = Object.entries(tuple).filter(([key]) => key !== "xid").map(([key, value]) => `l.${key}=${value}`);
  assert.equal(q.replacement.role, "helperGate");
  contains(q.replacement.sql, ["a.datname=current_database()", `a.query='${replacementQuery}'`, "l.locktype='tuple'", "l.mode='ExclusiveLock'", "AND l.granted", ...targetTuple, "x.pid=a.pid", "x.locktype='transactionid'", "x.mode='ShareLock'", "NOT x.granted", `x.transactionid='${tuple.xid}'::xid`, `${pids.holder}=ANY(pg_blocking_pids(a.pid))`]);
  assert.equal(q.receiver.role, "holder");
  contains(q.receiver.sql, ["a.datname=current_database()", `a.query='${receiverQuery}'`, "l.locktype='tuple'", "l.mode='RowShareLock'", "NOT l.granted", ...targetTuple, `${ids.replacement}=ANY(pg_blocking_pids(a.pid))`, `p.pid=${ids.replacement}`, "p.locktype='tuple'", "p.mode='ExclusiveLock'", "AND p.granted", "p.database=l.database", "p.relation=l.relation", "p.page=l.page", "p.tuple=l.tuple", "d.datname=current_database()", `${pids.handoff}=ANY(pg_blocking_pids(d.pid))`, `d.query='${dispatchQuery}'`]);
  assert.equal(q.postHolder.role, "replacementGate");
  contains(q.postHolder.sql, [`a.pid=${ids.receiver}`, `a.query='${receiverQuery}'`, "l.locktype='transactionid'", "l.mode='ShareLock'", "NOT l.granted", `${ids.replacement}=ANY(pg_blocking_pids(a.pid))`, `p.pid=${ids.replacement}`, "p.locktype='transactionid'", "p.mode='ExclusiveLock'", "AND p.granted", "p.transactionid=l.transactionid"]);
  const deferredTrigger = run.events.find(event => event.kind === "sql" && event.sql.includes("CREATE CONSTRAINT TRIGGER"));
  assert.ok(deferredTrigger, "real helper COMMIT is gated by a deferred constraint trigger");
  contains(deferredTrigger.sql, ["AFTER UPDATE ON agents DEFERRABLE INITIALLY DEFERRED", `NEW.id='${ids.helper}'::uuid`, "NEW.advanced_assets_connection IS DISTINCT FROM OLD.advanced_assets_connection"]);
  ordered(run.events, [
    ["helper connects", e => e.kind === "connect" && e.role === "helper"],
    ["helper COMMIT blocks", e => e.kind === "query" && e.sql === q.helperCommit.sql],
    ["old peer heartbeat", e => e.kind === "send" && e.role === "old"],
    ["committed activity", e => e.kind === "committedObservation"],
    ["foreign-key dispatch insert", e => e.kind === "dispatchInserted"],
    ["holder FOR UPDATE", e => e.kind === "holderAcquired"],
    ["capture physical tuple", e => e.kind === "query" && e.sql === q.targetTuple.sql],
    ["replacement connects", e => e.kind === "connect" && e.role === "replacement"],
    ["replacement pinned", e => e.kind === "replacementPinned"],
    ["helper released", e => e.kind === "released" && e.role === "helperGate"],
    ["receiver pinned", e => e.kind === "receiverPinned"],
    ["holder released", e => e.kind === "released" && e.role === "holder"],
    ["same receiver after holder", e => e.kind === "postHolderObserved"],
    ["replacement publication released", e => e.kind === "released" && e.role === "replacementGate"],
    ["stable rejection", e => e.kind === "stable"],
  ]);
  const committedAt = run.events.findIndex(e => e.kind === "committedObservation");
  const replacementAt = run.events.findIndex(e => e.kind === "connect" && e.role === "replacement");
  for (const event of run.events.slice(committedAt + 1, replacementAt)) {
    assert.ok(!event.sql || !/\bUPDATE\s+agents\s+SET\b/i.test(event.sql), "no intervening target UPDATE can change the committed tuple");
  }
  releasedBeforeCleanup(run);
  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), {
    synthetic: true,
    variants: [{ mode: "connection", contended_agent_row: true, incoming_activity_gate: true,
      same_committed_tuple_handoff: true, invalidation: "post_wait_connection_rejected",
      authorization_timeouts: 0, stale_report_credit: 0, fresh_authorized_delta: 3 }],
  });
}

function mutate(before, after, code = connectionDefinition) {
  assert.ok(code.includes(before), `negative control must alter actual fixture: ${before}`);
  return code.replace(before, after);
}

test("actual connection fixture pins the same committed physical tuple and both backend identities", async () => {
  evidenceContract(await runFixture());
});

test("committed heartbeat observation requires explicit PostgreSQL true", async () => {
  for (const value of ["f", "", null, "false", "0", seen]) {
    const run = await runFixture({ committedValue: value });
    assert.match(run.error?.message ?? "", /Deadline: Incoming activity commits/);
    assert.equal(run.events.some(e => e.kind === "holderAcquired"), false);
    assert.equal(run.events.some(e => e.kind === "dispatchInserted"), false);
    releasedBeforeCleanup(run);
  }
  const weakened = mutate(')) === "t", "Incoming activity commits', ')) !== seen, "Incoming activity commits');
  const run = await runFixture({ committedValue: "f" }, weakened);
  assert.equal(run.error, undefined, "negative control demonstrates why non-equality is insufficient");
  assert.throws(() => assert.match(run.error?.message ?? "", /Deadline: Incoming activity commits/));
});

test("helper COMMIT, unique backend evidence and publication PID equality fail closed", async () => {
  for (const [options, expected] of [
    [{ helperCommitCount: "0" }, /Helper COMMIT holds/],
    [{ helperCommitCount: "2" }, /Helper COMMIT holds/],
    [{ replacementPids: [] }, /Replacement queues/],
    [{ replacementPids: [701, 703] }, /Replacement queues/],
    [{ replacementPids: [0] }, /Replacement queues/],
    [{ receiverPids: [] }, /Same tuple proves/],
    [{ receiverPids: [702, 704] }, /Same tuple proves/],
    [{ publicationPids: [703] }, /Same replacement owns publication gate/],
    [{ postHolderCount: "0" }, /Actual receiver remains blocked/],
    [{ postHolderCount: "2" }, /Actual receiver remains blocked/],
  ]) {
    const run = await runFixture(options);
    assert.match(run.error?.message ?? "", expected);
    assert.equal(run.result, undefined);
    assert.equal(run.events.some(e => e.kind === "accepted"), false);
    releasedBeforeCleanup(run);
  }
});

test("physical tuple and holder transaction identifiers must be valid before replacement admission", async () => {
  for (const invalid of [{ xid: "" }, { xid: "1 OR true" }, { database: -1 }, { relation: 1.5 }, { page: null }, { tuple: Number.MAX_SAFE_INTEGER + 1 }]) {
    const run = await runFixture({ tuple: invalid });
    assert.ok(run.error, JSON.stringify(invalid));
    assert.equal(run.events.some(e => e.kind === "connect" && e.role === "replacement"), false);
    releasedBeforeCleanup(run);
  }
});

test("negative SQL mutations cannot weaken the target tuple, lock modes or backend correlations", async () => {
  const mutations = [
    ["AND advanced_assets_connection=${quote(peer.connection)}::uuid AND NOT revoked AND last_seen IS DISTINCT FROM", "AND NOT revoked AND last_seen IS DISTINCT FROM"],
    ["AND last_seen IS DISTINCT FROM ${quote(seen)}::timestamptz)", ")"],
    ["AND a.query='UPDATE agents SET advanced_assets_version=0,advanced_assets_connection=$2,last_seen=clock_timestamp() WHERE id=$1 AND token_hash=$3 AND NOT revoked'", ""],
    ["AND l.mode='ExclusiveLock' AND l.granted AND ${tupleTag}", "AND l.mode='RowShareLock' AND NOT l.granted AND ${tupleTag}"],
    ["AND x.transactionid=${quote(holderXid)}::xid", ""],
    ["AND x.mode='ShareLock' AND NOT x.granted", "AND x.mode='ShareLock' AND x.granted"],
    ["AND ${blockerPid}=ANY(pg_blocking_pids(a.pid))", ""],
    ["AND a.query='SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND NOT revoked FOR SHARE'", ""],
    ["AND l.mode='RowShareLock' AND NOT l.granted", "AND l.mode='RowShareLock' AND l.granted"],
    ["AND l.mode='RowShareLock' AND NOT l.granted", "AND l.mode='ShareLock' AND NOT l.granted"],
    ["AND ${pinnedReplacement}=ANY(pg_blocking_pids(a.pid))", ""],
    ["p.pid=${pinnedReplacement} AND p.locktype='tuple'", "p.pid=999 AND p.locktype='tuple'"],
    ["AND p.mode='ExclusiveLock' AND p.granted", "AND p.mode='ExclusiveLock' AND NOT p.granted"],
    ["AND p.database=l.database", ""],
    ["AND p.relation=l.relation", ""],
    ["AND p.page=l.page", ""],
    ["AND p.tuple=l.tuple", ""],
    ["WHERE a.pid=${pinnedReceiver}", "WHERE a.pid=999"],
    ["AND p.transactionid=l.transactionid", ""],
    ["AND ${replacementPid}=ANY(pg_blocking_pids(a.pid))", ""],
    ["l.database=${target.database} AND ", ""],
    ["AND l.relation=${target.relation}", ""],
    ["AND l.page=${target.page}", ""],
    ["AND l.tuple=${target.tuple}", ""],
  ];
  for (const [before, after] of mutations) {
    // A mutation with no source match is a broken test, not a successful control.
    const run = await runFixture({}, mutate(before, after));
    assert.ifError(run.error);
    assert.throws(() => evidenceContract(run), undefined, before);
  }
});

test("negative ordering and gate-release mutations are rejected by captured execution", async () => {
  const insert = connectionDefinition.match(/        f\.sql\(`INSERT INTO agent_transfers[^\n]+\n/)[0];
  const holder = connectionDefinition.match(/        await held\.query\(`SELECT id FROM agents[^\n]+\n/)[0];
  const reordered = mutate(insert + holder, holder + insert);
  const wrongOrder = await runFixture({}, reordered);
  assert.ifError(wrongOrder.error);
  assert.throws(() => evidenceContract(wrongOrder), /foreign-key dispatch insert|holder FOR UPDATE/);
  const lateHelper = await runFixture({}, mutate("await helperGate.finish();", ""));
  assert.ifError(lateHelper.error);
  assert.throws(() => evidenceContract(lateHelper), /helper released|receiver pinned/);
  const changedTuple = await runFixture({}, mutate(insert,
    insert + "        f.sql(`UPDATE agents SET last_seen=clock_timestamp() WHERE id=${quote(identity.id)}`);\n"));
  assert.ifError(changedTuple.error);
  assert.throws(() => evidenceContract(changedTuple), /no intervening target UPDATE/);
  for (const release of [
    "await helperGate?.finish(false);",
    "await gate?.finish(false);",
    "await replacementGate?.finish(false);",
    "await Promise.all([held.finish(false), handoff?.finish(false)]);",
  ]) {
    // Fail before the first successful release so finally must release every gate.
    const run = await runFixture({ committedValue: "f" }, mutate(release, ""));
    assert.ok(run.error);
    assert.throws(() => releasedBeforeCleanup(run), /must finish before/);
  }
  const unawaited = await runFixture({ committedValue: "f" }, mutate(
    "await Promise.all([held.finish(false), handoff?.finish(false)]);",
    "Promise.all([held.finish(false), handoff?.finish(false)]);",
  ));
  assert.throws(() => releasedBeforeCleanup(unawaited), /must finish before/);
});
