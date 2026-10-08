import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { mkdir, writeFile, readFile, open, rename, rm } from "node:fs/promises";
import http from "node:http";
import { outputCleanup } from "./output-cleanup.mjs";
import { resolve } from "node:path";

// Controlled output bytes isolate actual Worker routing from FFmpeg execution.
// Top-level boxes exercise structural checks; these are not decodable samples.
function atom(kind, value) {
  const payload = Buffer.from(value);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length);
  header.write(kind, 4);
  return Buffer.concat([header, payload]);
}
const initBytes = (attempt) =>
  Buffer.concat([atom("ftyp", "test"), atom("moov", `init-${attempt}`)]);
const segmentBytes = (attempt) =>
  Buffer.concat([atom("moof", "test"), atom("mdat", `media-${attempt}`)]);
export async function workerAttempts({
  plan,
  worker,
  sql,
  key,
  cache,
  readiness,
}) {
  const id = plan.session_id;
  const original = sql(
    `SELECT resource FROM playback_sessions WHERE id='${id}'`,
  );
  const originalCiphertext = Buffer.from(
    JSON.parse(original).encrypted,
    "base64",
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    originalCiphertext.subarray(0, 12),
  );
  decipher.setAuthTag(originalCiphertext.subarray(-16));
  const originalResource = JSON.parse(
    Buffer.concat([
      decipher.update(originalCiphertext.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8"),
  );
  const cachedResource = { ...originalResource, job_id: id };
  // These controlled v1/v2 outputs predate recorded plan facts. Retain actual
  // source authority without claiming the original direct plan's output facts.
  delete cachedResource.plan_facts_version;
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    nonce,
  );
  const encrypted = Buffer.concat([
    nonce,
    // Keep the authenticated source kind and identity when selecting the
    // fixture's controlled cached output route.
    cipher.update(JSON.stringify(cachedResource)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const playlist = new URL(worker + plan.playback_url);
  playlist.pathname = `/media-delivery/${id}/index.m3u8`;
  async function assertStatus(response, expected) {
    if (response.status === 401 && expected !== 401) {
      const diagnostic = {
        expected_status: expected,
        actual_status: response.status,
      };
      try {
        const value = await response.clone().json();
        diagnostic.error_code = /^[A-Z_]{1,80}$/.test(value?.error?.code ?? "")
          ? value.error.code
          : "UNPARSEABLE";
      } catch {
        diagnostic.response_evidence_unavailable = true;
      }
      try {
        const token = playlist.searchParams.get("token");
        const tokenHash = createHash("sha256")
          .update(token ?? "")
          .digest("hex");
        diagnostic.grant_predicates = JSON.parse(
          sql(
            `SET statement_timeout='500ms'; SELECT json_build_object('token_matches',p.delivery_token_hash='${tokenHash}','unexpired',p.expires_at>clock_timestamp(),'stopped',p.stopped,'source_allowed',COALESCE(playback_source_allowed(p.media_id,p.resource,p.id),false),'room_active',r.lifecycle='active','epoch_matches',r.lifecycle_epoch=p.lifecycle_epoch,'generation_matches',(s.state->>'media_generation')::bigint=p.generation,'member_present',EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id),'origin_allowed',COALESCE(playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch),false),'library_allowed',COALESCE(playback_library_session_allowed(p.id),false),'job_present',j.id IS NOT NULL,'job_session_matches',j.session_id=p.id,'output_present',EXISTS(SELECT 1 FROM media_outputs o WHERE o.job_id=j.id AND o.attempt=j.attempt),'resource_matches_fixture',p.resource->>'encrypted'='${encrypted}') FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id LEFT JOIN media_jobs j ON j.id=p.id WHERE p.id='${id}'`,
          )
            .split("\n")
            .at(-1) || "null",
        );
      } catch {
        diagnostic.grant_evidence_unavailable = true;
      }
      console.error(
        "Worker attempts authorization failure: " + JSON.stringify(diagnostic),
      );
    }
    assert.equal(response.status, expected);
  }
  try {
    for (const attempt of [1, 2]) {
      const dir = resolve(cache, id, String(attempt));
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "index.m3u8"),
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nindex0.m4s\n#EXT-X-ENDLIST\n',
      );
      await writeFile(resolve(dir, "init.mp4"), initBytes(attempt));
      await writeFile(resolve(dir, "index0.m4s"), segmentBytes(attempt));
    }
    sql(
      `INSERT INTO media_jobs(id,session_id,status,spec,attempt) VALUES('${id}','${id}','succeeded','{}',1); UPDATE playback_sessions SET resource=resource||jsonb_build_object('encrypted','${encrypted}') WHERE id='${id}'`,
    );
    const saved = await readFile(resolve(cache, id, "1", "index.m3u8"));
    const digest = createHash("sha256").update(saved).digest("hex");
    for (const attempt of [1, 2]) {
      sql(
        `INSERT INTO media_outputs(job_id,attempt,status,relative_dir,manifest_sha256,segment_count,published_at,validation_version) VALUES('${id}',${attempt},'published','${id}/${attempt}','${digest}',1,now(),1)`,
      );
    }
    await writeFile(
      resolve(cache, id, "1", "index.m3u8"),
      Buffer.concat([saved, Buffer.from("#changed\n")]),
    );
    assert.equal(
      (await readiness()).status,
      "ready",
      "legacy output retains on-demand Worker validation",
    );
    await assertStatus(await fetch(playlist), 502);
    await writeFile(resolve(cache, id, "1", "index.m3u8"), saved);
    let response = await fetch(playlist);
    await assertStatus(response, 200);
    const manifest = await response.text();
    assert.ok(manifest.includes("#EXT-X-ENDLIST"));
    sql(
      `UPDATE media_jobs SET status='running',lease_until=now()+interval '1 hour' WHERE id='${id}'; UPDATE media_outputs SET status='writing' WHERE job_id='${id}' AND attempt=1`,
    );
    assert.ok(
      !(await (await fetch(playlist)).text()).includes("#EXT-X-ENDLIST"),
      "uncommitted output cannot advertise completion",
    );
    for (const partial of [
      "#EXTM",
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\n',
    ]) {
      await writeFile(resolve(cache, id, "1", "index.m3u8"), partial);
      let answered = false;
      const pending = fetch(playlist).then((response) => {
        answered = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        answered,
        false,
        "a torn playlist must not be returned as 200",
      );
      await writeFile(resolve(cache, id, "1", "index.m3u8"), saved);
      const recovered = await pending;
      await assertStatus(recovered, 200);
      assert.ok((await recovered.text()).includes("index0.m4s"));
    }
    const growing = resolve(cache, id, "1");
    const nextManifest = saved
      .toString()
      .replace("#EXT-X-ENDLIST\n", "#EXTINF:4,\nindex1.m4s\n");
    await writeFile(resolve(growing, "index1.m4s.tmp"), segmentBytes(1));
    await writeFile(resolve(growing, "index.m3u8"), nextManifest);
    let advertised = false;
    const waiting = fetch(playlist).then((r) => {
      advertised = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      advertised,
      false,
      "a playlist cannot advertise a temporary segment",
    );
    await rename(
      resolve(growing, "index1.m4s.tmp"),
      resolve(growing, "index1.m4s"),
    );
    const ready = await waiting;
    await assertStatus(ready, 200);
    assert.ok((await ready.text()).includes("index1.m4s"));
    await writeFile(resolve(growing, "index.m3u8"), saved);
    await rm(resolve(growing, "index1.m4s"));
    sql(
      `UPDATE media_jobs SET status='succeeded',lease_until=NULL WHERE id='${id}'; UPDATE media_outputs SET status='published' WHERE job_id='${id}' AND attempt=1`,
    );
    assert.ok(
      (await (await fetch(playlist)).text()).includes("#EXT-X-ENDLIST"),
    );
    const init = manifest.match(/URI="([^"]+)"/)[1];
    const segment = manifest.split("\n").find((line) => line.startsWith("/"));
    assert.equal(new URL(worker + init).searchParams.get("attempt"), "1");
    assert.equal(new URL(worker + segment).searchParams.get("attempt"), "1");
    assert.deepEqual(
      Buffer.from(await (await fetch(worker + init)).arrayBuffer()),
      initBytes(1),
    );
    assert.deepEqual(
      Buffer.from(await (await fetch(worker + segment)).arrayBuffer()),
      segmentBytes(1),
    );
    const hidden = new URL(worker + segment);
    for (const name of ["index0.m4s.tmp", "index00.m4s", "log.txt"]) {
      hidden.pathname = `/media-delivery/${id}/${name}`;
      await writeFile(resolve(growing, name), segmentBytes(1));
      assert.equal(
        (await fetch(hidden)).status,
        400,
        "private files are never output resources",
      );
    }
    hidden.pathname = `/media-delivery/${id}/index1.m4s`;
    await writeFile(resolve(growing, "index1.m4s"), segmentBytes(1));
    assert.equal(
      (await fetch(hidden)).status,
      502,
      "existing but unadvertised segments cannot be read",
    );
    await writeFile(
      resolve(growing, "index0.m4s"),
      segmentBytes(1).subarray(0, -1),
    );
    for (const options of [
      {},
      { method: "HEAD" },
      { headers: { Range: "bytes=0-7" } },
    ]) {
      assert.equal(
        (await fetch(worker + segment, options)).status,
        502,
        "truncated boxes cannot bypass checks",
      );
    }
    await rm(resolve(growing, "index0.m4s"));
    assert.equal(
      (await fetch(worker + segment)).status,
      502,
      "missing completed outputs fail promptly",
    );
    await writeFile(resolve(growing, "index0.m4s"), segmentBytes(1));
    console.log(
      "PASS: Worker gates live playlists on ready segments and rejects temporary, unadvertised or truncated files",
    );
    sql(`UPDATE media_jobs SET attempt=2 WHERE id='${id}'`);
    await writeFile(resolve(cache, id, "1", "index0.m4s"), "late old writer");
    assert.equal((await fetch(worker + segment)).status, 409);
    assert.equal((await fetch(worker + init)).status, 409);
    const current = await (await fetch(playlist)).text();
    const currentSegment = current
      .split("\n")
      .find((line) => line.startsWith("/"));
    assert.deepEqual(
      Buffer.from(await (await fetch(worker + currentSegment)).arrayBuffer()),
      segmentBytes(2),
    );
    const large = await open(resolve(cache, id, "2", "index0.m4s"), "r+");
    const length = 100 * 1024 * 1024;
    const moof = atom("moof", "test");
    const mdat = Buffer.alloc(8);
    mdat.writeUInt32BE(length - moof.length);
    mdat.write("mdat", 4);
    await large.write(
      Buffer.concat([moof, mdat]),
      0,
      moof.length + mdat.length,
      0,
    );
    await large.truncate(length);
    await large.close();
    let stalled;
    try {
      stalled = await new Promise((resolve, reject) => {
        http
          .get(worker + currentSegment, (response) => {
            response.pause();
            resolve(response);
          })
          .on("error", reject);
      });
      const aborted = new Promise((resolve) => {
        stalled.on("aborted", () => resolve(true));
        stalled.on("end", () => resolve(false));
        stalled.on("error", () => resolve(true));
      });
      await new Promise((r) => setTimeout(r, 500));
      const lease = sql(
        `SELECT id FROM cache_read_leases WHERE cache_id='${id}' ORDER BY expires_at DESC LIMIT 1`,
      );
      assert.ok(lease, "paused HTTP body retains its read lease");
      assert.equal(
        sql(`SELECT attempt FROM cache_read_leases WHERE id='${lease}'`),
        "2",
        "HTTP reader pins its actual output attempt",
      );
      const expires = sql(
        `SELECT expires_at FROM cache_read_leases WHERE id='${lease}'`,
      );
      await new Promise((r) => setTimeout(r, 6000));
      assert.ok(
        sql(`SELECT expires_at FROM cache_read_leases WHERE id='${lease}'`) >
          expires,
        "backpressure must not stop lease renewal",
      );
      sql(
        `UPDATE cache_read_leases SET expires_at=now()-interval '1 second' WHERE id='${lease}'`,
      );
      stalled.resume();
      // Keep consuming slowly enough that the lease-loss notification beats EOF.
      stalled.on("data", () => {
        stalled.pause();
        setTimeout(() => stalled.resume(), 25);
      });
      assert.equal(
        await Promise.race([
          aborted,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(Error("lease loss did not close stream")),
              12000,
            ),
          ),
        ]),
        true,
      );
    } finally {
      stalled?.destroy();
      await writeFile(resolve(cache, id, "2", "index0.m4s"), segmentBytes(2));
    }
    console.log(
      "PASS: stalled cached body renews its read lease; lease loss aborts delivery",
    );
    const unpinned = new URL(worker + currentSegment);
    unpinned.searchParams.delete("attempt");
    assert.equal((await fetch(unpinned)).status, 409);
    // Version 2 survives mutations of FFmpeg's private playlist and verifies
    // payload bytes, even when box boundaries and the total length still match.
    sql(
      `UPDATE media_outputs SET validation_version=2,visible_manifest='${saved.toString().replaceAll("'", "''")}',ready_segments=1 WHERE job_id='${id}' AND attempt=2`,
    );
    assert.deepEqual(await readiness(), {
      session_id: id,
      status: "ready",
      complete: true,
      available_until_ms: 4000,
    });
    sql(
      `UPDATE media_jobs SET status='running',lease_until=now()+interval '1 hour' WHERE id='${id}'; UPDATE media_outputs SET visible_manifest=NULL,ready_segments=0 WHERE job_id='${id}' AND attempt=2`,
    );
    assert.deepEqual(await readiness(), {
      session_id: id,
      status: "preparing",
      complete: false,
      available_until_ms: 0,
    });
    // Attempt 1 still has an output; only attempt 2 may determine readiness.
    sql(
      `UPDATE media_outputs SET visible_manifest='${saved.toString().replaceAll("'", "''")}',ready_segments=1 WHERE job_id='${id}' AND attempt=2`,
    );
    assert.deepEqual(await readiness(), {
      session_id: id,
      status: "ready",
      complete: false,
      available_until_ms: 4000,
    });
    assert.equal((await readiness(200, 3999)).status, "ready");
    assert.equal((await readiness(200, 4000)).status, "preparing");
    assert.equal((await readiness(200, 5000)).status, "preparing");
    assert.equal((await readiness(400, -1)).error.code, "INVALID_POSITION");
    assert.equal((await readiness(400, "NaN")).error.code, "INVALID_POSITION");
    sql(`UPDATE media_jobs SET status='succeeded' WHERE id='${id}'`);
    for (const [index, bytes] of [
      [-1, initBytes(2)],
      [0, segmentBytes(2)],
    ]) {
      sql(
        `INSERT INTO media_output_files(job_id,attempt,segment_index,size_bytes,sha256) VALUES('${id}',2,${index},${bytes.length},'${createHash("sha256").update(bytes).digest("hex")}')`,
      );
    }
    await writeFile(resolve(cache, id, "2", "index.m3u8"), "#EXTM");
    const durable = await fetch(playlist);
    assert.equal(durable.status, 200);
    assert.ok((await durable.text()).includes("#EXT-X-ENDLIST"));
    assert.deepEqual(
      Buffer.from(await (await fetch(worker + currentSegment)).arrayBuffer()),
      segmentBytes(2),
    );
    const altered = Buffer.from(segmentBytes(2));
    altered[altered.length - 1] ^= 1;
    await writeFile(resolve(cache, id, "2", "index0.m4s"), altered);
    for (const options of [
      {},
      { method: "HEAD" },
      { headers: { Range: "bytes=0-7" } },
    ]) {
      assert.equal(
        (await fetch(worker + currentSegment, options)).status,
        502,
        "equal-length payload damage fails the committed digest",
      );
    }
    await writeFile(resolve(cache, id, "2", "index0.m4s"), segmentBytes(2));
    sql(
      `DELETE FROM media_output_files WHERE job_id='${id}' AND attempt=2 AND segment_index=0`,
    );
    assert.equal(
      (await fetch(worker + currentSegment)).status,
      502,
      "a committed manifest cannot bypass missing file proofs",
    );
    console.log(
      "PASS: persisted snapshots ignore private torn playlists; full content proofs gate GET, HEAD and Range",
    );
    await outputCleanup({ id, cache, sql });
    for (const [reason, code, status] of [
      ["cache_capacity_exceeded", "CACHE_CAPACITY_EXCEEDED", 503],
      ["cache_read_only", "CACHE_READ_ONLY", 503],
      ["cache_permission_denied", "CACHE_PERMISSION_DENIED", 503],
      ["media_input_invalid", "MEDIA_INPUT_INVALID", 422],
      ["media_input_denied", "MEDIA_INPUT_DENIED", 502],
      ["media_decoder_unavailable", "MEDIA_DECODER_UNAVAILABLE", 422],
      ["media_encoder_unavailable", "MEDIA_ENCODER_UNAVAILABLE", 503],
      ["media_job_retry_exhausted", "MEDIA_JOB_RETRY_EXHAUSTED", 502],
      ["upstream_transport_retry_exhausted", "MEDIA_JOB_RETRY_EXHAUSTED", 502],
      ["private_path_and_credentials", "MEDIA_JOB_FAILED", 502],
    ]) {
      sql(
        `UPDATE media_jobs SET status='failed',error='${reason}' WHERE id='${id}'`,
      );
      const failure = await fetch(worker + currentSegment);
      const preparation = await readiness(status);
      assert.equal(preparation.error.code, code);
      assert.equal(preparation.error.retryable, false);
      assert.ok(
        !JSON.stringify(preparation).includes("private_path_and_credentials"),
      );
      assert.equal(failure.status, status);
      const body = await failure.json();
      assert.equal(body.error.code, code);
      assert.equal(
        body.error.retryable,
        false,
        "terminal job cannot recover by retrying its URL",
      );
      assert.ok(!JSON.stringify(body).includes("private_path_and_credentials"));
    }
    sql(`UPDATE media_jobs SET status='cancelled' WHERE id='${id}'`);
    assert.equal((await readiness(410)).error.code, "MEDIA_JOB_CANCELLED");
    const cancelled = await fetch(worker + currentSegment);
    assert.equal(cancelled.status, 410);
    assert.equal((await cancelled.json()).error.code, "MEDIA_JOB_CANCELLED");
    sql(`UPDATE media_jobs SET status='failed' WHERE id='${id}'`);
    assert.equal(
      (await fetch(worker + currentSegment)).status,
      502,
      "existing files cannot bypass terminal failure",
    );
  } finally {
    sql(
      `DELETE FROM media_jobs WHERE id='${id}'; UPDATE playback_sessions SET resource='${original.replaceAll("'", "''")}'::jsonb WHERE id='${id}'`,
    );
  }
  console.log(
    "PASS: Worker pins init/segments, rejects stale/unpinned attempts and failed outputs",
  );
}
