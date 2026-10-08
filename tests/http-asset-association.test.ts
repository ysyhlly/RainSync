import { describe, it, expect } from "vitest";
import { parseHttpAssetAssociation } from "../apps/web/src/features/admin/http-asset-association";
describe("source-owner HTTP asset association", () => {
  it("omits sibling reads until explicitly declared", () => {
    expect(parseHttpAssetAssociation("")).toBeUndefined();
    expect(parseHttpAssetAssociation("   ")).toBeUndefined();
  });
  it("admits only finite same-stem kinds and immediate fonts", () => {
    const value = {
      schema_version: 1,
      subtitles: ["ass", "ssa", "pgs"],
      fonts: ["body.ttf", "CJK.TTC"],
    };
    expect(parseHttpAssetAssociation(JSON.stringify(value))).toEqual(value);
  });
  it("refuses URLs, roots, traversal, duplicates and arbitrary filter fields", () => {
    for (const font of [
      "../borrowed.ttf",
      "/etc/font.ttf",
      "https://foreign.invalid/font.ttf",
      "folder/body.ttf",
      "x%2fbody.ttf",
      ".hidden.ttf",
    ])
      expect(() =>
        parseHttpAssetAssociation(
          JSON.stringify({
            schema_version: 1,
            subtitles: ["ass"],
            fonts: [font],
          }),
        ),
      ).toThrow();
    for (const value of [
      { schema_version: 2, subtitles: [], fonts: [] },
      { schema_version: 1, subtitles: ["ass", "ass"], fonts: [] },
      { schema_version: 1, subtitles: ["vtt"], fonts: [] },
      { schema_version: 1, subtitles: [], fonts: ["a.ttf", "a.ttf"] },
      {
        schema_version: 1,
        subtitles: [],
        fonts: Array.from({ length: 65 }, (_, i) => `font${i}.ttf`),
      },
      {
        schema_version: 1,
        subtitles: [],
        fonts: [],
        url: "https://foreign.invalid/a.ass",
      },
      {
        schema_version: 1,
        subtitles: [],
        fonts: [],
        filter: "movie=/etc/passwd",
      },
    ])
      expect(() => parseHttpAssetAssociation(JSON.stringify(value))).toThrow();
  });
});
