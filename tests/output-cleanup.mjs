import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function missing(path) {
  try { await stat(path); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
async function removed(path) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await missing(path)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("obsolete attempt directory was not reclaimed");
}

// Run against the actual Worker maintenance loop, with no quota pressure and
// an active session/current reader. Controlled bytes isolate deletion behavior.
export async function outputCleanup({ id, cache, sql }) {
  const old = resolve(cache, id, "1");
  const current = resolve(cache, id, "2", "index0.m4s");
  const saved = await readFile(current);
  const oldLease = randomUUID(), currentLease = randomUUID();
  const writerReceipt = randomUUID(), writerOwner = randomUUID();
  try {
    // This controlled old attempt starts no encoder, and its fixture-owned
    // writes have completed. Lease expiry alone must never stand in for drain.
    sql(`INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id,reaped_at) VALUES('${writerReceipt}','${id}','job','${id}',1,'${writerOwner}',clock_timestamp())`);
    sql(`INSERT INTO cache_read_leases(id,cache_id,attempt,expires_at) VALUES('${oldLease}','${id}',1,now()+interval '1 hour'),('${currentLease}','${id}',2,now()+interval '1 hour'); UPDATE media_outputs SET status='abandoned',cleanup_after=now() WHERE job_id='${id}' AND attempt=1`);
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(await missing(old), false, "an old response still pins its own files");
    sql(`UPDATE cache_read_leases SET expires_at=now()-interval '1 second' WHERE id='${oldLease}'`);
    await removed(old);
    assert.deepEqual(await readFile(current), saved, "active current output survives old-attempt cleanup");
    assert.equal(sql(`SELECT count(*) FROM cache_read_leases WHERE id='${currentLease}' AND expires_at>now()`), "1");
    assert.equal(sql(`SELECT count(*) FROM playback_sessions WHERE id='${id}' AND NOT stopped AND expires_at>now()`), "1");
    // Simulate a fenced, previously suspended writer creating late private data.
    await mkdir(old, { recursive: true });
    await writeFile(resolve(old, "late.tmp"), "late private bytes");
    sql(`UPDATE media_outputs SET cleanup_after=now() WHERE job_id='${id}' AND attempt=1`);
    await removed(old);
    assert.deepEqual(await readFile(current), saved);
    console.log("PASS: independent old-attempt cleanup respects old readers, preserves active current output and revisits late writes");
  } finally {
    sql(`DELETE FROM cache_read_leases WHERE id IN ('${oldLease}','${currentLease}')`);
    sql(`DELETE FROM media_executions WHERE id='${writerReceipt}' AND owner_id='${writerOwner}'`);
  }
}
