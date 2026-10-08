import { loadDashJs } from "../../../../../packages/player-core/dash/loader";
import { getPlaybackMediaSource } from "./browser-mse";
import type { Media } from "../../shared/api/types";

/** A public SDK download only; never resolve a source or request a media grant. */
export function prewarmNativeDash(
  media: Pick<Media, "platform"> | undefined,
  mode = "auto",
): Promise<void> | undefined {
  if (
    media?.platform?.version !== 1 ||
    media.platform.provider !== "bilibili" ||
    !["auto", "native"].includes(mode)
  )
    return;
  const Mse = getPlaybackMediaSource();
  try {
    if (
      !Mse?.isTypeSupported('video/mp4; codecs="avc1.42E01E"') ||
      !Mse.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')
    )
      return;
  } catch {
    return;
  }
  // An optional warm-up failure must neither fail playback nor become unhandled.
  // loadDashJs evicts rejected promises so the actual load can retry later.
  return loadDashJs().then(
    () => {},
    () => {},
  );
}
