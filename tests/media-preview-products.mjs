import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
// All containers, network, ports, users and media are created by this invocation.
await isolatedMediaStack("preview-products", async (f) => {
  const name = "rainsync-polish-" + f.id.slice(0, 8),
    network = name + "-net",
    containers = [];
  const docker = (args, env = {}) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const image =
      process.env.RAINSYNC_PREVIEW_IMAGE ?? "rainsync-polish-fixture:20260929",
    evidence = [];
  const wait = async (fn, label) => {
    for (let i = 0; i < 180; i++) {
      try {
        if (await fn()) return;
      } catch {}
      await delay(500);
    }
    throw Error(label);
  };
  async function start(suffix, img, args = [], env = {}) {
    const n = name + "-" + suffix;
    containers.push(n);
    docker(
      [
        "run",
        "-d",
        "--name",
        n,
        "--network",
        network,
        "--label",
        "rainsync.fixture=" + f.id,
        ...Object.keys(env).flatMap((k) => ["-e", k]),
        ...args,
        img,
      ],
      env,
    );
    return n;
  }
  try {
    await f.makeClip("fallback.mp4");
    await f.makeClip("poster.mp4");
    docker(["network", "create", network]);
    docker(["network", "connect", network, f.container]);
    await f.stopServer();
    const env = {
      ...f.env,
      DATABASE_URL: `postgres://rainsync:${f.password}@${f.container}:5432/rainsync`,
      BIND: "0.0.0.0:8080",
      WORKER_BIND: "0.0.0.0:8081",
      PUBLIC_ORIGIN: "http://localhost",
      CACHE_ROOT: "/tmp/cache",
    };
    const keys = [
      "DATABASE_URL",
      "ADMIN_USERNAME",
      "ADMIN_PASSWORD",
      "SOURCE_ENCRYPTION_KEY",
      "BIND",
      "WORKER_BIND",
      "PUBLIC_ORIGIN",
      "CACHE_ROOT",
    ];
    const runtime = Object.fromEntries(keys.map((k) => [k, env[k]]));
    const server = await start(
      "server",
      image,
      ["-p", "127.0.0.1::8080", "-v", f.root + ":/media:ro"],
      runtime,
    );
    f.origin = "http://" + docker(["port", server, "8080/tcp"]);
    f.env.PUBLIC_ORIGIN = "http://localhost";
    await wait(
      async () => (await fetch(f.origin + "/health")).ok,
      "linux server startup",
    );
    const worker = name + "-worker";
    containers.push(worker);
    docker(
      [
        "run",
        "-d",
        "--name",
        worker,
        "--network",
        network,
        "--label",
        "rainsync.fixture=" + f.id,
        ...Object.keys(runtime).flatMap((k) => ["-e", k]),
        "-v",
        f.root + ":/media:ro",
        image,
        "rainsync-media-worker",
      ],
      runtime,
    );
    const admin = f.client();
    await admin.login();
    const pixel = async (cover) => {
      const r = await admin.raw(cover.url.replace("/api/v1", ""));
      assert.equal(r.status, 200);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
      assert.ok(bytes.length <= 262144);
      const file = resolve(f.root, cover.revision + ".webp");
      await writeFile(file, bytes);
      const raw = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          file,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { windowsHide: true, timeout: 10000, maxBuffer: 2e6 },
      );
      assert.equal(raw.length, 640 * 360 * 3);
      return [
        ...raw.subarray((180 * 640 + 320) * 3, (180 * 640 + 320) * 3 + 3),
      ];
    };
    const local = await admin.request("/sources", "POST", {
      name: "linux-local",
      kind: "local",
      config: { root: "/media" },
    });
    await admin.request(`/sources/${local.id}/test`, "POST");
    for (const item of await admin.request("/media")) {
      await admin.request("/media/previews", "POST", { media_ids: [item.id] });
      const cover = await f.waitForPreview(item.id);
      assert.ok((await pixel(cover))[0] > 180);
    }
    evidence.push(
      "new Linux Server/Worker: actual local decode and authenticated bounded WebP",
    );
    const blue = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=640x360",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "pipe:1",
      ],
      { windowsHide: true, timeout: 10000 },
    );
    for (const [kind, img] of [
      ["jellyfin", "jellyfin/jellyfin:10.11.0"],
      ["emby", "emby/embyserver:4.10.0.40"],
    ]) {
      const config = resolve(f.root, kind);
      await mkdir(config, { recursive: true });
      const upstream = await start(kind, img, [
        "-p",
        "127.0.0.1::8096",
        "-v",
        config + ":/config",
        "-v",
        f.root + ":/media:ro",
      ]);
      const base =
        "http://" +
        docker(["port", upstream, "8096/tcp"]) +
        (kind === "emby" ? "/emby" : "");
      let token = "";
      async function api(path, method = "GET", body) {
        const r = await fetch(base + path, {
          method,
          signal: AbortSignal.timeout(15000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `MediaBrowser Client="RainSync Fixture", Device="Fixture", DeviceId="${f.id}", Version="1.0"${token ? `, Token="${token}"` : ""}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assert.ok(r.ok, `${kind} ${method} ${path}: ${r.status}`);
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      }
      await wait(async () => {
        const r = await fetch(base + "/Startup/Configuration");
        return r.ok;
      }, kind + " startup");
      await api("/Startup/Configuration", "POST", {
        ServerName: "owned fixture",
        UICulture: "en-US",
        MetadataCountryCode: "US",
        PreferredMetadataLanguage: "en",
      });
      await api("/Startup/User");
      await api("/Startup/User", "POST", {
        Name: "fixture",
        Password: f.password,
      });
      await api("/Startup/RemoteAccess", "POST", {
        EnableRemoteAccess: true,
        EnableAutomaticPortMapping: false,
      });
      await api("/Startup/Complete", "POST");
      const auth = await api("/Users/AuthenticateByName", "POST", {
        Username: "fixture",
        Pw: f.password,
      });
      token = auth.AccessToken;
      await api(
        "/Library/VirtualFolders?name=Fixtures&collectionType=homevideos&refreshLibrary=true",
        "POST",
        {
          LibraryOptions: {
            PathInfos: [{ Path: "/media" }],
            EnableRealtimeMonitor: false,
            EnableInternetProviders: false,
            SaveLocalMetadata: false,
            EnableChapterImageExtraction: false,
            EnableAutomaticSeriesGrouping: false,
          },
        },
      );
      await api("/Library/Refresh", "POST");
      let upstreamItems = [];
      await wait(async () => {
        upstreamItems = (
          await api(
            `/Users/${auth.User.Id}/Items?Recursive=true&IncludeItemTypes=Video,Movie`,
          )
        ).Items;
        return upstreamItems.length >= 2;
      }, kind + " scan");
      await wait(
        async () =>
          !(await api("/ScheduledTasks")).some(
            (t) =>
              /RefreshLibrary|Scan.*Library/i.test(t.Key ?? t.Name) &&
              t.State === "Running",
          ),
        kind + " scan complete",
      );
      const poster = upstreamItems.find((v) => v.Name === "poster");
      assert.ok(poster);
      const upload = await fetch(base + `/Items/${poster.Id}/Images/Backdrop`, {
        method: "POST",
        headers: { "Content-Type": "image/png", "X-Emby-Token": token },
        body: blue.toString("base64"),
      });
      assert.ok(upload.ok, kind + " poster upload " + upload.status);
      await wait(async () => {
        const items = (
          await api(
            `/Users/${auth.User.Id}/Items?Recursive=true&IncludeItemTypes=Video,Movie`,
          )
        ).Items;
        return (
          items.find((i) => i.Id === poster.Id)?.BackdropImageTags?.length > 0
        );
      }, kind + " backdrop metadata");
      const source = await admin.request("/sources", "POST", {
        name: kind,
        kind,
        config: {
          url: `http://${upstream}:8096` + (kind === "emby" ? "/emby" : ""),
          token,
          user_id: auth.User.Id,
        },
      });
      await admin.request(`/sources/${source.id}/test`, "POST");
      for (const id of f
        .sql(`SELECT id FROM media_items WHERE source_id='${source.id}'`)
        .split("\n")) {
        const item = await admin.request(`/media/${id}`);
        await admin.request("/media/previews", "POST", { media_ids: [id] });
        const cover = await f.waitForPreview(id);
        const rgb = await pixel(cover);
        if (item.original_title === "poster")
          assert.ok(rgb[2] > 180 && rgb[0] < 50, kind + " poster " + rgb);
        else
          assert.ok(
            rgb[0] > 180 && rgb[2] < 50,
            kind + " video fallback " + rgb,
          );
      }
      evidence.push(
        kind +
          ": real product scan, uploaded Backdrop priority, static video fallback",
      );
    }
    assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
    await writeFile(
      resolve(f.root, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.log("PASS: " + evidence.join("; "));
  } finally {
    for (const n of containers.reverse()) {
      try {
        await writeFile(resolve(f.root, n + ".log"), docker(["logs", n]));
        docker(["rm", "-f", n]);
      } catch {}
    }
    try {
      docker(["network", "disconnect", network, f.container]);
      docker(["network", "rm", network]);
    } catch {}
  }
});
