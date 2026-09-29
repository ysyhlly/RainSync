import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { png } from "./fixtures/png.mjs";

// Exercise the deployed Linux FFmpeg, not just the host's newer encoder.
// The fixture owns its database; the application image never uses deployment data.
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    ...options,
  }).trim();
await isolatedServer("avatar-container", async (f) => {
  await f.stopServer();
  const ip = docker([
    "inspect",
    "--format",
    "{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    f.container,
  ]);
  const database = new URL(f.env.DATABASE_URL);
  database.hostname = ip;
  database.port = "5432";
  const name = `rainsync-avatar-test-${randomUUID()}`;
  const env = {
    ...f.env,
    DATABASE_URL: database.toString(),
    BIND: "0.0.0.0:8080",
  };
  const variables = [
    "DATABASE_URL",
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD",
    "SOURCE_ENCRYPTION_KEY",
    "PUBLIC_ORIGIN",
    "BIND",
  ];
  let started = false;
  try {
    docker(
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "-p",
        `127.0.0.1:${new URL(f.origin).port}:8080`,
        ...variables.flatMap((key) => ["-e", key]),
        process.env.RAINSYNC_AVATAR_TEST_IMAGE ?? "rainsync-server:dev",
      ],
      { env },
    );
    started = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (
          await fetch(f.origin + "/health", {
            signal: AbortSignal.timeout(500),
          })
        ).ok;
      } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, "isolated Linux Server must become ready");
    const client = f.client();
    await client.login();
    const cases = [
      ["transparent", png(), false],
      ["detailed", png(512, 512, { noisy: true, alpha: 255 }), true],
    ];
    if (process.env.RAINSYNC_AVATAR_TEST_PNG)
      cases.push([
        "local crop",
        await readFile(process.env.RAINSYNC_AVATAR_TEST_PNG),
        false,
      ]);
    let version = "none";
    for (const [label, input, large] of cases) {
      const response = await client.raw("/users/me/avatar", {
        method: "PUT",
        body: input,
        headers: {
          "Content-Type": "image/png",
          "If-Match": `"${version}"`,
          "x-avatar-operation-id": randomUUID(),
        },
      });
      const result = await response.json();
      assert.equal(
        response.status,
        200,
        `${label}: ${result.error?.code ?? "unexpected status"}`,
      );
      version = result.avatar_version;
      const stored = await client.raw(result.avatar_url.replace("/api/v1", ""));
      assert.equal(stored.status, 200);
      const bytes = Buffer.from(await stored.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
      assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
      assert.equal(
        bytes.readUInt32LE(4) + 8,
        bytes.length,
        "pipe output must have a complete RIFF length",
      );
      assert.ok(bytes.length <= 256 * 1024);
      if (large)
        assert.ok(
          bytes.length > 32768,
          "exercise output beyond the old muxer's seek buffer",
        );
      console.log(
        `PASS: Linux avatar ${label}, complete WebP (${bytes.length} bytes)`,
      );
    }
  } finally {
    if (started) docker(["rm", "-f", name]);
  }
});
