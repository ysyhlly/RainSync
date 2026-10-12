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

test("DASH and HLS SDKs remain outside the initial import closure", async () => {
  for (const name of ["hls", "dash"]) {
    const driver = Object.keys(manifest).find((key) =>
      key.endsWith(`/drivers/${name}-driver.ts`),
    );
    assert.ok(driver, `missing independently emitted ${name} driver`);
    assert.ok(
      dynamicEntries.has(driver),
      `${name} driver has no dynamic import`,
    );
    assert.ok(
      deferred.has(driver),
      `${name} driver has no deferred import path`,
    );
    assert.equal(
      initial.has(driver),
      false,
      `${name} driver is statically reachable`,
    );
    assert.equal(
      initialFiles.has(manifest[driver].file),
      false,
      `${name} driver shares initial code`,
    );
  }
  // This stable SDK extension installation belongs to the actual adapter.
  // Checking the facade alone would miss an eager import of its implementation.
  const marker = "SegmentBaseGetter";
  const initialBodies = await Promise.all(
    [...initialFiles]
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(resolve(output, file), "utf8")),
  );
  assert.ok(
    initialBodies.every((body) => !body.includes(marker)),
    "DASH adapter reached the initial JavaScript closure",
  );
  const dashDriver = Object.keys(manifest).find((key) =>
    key.endsWith("/drivers/dash-driver.ts"),
  );
  const adapterBodies = await Promise.all(
    [...dependencies(dashDriver)]
      .filter((key) => !initial.has(key))
      .map((key) => manifest[key].file)
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(resolve(output, file), "utf8")),
  );
  // Only static imports of the deferred driver count here, not its dynamic SDK.
  assert.ok(
    adapterBodies.some((body) => body.includes(marker)),
    "DASH adapter is missing from the deferred driver closure",
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

test("the unchanged P2P implementation is deferred with the HLS driver", async () => {
  const markers = ["P2P 目录绑定不匹配", "rainsync-chunks-v1"];
  const initialBodies = await Promise.all(
    [...initialFiles]
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(resolve(output, file), "utf8")),
  );
  const hlsDriver = Object.keys(manifest).find((key) =>
    key.endsWith("/drivers/hls-driver.ts"),
  );
  assert.ok(hlsDriver, "missing deferred HLS driver");
  const files = new Set(
    [...dependencies(hlsDriver)]
      .filter((key) => !initial.has(key))
      .map((key) => manifest[key].file)
      .filter((file) => file.endsWith(".js")),
  );
  const bodies = await Promise.all(
    [...files].map((file) => readFile(resolve(output, file), "utf8")),
  );
  for (const marker of markers) {
    assert.ok(
      initialBodies.every((body) => !body.includes(marker)),
      "P2P implementation reached the initial JavaScript closure",
    );
    assert.ok(
      bodies.some((body) => body.includes(marker)),
      "P2P implementation is missing from the deferred HLS driver closure",
    );
  }
  const sizes = await Promise.all(
    [...files].map(async (file) => ({
      file,
      bytes: (await stat(resolve(output, file))).size,
    })),
  );
  console.log(
    JSON.stringify({
      hls_deferred_static_js_bytes: sizes.reduce((sum, entry) => sum + entry.bytes, 0),
      hls_deferred_static_js_files: sizes,
    }),
  );
});
