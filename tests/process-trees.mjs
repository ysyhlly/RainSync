import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Keep the container alive after Worker exits: Docker's container teardown must
// not be what removes the descendants under test.
export async function processTrees({
  docker,
  image,
  root,
  env,
  name,
  sql,
  children,
  until,
  report,
}) {
  for (const mode of ["cancel", "shutdown", "normal"]) {
    const scenario = `tree-${mode}`,
      id = randomUUID(),
      worker = `${name}-${scenario}`;
    const shim = resolve(root, scenario),
      volume = resolve(root, `${scenario}-cache`);
    await mkdir(shim);
    await mkdir(volume);
    await writeFile(
      resolve(shim, "ffmpeg"),
      [
        "#!/bin/sh",
        'case " $* " in *" framehash "*) exec /usr/bin/ffmpeg "$@" ;; esac',
        "sleep 120 &",
        "leaf=$!",
        '/usr/bin/ffmpeg "$@" &',
        "encoder=$!",
        'printf "%s\\n%s\\n%s\\n" "$$" "$encoder" "$leaf" > /cache/tree.pids.tmp',
        "mv /cache/tree.pids.tmp /cache/tree.pids",
        'wait "$encoder"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    sql(
      `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}',0,'${id}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{"root":"/media","resource":"source.mp4","transcode":true,"estimated_output_bytes":268435456,"start_seconds":${mode === "normal" ? 150 : 0}}')`,
    );
    children.push(worker);
    docker(
      "run",
      "-d",
      "--init",
      "--name",
      worker,
      "--network",
      name,
      "--cpus",
      "0.5",
      ...env,
      "-e",
      `PATH=/media/${scenario}:/usr/local/bin:/usr/bin:/bin`,
      "--mount",
      `type=bind,source=${root},target=/media,readonly`,
      "--mount",
      `type=bind,source=${volume},target=/cache`,
      image,
      "sh",
      "-c",
      'rainsync-media-worker & worker=$!; printf "%s" "$worker" > /cache/worker.pid; wait "$worker"; code=$?; printf "%s" "$code" > /cache/worker.exit; exec sleep 120',
    );
    await until(() => {
      try {
        docker("exec", worker, "test", "-s", "/cache/tree.pids");
        return true;
      } catch {
        return false;
      }
    }, "encoder process tree started");
    const pids = docker("exec", worker, "cat", "/cache/tree.pids").split(/\s+/);
    assert.equal(pids.length, 3);
    pids.forEach((pid) => assert.match(pid, /^\d+$/));
    const workerPid = docker("exec", worker, "cat", "/cache/worker.pid");
    assert.match(workerPid, /^\d+$/);
    if (mode !== "normal") {
      for (const pid of pids)
        docker("exec", worker, "test", "-d", `/proc/${pid}`);
      // All generated descendants inherit the dedicated encoder group.
      for (const pid of pids) {
        const group = docker(
          "exec",
          worker,
          "awk",
          "{print $5}",
          `/proc/${pid}/stat`,
        );
        assert.equal(group, pids[0]);
      }
    }
    if (mode === "cancel")
      sql(`UPDATE playback_sessions SET stopped=true WHERE id='${id}'`);
    if (mode === "shutdown")
      docker("exec", worker, "sh", "-c", 'kill -TERM "$1"', "sh", workerPid);
    const began = Date.now();
    await until(
      () =>
        pids.every((pid) => {
          try {
            docker("exec", worker, "test", "!", "-e", `/proc/${pid}`);
            return true;
          } catch {
            return false;
          }
        }),
      "whole process group including zombies reaped",
      45000,
    );
    await until(
      () =>
        sql(
          `SELECT count(*) FROM cache_write_reservations WHERE job_id='${id}'`,
        ) === "0",
      "budget released after process tree exit",
    );
    if (mode === "normal") {
      await until(
        () =>
          sql(`SELECT status FROM media_jobs WHERE id='${id}'`) === "succeeded",
        "normal wrapper completion publishes valid output",
      );
    }
    if (mode !== "shutdown")
      docker("exec", worker, "sh", "-c", 'kill -TERM "$1"', "sh", workerPid);
    await until(() => {
      try {
        return docker("exec", worker, "cat", "/cache/worker.exit") === "0";
      } catch {
        return false;
      }
    }, "Worker exits while container stays alive");
    for (const pid of pids)
      docker("exec", worker, "test", "!", "-e", `/proc/${pid}`);
    assert.equal(
      docker("inspect", "--format", "{{.State.Running}}", worker),
      "true",
    );
    sql(
      `UPDATE playback_sessions SET stopped=true WHERE id='${id}'; UPDATE media_jobs SET status='cancelled',lease_until=NULL,owner_id=NULL WHERE id='${id}' AND status<>'succeeded'`,
    );
    report.cases.push({
      scenario,
      descendant_pids: pids,
      container_still_running: true,
      remaining_processes: 0,
      elapsed_ms: Date.now() - began,
    });
    docker("rm", "-f", "-v", worker);
  }
  console.log(
    "PASS: real FFmpeg process groups reap wrapper, encoder and lingering descendant on cancel, shutdown and normal exit before container teardown",
  );
}
