import assert from "node:assert/strict";
import test from "node:test";
import { sameProfileItemMasterPath, profileSubtitleSelectionSupported } from "./fixtures/upstream-profile-route-contract.mjs";

test("only Jellyfin's exact compact/hyphenated GUID item aliases match the same base/master route", () => {
  const compact = "1234567890abcdef1234567890abcdef";
  const hyphenated = "12345678-90ab-cdef-1234-567890abcdef";
  for (const [item, route] of [[compact, hyphenated], [hyphenated, compact]]) {
    for (const base of ["/", "/proxy/jellyfin/"]) {
      const path = `${base}Videos/${route}/master.m3u8`;
      assert.equal(sameProfileItemMasterPath("jellyfin", base, item, path), true);
      assert.equal(sameProfileItemMasterPath("emby", base, item, path), false);
      for (const bad of [
        path.replace(route, "12345678-90ab-cdef-1234-567890abcdee"),
        path.replace(route, "1234-567890ab-cdef-1234-567890abcdef"),
        path.replace(route, `{${hyphenated}}`),
        path.replace(route, "urn:uuid:" + hyphenated),
        path.replace(route, "%31" + route.slice(1)),
        path.replace("master.m3u8", "main.m3u8"),
        "/other" + path,
        path + "/extra",
      ]) assert.equal(sameProfileItemMasterPath("jellyfin", base, item, bad), false, bad);
    }
  }
  assert.equal(sameProfileItemMasterPath("jellyfin", "/", "not-a-guid", "/videos/notaguid/master.m3u8"), false);
  assert.equal(sameProfileItemMasterPath("emby", "/", "item", "/Videos/item/master.m3u8"), true);
});

test("Jellyfin Encode alone is inert; selected/malformed/duplicate subtitle indices remain rejected", () => {
  for (const kind of ["jellyfin", "emby"]) {
    for (const index of [null, ["-1"]]) {
      assert.equal(profileSubtitleSelectionSupported(kind, { subtitlestreamindex: index, subtitlemethod: ["Encode"] }), kind === "jellyfin");
      assert.equal(profileSubtitleSelectionSupported(kind, { subtitlestreamindex: index }), true);
    }
    for (const index of [["0"], ["2"], [""], ["null"], ["-2"], ["-1", "0"]]) {
      for (const method of [null, ["Encode"], ["External"]])
        assert.equal(profileSubtitleSelectionSupported(kind, { subtitlestreamindex: index, subtitlemethod: method }), false);
    }
    assert.equal(profileSubtitleSelectionSupported(kind, { subtitlemethod: ["Encode", "External"] }), false);
  }
});
