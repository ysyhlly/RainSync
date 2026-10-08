import type { BrowseFolder } from "./media.api";

/** Counts describe only the loaded page, separately from descendant totals. */
export function libraryPageSummary(
  folders: readonly BrowseFolder[],
  mediaCount: number,
): string {
  const sources = folders.filter((folder) => folder.type === "source").length;
  const directories = folders.length - sources;
  return (
    [
      sources ? `${sources} 个片源` : "",
      directories ? `${directories} 个目录` : "",
      mediaCount ? `${mediaCount} 部影片` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "0 部影片"
  );
}
