import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  bilibiliCourseLink,
  ordinaryPlatformLink,
  platformEpisodeLabel,
  selectedPlatformImportItems,
  validatePlatformImportPreview,
  validatePlatformImportBatch,
  validNativePlatformMetadata,
} from "../apps/web/src/features/rooms/platform-import";
import {
  nativePlatformRequest,
  validNativePlatformPlan,
} from "../apps/web/src/features/playback/native-platform-intent";
import { platformTextBase } from "../apps/web/src/features/playback/platform-text";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
const id = "00000000-0000-0000-0000-000000000001";
const item = {
  key: "a".repeat(64),
  provider: "bilibili" as const,
  url: "https://www.bilibili.com/cheese/play/ep9007199254740993",
  part: 1,
  title: null,
  course_version: 1 as const,
};
const preview = { items: [item], failures: [], truncated: false, limit: 20 };
const platform = {
  version: 4,
  provider: "bilibili",
  content_id: "course:ep9007199254740993",
  part: 1,
  resource: {
    kind: "bilibili_course",
    ep_id: "9007199254740993",
    aid: "9007199254740994",
    cid: "9007199254740995",
    season_id: "12345",
  },
};
const media = {
  id,
  title: "Course · Episode",
  kind: "native_platform",
  platform,
};
it("canonical single course links retain exact large decimal identity and explicit opt-in", () => {
  expect(
    ordinaryPlatformLink(
      "https://m.bilibili.com/cheese/play/ep9007199254740993/",
    ),
  ).toEqual({
    provider: "bilibili",
    url: item.url,
    part: 1,
    course_version: 1,
  });
  expect(platformEpisodeLabel(item)).toContain("课程单集");
  for (const url of [
    item.url + "?",
    item.url + "?p=1",
    item.url + "#x",
    item.url.replace("ep9007199254740993", "ss12345"),
    item.url.replace("ep9007199254740993", "ep07"),
    item.url.replace("ep9007199254740993", "ep9223372036854775808"),
    item.url.replace("www.bilibili.com", "evil.example"),
    item.url.replace("/cheese/", "/bangumi/"),
    item.url.replace("/play/", "/play/../play/"),
  ])
    expect(() => bilibiliCourseLink(url)).toThrow();
  expect(validatePlatformImportPreview(preview).items).toEqual([item]);
  for (const patch of [
    { course_version: undefined },
    { course_version: 2 },
    { live_version: 1 },
  ])
    expect(() =>
      validatePlatformImportPreview({
        ...preview,
        items: [{ ...item, ...patch }],
      }),
    ).toThrow();
});
it("version four public metadata admits only closed identity, without credentials or access details", () => {
  expect(validNativePlatformMetadata(platform)).toBe(true);
  expect(
    validNativePlatformMetadata({
      version: 1,
      provider: "bilibili",
      content_id: platform.content_id,
      part: 1,
    }),
  ).toBe(false);
  for (const patch of [
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { provider: "youtube" },
    { part: 2 },
    { content_id: "ep9007199254740993" },
    { cookie: "private" },
    { has_paid: true },
    { account_id: id },
  ])
    expect(validNativePlatformMetadata({ ...platform, ...patch })).toBe(false);
  for (const axis of ["ep_id", "aid", "cid", "season_id"])
    for (const value of ["0", "01", "9223372036854775808", 1, null])
      expect(
        validNativePlatformMetadata({
          ...platform,
          resource: { ...platform.resource, [axis]: value },
        }),
      ).toBe(false);
  for (const kind of ["bilibili_pgc", "bilibili_live", "video"])
    expect(
      validNativePlatformMetadata({
        ...platform,
        resource: { ...platform.resource, kind },
      }),
    ).toBe(false);
  for (const field of [
    "bvid",
    "can_view",
    "has_paid",
    "cookie",
    "account_revision",
  ])
    expect(
      validNativePlatformMetadata({
        ...platform,
        resource: { ...platform.resource, [field]: "private" },
      }),
    ).toBe(false);
});
it("selected course imports keep viewer account intent and reject cross-kind or episode substitution", async () => {
  const selected = selectedPlatformImportItems(
    preview,
    [item.key],
    "own_or_anonymous",
    {
      bilibili: { id, provider: "bilibili", state: "connected", revision: "1" },
    },
  );
  expect(selected[0]).toMatchObject({
    course_version: 1,
    credential_mode: "own_or_anonymous",
    account_id: id,
  });
  const api = vi.fn(async () => ({
    outcomes: [{ key: item.key, media }],
    stopped: null,
  }));
  await roomsApi(api as any).importPlatformBatch(id, selected);
  expect(api.mock.calls[0]?.[2]).toEqual({ items: selected });
  expect(
    selectedPlatformImportItems(preview, [item.key], "anonymous")[0],
  ).not.toHaveProperty("account_id");
  expect(
    validatePlatformImportBatch(
      { outcomes: [{ key: item.key, media }], stopped: null },
      selected,
    ).outcomes[0].media?.id,
  ).toBe(id);
  for (const wrong of [
    { version: 1, provider: "bilibili", content_id: "BV1xx411c7mD", part: 1 },
    {
      version: 2,
      provider: "bilibili",
      content_id: "ep9007199254740993",
      part: 1,
      resource: {
        kind: "bilibili_pgc",
        ep_id: platform.resource.ep_id,
        cid: platform.resource.cid,
        season_id: platform.resource.season_id,
      },
    },
    {
      ...platform,
      content_id: "course:ep70",
      resource: { ...platform.resource, ep_id: "70" },
    },
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
it("course playback grants require exact opt-in and cannot be reused as legacy or live playback", () => {
  const request = nativePlatformRequest({
    viewer_id: id,
    plan_generation: 2,
    idempotency_key: id,
    room_id: id,
    media_generation: 4,
    position_ms: 0,
    credential_mode: "anonymous",
    mse_h264_aac: true,
    course: true,
  });
  expect(request.native_platform?.course_version).toBe(1);
  const plan: any = {
    media_generation: 4,
    plan_generation: 2,
    media_id: id,
    native_platform: {
      version: 1,
      provider: "bilibili",
      credential_mode: "anonymous",
      refresh_after_seconds: 30,
      course_version: 1,
    },
    session_id: id,
    delivery_mode: "direct",
    transport: "dash",
    timeline_origin_ms: 0,
    rebuild_on_seek: false,
    expires_in_seconds: 120,
    audio_tracks: [],
    subtitle_tracks: [],
    playback_url: `/api/v1/platform-delivery/${id}/manifest.mpd?token=abcdefghijklmnop`,
  };
  expect(
    validNativePlatformPlan(
      request,
      plan,
      "https://rain.test",
      "bilibili",
      undefined,
      true,
    ),
  ).toBe(true);
  expect(platformTextBase(plan, "https://rain.test")).toBeUndefined();
  expect(validNativePlatformPlan(request, plan, "https://rain.test")).toBe(
    false,
  );
  for (const course_version of [undefined, 0, 2, null])
    expect(
      validNativePlatformPlan(
        request,
        {
          ...plan,
          native_platform: { ...plan.native_platform, course_version },
        },
        "https://rain.test",
        "bilibili",
        undefined,
        true,
      ),
    ).toBe(false);
  for (const credential_mode of ["own_account", "owner_account"])
    expect(
      validNativePlatformPlan(
        request,
        {
          ...plan,
          native_platform: { ...plan.native_platform, credential_mode },
        },
        "https://rain.test",
        "bilibili",
        undefined,
        true,
      ),
    ).toBe(false);
  expect(
    validNativePlatformPlan(
      {
        ...request,
        native_platform: { ...request.native_platform!, live_version: 1 },
      },
      plan,
      "https://rain.test",
      "bilibili",
      undefined,
      true,
    ),
  ).toBe(false);
});
it("course migration preserves legacy/live checks and exact frozen per-viewer source authority", () => {
  const sql = readFileSync(
    new URL("../migrations/0059_bilibili_courses.sql", import.meta.url),
    "utf8",
  );
  const live = readFileSync(
    new URL("../migrations/0058_bilibili_live.sql", import.meta.url),
    "utf8",
  );
  const legacyShape = live.slice(
    live.indexOf("ALTER TABLE room_platform_media DROP CONSTRAINT"),
    live.indexOf("\n\n\nCREATE TABLE bilibili_live_broadcasts"),
  );
  const prior = legacyShape.slice(
    0,
    legacyShape.lastIndexOf("    ELSE false END"),
  );
  const retained = sql
    .slice(
      sql.indexOf("ALTER TABLE room_platform_media DROP CONSTRAINT"),
      sql.indexOf("    WHEN 'course_episode' THEN"),
    )
    .replaceAll("THEN aid IS NULL AND", "THEN");
  expect(retained).toBe(prior);
  for (const gate of [
    "WHEN 'course_episode'",
    "duration_ms BETWEEN 1000 AND 86400000",
    "'kind','bilibili_course','ep_id',e.ep_id::text,'aid',e.aid::text,'cid',e.cid::text,'season_id',e.season_id::text",
    "e.room_id::text",
    "e.revision::text",
    "a.user_id::text",
    "a.provider='bilibili'",
    "a.revision::text",
    "a.state='connected'",
    "a.credential_expires_at>clock_timestamp()",
    "playback_http_file_context_allowed",
    "ELSE native_platform_source_allowed_pre_course($1,$2)",
    "jsonb_object_keys($2))=3",
    "jsonb_object_keys($2->'native_platform_context'))=10",
  ])
    expect(sql).toContain(gate);
  expect(sql).not.toMatch(/DROP (?:TRIGGER|FUNCTION)/);
});
