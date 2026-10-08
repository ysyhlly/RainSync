export const missingCover = {
  status: "missing",
  revision: null,
  url: null,
  retry_after_ms: null,
};
export function mediaRecord(item: {
  id: string;
  title: string;
  [key: string]: unknown;
}) {
  return {
    original_title: item.title,
    shared_title: null,
    shared_title_revision: "0",
    personal_title: null,
    personal_title_revision: "0",
    cover: { ...missingCover },
    duration_ms: null,
    kind: "local",
    ...item,
  };
}

// Independent legacy playback fixtures must return real DTO shapes for new routes.
export function mediaExtraResponse(
  route: import("@playwright/test").Route,
  browseMedia = [mediaRecord({ id: "movie", title: "movie", kind: "local" })],
) {
  const url = new URL(route.request().url()),
    path = url.pathname;
  // Directory-first library requests must not fall through to the single-item
  // /media/:id fixture below. The source is navigable and uses bounded pages.
  if (path === "/api/v1/media/browse") {
    const node = url.searchParams.get("node"),
      after = url.searchParams.get("after"),
      start = after
        ? browseMedia.findIndex((item) => item.id === after) + 1
        : 0,
      limit = Number(url.searchParams.get("limit") ?? 24),
      media = browseMedia.slice(start, start + limit);
    return route.fulfill({
      json: {
        node,
        breadcrumbs: [
          { id: null, name: "全部片源" },
          ...(node ? [{ id: "legacy-source", name: "回归测试片源" }] : []),
        ],
        entries: node
          ? media.map((item) => ({ type: "media", media: item }))
          : [
              {
                type: "source",
                id: "legacy-source",
                name: "回归测试片源",
                kind: "local",
                media_count: browseMedia.length,
              },
            ],
        next_cursor:
          node && start + limit < browseMedia.length ? media.at(-1)!.id : null,
        total_media: browseMedia.length,
      },
    });
  }
  if (path === "/api/v1/media/previews") {
    const ids =
      route.request().method() === "POST"
        ? route.request().postDataJSON().media_ids
        : (url.searchParams.get("ids") ?? "").split(",");
    return route.fulfill({
      json: {
        items: ids.map((media_id: string) => ({
          media_id,
          cover: {
            ...missingCover,
            status: "unavailable",
            retry_after_ms: 60000,
          },
        })),
      },
    });
  }
  if (/^\/api\/v1\/(?:rooms\/[^/]+\/)?media\/[^/]+$/.test(path))
    return route.fulfill({
      json: mediaRecord({
        id: decodeURIComponent(path.split("/").at(-1)!),
        title: "movie",
      }),
    });
  if (
    /^\/api\/v1\/rooms\/[^/]+\/compute$/.test(path) &&
    route.request().method() === "GET"
  )
    return route.fulfill({
      json: {
        enabled: false,
        p2p_enabled: false,
        jobs: [],
        source_probe_ready: false,
        source_audio_tracks: [],
      },
    });
  return undefined;
}
