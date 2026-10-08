import { expect, it } from "vitest";
import {
  validatePlatformImportPreview,
  selectedPlatformImportItems,
  validatePlatformPreviewCover,
} from "../apps/web/src/features/rooms/platform-import";
import { libraryPageSummary } from "../apps/web/src/features/library/library-summary";
import { mediaEpisodeLabel } from "../apps/web/src/features/library/media-label";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWHsAAAAASUVORK5CYII=";
const item = {
  key: "a".repeat(64),
  provider: "bilibili",
  url: "https://www.bilibili.com/video/BV1xx411c7mD",
  part: 1,
  title: "真实视频标题",
};
const response = (fields: object) => ({
  items: [{ ...item, ...fields }],
  failures: [],
  truncated: false,
  limit: 20,
});
it("keeps safe raster metadata in preview and never forwards it in an import mutation", () => {
  const preview = validatePlatformImportPreview(
    response({
      cover_data_url: png,
      metadata_error: { code: "platform_import_unavailable", retryable: true },
    }),
  );
  expect(preview.items[0].cover_data_url).toBe(png);
  expect(preview.items[0].metadata_error?.retryable).toBe(true);
  const body = selectedPlatformImportItems(preview, [item.key], "anonymous")[0];
  expect(Object.keys(body).sort()).toEqual(["key", "part", "provider", "url"]);
});
it.each([
  ["provider URL", "https://i0.hdslb.com/cover.jpg"],
  ["SVG payload", "data:image/svg+xml;base64,PHN2Zz4="],
  ["wrong PNG magic", "data:image/png;base64,PHNjcmlwdD4="],
  ["wrong JPEG magic", "data:image/jpeg;base64,AAAA"],
  ["oversized payload", "data:image/png;base64," + "A".repeat(700_000)],
])("rejects an unsafe preview image: %s", (_label, value) => {
  expect(() => validatePlatformPreviewCover(value)).toThrow(
    "预览封面无法安全显示",
  );
});
it("keeps a known missing-cover reason but rejects arbitrary metadata messages", () => {
  expect(
    validatePlatformImportPreview(
      response({
        cover_unavailable_reason: "platform_preview_cover_unavailable",
      }),
    ).items[0].cover_unavailable_reason,
  ).toBe("platform_preview_cover_unavailable");
  expect(() =>
    validatePlatformImportPreview(
      response({ cover_unavailable_reason: "https://untrusted.example" }),
    ),
  ).toThrow();
});
it("distinguishes loaded source/folder counts from the total number of videos", () => {
  expect(
    libraryPageSummary(
      [{ type: "source", id: "a", name: "A", media_count: 25 }],
      0,
    ),
  ).toBe("1 个片源");
  expect(
    libraryPageSummary(
      [{ type: "folder", id: "b", name: "B", media_count: 10 }],
      2,
    ),
  ).toBe("1 个目录 · 2 部影片");
});
it("labels only explicit episode or native part evidence", () => {
  expect(
    mediaEpisodeLabel({
      title: "源里的第三集",
      series: { season_number: 1, episode_number: 3 },
    }),
  ).toBe("第 1 季 · 第 3 集");
  expect(mediaEpisodeLabel({ title: "Show.S02E03.1080p" })).toBe(
    "第 2 季 · 第 3 集",
  );
  expect(mediaEpisodeLabel({ title: "某番剧 第12集" })).toBe("第 12 集");
  expect(mediaEpisodeLabel({ title: "2026旅行记录" })).toBe("");
  expect(
    mediaEpisodeLabel({
      title: "Video",
      platform: {
        version: 1,
        provider: "bilibili",
        content_id: "BV1xx411c7mD",
        part: 2,
      },
    }),
  ).toBe("分 P · P2");
});
