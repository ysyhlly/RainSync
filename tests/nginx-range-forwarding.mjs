import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const executable = process.env.RAINSYNC_NGINX_EXECUTABLE;
assert.ok(executable, "Set RAINSYNC_NGINX_EXECUTABLE to an installed Nginx binary");
const root = await mkdtemp(join(tmpdir(), "rainsync-nginx-ranges-"));
const media = Buffer.alloc(4096, 0x61), requests = [];
const origin = createServer((request, response) => {
  requests.push({ range: request.headers.range, ifRange: request.headers["if-range"] });
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", "video/mp4");
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
  if (range) {
    const start = Number(range[1]), end = Number(range[2]);
    response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${media.length}` });
    response.end(media.subarray(start, end + 1));
  } else response.end(media);
});
let nginx;
try {
  await new Promise(done => origin.listen(0, "127.0.0.1", done));
  const upstream = `http://127.0.0.1:${origin.address().port}`;
  const listener = tcpServer();
  await new Promise(done => listener.listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  await mkdir(join(root, "cache"));
  await mkdir(join(root, "logs"));
  const snippet = resolve("deploy/nginx-playback.inc.conf");
  await writeFile(join(root, "nginx.conf"), `
${process.getuid?.() === 0 ? "user root;" : ""}
worker_processes 1;
pid ${root}/nginx.pid;
error_log ${root}/error.log;
events { worker_connections 64; }
http {
  ${process.env.RAINSYNC_NGINX_LUA_PATH ? `lua_package_path ${JSON.stringify(process.env.RAINSYNC_NGINX_LUA_PATH)};` : ""}
  access_log off;
  proxy_cache_path ${root}/cache keys_zone=ranges:1m;
  proxy_cache ranges;
  server {
    listen 127.0.0.1:${port};
    location /inherited-cache { proxy_pass ${upstream}; }
    location /rainsync {
      include ${snippet};
      proxy_pass ${upstream};
    }
  }
}
`);
  nginx = spawn(executable, ["-p", root + "/", "-c", join(root, "nginx.conf"), "-g", "daemon off;"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  nginx.stderr.on("data", chunk => { stderr += chunk; });
  let launchError;
  nginx.on("error", error => { launchError = error; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (nginx.exitCode !== null) {
      const log = await readFile(join(root, "error.log"), "utf8").catch(() => "");
      throw new Error(`owned Nginx exited: ${(stderr + log).slice(-2000)}`);
    }
    try { if ((await fetch(base + "/rainsync", { signal: AbortSignal.timeout(200) })).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(ready, "owned Nginx ready");
  const headers = { Range: "bytes=935-1778", "If-Range": '"same-object"' };
  const broken = await fetch(base + "/inherited-cache", { headers });
  assert.equal(broken.status, 200);
  assert.equal((await broken.arrayBuffer()).byteLength, media.length);
  assert.equal(requests.at(-1).range, undefined);
  assert.equal(requests.at(-1).ifRange, undefined);
  const fixed = await fetch(base + "/rainsync", { headers });
  assert.equal(fixed.status, 206);
  assert.equal(fixed.headers.get("content-range"), "bytes 935-1778/4096");
  assert.equal((await fixed.arrayBuffer()).byteLength, 844);
  assert.deepEqual(requests.at(-1), { range: headers.Range, ifRange: headers["If-Range"] });
  const initialization = await fetch(base + "/rainsync", { headers: { Range: "bytes=0-934" } });
  assert.equal(initialization.status, 206);
  assert.equal(initialization.headers.get("content-range"), "bytes 0-934/4096");
  assert.equal((await initialization.arrayBuffer()).byteLength, 935);
  console.log(JSON.stringify({ inherited_cache_drops_ranges_despite_no_store: true, configured_proxy_preserves_range_and_if_range: true, index_and_initialization_ranges_206: true }));
} finally {
  if (nginx && nginx.exitCode === null) {
    const closed = once(nginx, "close");
    nginx.kill("SIGTERM");
    await closed;
  }
  await new Promise(done => origin.close(done));
  await rm(root, { recursive: true, force: true });
}
