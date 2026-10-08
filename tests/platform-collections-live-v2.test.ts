import { expect, it, vi } from "vitest";
import {
  ordinaryPlatformLink,
  validNativePlatformMetadata,
  validatePlatformImportPreview,
  validatePlatformImportBatch,
  selectedPlatformImportItems,
} from "../apps/web/src/features/rooms/platform-import";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
const hash = "a".repeat(64),
  key = "b".repeat(64),
  id = "00000000-0000-0000-0000-000000000001";
const url = "https://www.youtube.com/live/dQw4w9WgXcQ";
const metadata = {
  version: 5,
  provider: "youtube",
  content_id: `live:youtube:${hash}`,
  part: 1,
  resource: {
    kind: "other_live",
    provider: "youtube",
    resource_id: "dQw4w9WgXcQ",
    broadcaster_id: "UCabcdefghijklmnopqrstuv",
    started_at: 1700000000,
    broadcast_id: hash,
    canonical_url: url,
  },
};
it("admits explicit canonical livev2 selectors separately from VOD and Bili livev1", () => {
  for (const [provider, liveUrl] of [
    ["youtube", url],
    ["douyin", "https://live.douyin.com/7"],
    ["tiktok", "https://www.tiktok.com/@creator/live"],
    ["tiktok", "https://m.tiktok.com/share/live/7"],
  ] as const) {
    expect(ordinaryPlatformLink(liveUrl, provider).live_version).toBe(2);
    for (const suffix of ["?cookie=secret", "#x"])
      expect(() => ordinaryPlatformLink(liveUrl + suffix, provider)).toThrow();
  }
  expect(
    ordinaryPlatformLink(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "youtube",
    ).live_version,
  ).toBeUndefined();
  expect(
    ordinaryPlatformLink("https://live.bilibili.com/7", "bilibili")
      .live_version,
  ).toBe(1);
  expect(() =>
    ordinaryPlatformLink("https://live.douyin.com:443/7", "douyin"),
  ).toThrow();
});
it("validates v5 exact identity axes without confusing old Bili broadcasts", () => {
  expect(validNativePlatformMetadata(metadata)).toBe(true);
  for (const changed of [
    { ...metadata, provider: "bilibili" },
    { ...metadata, content_id: "live:7:7:9:1700000000" },
    { ...metadata, resource: { ...metadata.resource, resource_id: "wrong" } },
    { ...metadata, resource: { ...metadata.resource, started_at: Date.now() } },
    {
      ...metadata,
      resource: { ...metadata.resource, broadcast_id: "7:9:1700000000" },
    },
    {
      ...metadata,
      resource: {
        ...metadata.resource,
        upstream_url: "https://secret.invalid",
      },
    },
  ])
    expect(validNativePlatformMetadata(changed)).toBe(false);
});
it("reviews bounded pages and opaque continuation only, without automatically importing", async () => {
  const item = {
    key,
    provider: "youtube",
    url,
    part: 1,
    title: "Stream",
    live_version: 2,
  };
  const preview = validatePlatformImportPreview({
    items: [item],
    failures: [],
    truncated: true,
    limit: 20,
    next: "opaque_url_safe",
    omitted: 0,
  });
  expect(preview.next).toBe("opaque_url_safe");
  expect(() => selectedPlatformImportItems(preview, [], "anonymous")).toThrow();
  for (const next of ["https://upstream.invalid/cursor", "x".repeat(16385), 42])
    expect(() => validatePlatformImportPreview({ ...preview, next })).toThrow();
  const selected = selectedPlatformImportItems(preview, [key], "anonymous");
  expect(selected[0].live_version).toBe(2);
  const send = vi.fn().mockResolvedValue({ ...preview });
  await roomsApi(send).previewPlatform(
    id,
    "https://www.bilibili.com/bangumi/play/ss7",
    "bilibili",
    true,
    undefined,
    undefined,
    "opaque_url_safe",
  );
  expect(send.mock.calls[0][2]).toMatchObject({
    collection_version: 2,
    continuation: "opaque_url_safe",
  });
  expect(send).toHaveBeenCalledTimes(1);
  const batch = {
    outcomes: [
      {
        key,
        media: {
          id,
          kind: "native_platform",
          title: "Stream",
          duration_ms: null,
          platform: metadata,
        },
      },
    ],
    stopped: null,
  };
  expect(
    validatePlatformImportBatch(batch, selected).outcomes[0].media?.platform
      ?.version,
  ).toBe(5);
  expect(() =>
    validatePlatformImportBatch(
      {
        ...batch,
        outcomes: [
          {
            key,
            media: {
              ...batch.outcomes[0].media,
              platform: {
                ...metadata,
                resource: {
                  ...metadata.resource,
                  canonical_url: "https://www.youtube.com/live/abcdefghijk",
                },
              },
            },
          },
        ],
      },
      selected,
    ),
  ).toThrow();
});
it("course import keeps the refreshed Bili account replacement fence", () => {
  const item = {
    key,
    provider: "bilibili",
    url: "https://www.bilibili.com/cheese/play/ep7",
    part: 1,
    title: "Course",
    course_version: 1,
  };
  const preview = validatePlatformImportPreview({
    items: [item],
    failures: [],
    truncated: false,
    limit: 20,
  });
  const selected = selectedPlatformImportItems(
    preview,
    [key],
    "own_or_anonymous",
    { bilibili: { id, provider: "bilibili", state: "connected" } as any },
  );
  expect(selected[0]).toMatchObject({
    course_version: 1,
    credential_mode: "own_or_anonymous",
    account_id: id,
  });
});
