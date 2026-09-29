// Freeze an allowlisted, self-contained source candidate before long validation.
// Dependencies resolve from the repository's ancestor node_modules directory.
// Live-source stability is checked around copying; later development is allowed.
// Docker builds and verification use only the frozen files and pinned image ID.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { cpus, platform, release, totalmem } from "node:os";

const execute = promisify(execFile);
const options = new Map();
for (const argument of process.argv.slice(2)) {
  if (argument === "--build") options.set("build", true);
  else {
    const match =
      /^--(id|image|verify|vendor-candidate|frontend-ref)=(.+)$/.exec(argument);
    assert.ok(match, `unknown argument: ${argument}`);
    assert.ok(!options.has(match[1]), `duplicate option: ${match[1]}`);
    options.set(match[1], match[2]);
  }
}
assert.ok(
  !options.has("verify") || options.size === 1,
  "--verify cannot be combined with candidate creation or build options",
);
assert.ok(
  !options.has("image") || options.has("build"),
  "--image requires --build",
);
assert.ok(
  !options.has("vendor-candidate") || options.has("build"),
  "--vendor-candidate requires --build",
);

const sha = (value) => createHash("sha256").update(value).digest("hex");
const digestManifest = (manifest) => sha(JSON.stringify(manifest));
async function command(program, args, cwd, timeout = 60000) {
  const { stdout } = await execute(program, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}
const workspace = (
  await command("git", ["rev-parse", "--show-toplevel"], process.cwd())
).trim();
const storage = resolve(workspace, ".runtime/validation-candidates");
const identifier =
  options.get("verify") ??
  options.get("id") ??
  `candidate-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
function validateIdentifier(value) {
  assert.ok(
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value),
    "unsafe candidate ID",
  );
  assert.ok(
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value),
    "reserved candidate ID",
  );
}
validateIdentifier(identifier);
if (options.has("vendor-candidate"))
  validateIdentifier(options.get("vendor-candidate"));
const root = resolve(storage, identifier);
const frozen = resolve(root, "source");

// Never copy ignored runtime, credentials, key files, environment files, Git,
// tool connection settings, installed dependencies or generated build outputs.
const roots = new Set([
  "apps",
  "crates",
  "packages",
  "scripts",
  "tests",
  "migrations",
  "docs",
  "deploy",
  ".github",
]);
const rootFiles = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "package-lock.json",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "README.md",
  "NEXT_PLAN.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "NOTICE",
  "NOTICE.md",
  ".dockerignore",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierignore",
  ".nvmrc",
  ".node-version",
  "rust-toolchain",
  "rust-toolchain.toml",
  "rustfmt.toml",
  "clippy.toml",
  "Dockerfile",
  "Caddyfile",
  "Makefile",
  "playwright.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
]);
const extensions = new Set([
  "rs",
  "toml",
  "lock",
  "json",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "css",
  "scss",
  "html",
  "sql",
  "md",
  "yaml",
  "yml",
  "sh",
  "ps1",
  "py",
  "txt",
  "base64",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "snap",
]);
function forbidden(path) {
  const parts = path.split("/");
  return parts.some(
    (part) =>
      /^(?:\.git|\.runtime|\.codex|\.agents|\.aws|\.cgraphy|node_modules|target|dist|media|test-results|playwright-report)$/i.test(
        part,
      ) ||
      /^\.env(?:\.|$)/i.test(part) ||
      /\.(?:key|pem|p12|pfx|jks|keystore|kdbx|dump|log)$/i.test(part) ||
      /^(?:id_rsa|id_ed25519|credentials(?:\.json)?|agent-credentials\.json|secrets?\.(?:json|ya?ml)|\.mcp\.json)$/i.test(
        part,
      ),
  );
}
function safePath(path) {
  assert.ok(
    typeof path === "string" && path && !isAbsolute(path),
    "invalid manifest path",
  );
  assert.ok(
    !path.includes("\\") && !path.includes(":"),
    "invalid manifest path separator",
  );
  assert.ok(
    path.split("/").every((part) => part && part !== "." && part !== ".."),
    "manifest path escapes candidate",
  );
  return path;
}
function allowed(path) {
  safePath(path);
  if (forbidden(path)) return false;
  if (rootFiles.has(path)) return true;
  if (
    /^(?:vite|vitest|playwright|postcss|tailwind|eslint|prettier)\.config\.(?:ts|js|mjs|cjs)$/.test(
      path,
    )
  )
    return true;
  if (!roots.has(path.split("/")[0])) return false;
  const name = basename(path);
  return (
    /^(?:Dockerfile(?:\.[a-zA-Z0-9_-]+)?|Caddyfile|LICENSE(?:\.[a-z]+)?|NOTICE)$/i.test(
      name,
    ) || extensions.has(name.split(".").at(-1).toLowerCase())
  );
}
function productionPath(path) {
  return (
    ["Cargo.toml", "Cargo.lock"].includes(path) ||
    /^(?:crates|migrations)\//.test(path) ||
    /^apps\/(?:server|media-worker|nas-agent)\//.test(path)
  );
}
function frontendPath(path) {
  return (
    /^(?:apps\/web|packages)\//.test(path) ||
    ["package.json", "package-lock.json", "tsconfig.json"].includes(path) ||
    /^(?:vite|postcss|tailwind|eslint)\.config\.(?:ts|js|mjs|cjs)$/.test(path)
  );
}
async function frontendReference() {
  const ref = options.get("frontend-ref");
  if (!ref) return undefined;
  assert.ok(
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) && !ref.includes(".."),
    "unsafe frontend ref",
  );
  const commit = (
    await command(
      "git",
      ["rev-parse", "--verify", `${ref}^{commit}`],
      workspace,
    )
  ).trim();
  assert.match(commit, /^[0-9a-f]{40,64}$/, "invalid frontend commit identity");
  // This is baseline Git-tree evidence. The separate frozen frontend manifest
  // records the actual integrated files, which may contain deliberate fixes.
  const tree = await command(
    "git",
    [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      "--",
      "apps/web",
      "packages",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ],
    workspace,
  );
  const baseline = tree
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/.exec(line);
      assert.ok(match, "unexpected frontend baseline tree entry");
      return {
        path: match[4],
        mode: match[1],
        type: match[2],
        git_object: match[3],
      };
    })
    .filter((item) => allowed(item.path) && frontendPath(item.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.ok(
    baseline.some((item) => item.path.startsWith("apps/web/")),
    "frontend ref contains no web source",
  );
  assert.ok(
    baseline.every((item) => item.type === "blob" && item.mode !== "120000"),
    "frontend baseline contains unsupported linked source",
  );
  return {
    ref,
    commit,
    baseline_tree: baseline,
    baseline_tree_sha256: digestManifest(baseline),
  };
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function entry(base, path, allowDeleted = false) {
  const absolute = resolve(base, safePath(path));
  let status;
  try {
    status = await lstat(absolute);
  } catch (error) {
    if (allowDeleted && error.code === "ENOENT") return { path, deleted: true };
    throw error;
  }
  assert.ok(
    status.isFile() && !status.isSymbolicLink(),
    `refusing non-regular source file: ${path}`,
  );
  // Refuse directory junctions/symlinks as well, without following them while
  // collecting source or vendor data.
  let parent = dirname(absolute);
  while (relative(base, parent)) {
    const directory = await lstat(parent);
    assert.ok(
      directory.isDirectory() && !directory.isSymbolicLink(),
      `refusing linked directory: ${path}`,
    );
    parent = dirname(parent);
  }
  return { path, bytes: status.size, sha256: await hashFile(absolute) };
}
async function sourcePaths() {
  return [
    ...new Set(
      (
        await command(
          "git",
          ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          workspace,
        )
      )
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
}
async function capture() {
  const listed = await sourcePaths();
  const paths = listed.filter(allowed);
  const manifest = [];
  for (const path of paths) manifest.push(await entry(workspace, path, true));
  const head = (await command("git", ["rev-parse", "HEAD"], workspace)).trim();
  const status = await command(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths],
    workspace,
  );
  // Diff output is hashed in memory and never stored or printed. Even the
  // queried pathspec excludes forbidden files before Git reads their content.
  const working = await command(
    "git",
    ["diff", "--binary", "--no-ext-diff", "--", ...paths],
    workspace,
  );
  const staged = await command(
    "git",
    ["diff", "--cached", "--binary", "--no-ext-diff", "--", ...paths],
    workspace,
  );
  return {
    manifest,
    frontend: await frontendReference(),
    excluded_paths: listed.filter((path) => !allowed(path)),
    git: {
      head,
      status,
      working_diff_sha256: sha(working),
      staged_diff_sha256: sha(staged),
    },
  };
}
async function treePaths(base, filter = () => true, skipForbidden = false) {
  const rootStatus = await lstat(base);
  assert.ok(
    rootStatus.isDirectory() && !rootStatus.isSymbolicLink(),
    "refusing linked candidate root",
  );
  const paths = [];
  async function visit(directory, prefix = "") {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = prefix + item.name;
      const absolute = resolve(directory, item.name);
      const status = await lstat(absolute);
      assert.ok(
        !status.isSymbolicLink(),
        `refusing linked candidate input: ${path}`,
      );
      if (item.isDirectory()) {
        if (!skipForbidden || !forbidden(path))
          await visit(absolute, path + "/");
      } else if (item.isFile() && filter(path)) paths.push(path);
      else assert.ok(item.isFile(), `unsupported candidate input: ${path}`);
    }
  }
  await visit(base);
  return paths.sort();
}
async function treeManifest(base, filter, skipForbidden = false) {
  const manifest = [];
  for (const path of await treePaths(base, filter, skipForbidden))
    manifest.push(await entry(base, path));
  return manifest;
}
async function verifySource(candidate) {
  assert.equal(candidate.schema_version, 1, "unsupported candidate schema");
  assert.equal(candidate.id, identifier, "candidate ID mismatch");
  assert.equal(
    digestManifest(candidate.source_manifest),
    candidate.source_manifest_sha256,
    "candidate manifest digest mismatch",
  );
  assert.ok(
    candidate.source_manifest.every((item) => allowed(item.path)),
    "candidate contains forbidden source path",
  );
  assert.equal(
    digestManifest(
      candidate.source_manifest.filter((item) => productionPath(item.path)),
    ),
    candidate.production_manifest_sha256,
    "production digest mismatch",
  );
  if (candidate.frontend) {
    assert.match(
      candidate.frontend.commit,
      /^[0-9a-f]{40,64}$/,
      "invalid frozen frontend commit",
    );
    assert.equal(
      digestManifest(candidate.frontend.baseline_tree),
      candidate.frontend.baseline_tree_sha256,
      "frontend baseline tree digest mismatch",
    );
    assert.deepEqual(
      candidate.frontend.source_manifest,
      candidate.source_manifest.filter((item) => frontendPath(item.path)),
      "frontend source manifest differs from frozen source",
    );
    assert.equal(
      digestManifest(candidate.frontend.source_manifest),
      candidate.frontend.source_manifest_sha256,
      "frontend source digest mismatch",
    );
  }
  const frozenPaths = await treePaths(frozen, () => true, true);
  assert.ok(
    frozenPaths.every(allowed),
    "frozen source contains an unexpected or forbidden file",
  );
  const actual = [];
  for (const path of frozenPaths) actual.push(await entry(frozen, path));
  assert.deepEqual(
    actual,
    candidate.source_manifest.filter((item) => !item.deleted),
    "frozen candidate source changed",
  );
}
async function save(candidate) {
  const temporary = resolve(root, "candidate.json.tmp");
  await writeFile(temporary, JSON.stringify(candidate, null, 2) + "\n");
  await rename(temporary, resolve(root, "candidate.json"));
}
async function inspectImage(id) {
  const value = JSON.parse(
    await command(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", id],
      workspace,
    ),
  );
  return {
    id: value.Id,
    architecture: value.Architecture,
    os: value.Os,
    repo_digests: value.RepoDigests ?? [],
    labels: value.Config?.Labels ?? {},
  };
}
function verifyImageProvenance(candidate, image) {
  assert.equal(
    image.labels["org.rainsync.source-manifest"],
    candidate.production_manifest_sha256,
    "image source label differs from production candidate",
  );
  assert.equal(
    image.labels["org.rainsync.full-source-manifest"],
    candidate.source_manifest_sha256,
    "image full source label differs from frozen candidate",
  );
  assert.equal(
    image.labels["org.rainsync.candidate-id"],
    candidate.id,
    "image candidate identity differs from frozen candidate",
  );
  if (candidate.frontend) {
    assert.equal(
      image.labels["org.rainsync.frontend-ref"],
      candidate.frontend.ref,
      "image frontend ref differs from frozen candidate",
    );
    assert.equal(
      image.labels["org.rainsync.frontend-commit"],
      candidate.frontend.commit,
      "image frontend commit differs from frozen candidate",
    );
  }
}
async function binaryProof(id) {
  const container = `${identifier}-binary-proof`;
  try {
    const output = await command(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        container,
        id,
        "sh",
        "-c",
        "sha256sum /usr/local/bin/rainsync-server /usr/local/bin/rainsync-media-worker /usr/local/bin/rainsync-nas-agent; ffmpeg -version",
      ],
      workspace,
    );
    const hashes = {};
    for (const line of output.split(/\r?\n/)) {
      const match =
        /^([0-9a-f]{64})\s+\/usr\/local\/bin\/(rainsync-[a-z-]+)$/.exec(line);
      if (match) hashes[match[2]] = match[1];
    }
    assert.equal(
      Object.keys(hashes).length,
      3,
      "all actual production binaries must be measured",
    );
    const ffmpeg = output
      .split(/\r?\n/)
      .filter((line) =>
        /^(?:ffmpeg version|built with|configuration:|lib[a-z])/i.test(line),
      );
    assert.ok(
      ffmpeg.some((line) => line.startsWith("ffmpeg version")),
      "FFmpeg build identity missing",
    );
    return { binary_sha256: hashes, ffmpeg_build: ffmpeg };
  } finally {
    // A timed-out Docker CLI does not guarantee its temporary container ended.
    await command("docker", ["rm", "-f", container], workspace, 15000).catch(
      () => {},
    );
  }
}
async function reusableVendor(
  id,
  expectedSourceManifest,
  expectedVendorManifest,
) {
  validateIdentifier(id);
  assert.notEqual(
    id,
    identifier,
    "candidate cannot reuse its own vendor directory",
  );
  const location = resolve(storage, id);
  const actualStorage = await realpath(storage);
  const actualLocation = await realpath(location);
  assert.ok(
    actualLocation.startsWith(actualStorage + sep),
    "reused candidate escapes candidate storage",
  );
  for (const path of [
    location,
    resolve(location, "build"),
    resolve(location, "build/vendor"),
  ]) {
    const status = await lstat(path);
    assert.ok(
      status.isDirectory() && !status.isSymbolicLink(),
      "refusing linked reusable vendor path",
    );
  }
  const source = JSON.parse(
    await readFile(resolve(location, "candidate.json"), "utf8"),
  );
  assert.equal(
    source.schema_version,
    1,
    "unsupported reusable candidate schema",
  );
  assert.equal(source.id, id, "reusable candidate ID mismatch");
  assert.equal(
    source.status,
    "built",
    "reusable vendor candidate must have completed a real build",
  );
  assert.ok(
    /^sha256:[0-9a-f]{64}$/.test(source.image?.id ?? ""),
    "reusable candidate lacks its built image identity",
  );
  assert.equal(
    source.image?.labels?.["org.rainsync.source-manifest"],
    source.production_manifest_sha256,
    "reusable candidate image provenance is inconsistent",
  );
  for (const binary of [
    "rainsync-server",
    "rainsync-media-worker",
    "rainsync-nas-agent",
  ])
    assert.ok(
      /^[0-9a-f]{64}$/.test(source.image?.binary_sha256?.[binary] ?? ""),
      "reusable candidate lacks actual binary proof",
    );
  assert.equal(
    source.build?.vendor_directory,
    "build/vendor",
    "reusable vendor must use the candidate's fixed directory",
  );
  assert.ok(
    !source.build.vendor_candidate_id,
    "reusable vendor must be owned by the named candidate, not a chain of references",
  );
  assert.equal(
    digestManifest(source.source_manifest),
    source.source_manifest_sha256,
    "reusable candidate source manifest changed",
  );
  assert.ok(
    /^[0-9a-f]{64}$/.test(source.build.vendor_manifest_sha256),
    "invalid reusable vendor digest",
  );
  if (expectedSourceManifest)
    assert.equal(
      source.source_manifest_sha256,
      expectedSourceManifest,
      "reusable candidate provenance changed",
    );
  if (expectedVendorManifest)
    assert.equal(
      source.build.vendor_manifest_sha256,
      expectedVendorManifest,
      "reusable candidate vendor digest changed",
    );
  return {
    directory: resolve(location, "build/vendor"),
    id,
    source_manifest_sha256: source.source_manifest_sha256,
    vendor_manifest_sha256: source.build.vendor_manifest_sha256,
  };
}
async function vendorDirectory(candidate) {
  assert.equal(
    candidate.build.vendor_directory,
    "build/vendor",
    "invalid frozen vendor directory",
  );
  if (!candidate.build.vendor_candidate_id)
    return resolve(root, "build/vendor");
  assert.ok(
    /^[0-9a-f]{64}$/.test(candidate.build.vendor_source_manifest_sha256 ?? ""),
    "reused vendor provenance digest missing",
  );
  return (
    await reusableVendor(
      candidate.build.vendor_candidate_id,
      candidate.build.vendor_source_manifest_sha256,
      candidate.build.vendor_manifest_sha256,
    )
  ).directory;
}
async function verifyBuildInputs(candidate) {
  if (!candidate.build) return;
  assert.equal(
    await hashFile(resolve(root, "build/Dockerfile.process-trees")),
    candidate.build.dockerfile_sha256,
    "frozen Dockerfile changed",
  );
  const vendor = await treeManifest(await vendorDirectory(candidate));
  assert.equal(
    digestManifest(vendor),
    candidate.build.vendor_manifest_sha256,
    "frozen vendored build context changed",
  );
}

let candidate;
try {
  if (options.has("verify")) {
    candidate = JSON.parse(
      await readFile(resolve(root, "candidate.json"), "utf8"),
    );
    await verifySource(candidate);
    await verifyBuildInputs(candidate);
    if (candidate.image) {
      const image = await inspectImage(candidate.image.id);
      verifyImageProvenance(candidate, image);
      assert.deepEqual(
        (await binaryProof(image.id)).binary_sha256,
        candidate.image.binary_sha256,
        "actual image binaries differ from candidate",
      );
    }
    console.log(
      `VERIFIED: ${root}\nSource: ${candidate.source_manifest_sha256}\nProduction: ${candidate.production_manifest_sha256}`,
    );
  } else {
    await mkdir(storage, { recursive: true });
    const actualStorage = await realpath(storage);
    const actualWorkspace = await realpath(workspace);
    assert.ok(
      actualStorage.startsWith(actualWorkspace + sep),
      "candidate storage escapes workspace",
    );
    await mkdir(root); // Never overwrite or delete an existing candidate.
    await mkdir(frozen);
    const before = await capture();
    assert.ok(
      before.manifest.some(
        (file) => file.path === "Cargo.lock" && !file.deleted,
      ),
      "Cargo.lock missing",
    );
    assert.ok(
      before.manifest.some(
        (file) => file.path === "package-lock.json" && !file.deleted,
      ),
      "package-lock.json missing",
    );
    for (const file of before.manifest) {
      if (file.deleted) continue;
      const destination = resolve(frozen, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolve(workspace, file.path), destination);
      const original = await lstat(resolve(workspace, file.path));
      await chmod(destination, original.mode & 0o777);
      assert.deepEqual(
        await entry(frozen, file.path),
        file,
        `source changed while copying: ${file.path}`,
      );
    }
    const after = await capture();
    assert.deepEqual(
      after,
      before,
      "live source changed while freezing candidate; retry after edits settle",
    );
    const production = before.manifest.filter((file) =>
      productionPath(file.path),
    );
    candidate = {
      schema_version: 1,
      id: identifier,
      captured_at: new Date().toISOString(),
      status: "source-frozen",
      source_directory: "source",
      source_manifest: before.manifest,
      source_manifest_sha256: digestManifest(before.manifest),
      production_manifest: production,
      production_manifest_sha256: digestManifest(production),
      ...(before.frontend
        ? {
            frontend: {
              ...before.frontend,
              source_manifest: before.manifest.filter((file) =>
                frontendPath(file.path),
              ),
              source_manifest_sha256: digestManifest(
                before.manifest.filter((file) => frontendPath(file.path)),
              ),
            },
          }
        : {}),
      git: before.git,
      excluded_paths: before.excluded_paths,
      hardware: {
        os: platform(),
        release: release(),
        architecture: process.arch,
        cpu: cpus()[0]?.model,
        logical_cpus: cpus().length,
        memory_bytes: totalmem(),
      },
      node: process.version,
      integrity_scope:
        "Live files checked before and after copy; frozen source/build inputs checked before and after build. Subsequent live-repository edits do not change this candidate.",
      build_reproducibility:
        "A source-bound validation candidate; upstream base images and Debian FFmpeg packages still require release pinning.",
    };
    await verifySource(candidate);
    await save(candidate);
    console.log(
      `FROZEN: ${root}\nSource: ${candidate.source_manifest_sha256}\nProduction: ${candidate.production_manifest_sha256}`,
    );
    if (options.has("build")) {
      const engine = (
        await command(
          "docker",
          [
            "info",
            "--format",
            "{{json .OSType}}|{{json .Architecture}}|{{json .NCPU}}|{{json .MemTotal}}|{{json .ServerVersion}}",
          ],
          workspace,
        )
      )
        .trim()
        .split("|")
        .map(JSON.parse);
      candidate.hardware.docker_engine = {
        os: engine[0],
        architecture: engine[1],
        logical_cpus: engine[2],
        memory_bytes: engine[3],
        version: engine[4],
      };
      const originalDockerfile = resolve(
        workspace,
        ".runtime/build-inputs/Dockerfile.process-trees",
      );
      const reuse = options.has("vendor-candidate")
        ? await reusableVendor(options.get("vendor-candidate"))
        : undefined;
      const originalVendor =
        reuse?.directory ??
        resolve(workspace, ".runtime/build-inputs/process-tree-vendor");
      const recipeBefore = await hashFile(originalDockerfile);
      const vendorBefore = await treeManifest(originalVendor);
      if (reuse)
        assert.equal(
          digestManifest(vendorBefore),
          reuse.vendor_manifest_sha256,
          "reusable vendor differs from its original candidate build",
        );
      await mkdir(resolve(root, "build"));
      await copyFile(
        originalDockerfile,
        resolve(root, "build/Dockerfile.process-trees"),
      );
      if (!reuse)
        await cp(originalVendor, resolve(root, "build/vendor"), {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
        });
      if (!reuse)
        assert.equal(
          await hashFile(originalDockerfile),
          recipeBefore,
          "build recipe changed while copying",
        );
      assert.equal(
        digestManifest(await treeManifest(originalVendor)),
        digestManifest(vendorBefore),
        "vendored context changed while copying",
      );
      candidate.build = {
        dockerfile: "build/Dockerfile.process-trees",
        dockerfile_sha256: recipeBefore,
        vendor_directory: "build/vendor",
        vendor_files: vendorBefore.length,
        vendor_manifest_sha256: digestManifest(vendorBefore),
        ...(reuse
          ? {
              vendor_candidate_id: reuse.id,
              vendor_source_manifest_sha256: reuse.source_manifest_sha256,
            }
          : {}),
        started_at: new Date().toISOString(),
      };
      await verifySource(candidate);
      await verifyBuildInputs(candidate);
      candidate.status = "building";
      await save(candidate);
      const imageTag =
        options.get("image") ??
        `rainsync-validation-candidate:${identifier.toLowerCase()}`;
      assert.ok(
        /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(imageTag),
        "unsafe image tag",
      );
      const buildArgs = [
        "build",
        "--progress",
        "plain",
        "--build-context",
        `vendored=${await vendorDirectory(candidate)}`,
        "--label",
        `org.rainsync.source-manifest=${candidate.production_manifest_sha256}`,
        "--label",
        `org.rainsync.full-source-manifest=${candidate.source_manifest_sha256}`,
        "--label",
        `org.rainsync.candidate-id=${identifier}`,
        ...(candidate.frontend
          ? [
              "--label",
              `org.rainsync.frontend-ref=${candidate.frontend.ref}`,
              "--label",
              `org.rainsync.frontend-commit=${candidate.frontend.commit}`,
            ]
          : []),
        "-f",
        resolve(root, candidate.build.dockerfile),
        "-t",
        imageTag,
        frozen,
      ];
      candidate.build.command = ["docker", ...buildArgs];
      await save(candidate);
      console.log(`BUILDING: ${imageTag} from frozen source and vendor`);
      try {
        const result = await execute("docker", buildArgs, {
          cwd: workspace,
          encoding: "utf8",
          windowsHide: true,
          timeout: 3600000,
          maxBuffer: 32 * 1024 * 1024,
        });
        await writeFile(
          resolve(root, "build.log"),
          result.stdout + result.stderr,
        );
      } catch (error) {
        await writeFile(
          resolve(root, "build.log"),
          String(error.stdout ?? "") + String(error.stderr ?? ""),
        );
        throw new Error(
          "candidate image build failed; inspect the candidate build.log",
        );
      }
      await verifySource(candidate);
      await verifyBuildInputs(candidate);
      candidate.image = await inspectImage(imageTag);
      verifyImageProvenance(candidate, candidate.image);
      Object.assign(candidate.image, await binaryProof(candidate.image.id));
      candidate.build.finished_at = new Date().toISOString();
      candidate.status = "built";
      await save(candidate);
      console.log(
        `BUILT: ${candidate.image.id}\nManifest: ${resolve(root, "candidate.json")}`,
      );
    }
  }
} catch (error) {
  if (candidate && !options.has("verify")) {
    candidate.status = "failed";
    candidate.failure = String(error.message);
    await save(candidate).catch(() => {});
  }
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
