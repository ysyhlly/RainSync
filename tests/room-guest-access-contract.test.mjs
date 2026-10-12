// Source seam guards only. Real PostgreSQL waits, trigger rollback, and natural
// expiry still require the identical native fixture on original and candidate.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

// Evaluate only extracted definitions with in-memory psql mocks.
// No native entrypoint imports, processes, database, HTTP or sockets.
{
const source=readFileSync(new URL('./room-guest-access-authority-native.mjs',import.meta.url),'utf8');
const section=(start,end)=>{
 const from=source.indexOf(start);assert.notEqual(from,-1,start);
 const to=source.indexOf(end,from+start.length);assert.notEqual(to,-1,end);
 return source.slice(from,to);
};
const helpers=section('const quote=','// This fixed set');
const load=(scope={})=>runInNewContext(`${helpers}\n({authSelect,policySelect,boundaryDiagnosticSql,safeBoundaryDiagnostic,safeBoundaryFailureCode,captureBoundaryDiagnostic})`,{assert,setTimeout,clearTimeout,...scope},{timeout:1000});
const plain=value=>JSON.parse(JSON.stringify(value));
const backend_start='2026-10-12T03:00:00.000000Z';
const marker='guest_policy_holder_'+'a'.repeat(32);
const payload=()=>({database_deadline_reached:true,holder:{pid:100,backend_start},waiters:[{pid:101,backend_start,query_class:'auth_select',blocking_pids:[100],blockers_truncated:false,wait_event_type:'Lock',wait_event:'relation'}],waiters_truncated:false,locks:[{pid:100,relation:'room_guest_access',mode:'AccessExclusiveLock',granted:true},{pid:101,relation:'room_guest_access',mode:'AccessShareLock',granted:false}],locks_truncated:false});
function fakeProcess(onEnd,killCloses=true){
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.done=Promise.resolve();
 child.kills=[];child.kill=signal=>{child.kills.push(signal);if(killCloses)queueMicrotask(()=>child.emit('close',null,signal));};
 child.stdin.end=script=>{child.script=script;onEnd?.(child);};
 return child;
}
const emitResult=(child,value=payload())=>{child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));child.emit('close',0,null);};
function fakeTimers(){
 const pending=new Map();let serial=0;
 return {setTimeout:(fn,ms)=>{const id=++serial;pending.set(id,{fn,ms});return id;},clearTimeout:id=>pending.delete(id),fire:ms=>{const entry=[...pending].find(([,v])=>v.ms===ms);assert.ok(entry,`missing ${ms} ms bound`);pending.delete(entry[0]);entry[1].fn();},pending};
}

test('diagnostic SQL identifies the current owned holder and bounds read-only catalog output',()=>{
 const api=load(),sql=api.boundaryDiagnosticSql({pid:100,backendStart:backend_start,marker},backend_start);
 const identity=readFileSync(new URL('../apps/server/src/identity/request.rs',import.meta.url),'utf8');
 assert.ok(identity.includes(`sqlx::query("${api.authSelect}")`),'auth classification matches the actual query exactly');
 assert.match(sql,/BEGIN READ ONLY;/);
 assert.match(sql,/statement_timeout='1s'/);assert.match(sql,/lock_timeout='250ms'/);assert.match(sql,/ROLLBACK;$/);
 assert.ok(sql.includes(`pid=100 AND backend_start='${backend_start}'::timestamptz`));
 assert.ok(sql.includes(`application_name='${marker}'`));
 assert.match(sql,/h\.pid=ANY\(pg_blocking_pids\(a\.pid\)\)/);
 for(const limit of [9,8,65,64])assert.ok(sql.includes(`LIMIT ${limit}`));
 assert.match(sql,/w\.blockers\[1:8\]/);
 assert.ok(sql.includes(`CASE a.query WHEN '${api.authSelect}' THEN 'auth_select' WHEN '${api.policySelect}' THEN 'policy_select' ELSE 'other' END`));
 assert.doesNotMatch(sql,/'(?:query|cookie|token|body|selector|datname|application_name)'\s*,|to_jsonb\([ahw]\)|pg_get_/);
 assert.match(sql,/clock_timestamp\(\)>='2026-10-12T03:00:00\.000000Z'::timestamptz/);
 assert.match(api.boundaryDiagnosticSql({pid:100,backendStart:backend_start,marker}),/'database_deadline_reached',NULL/);
 assert.throws(()=>api.boundaryDiagnosticSql({pid:'100; private',backendStart:backend_start,marker}));
 assert.throws(()=>api.boundaryDiagnosticSql({pid:100,backendStart:backend_start,marker},'private deadline'));
});

