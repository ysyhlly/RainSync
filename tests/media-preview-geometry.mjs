import assert from "node:assert/strict";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import {
  geometryCases,
  makeGeometry,
  measureCover,
  assertGeometry,
} from "./fixtures/preview-geometry.mjs";

await isolatedMediaStack("preview-geometry", async (f) => {
  makeGeometry(f.root);
  const client = f.client();
  await client.login();
  const source = await client.request("/sources", "POST", {
    name: "geometry",
    kind: "local",
    config: { root: f.root },
  });
  await client.request(`/sources/${source.id}/test`, "POST");
  const items = await client.request("/media");
  await f.startWorker();
  for (const c of geometryCases) {
    const item = items.find((i) => i.original_title === c.name);
    assert.ok(item, c.name);
    await client.request("/media/previews", "POST", { media_ids: [item.id] });
    const actual = await measureCover(
      client,
      f.root,
      await f.waitForPreview(item.id),
    );
    console.log(c.name, actual);
    assertGeometry(c, actual);
  }
  assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
  console.log(
    "PASS: native Server/Worker display geometry for anamorphic 16:9, 4:3, square pixels and portrait",
  );
});
