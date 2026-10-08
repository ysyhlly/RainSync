// Read-only preflight. It never pulls images, downloads crates or changes Docker
// networking/security. Missing Linux/offline prerequisites are failures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./native-owner-binding.mjs";

export function staticHlsConfiguration(env, { postgres = false } = {}) {
  const required = (name) => {
    const value = env[name];
    assert.ok(typeof value === "string" && value.length > 0 &&
      value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value), `Set ${name}`);
    return value;
  };
  const image = (name) => {
    const value = required(name);
    assert.match(value,
      /^(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64})$/,
      `${name} must be an existing immutable image ID or digest, never a mutable tag`);
    return value;
  };
  const path = (name) => {
    const value = required(name);
    assert.ok(isAbsolute(value) && !value.includes(","),
      `${name} must be an absolute local bind-mount path without commas`);
    return value;
  };
  return {
    image: image(postgres ? "RAINSYNC_NATIVE_TEST_IMAGE" : "RAINSYNC_OWNER_TEST_IMAGE"),
    registry: path("RAINSYNC_OWNER_TEST_REGISTRY"),
    cargoConfig: path("RAINSYNC_OWNER_TEST_CARGO_CONFIG"),
    ...(postgres ? { postgresImage: image("RAINSYNC_SQL_POSTGRES_IMAGE") } : {}),
  };
}

export function validateStaticImage(image, { postgres = false } = {}) {
  assert.match(image?.Id ?? "", /^sha256:[0-9a-f]{64}$/, "Docker image ID missing");
  assert.equal(image.Os, "linux", "Static HLS owner fixtures require Linux images");
  if (postgres) {
    assert.equal(image.Config?.StopSignal, "SIGINT", "PostgreSQL must support clean SIGINT shutdown");
    assert.ok(image.Config?.Env?.includes("PG_MAJOR=17"),
      "The owned static HLS database fixture requires PostgreSQL 17");
  }
  return image.Id;
}

export async function staticHlsPrerequisites(options = {}) {
  const configuration = staticHlsConfiguration(process.env, options);
  assert.ok((await stat(configuration.registry)).isDirectory(),
    "RAINSYNC_OWNER_TEST_REGISTRY must be the populated offline Cargo registry directory");
  assert.ok((await readdir(configuration.registry)).length > 0,
    "The offline Cargo registry directory is empty");
  assert.ok((await stat(configuration.cargoConfig)).isFile(),
    "RAINSYNC_OWNER_TEST_CARGO_CONFIG must be a regular readable file");
  const configHash = sha256(await readFile(configuration.cargoConfig));
  const docker = (args) => execFileSync("docker", args, {
    encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  assert.equal(docker(["info", "--format", "{{.OSType}}"]).trim(), "linux",
    "A ready Linux Docker daemon is required; no platform fallback is supported");
  const inspect = (reference, options) => {
    const values = JSON.parse(docker(["image", "inspect", reference]));
    assert.equal(values.length, 1, "Exactly one local fixture image is required");
    const id = validateStaticImage(values[0], options);
    if (reference.startsWith("sha256:")) assert.equal(id, reference);
    return id;
  };
  const imageId = inspect(configuration.image);
  const postgresImageId = configuration.postgresImage
    ? inspect(configuration.postgresImage, { postgres: true }) : undefined;
  return {
    ...configuration, imageId, postgresImageId,
    summary: {
      result: "passed", docker_os: "linux", image_id: imageId,
      ...(postgresImageId ? { postgres_image_id: postgresImageId, postgres_major: 17 } : {}),
      cargo_config_sha256: configHash,
      dependency_mode: "offline --locked; registry/config mounted read-only",
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length === 3 && ["owner", "pending"].includes(process.argv[2]),
      "Usage: check-static-hls-prerequisites.mjs owner|pending");
    const result = await staticHlsPrerequisites({ postgres: process.argv[2] === "pending" });
    console.log(JSON.stringify(result.summary, null, 2));
  } catch (error) {
    // Docker stderr/config content is intentionally never printed.
    console.error(error instanceof assert.AssertionError ? error.message
      : "Static HLS prerequisites unavailable: check the local image IDs, offline paths and Linux Docker daemon");
    process.exitCode = 1;
  }
}
