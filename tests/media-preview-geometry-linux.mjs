import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import {
  geometryCases,
  makeGeometry,
  measureCover,
  assertGeometry,
} from "./fixtures/preview-geometry.mjs";

const image = process.env.RAINSYNC_PREVIEW_IMAGE;
assert.ok(
  image,
  "Set RAINSYNC_PREVIEW_IMAGE to the dedicated patched Linux image",
);
await isolatedMediaStack("geometry-linux", async (f) => {
  const name = "rainsync-geometry-" + f.id.slice(0, 8),
    network = name + "-net",
    containers = [];
  let networkCreated = false,
    connected = false;
  const docker = (args, env = {}) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    }).trim();
  try {
    makeGeometry(f.root);
    docker(["network", "create", network]);
    networkCreated = true;
    docker(["network", "connect", network, f.container]);
    connected = true;
    await f.stopServer();
    const env = {
      DATABASE_URL: `postgres://rainsync:${f.password}@${f.container}:5432/rainsync`,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: f.password,
      SOURCE_ENCRYPTION_KEY: f.env.SOURCE_ENCRYPTION_KEY,
      BIND: "0.0.0.0:8080",
      WORKER_BIND: "0.0.0.0:8081",
      PUBLIC_ORIGIN: "http://localhost",
      CACHE_ROOT: "/tmp/cache",
    };
    for (const role of ["server", "media-worker"]) {
      const container = name + "-" + role;
      containers.push(container);
      docker(
        [
          "run",
          "-d",
          "--name",
          container,
          "--network",
          network,
          "--label",
          "rainsync.fixture=" + f.id,
          ...Object.keys(env).flatMap((k) => ["-e", k]),
          "-v",
          f.root + ":/media:ro",
          ...(role === "server" ? ["-p", "127.0.0.1::8080"] : []),
          image,
          "rainsync-" + role,
        ],
        env,
      );
    }
    f.origin = "http://" + docker(["port", containers[0], "8080/tcp"]);
    f.env.PUBLIC_ORIGIN = env.PUBLIC_ORIGIN;
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      try {
        healthy = (
          await fetch(f.origin + "/health", {
            signal: AbortSignal.timeout(500),
          })
        ).ok;
      } catch {}
      if (healthy) break;
      await delay(100);
    }
    assert.ok(healthy, "Linux Server health");
    const version = docker(["exec", containers[1], "ffmpeg", "-version"]);
    assert.match(version, /ffmpeg version 5\.1/);
    await writeFile(resolve(f.root, "ffmpeg-version.txt"), version);
    const client = f.client();
    await client.login();
    const source = await client.request("/sources", "POST", {
      name: "Linux geometry",
      kind: "local",
      config: { root: "/media" },
    });
    await client.request(`/sources/${source.id}/test`, "POST");
    const items = await client.request("/media");
    for (const c of geometryCases) {
      const item = items.find((i) => i.original_title === c.name);
      assert.ok(item, c.name);
      await client.request("/media/previews", "POST", { media_ids: [item.id] });
      const actual = await measureCover(
        client,
        f.root,
        await f.waitForPreview(item.id),
      );
      console.log(c.name, actual);
      assertGeometry(c, actual);
    }
    assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
    console.log(
      "PASS: new Linux Server/Worker with Bookworm FFmpeg 5.1; authenticated display geometry for all four fixtures",
    );
  } finally {
    for (const container of containers.reverse()) {
      try {
        await writeFile(
          resolve(f.root, container + ".log"),
          docker(["logs", container]),
        );
      } catch {}
      try {
        docker(["rm", "-f", container]);
      } catch {}
    }
    if (connected) docker(["network", "disconnect", network, f.container]);
    if (networkCreated) docker(["network", "rm", network]);
  }
});
