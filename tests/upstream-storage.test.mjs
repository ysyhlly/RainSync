import assert from "node:assert/strict";
import test from "node:test";
import { ownedUpstreamStorage, createOwnedUpstreamVolume, verifyOwnedUpstreamVolume, removeOwnedUpstreamVolume } from "./fixtures/upstream-storage.mjs";

const id = "12345678-1234-4123-8123-123456789abc";
const [volume] = ownedUpstreamStorage("emby", id);

test("storage is limited to exact run-owned config/cache names", () => {
  for (const kind of ["emby", "jellyfin"]) {
    const storage = ownedUpstreamStorage(kind, id);
    assert.deepEqual(storage.map((v) => v.target), ["/config", "/cache"]);
    assert.ok(storage.every((v) => v.owner === id && v.name.startsWith(`rainsync-upstream-${kind}-${id}-`)));
  }
  for (const invalid of ["", "../config", "12345678-1234-1123-8123-123456789abc"])
    assert.throws(() => ownedUpstreamStorage("emby", invalid));
  assert.throws(() => ownedUpstreamStorage("foreign", id));
});

test("new volume creation uses its exact fixture label", async () => {
  const calls = [];
  await createOwnedUpstreamVolume(async (...args) => {
    calls.push(args);
    return args[1] === "ls" ? "" : volume.name;
  }, volume);
  assert.deepEqual(calls, [
    ["volume", "ls", "--filter", `name=^${volume.name}$`, "--format", "{{.Name}}"],
    ["volume", "create", "--label", `rainsync.fixture=${id}`, volume.name],
  ]);
});

test("pre-existing volume is never adopted or changed", async () => {
  const calls = [];
  await assert.rejects(createOwnedUpstreamVolume(async (...args) => {
    calls.push(args); return volume.name;
  }, volume), /must not already exist/);
  assert.equal(calls.length, 1);
});

test("cleanup eligibility requires exact name and owner, no permission mutation", async () => {
  for (const details of [
    { Name: volume.name, Labels: { "rainsync.fixture": id } },
    { Name: volume.name, Labels: {} },
    { Name: volume.name, Labels: { "rainsync.fixture": "foreign" } },
    { Name: "foreign", Labels: { "rainsync.fixture": id } },
  ]) {
    const calls = [];
    const check = verifyOwnedUpstreamVolume(async (...args) => {
      calls.push(args); return JSON.stringify(details);
    }, volume);
    if (details.Name === volume.name && details.Labels["rainsync.fixture"] === id) await check;
    else await assert.rejects(check);
    assert.deepEqual(calls, [["volume", "inspect", volume.name, "--format", "{{json .}}"]]);
  }
});

test("partial-startup cleanup removes only a positively verified owned volume", async () => {
  for (const labels of [{ "rainsync.fixture": id }, {}, { "rainsync.fixture": "foreign" }]) {
    const calls = [];
    const cleanup = removeOwnedUpstreamVolume(async (...args) => {
      calls.push(args);
      return args[1] === "inspect" ? JSON.stringify({ Name: volume.name, Labels: labels }) : volume.name;
    }, volume);
    if (labels["rainsync.fixture"] === id) {
      await cleanup;
      assert.deepEqual(calls[1], ["volume", "rm", volume.name]);
    } else {
      await assert.rejects(cleanup);
      assert.equal(calls.length, 1, "foreign/unlabeled storage never reaches rm");
    }
  }
});

test("uncertain create is registered before its side effect and still checked before cleanup", async () => {
  const attempted = [];
  let created = false;
  await assert.rejects(createOwnedUpstreamVolume(async (...args) => {
    if (args[1] === "ls") return "";
    assert.deepEqual(attempted, [volume], "cleanup registration precedes create");
    created = true;
    throw new Error("Docker response or activity log failed after creation");
  }, volume, (value) => attempted.push(value)), /after creation/);
  assert.equal(created, true);
  const calls = [];
  for (const pending of attempted)
    await removeOwnedUpstreamVolume(async (...args) => {
      calls.push(args);
      return args[1] === "inspect"
        ? JSON.stringify({ Name: volume.name, Labels: { "rainsync.fixture": id } })
        : volume.name;
    }, pending);
  assert.deepEqual(calls.map((args) => args[1]), ["inspect", "rm"]);
});

test("pre-existing storage never enters the cleanup tracker", async () => {
  const attempted = [];
  await assert.rejects(createOwnedUpstreamVolume(async () => volume.name, volume, (value) => attempted.push(value)));
  assert.deepEqual(attempted, []);
});
