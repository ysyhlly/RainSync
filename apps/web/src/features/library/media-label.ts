import type { Media } from "../../shared/api/types";

/** Only explicit source/title evidence. A list position is never an episode. */
export function mediaEpisodeLabel(
  media: Pick<Media, "title" | "platform" | "series">,
): string {
  const episode = media.series?.episode_number,
    season = media.series?.season_number;
  if (Number.isInteger(episode) && episode! >= 0 && episode! <= 10_000) {
    const prefix =
      Number.isInteger(season) && season! >= 0 && season! <= 10_000
        ? `第 ${season} 季 · `
        : "";
    return `${prefix}第 ${episode} 集`;
  }
  if (
    media.platform?.version === 1 &&
    media.platform.provider === "bilibili" &&
    media.platform.part > 1
  )
    return `分 P · P${media.platform.part}`;
  const numbered = /(?:^|[\s._-])S(\d{1,2})E(\d{1,3})(?=$|[\s._-])/i.exec(
    media.title,
  );
  if (numbered && Number(numbered[2]) > 0)
    return `第 ${Number(numbered[1])} 季 · 第 ${Number(numbered[2])} 集`;
  const explicit = /第\s*([1-9]\d{0,3})\s*集/.exec(media.title);
  return explicit ? `第 ${Number(explicit[1])} 集` : "";
}
