import assert from "node:assert/strict";
import { createCipheriv, randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Controlled output bytes isolate actual Worker routing from FFmpeg execution.
export async function workerAttempts({ plan, worker, sql, key, cache }) {
  const id = plan.session_id;
  const original = sql(
    `SELECT resource FROM playback_sessions WHERE id='${id}'`,
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    nonce,
  );
  const encrypted = Buffer.concat([
    nonce,
    cipher.update(JSON.stringify({ job_id: id })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const playlist = new URL(worker + plan.playback_url);
  playlist.pathname = `/media-delivery/${id}/index.m3u8`;
  try {
    for (const attempt of [1, 2]) {
      const dir = resolve(cache, id, String(attempt));
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "index.m3u8"),
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nindex0.m4s\n#EXT-X-ENDLIST\n',
      );
      await writeFile(resolve(dir, "init.mp4"), `init-${attempt}`);
      await writeFile(resolve(dir, "index0.m4s"), `media-${attempt}`);
    }
    sql(
      `INSERT INTO media_jobs(id,session_id,status,spec,attempt) VALUES('${id}','${id}','succeeded','{}',1); UPDATE playback_sessions SET resource=jsonb_build_object('encrypted','${encrypted}') WHERE id='${id}'`,
    );
    const saved = await readFile(resolve(cache, id, "1", "index.m3u8"));
    const digest = createHash("sha256").update(saved).digest("hex");
    for (const attempt of [1, 2]) {
      sql(
        `INSERT INTO media_outputs(job_id,attempt,status,relative_dir,manifest_sha256,segment_count,published_at) VALUES('${id}',${attempt},'published','${id}/${attempt}','${digest}',1,now())`,
      );
    }
    await writeFile(
      resolve(cache, id, "1", "index.m3u8"),
      Buffer.concat([saved, Buffer.from("#changed\n")]),
    );
    assert.equal(
      (await fetch(playlist)).status,
      502,
      "published manifest digest must be enforced",
    );
    await writeFile(resolve(cache, id, "1", "index.m3u8"), saved);
    let response = await fetch(playlist);
    assert.equal(response.status, 200);
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
      assert.equal(recovered.status, 200);
      assert.ok((await recovered.text()).includes("index0.m4s"));
    }
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
    assert.equal(await (await fetch(worker + init)).text(), "init-1");
    assert.equal(await (await fetch(worker + segment)).text(), "media-1");
    sql(`UPDATE media_jobs SET attempt=2 WHERE id='${id}'`);
    await writeFile(resolve(cache, id, "1", "index0.m4s"), "late old writer");
    assert.equal((await fetch(worker + segment)).status, 409);
    assert.equal((await fetch(worker + init)).status, 409);
    const current = await (await fetch(playlist)).text();
    const currentSegment = current
      .split("\n")
      .find((line) => line.startsWith("/"));
    assert.equal(
      await (await fetch(worker + currentSegment)).text(),
      "media-2",
    );
    const unpinned = new URL(worker + currentSegment);
    unpinned.searchParams.delete("attempt");
    assert.equal((await fetch(unpinned)).status, 409);
    for (const [reason, code, status] of [
      ["cache_capacity_exceeded", "CACHE_CAPACITY_EXCEEDED", 503],
      ["media_job_retry_exhausted", "MEDIA_JOB_RETRY_EXHAUSTED", 502],
      ["private_path_and_credentials", "MEDIA_JOB_FAILED", 502],
    ]) {
      sql(
        `UPDATE media_jobs SET status='failed',error='${reason}' WHERE id='${id}'`,
      );
      const failure = await fetch(worker + currentSegment);
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
