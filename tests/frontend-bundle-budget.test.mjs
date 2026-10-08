// Inspect the emitted dependency graph; this checks the shipped assets rather
// than duplicating source import statements. Run after npm run build.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.RAINSYNC_ARTIFACT_DIR
  ? resolve(process.env.RAINSYNC_ARTIFACT_DIR, "web-dist")
  : resolve(root, "apps/web/dist");
const manifest = JSON.parse(
  await readFile(resolve(output, ".vite/manifest.json"), "utf8"),
);
function dependencies(key, visited = new Set()) {
  if (visited.has(key)) return visited;
  const entry = manifest[key];
  assert.ok(entry, `missing emitted dependency: ${key}`);
  visited.add(key);
  for (const child of entry.imports ?? []) dependencies(child, visited);
  return visited;
}
const initial = dependencies("index.html");
const initialFiles = new Set([...initial].map((key) => manifest[key].file));

test("initial JS stays bounded and every page is a deferred entry", async () => {
  const pages = [
    "LoginPage",
    "RegisterPage",
    "ProfilePage",
    "RoomsPage",
    "RoomPage",
    "LibraryPage",
    "PrivateLibrariesPage",
    "PluginsPage",
    "SourcesPage",
    "AgentsPage",
    "RegistrationInvitesPage",
    "CreateUserPage",
    "AdminSettingsPage",
    "NotFoundPage",
  ];
  for (const page of pages) {
    const found = Object.entries(manifest).find(([key]) =>
      key.endsWith(`/${page}.vue`),
    );
    assert.ok(found, `missing built route ${page}`);
    assert.equal(found[1].isDynamicEntry, true, `${page} is eager`);
    assert.equal(initial.has(found[0]), false, `${page} reaches initial JS`);
  }
  let bytes = 0;
  for (const file of initialFiles)
    if (file.endsWith(".js")) bytes += (await stat(resolve(output, file))).size;
  const maximum = Number(
    process.env.RAINSYNC_INITIAL_JS_MAX_BYTES ?? 400 * 1024,
  );
  assert.ok(Number.isSafeInteger(maximum) && maximum > 0);
  assert.ok(
    bytes <= maximum,
    `initial JavaScript ${bytes} bytes exceeds ${maximum}`,
  );
  console.log(
    JSON.stringify({
      initial_js_bytes: bytes,
      initial_js_max_bytes: maximum,
      lazy_page_count: pages.length,
    }),
  );
});

test("DASH and HLS SDKs remain outside the initial import closure", () => {
  for (const sdk of ["dashjs", "hls.js"]) {
    const records = Object.entries(manifest).filter(([key, entry]) =>
      `${key}/${entry.src ?? ""}`.includes(`node_modules/${sdk}/`),
    );
    assert.ok(records.length > 0, `missing independently emitted ${sdk} SDK`);
    for (const [key, entry] of records) {
      assert.equal(initial.has(key), false, `${sdk} is statically reachable`);
      assert.equal(
        initialFiles.has(entry.file),
        false,
        `${sdk} shares initial code`,
      );
    }
  }
});

test("Acorn is an independent worker asset and room layout CSS is route-owned", async () => {
  const assets = await readdir(resolve(output, "assets"));
  const parser = assets.find((file) => /^acorn-[^.]+\.js$/.test(file));
  assert.ok(parser, "worker parser did not split from its entry");
  assert.equal(initialFiles.has(`assets/${parser}`), false);
  const worker = assets.find((file) =>
    /^advanced-danmaku-worker-[^.]+\.js$/.test(file),
  );
  assert.ok(worker, "missing advanced danmaku worker");
  const workerBody = await readFile(resolve(output, "assets", worker), "utf8");
  assert.ok(
    workerBody.includes(parser),
    "worker has no on-demand parser reference",
  );
  const initialCss = new Set(
    [...initial].flatMap((key) => manifest[key].css ?? []),
  );
  for (const file of initialCss)
    assert.ok(
      !(await readFile(resolve(output, file), "utf8")).includes(
        ".room-modular-page",
      ),
      "room layout reached initial CSS",
    );
  const room = Object.keys(manifest).find((key) =>
    key.endsWith("/RoomPage.vue"),
  );
  assert.ok(room);
  const roomCss = new Set(
    [...dependencies(room)].flatMap((key) => manifest[key].css ?? []),
  );
  const styles = await Promise.all(
    [...roomCss].map((file) => readFile(resolve(output, file), "utf8")),
  );
  assert.ok(
    styles.some((css) => css.includes(".room-modular-page")),
    "room route lost its layout styling",
  );
});
