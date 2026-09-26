import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

// Deliberately never capture environment variables, container configuration,
// source credentials, or ignored runtime/media files.
function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function optional(command, args) {
  try {
    return { value: run(command, args) };
  } catch {
    return { unavailable: true };
  }
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = run("git", [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
])
  .split("\0")
  .filter(Boolean);
const files = [];
for (const path of [...new Set(paths)].sort()) {
  try {
    const bytes = await readFile(path);
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    files.push({ path, deleted: true });
  }
}
const imageNames = optional("docker", ["compose", "config", "--images"]);
const images = [];
for (const name of new Set(
  (imageNames.value ?? "").split(/\r?\n/).filter(Boolean),
)) {
  const inspected = optional("docker", [
    "image",
    "inspect",
    "--format",
    "{{json .Id}}|{{json .RepoDigests}}|{{json .Architecture}}|{{json .Os}}",
    name,
  ]);
  if (inspected.unavailable) images.push({ name, unavailable: true });
  else {
    const [id, repo_digests, architecture, os] = inspected.value
      .split("|")
      .map(JSON.parse);
    images.push({ name, id, repo_digests, architecture, os });
  }
}
const report = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  git: {
    head: run("git", ["rev-parse", "HEAD"]),
    status: run("git", ["status", "--porcelain=v1"]),
  },
  source_manifest_sha256: sha256(JSON.stringify(files)),
  files,
  lockfiles: files.filter((f) =>
    ["Cargo.lock", "package-lock.json"].includes(f.path),
  ),
  tools: {
    node: process.version,
    rust: optional("rustc", ["--version"]),
    docker: optional("docker", ["version", "--format", "{{.Server.Version}}"]),
  },
  images,
  image_inventory_available: !imageNames.unavailable,
};
const output = resolve(process.argv[2] ?? ".runtime/evidence/baseline.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  `Baseline: ${output}\nSource manifest: ${report.source_manifest_sha256}\nFiles: ${files.length}; images: ${images.length}`,
);
