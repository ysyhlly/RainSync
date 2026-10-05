import { expect, it, vi } from "vitest";
import {
  createPlatformImportFence,
  platformImportInput,
  platformCollectionProvider,
  platformImportFailureMessage,
  validatePlatformImportPreview,
  selectedPlatformImportItems,
  validatePlatformImportBatch,
  type PlatformImportPreviewItem,
} from "../apps/web/src/features/rooms/platform-import";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
const id = "00000000-0000-0000-0000-000000000001";
const bili: PlatformImportPreviewItem = {
  key: "a".repeat(64),
  provider: "bilibili",
  url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
  part: 2,
  title: "Example P2",
};
const douyin: PlatformImportPreviewItem = {
  key: "b".repeat(64),
  provider: "douyin",
  url: "https://www.douyin.com/video/123",
  part: 1,
  title: null,
};
const tiktok: PlatformImportPreviewItem = {
  key: "c".repeat(64),
  provider: "tiktok",
  url: "https://www.tiktok.com/@creator/video/456",
  part: 1,
  title: null,
};
const preview = (items = [bili, douyin, tiktok]) => ({
  items,
  failures: [],
  truncated: false,
  limit: 20,
});
const media = {
  id,
  title: "Imported",
  kind: "native_platform",
  platform: {
    version: 1,
    provider: "bilibili",
    content_id: "BV1xx411c7mD",
    part: 2,
  },
};
it("bounds mixed share paste by bytes and count without fetching any candidate", () => {
  const input =
    "复制打开抖音 https://v.douyin.com/ABC123/ 看视频\nhttps://b23.tv/DEF4567";
  expect(platformImportInput(input)).toBe(input);
  expect(() =>
    platformImportInput("https://b23.tv/ABC1234\n".repeat(21)),
  ).toThrow();
  expect(() => platformImportInput("中".repeat(6000))).toThrow();
  expect(() => platformImportInput("\0https://b23.tv/ABC1234")).toThrow();
});
it("only canonical bounded preview identities become selectable", () => {
  expect(validatePlatformImportPreview(preview()).items).toHaveLength(3);
  for (const item of [
    { ...bili, part: 1 },
    { ...bili, key: "capability" },
    { ...bili, url: "https://b23.tv/ABC1234" },
    { ...douyin, provider: "tiktok" },
    { ...douyin, title: "bad\ncontrol" },
    { ...douyin, url: "https://www.douyin.com:443/video/123" },
  ])
    expect(() =>
      validatePlatformImportPreview(preview([item as any])),
    ).toThrow();
  expect(() => validatePlatformImportPreview(preview([bili, bili]))).toThrow();
  expect(() =>
    validatePlatformImportPreview({ ...preview(), limit: 10000 }),
  ).toThrow();
});
it("an explicit collection preview preserves truncation and does not select or import automatically", () => {
  const p = validatePlatformImportPreview({
    ...preview([bili]),
    truncated: true,
  });
  expect(p.truncated).toBe(true);
  expect(() => selectedPlatformImportItems(p, [], "anonymous")).toThrow();
  expect(() =>
    selectedPlatformImportItems(p, [douyin.key], "anonymous"),
  ).toThrow();
  expect(() =>
    selectedPlatformImportItems(p, [bili.key, bili.key], "anonymous"),
  ).toThrow();
  expect(
    platformImportFailureMessage({
      code: "platform_collection_unsupported",
      retryable: false,
    }),
  ).toContain("暂不支持合集");
});
it("own-session batch intent never crosses provider fences or borrows Bilibili/YouTube credentials", () => {
  const own: any = { provider: "douyin", state: "connected", id };
  const items = selectedPlatformImportItems(
    preview(),
    [bili.key, douyin.key, tiktok.key],
    "own_or_anonymous",
    { douyin: own, tiktok: own },
  );
  expect(items[0]).not.toHaveProperty("credential_mode");
  expect(items[0]).not.toHaveProperty("account_id");
  expect(items[1]).toMatchObject({
    credential_mode: "own_or_anonymous",
    account_id: id,
  });
  expect(items[2]).toMatchObject({ credential_mode: "own_or_anonymous" });
  expect(items[2]).not.toHaveProperty("account_id");
  expect(
    selectedPlatformImportItems(preview(), [douyin.key], "anonymous", {
      douyin: own,
    })[0],
  ).not.toHaveProperty("account_id");
});
it("partial results retain success and distinguish retryable unattempted items", () => {
  const items = selectedPlatformImportItems(
    preview(),
    [bili.key, douyin.key],
    "anonymous",
  );
  const response = {
    outcomes: [
      { key: bili.key, media },
      {
        key: douyin.key,
        error: {
          code: "platform_import_deadline",
          retryable: true,
          attempted: false,
        },
      },
    ],
    stopped: "platform_import_deadline",
  };
  const result = validatePlatformImportBatch(response, items);
  expect(result.outcomes[0].media?.id).toBe(id);
  expect(result.outcomes[1].error).toEqual(response.outcomes[1].error);
  for (const bad of [
    { ...response, outcomes: [response.outcomes[0]] },
    { ...response, outcomes: [response.outcomes[0], response.outcomes[0]] },
    {
      ...response,
      outcomes: [
        { ...response.outcomes[0], key: tiktok.key },
        response.outcomes[1],
      ],
    },
    {
      ...response,
      outcomes: [
        { key: bili.key, media, error: { code: "invalid", retryable: false } },
        response.outcomes[1],
      ],
    },
    {
      ...response,
      outcomes: [
        {
          key: bili.key,
          media: {
            ...media,
            platform: { ...media.platform, content_id: "BV1yy411c7mD" },
          },
        },
        response.outcomes[1],
      ],
    },
  ])
    expect(() => validatePlatformImportBatch(bad, items)).toThrow();
});
it("per-item errors preserve safe correlation and explain access or extractor failures", () => {
  const items = selectedPlatformImportItems(
    preview([bili]),
    [bili.key],
    "anonymous",
  );
  for (const code of [
    "native_platform_access_denied",
    "native_platform_extractor_unavailable",
  ]) {
    const error = {
      code,
      retryable: false,
      attempted: true,
      status: 422,
      request_id: id,
    };
    const decode = (value: unknown) =>
      validatePlatformImportBatch(
        { outcomes: [{ key: bili.key, error: value }], stopped: null },
        items,
      );
    expect(
      decode({
        ...error,
        message: "private upstream body",
        url: "https://secret.example",
      }).outcomes[0].error,
    ).toEqual(error);
    expect(platformImportFailureMessage(error)).toContain(
      code.endsWith("access_denied") ? "平台拒绝访问" : "提取器未启用",
    );
    for (const invalid of [
      { ...error, request_id: "secret" },
      { ...error, status: 200 },
      { ...error, status: 502.5 },
    ])
      expect(() => decode(invalid)).toThrow();
  }
  expect(
    platformImportFailureMessage({ code: "constructor", retryable: false }),
  ).toBe("此条目导入失败，可重新预览或重试");
});
it("batch API sends only reviewed selected identities and scoped account intent, never preview titles or arbitrary fields", async () => {
  const items: any[] = selectedPlatformImportItems(
    preview([bili]),
    [bili.key],
    "anonymous",
  );
  items[0].cookie = "synthetic-secret";
  items[0].title = "private title";
  items[0].account_id = id;
  const request = vi.fn(async () => ({
    outcomes: [{ key: bili.key, media }],
    stopped: null,
  }));
  await roomsApi(request as any).importPlatformBatch(id, items);
  expect(request.mock.calls[0]).toEqual([
    `/rooms/${id}/platform-media/batch`,
    "POST",
    {
      items: [{ key: bili.key, provider: "bilibili", url: bili.url, part: 2 }],
    },
    undefined,
  ]);
});
it("preview API uses the room-scoped route and explicit collection toggle with an abort signal", async () => {
  const request = vi.fn(async () => preview([bili])),
    controller = new AbortController();
  await roomsApi(request as any).previewPlatform(
    id,
    "https://space.bilibili.com/123/lists/456?type=season",
    "bilibili",
    true,
    controller.signal,
  );
  expect(request.mock.calls[0]).toEqual([
    `/rooms/${id}/platform-media/preview`,
    "POST",
    {
      input: "https://space.bilibili.com/123/lists/456?type=season",
      provider: "bilibili",
      collection: true,
      collection_version: 2,
    },
    controller.signal,
  ]);
});
it("cancel and repeated preview/import requests cannot publish late results", () => {
  const scope = { room: id, epoch: 1, allowed: true },
    work = createPlatformImportFence(() => scope);
  const preview = work.begin();
  expect(work.current(preview)).toBe(true);
  const imported = work.begin();
  expect(preview.signal.aborted).toBe(true);
  expect(work.current(preview)).toBe(false);
  work.retire();
  expect(imported.signal.aborted).toBe(true);
  expect(work.current(imported)).toBe(false);
  const retried = work.begin();
  expect(work.current(retried)).toBe(true);
  expect(work.current(imported)).toBe(false);
});
it("room switching, login changes and controller revocation independently fence publication", () => {
  const scope = { room: id, epoch: 1, allowed: true },
    work = createPlatformImportFence(() => scope);
  const token = work.begin();
  scope.room = "00000000-0000-0000-0000-000000000002";
  expect(work.current(token)).toBe(false);
  scope.room = id;
  scope.epoch = 2;
  expect(work.current(token)).toBe(false);
  scope.epoch = 1;
  scope.allowed = false;
  expect(work.current(token)).toBe(false);
  work.retire();
  scope.allowed = true;
  expect(work.current(token)).toBe(false);
});
it("YouTube own-session imports use only the exact YouTube account and remain anonymous by default", () => {
  const youtube: PlatformImportPreviewItem = {
    key: "d".repeat(64),
    provider: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    part: 1,
    title: null,
  };
  const status: any = { provider: "youtube", id, state: "connected" };
  expect(
    selectedPlatformImportItems(
      preview([youtube]),
      [youtube.key],
      "own_or_anonymous",
      { youtube: status },
    )[0],
  ).toMatchObject({ credential_mode: "own_or_anonymous", account_id: id });
  expect(
    selectedPlatformImportItems(
      preview([youtube]),
      [youtube.key],
      "anonymous",
      { youtube: status },
    )[0],
  ).toMatchObject({ credential_mode: "anonymous" });
  expect(
    selectedPlatformImportItems(
      preview([youtube]),
      [youtube.key],
      "anonymous",
      { youtube: status },
    )[0],
  ).not.toHaveProperty("account_id");
  expect(
    selectedPlatformImportItems(
      preview([youtube]),
      [youtube.key],
      "own_or_anonymous",
      { youtube: { ...status, provider: "douyin" } },
    )[0],
  ).not.toHaveProperty("account_id");
});
it("YouTube playlist preview sends only explicit scoped account intent and never browser or caller flags", async () => {
  const request = vi.fn(async () => preview([])),
    controller = new AbortController();
  const input = "https://www.youtube.com/playlist?list=PLBB231211A4F62143";
  await roomsApi(request as any).previewPlatform(
    id,
    input,
    "bilibili",
    true,
    controller.signal,
    {
      credential_mode: "own_or_anonymous",
      account_id: id,
      cookies: "never-copy",
      flags: "--exec=bad",
    } as any,
  );
  expect(request.mock.calls[0]).toEqual([
    `/rooms/${id}/platform-media/preview`,
    "POST",
    {
      input,
      provider: "bilibili",
      collection: true,
      collection_version: 2,
      credential_mode: "own_or_anonymous",
      account_id: id,
    },
    controller.signal,
  ]);
  await roomsApi(request as any).previewPlatform(
    id,
    "PLBB231211A4F62143",
    "youtube",
    true,
    controller.signal,
    { credential_mode: "anonymous", account_id: id } as any,
  );
  expect(request.mock.calls[1][2]).toEqual({
    input: "PLBB231211A4F62143",
    provider: "youtube",
    collection: true,
    collection_version: 2,
    credential_mode: "anonymous",
  });
  await roomsApi(request as any).previewPlatform(
    id,
    "https://www.tiktok.com/@creator/collection/example-123",
    "tiktok",
    true,
    controller.signal,
    { credential_mode: "own_or_anonymous", account_id: id },
  );
  expect(request.mock.calls[2][2]).toEqual({
    input: "https://www.tiktok.com/@creator/collection/example-123",
    provider: "tiktok",
    collection: true,
    collection_version: 2,
  });
});
it("playlist selection accepts only canonical child videos, never a list, context URL, tracking alias or foreign extractor URL", () => {
  const youtube: PlatformImportPreviewItem = {
    key: "d".repeat(64),
    provider: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    part: 1,
    title: "Example",
  };
  const p = validatePlatformImportPreview(preview([youtube]));
  expect(
    selectedPlatformImportItems(p, [youtube.key], "anonymous")[0].url,
  ).toBe(youtube.url);
  for (const url of [
    "https://www.youtube.com/playlist?list=PLBB231211A4F62143",
    `${youtube.url}&list=PLBB231211A4F62143`,
    `${youtube.url}&si=tracking`,
    "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://attacker.test/watch?v=dQw4w9WgXcQ",
  ]) {
    expect(() =>
      validatePlatformImportPreview(preview([{ ...youtube, url }])),
    ).toThrow();
  }
  for (const code of [
    "platform_collection_provider_unavailable",
    "platform_collection_restricted",
    "platform_collection_items_unavailable",
    "platform_collection_cleanup_failed",
    "platform_collection_invalid",
  ]) {
    expect(platformImportFailureMessage({ code, retryable: false })).not.toBe(
      "此条目导入失败，可重新预览或重试",
    );
  }
});
it("single YouTube playlist share text preserves explicit own mode with the default Bilibili selector", async () => {
  const input =
    "分享 https://www.youtube.com/playlist?list=PLBB231211A4F62143。一起看";
  expect(platformCollectionProvider(input, "bilibili")).toBe("youtube");
  expect(
    platformCollectionProvider(
      "复制链接：https://www.youtube.com/playlist?list=PLBB231211A4F62143).",
      "bilibili",
    ),
  ).toBe("youtube");
  expect(platformCollectionProvider("PLBB231211A4F62143", "youtube")).toBe(
    "youtube",
  );
  const request = vi.fn(async () => preview([])),
    controller = new AbortController();
  await roomsApi(request as any).previewPlatform(
    id,
    input,
    "bilibili",
    true,
    controller.signal,
    { credential_mode: "own_or_anonymous", account_id: id },
  );
  expect(request.mock.calls[0]).toEqual([
    `/rooms/${id}/platform-media/preview`,
    "POST",
    {
      input,
      provider: "bilibili",
      collection: true,
      collection_version: 2,
      credential_mode: "own_or_anonymous",
      account_id: id,
    },
    controller.signal,
  ]);
});
it("collection account-intent recognition refuses multiple or overlong candidates without making a request", async () => {
  const request = vi.fn(async () => preview([]));
  for (const input of [
    "https://www.youtube.com/playlist?list=PLBB231211A4F62143 https://space.bilibili.com/123/lists/456?type=season",
    "PLBB231211A4F62143\nPLBB231211A4F62143",
    `分享 https://www.youtube.com/playlist?list=PL${"a".repeat(2100)}`,
  ]) {
    expect(() => platformCollectionProvider(input, "youtube")).toThrow();
    await expect(
      roomsApi(request as any).previewPlatform(
        id,
        input,
        "youtube",
        true,
        undefined,
        { credential_mode: "own_or_anonymous", account_id: id },
      ),
    ).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});
it("TikTok collection share text stays public even when YouTube is the fallback and own mode is selected", async () => {
  const input =
    "分享 https://www.tiktok.com/@creator/collection/example-123。一起看";
  expect(platformCollectionProvider(input, "youtube")).toBe("tiktok");
  const request = vi.fn(async () => preview([]));
  await roomsApi(request as any).previewPlatform(
    id,
    input,
    "youtube",
    true,
    undefined,
    { credential_mode: "own_or_anonymous", account_id: id },
  );
  expect(request.mock.calls[0]).toEqual([
    `/rooms/${id}/platform-media/preview`,
    "POST",
    { input, provider: "youtube", collection: true, collection_version: 2 },
    undefined,
  ]);
});
it("official non-YouTube collection/share host recognition cannot attach fallback YouTube intent", async () => {
  const request = vi.fn(async () => preview([]));
  for (const input of [
    "分享 https://space.bilibili.com/123/lists/456?type=season。",
    "分享 https://b23.tv/ABC1234。",
    "分享 https://v.douyin.com/ABC123。",
    "分享 https://vm.tiktok.com/ABC123。",
  ]) {
    expect(platformCollectionProvider(input, "youtube")).not.toBe("youtube");
    await roomsApi(request as any).previewPlatform(
      id,
      input,
      "youtube",
      true,
      undefined,
      { credential_mode: "own_or_anonymous", account_id: id },
    );
  }
  for (const call of request.mock.calls) {
    expect(call[2]).not.toHaveProperty("credential_mode");
    expect(call[2]).not.toHaveProperty("account_id");
  }
});
