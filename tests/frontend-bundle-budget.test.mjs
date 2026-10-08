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
// Vite gives shared chunks generated keys rather than source paths. Follow the
// emitted import edges so a shared dependency behind a dynamic entry is legal,
// but an unreferenced record or an SDK merged into initial code cannot pass.
const dynamicEntries = new Set();
const reachable = new Set();
function visit(key) {
  if (reachable.has(key)) return;
  const entry = manifest[key];
  assert.ok(entry, `missing emitted dependency: ${key}`);
  reachable.add(key);
  for (const child of entry.imports ?? []) visit(child);
  for (const child of entry.dynamicImports ?? []) {
    dynamicEntries.add(child);
    visit(child);
  }
}
visit("index.html");
const deferred = new Set(
  [...dynamicEntries].flatMap((key) => [...dependencies(key)]),
);

test("initial JS stays bounded and every page is a deferred entry", async () => {
  const pages = [
    "LoginPage",
    "InvitationPage",
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
    assert.ok(dynamicEntries.has(found[0]), `${page} has no dynamic import`);
    assert.equal(initial.has(found[0]), false, `${page} reaches initial JS`);
  }
  // Route modules may share their interaction panel without one route
  // statically importing the other full page.
  const login = Object.keys(manifest).find((key) =>
    key.endsWith("/LoginPage.vue"),
  );
  const invitation = Object.keys(manifest).find((key) =>
    key.endsWith("/InvitationPage.vue"),
  );
  assert.equal(
    dependencies(invitation).has(login),
    false,
    "invitation imports the login page",
  );
  assert.equal(
    dependencies(login).has(invitation),
    false,
    "login imports the invitation page",
  );
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
  const hlsDriver = Object.keys(manifest).find((key) =>
    key.endsWith("/drivers/hls-driver.ts"),
  );
  assert.ok(hlsDriver, "missing independently emitted HLS driver");
  assert.ok(dynamicEntries.has(hlsDriver), "HLS driver has no dynamic import");
  assert.ok(deferred.has(hlsDriver), "HLS driver has no deferred import path");
  assert.equal(
    initial.has(hlsDriver),
    false,
    "HLS driver is statically reachable",
  );
  assert.equal(
    initialFiles.has(manifest[hlsDriver].file),
    false,
    "HLS driver shares initial code",
  );
  for (const [sdk, emittedName] of [
    ["dashjs", "dash.all.min"],
    ["hls.js", "hls"],
  ]) {
    const records = Object.entries(manifest).filter(
      ([key, entry]) =>
        `${key}/${entry.src ?? ""}`.includes(`node_modules/${sdk}/`) ||
        entry.name === emittedName,
    );
    assert.ok(records.length > 0, `missing independently emitted ${sdk} SDK`);
    for (const [key, entry] of records) {
      assert.ok(deferred.has(key), `${sdk} has no deferred import path`);
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
