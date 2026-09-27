import assert from "node:assert/strict";
import {
  randomUUID,
  randomBytes,
  createHash,
  createCipheriv,
} from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function captureProcesses({
  docker,
  image,
  root,
  env,
  name,
  sql,
  children,
  until,
  report,
  sourceKey,
}) {
  const worker = `${name}-capture`,
    directory = resolve(root, "capture"),
    cache = resolve(root, "capture-cache");
  await mkdir(directory);
  await mkdir(cache);
  await writeFile(resolve(directory, "mode"), "normal");
  await writeFile(
    resolve(directory, "sample.srt"),
    "1\n00:00:01,000 --> 00:00:03,000\nSubtitle capture\n",
  );
  for (const program of ["ffprobe", "ffmpeg"]) {
    await writeFile(
      resolve(directory, program),
      `#!/bin/sh
sleep 120 &
leaf=$!
printf '%s\\n%s\\n' "$$" "$leaf" > /cache/pids.tmp
mv /cache/pids.tmp /cache/pids
case "$(cat /media/capture/mode)" in
timeout) wait "$leaf" ;;
oversize) head -c 9000000 /dev/zero; wait "$leaf" ;;
*) /usr/bin/${program} "$@" ;;
esac
`,
      { mode: 0o755 },
    );
  }
  children.push(worker);
  docker(
    "run",
    "-d",
    "--name",
    worker,
    "--network",
    name,
    ...env,
    "-e",
    "PATH=/media/capture:/usr/local/bin:/usr/bin:/bin",
    "-p",
    "127.0.0.1::8081",
    "--mount",
    `type=bind,source=${root},target=/media,readonly`,
    "--mount",
    `type=bind,source=${cache},target=/cache`,
    image,
    "rainsync-media-worker",
  );
  const origin = `http://${docker("port", worker, "8081/tcp")}`;
  const room = randomUUID(),
    id = randomUUID(),
    token = randomBytes(24).toString("hex");
  const user = sql("SELECT id FROM users WHERE admin LIMIT 1");
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", sourceKey, nonce);
  const resource = {
    kind: "local",
    root: "/media",
    resource: "source.mp4",
    subtitle_indices: [0],
    subtitle_files: { 0: "capture/sample.srt" },
  };
  const encrypted = Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(resource)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  sql(`INSERT INTO rooms(id,name,owner_id) VALUES('${room}','Capture validation','${user}');
    INSERT INTO room_members(room_id,user_id) VALUES('${room}','${user}');
    INSERT INTO room_snapshots(room_id,state) VALUES('${room}','{"media_generation":0}');
    INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at)
    VALUES('${id}','${user}','${room}',0,'${createHash("sha256").update(token).digest("hex")}',jsonb_build_object('encrypted','${encrypted}'),now()+interval '1 hour');`);
  for (const path of ["probe", "subtitle-0.vtt"]) {
    for (const mode of ["normal", "oversize", "timeout"]) {
      await writeFile(resolve(directory, "mode"), mode);
      const response = await fetch(
        `${origin}/media-delivery/${id}/${path}?token=${token}`,
        { signal: AbortSignal.timeout(45000) },
      );
      if (mode === "normal") {
        assert.equal(response.status, 200);
        if (path === "probe")
          assert.ok(
            (await response.json()).streams.some(
              (s) => s.codec_type === "video",
            ),
          );
        else assert.match(await response.text(), /Subtitle capture/);
      } else {
        assert.equal(response.status, 502);
        await response.text();
      }
      const pids = (await readFile(resolve(cache, "pids"), "utf8"))
        .trim()
        .split(/\s+/);
      for (const pid of pids) {
        assert.match(pid, /^\d+$/);
        assert.equal(
          docker(
            "exec",
            worker,
            "sh",
            "-c",
            'test ! -e "/proc/$1" && echo gone',
            "sh",
            pid,
          ),
          "gone",
        );
      }
      assert.equal(
        docker("inspect", "--format", "{{.State.Running}}", worker),
        "true",
      );
      report.cases.push({
        scenario: `capture-${path}-${mode}`,
        response_status: response.status,
        remaining_processes: 0,
      });
    }
  }
  docker("kill", "--signal=TERM", worker);
  await until(
    () =>
      docker("inspect", "--format", "{{.State.Running}}", worker) === "false",
    "capture worker shutdown",
  );
  assert.equal(docker("wait", worker), "0");
  console.log(
    "PASS: real ffprobe and subtitle FFmpeg responses reap descendants on success, output limit and deadline",
  );
}