test('the report projection excludes extra fields and reduces unrecognized strings to fixed categories',()=>{
 const api=load(),value=payload(),secret='private cookie token body SQL parameter path';
 value.secret=secret;value.holder.query=secret;value.waiters[0].query=secret;value.waiters[0].body=secret;
 value.waiters[0].query_class=secret;value.waiters[0].wait_event=secret;value.waiters[0].wait_event_type=secret;
 value.locks[0].relation=secret;value.locks[0].mode=secret;
 const safe=plain(api.safeBoundaryDiagnostic(value));
 assert.equal(JSON.stringify(safe).includes(secret),false);
 assert.deepEqual(Object.keys(safe),['database_deadline_reached','holder','waiters','waiters_truncated','locks','locks_truncated']);
 assert.deepEqual(Object.keys(safe.holder),['pid','backend_start']);
 assert.deepEqual(Object.keys(safe.waiters[0]),['pid','backend_start','query_class','blocking_pids','blockers_truncated','wait_event_type','wait_event']);
 assert.equal(safe.waiters[0].query_class,'other');assert.equal(safe.waiters[0].wait_event,'other');assert.equal(safe.waiters[0].wait_event_type,'other');
 assert.deepEqual(safe.locks[0],{pid:100,relation:'other',mode:'other',granted:true});
 for(const query_class of ['auth_select','policy_select','other']){
  const v=payload();v.waiters[0].query_class=query_class;
  assert.equal(api.safeBoundaryDiagnostic(v).waiters[0].query_class,query_class);
 }
 for(const change of [v=>v.waiters=Array(9).fill(v.waiters[0]),v=>v.locks=Array(65).fill(v.locks[0]),v=>v.waiters[0].blocking_pids=Array(9).fill(100),v=>v.holder.backend_start=secret,v=>v.waiters[0].pid=secret,v=>v.database_deadline_reached=secret,v=>v.locks[0].granted=secret]){
  const v=payload();change(v);assert.throws(()=>api.safeBoundaryDiagnostic(v),/guest_diagnostic_invalid_result/);
 }
});

test('only exact allowlisted original failure codes become public',()=>{
 const api=load();
 for(const code of ['guest_sql_witness_deadline','expiry_reached_before_request','exact_pg_edge_failed','backend_identity_changed'])assert.equal(api.safeBoundaryFailureCode(Error(code)),code);
 for(const error of [Error('private cookie path'),Error('guest_sql_witness_deadline: private detail'),undefined,null,false,{get message(){throw Error('private getter');}}])assert.equal(api.safeBoundaryFailureCode(error),'guest_boundary_failed');
 let reads=0;assert.equal(api.safeBoundaryFailureCode({get message(){return ++reads===1?'guest_sql_witness_deadline':'private second read';}}),'guest_sql_witness_deadline');assert.equal(reads,1);
});

test('diagnostic capture succeeds without forwarding raw process output',async()=>{
 const api=load(),value=payload();value.query='private SQL';
 const child=fakeProcess(c=>emitResult(c,value));
 const result=await api.captureBoundaryDiagnostic((query,options)=>{assert.equal(query,undefined);assert.equal(options.interactive,true);return child;},'safe query');
 assert.deepEqual(plain(result),{capture_code:'guest_diagnostic_captured',...payload()});
 assert.equal(child.script,'\\set QUIET on\nsafe query\n\\q\n');assert.deepEqual(child.kills,[]);
});

test('capture bounds output, stalled exits, and cleanup, returning only fixed failure codes',async()=>{
 const timer=fakeTimers(),api=load(timer);
 const stalled=fakeProcess();const pending=api.captureBoundaryDiagnostic(()=>stalled,'safe query');
 timer.fire(2000);assert.equal((await pending).capture_code,'guest_diagnostic_timeout');assert.deepEqual(stalled.kills,['SIGKILL']);assert.equal(timer.pending.size,0);
 const stuck=fakeProcess(undefined,false),unconfirmed=api.captureBoundaryDiagnostic(()=>stuck,'safe query');
 timer.fire(2000);timer.fire(500);assert.equal((await unconfirmed).capture_code,'guest_diagnostic_cleanup_unconfirmed');assert.deepEqual(stuck.kills,['SIGKILL']);
 const huge=fakeProcess(c=>c.stdout.emit('data',Buffer.alloc(65537,120)));
 assert.equal((await api.captureBoundaryDiagnostic(()=>huge,'safe query')).capture_code,'guest_diagnostic_output_limit');assert.deepEqual(huge.kills,['SIGKILL']);
 const malformed=fakeProcess(c=>{c.stdout.emit('data',Buffer.from('private raw SQL'));c.emit('close',0,null);});
 assert.deepEqual(plain(await api.captureBoundaryDiagnostic(()=>malformed,'safe query')),{capture_code:'guest_diagnostic_invalid_result'});
 const failed=fakeProcess(c=>c.emit('close',1,null));
 assert.equal((await api.captureBoundaryDiagnostic(()=>failed,'safe query')).capture_code,'guest_diagnostic_query_failed');
 assert.equal((await api.captureBoundaryDiagnostic(()=>{throw Error('private spawn detail');},'safe query')).capture_code,'guest_diagnostic_unavailable');
 assert.equal(timer.pending.size,0);
});

