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
export function mediaExtraResponse(route: import("@playwright/test").Route) {
  const url = new URL(route.request().url()),
    path = url.pathname;
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
  if (/^\/api\/v1\/media\/[^/]+$/.test(path))
    return route.fulfill({
      json: mediaRecord({
        id: decodeURIComponent(path.split("/").at(-1)!),
        title: "movie",
      }),
    });
  return undefined;
}
