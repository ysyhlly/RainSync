import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  bilibiliEpisodeLink,
  ordinaryPlatformLink,
  platformEpisodeLabel,
  selectedPlatformImportItems,
  validatePlatformImportBatch,
  validatePlatformImportPreview,
  validNativePlatformMetadata,
} from "../apps/web/src/features/rooms/platform-import";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
const id = "00000000-0000-0000-0000-000000000001";
const item = {
  key: "a".repeat(64),
  provider: "bilibili" as const,
  url: "https://www.bilibili.com/bangumi/play/ep7",
  part: 1,
  title: null,
};
const preview = { items: [item], failures: [], truncated: false, limit: 20 };
const platform = {
  version: 2,
  provider: "bilibili",
  content_id: "ep7",
  part: 1,
  resource: { kind: "bilibili_pgc", ep_id: "7", cid: "8", season_id: "9" },
};
const media = {
  id,
  title: "Season · Episode",
  kind: "native_platform",
  platform,
};
it("canonical single-episode parsing never interprets a PGC URL as a UGC part or season", () => {
  expect(
    ordinaryPlatformLink("https://bilibili.com/bangumi/play/ep7/"),
  ).toEqual({ provider: "bilibili", url: item.url, part: 1 });
  expect(platformEpisodeLabel(item)).toBe(" · 单集 ep7");
  for (const url of [
    "https://www.bilibili.com/bangumi/play/ss7",
    item.url + "?p=2",
    item.url + "?from=share",
    item.url + "#p=1",
    "https://www.bilibili.com/bangumi/play/ep07",
    "https://evil.example/bangumi/play/ep7",
    "https://www.bilibili.com/bangumi/play/ep9223372036854775808",
    "https://www.bilibili.com/bangumi/play/../play/ep7",
  ])
    expect(() => bilibiliEpisodeLink(url)).toThrow();
  expect(validatePlatformImportPreview(preview).items).toEqual([item]);
});
it("the v2 resource is closed and rejects legacy, wrong provider and cross-kind substitutions", () => {
  expect(validNativePlatformMetadata(platform)).toBe(true);
  for (const wrong of [
    { ...platform, version: 1 },
    { ...platform, provider: "youtube" },
    { ...platform, content_id: "BV1xx411c7mD" },
    { ...platform, part: 2 },
    { ...platform, cookie: "secret" },
    { ...platform, resource: { ...platform.resource, kind: "video" } },
    { ...platform, resource: { ...platform.resource, ep_id: "07" } },
    {
      ...platform,
      resource: { ...platform.resource, cid: "9223372036854775808" },
    },
    { ...platform, resource: { ...platform.resource, season_id: 9 } },
    { ...platform, resource: { ...platform.resource, extra: true } },
  ])
    expect(validNativePlatformMetadata(wrong)).toBe(false);
  expect(
    validNativePlatformMetadata({
      version: 1,
      provider: "bilibili",
      content_id: "BV1xx411c7mD",
      part: 2,
    }),
  ).toBe(true);
});
it("batch result must match the selected exact episode rather than a provider-reported BV", () => {
  const selected = selectedPlatformImportItems(
    preview,
    [item.key],
    "anonymous",
  );
  expect(
    validatePlatformImportBatch(
      { outcomes: [{ key: item.key, media }], stopped: null },
      selected,
    ).outcomes[0].media?.id,
  ).toBe(id);
  for (const wrong of [
    {
      ...platform,
      resource: { ...platform.resource, ep_id: "70" },
      content_id: "ep70",
    },
    { version: 1, provider: "bilibili", content_id: "BV1xx411c7mD", part: 1 },
  ])
    expect(() =>
      validatePlatformImportBatch(
        {
          outcomes: [{ key: item.key, media: { ...media, platform: wrong } }],
          stopped: null,
        },
        selected,
      ),
    ).toThrow();
});
it("PGC import transmits only the viewer's exact own Bili account and keeps anonymous explicit", async () => {
  const selected = selectedPlatformImportItems(
    preview,
    [item.key],
    "own_or_anonymous",
    {
      bilibili: { id, provider: "bilibili", state: "connected", revision: "1" },
    },
  );
  expect(selected[0]).toMatchObject({
    credential_mode: "own_or_anonymous",
    account_id: id,
  });
  let body: any;
  await roomsApi((async (_path: unknown, _method: unknown, input: unknown) => {
    body = input;
    return { outcomes: [{ key: item.key, media }], stopped: null };
  }) as any).importPlatformBatch(id, selected);
  expect(body.items[0]).toEqual({ ...selected[0] });
  for (const state of ["revoked", "expired"] as const)
    expect(
      selectedPlatformImportItems(preview, [item.key], "own_or_anonymous", {
        bilibili: { id, provider: "bilibili", state, revision: "2" },
      })[0],
    ).not.toHaveProperty("account_id");
  expect(
    selectedPlatformImportItems(preview, [item.key], "anonymous", {
      bilibili: { id, provider: "bilibili", state: "connected", revision: "1" },
    })[0],
  ).not.toHaveProperty("account_id");
});
it("migration binds every resource axis and keeps account owner/revision/state/expiry and immutable gates", () => {
  const sql = readFileSync(
    new URL("../migrations/0055_pgc_episodes.sql", import.meta.url),
    "utf8",
  );
  expect(sql).toContain("WHEN '1'::jsonb THEN e.resource_kind='video'");
  expect(sql).toContain(
    "WHEN '2'::jsonb THEN e.resource_kind='pgc_episode' AND e.provider='bilibili'",
  );
  expect(sql).toContain(
    "'kind','bilibili_pgc','ep_id',e.ep_id::text,'cid',e.cid::text,'season_id',e.season_id::text",
  );
  for (const gate of [
    "e.room_id::text",
    "e.revision::text",
    "a.user_id::text",
    "a.provider=",
    "a.revision::text",
    "a.state='connected'",
    "a.credential_expires_at>clock_timestamp()",
    "playback_http_file_context_allowed",
    "=9",
    "=10",
  ])
    expect(sql).toContain(gate);
  expect(sql).not.toMatch(/DROP (?:TRIGGER|FUNCTION)/);
});
