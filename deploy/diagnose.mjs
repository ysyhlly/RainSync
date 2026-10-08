// Read-only post-start gate, run from the actual browser/Agent network location.
// HTTP probes never include credentials and never follow redirects.
import assert from "node:assert/strict";
import { realpath, stat, lstat, access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  dirname,
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export function origin(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error(`${name}: invalid HTTP(S) origin`);
  }
  assert.ok(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      !["0.0.0.0", "[::]"].includes(url.hostname) &&
      url.port !== "0",
    `${name}: use a reachable HTTP(S) origin without credentials, path, query or fragment`,
  );
  return url.origin;
}
async function canonicalDestination(path) {
  // Keep symlink/.. traversal semantics until realpath has resolved it.
  path = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw Error("root cannot be resolved");
  }
  const parent = dirname(path);
  assert.notEqual(parent, path, "root has no existing ancestor");
  const name = basename(path);
  assert.ok(
    name !== ".." && name !== ".",
    "root contains unresolved path components",
  );
  // Strip terminal separators without normalizing symlink/.. parents.
  const entry = await lstat(`${parent}${sep}${name}`).catch((error) => {
    if (error.code !== "ENOENT") throw Error("root cannot be resolved");
    return null;
  });
  assert.ok(!entry, "root contains an unresolved symlink");
  return resolve(await canonicalDestination(parent), name);
}
function containsPath(parent, child) {
  const tail = relative(parent, child);
  return (
    tail === "" ||
    (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
  );
}
export async function configuration(env = process.env) {
  const publicOrigin = origin(
    "PUBLIC_ORIGIN",
    env.PUBLIC_ORIGIN ?? "http://localhost:8088",
  );
  const mediaOrigin = origin("MEDIA_ORIGIN", env.MEDIA_ORIGIN ?? publicOrigin);
  const agentDataOrigin = origin(
    "AGENT_DATA_ORIGIN",
    env.AGENT_DATA_ORIGIN ?? publicOrigin,
  );
  assert.equal(
    mediaOrigin,
    publicOrigin,
    "MEDIA_ORIGIN must equal PUBLIC_ORIGIN; split-origin browser media is not supported",
  );
  if (env.WORKER_URL) origin("WORKER_URL", env.WORKER_URL);
  assert.ok(
    typeof env.SOURCE_ENCRYPTION_KEY === "string" &&
      /^[A-Za-z0-9+/]{43}=$/.test(env.SOURCE_ENCRYPTION_KEY) &&
      Buffer.from(env.SOURCE_ENCRYPTION_KEY, "base64").length === 32,
    "SOURCE_ENCRYPTION_KEY must encode exactly 32 bytes",
  );
  const media = env.MEDIA_ROOT ?? "/media",
    cache = env.CACHE_ROOT ?? "/cache";
  const canonicalMedia = await canonicalDestination(media),
    canonicalCache = await canonicalDestination(cache);
  assert.ok(
    !containsPath(canonicalMedia, canonicalCache) &&
      !containsPath(canonicalCache, canonicalMedia),
    "MEDIA_ROOT and CACHE_ROOT must not resolve to overlapping directories (equal, ancestor or descendant; including aliases/symlinks)",
  );
  assert.ok(
    (await stat(media)).isDirectory(),
    "MEDIA_ROOT must be a directory",
  );
  await access(media, constants.R_OK);
  assert.ok(
    (await stat(cache)).isDirectory(),
    "CACHE_ROOT must be a directory after Worker startup",
  );
  await access(cache, constants.R_OK | constants.W_OK);
  return { publicOrigin, mediaOrigin, agentDataOrigin };
}
export async function endpointChecks(
  endpoints,
  { fetchImpl = fetch, timeoutMs = 5000 } = {},
) {
  const probes = [
    [
      "control_liveness",
      endpoints.publicOrigin,
      "/api/v1/deployment/health",
      "rainsync-server",
    ],
    ["control_readiness", endpoints.publicOrigin, "/api/v1/deployment/ready"],
    [
      "media_liveness",
      endpoints.mediaOrigin,
      "/media-delivery/health",
      "rainsync-worker",
    ],
    ["media_readiness", endpoints.mediaOrigin, "/media-delivery/ready"],
    [
      "agent_data_liveness",
      endpoints.agentDataOrigin,
      "/agent-data/health",
      "rainsync-worker",
    ],
  ];
  const checks = Object.fromEntries(
    await Promise.all(
      probes.map(async ([name, base, path, service]) => {
        try {
          const response = await fetchImpl(base + path, {
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Accept: "application/json" },
          });
          assert.equal(response.status, 200);
          assert.match(
            response.headers.get("content-type") ?? "",
            /^application\/json\b/i,
          );
          // Bound responses; a misrouted SPA/proxy must not consume unlimited memory.
          const reader = response.body.getReader();
          let size = 0;
          const chunks = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              assert.ok(size <= 16384);
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          assert.ok(
            service
              ? body.service === service && body.live === true
              : body.ready === true &&
                  Object.keys(body.checks ?? {}).length > 0 &&
                  Object.values(body.checks).every(
                    (value) => value === "ready",
                  ),
          );
          return [name, "passed"];
        } catch {
          return [name, "failed"];
        }
      }),
    ),
  );
  return {
    schema_version: 1,
    result: Object.values(checks).every((value) => value === "passed")
      ? "passed"
      : "failed",
    checks,
    scope:
      "bounded HTTP route/readiness checks from this host only; not Agent WebSocket authentication, hardware encoder or playback acceptance",
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await endpointChecks(await configuration());
    console.log(JSON.stringify(report, null, 2));
    if (report.result !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(
      error.message.startsWith("ENOENT") || error.message.startsWith("EACCES")
        ? "configuration root unavailable"
        : error.message,
    );
    process.exitCode = 1;
  }
}