const start=' for(const spec of cases)await runCase(spec.name,';
const callback=section(start,'\n });').slice(start.length)+'\n }';
test('the actual boundary captures before release and preserves the original even if diagnostics fail',async()=>{
 for(const capture_code of ['guest_diagnostic_captured','guest_diagnostic_unavailable','guest_diagnostic_timeout','guest_diagnostic_output_limit','guest_diagnostic_cleanup_unconfirmed']){
  const timer=fakeTimers(),api=load(timer),original=Error('guest_sql_witness_deadline'),events=[],active={},response={bodyUsed:false,text:async()=>{response.bodyUsed=true;return '{}';}};
  let settle;const pending=new Promise(done=>settle=done);
  const block={record:{holder_child_pid:10,holder_backend_pid:100},witness:'exact witness',diagnosticSql:deadline=>{assert.equal(deadline,backend_start);return 'safe diagnostic';},release:async()=>{events.push('release');settle(response);return {};}};
  const scope={assert,Buffer,Error,AggregateError,active,spec:{name:'get_entry_only_natural_expiry_policy_select',boundary:'policy',expiry:true,status:200},
   subject:async()=>({owner:{id:'owner',client:{raw:()=>{events.push('request');return pending;}}},member:{},outside:{}}),
   f:{sql:query=>query.startsWith('SELECT to_char')?backend_start:'t',sqlProcess:()=>{
    events.push('diagnostic');if(capture_code==='guest_diagnostic_unavailable')throw Error('private spawn detail');
    const child=fakeProcess(c=>{
     if(capture_code==='guest_diagnostic_captured')emitResult(c);
     else if(capture_code==='guest_diagnostic_output_limit')c.stdout.emit('data',Buffer.alloc(65537,120));
     else{timer.fire(2000);if(capture_code==='guest_diagnostic_cleanup_unconfirmed')timer.fire(500);}
    },capture_code!=='guest_diagnostic_cleanup_unconfirmed');
    const kill=child.kill;child.kill=signal=>{events.push('kill_diagnostic_only');kill(signal);};return child;
   }},
   testLoginHash:()=> 'private login hash',uuid:value=>value,quote:value=>value,path:()=>'/private/room',readOptions:{},
   fixed:(ok,code)=>assert.ok(ok,code),snapshot:async()=>({value:{playback_sessions:[],playback_requests:[]},receipt:{},sql:{}}),
   privateFile:async()=>({sha256:'private receipt digest'}),privateFailureDetails:()=>({message:'private failure'}),
   holder:async()=>block,phase:async value=>{active.phase=value;events.push(value);},waitSql:async()=>{events.push('wait');throw original;},cleanupBound:async value=>await value,
   safeBoundaryFailureCode:api.safeBoundaryFailureCode,captureBoundaryDiagnostic:api.captureBoundaryDiagnostic,
  };
  const work=runInNewContext(`(${callback})`,scope,{timeout:1000});
  await assert.rejects(work(),error=>error===original);
  const killed=['guest_diagnostic_timeout','guest_diagnostic_output_limit','guest_diagnostic_cleanup_unconfirmed'].includes(capture_code);
  assert.deepEqual(events,['request','request_started','waiting_exact_policy_edge','wait','diagnostic',...(killed?['kill_diagnostic_only']:[]),'release']);
  assert.equal(active.boundary_diagnostic.failure_code,'guest_sql_witness_deadline');
  assert.equal(active.boundary_diagnostic.phase,'waiting_exact_policy_edge');
  assert.equal(active.boundary_diagnostic.request_started,true);assert.equal(active.boundary_diagnostic.request_settled,false);assert.equal(active.boundary_diagnostic.request_settled_after_capture,false);
  assert.equal(active.boundary_diagnostic.capture_code,capture_code);
  assert.equal(active.pending_http_body_consumed,true);assert.equal(response.bodyUsed,true);
  assert.equal(JSON.stringify(active).includes('private spawn detail'),false);
 }
});

test('diagnostics leave exact SQL, identity, expiry, pending and cleanup requirements intact',()=>{
 for(const exact of [
  "'LOCK TABLE room_guest_access IN ACCESS EXCLUSIVE MODE'",
  "fixed(tuple.length===1,'holder_backend_not_unique')",
  'blocked.query=${quote(query)} AND pg_blocking_pids(blocked.pid)=ARRAY[${backend}]::integer[]',
  "pids.length===1&&Number.isInteger(pids[0])&&pids[0]>0&&pids[0]!==block.record.holder_backend_pid",
  "value.blocked.query===block.query&&value.blocked.wait_event_type==='Lock'",
  "fixed(first.value.clock<deadline,'first_witness_not_before_expiry')",
  "JSON.stringify(JSON.parse(f.sql(block.pidsSql)))===JSON.stringify([blocked])&&!requestSettled",
  'first.value.holder.backend_start===second.value.holder.backend_start&&first.value.blocked.backend_start===second.value.blocked.backend_start',
  "fixed(second.value.clock>=deadline,'database_clock_not_reached')",
  "fixed(bodyConsumed&&response.bodyUsed,'pending_http_body_not_consumed')",
  'if(primaryFailed)throw failure;',
 ])assert.ok(source.includes(exact),exact);
 assert.doesNotMatch(source,/REINDEX|pg_cancel_backend|pg_terminate_backend/);
});
}
