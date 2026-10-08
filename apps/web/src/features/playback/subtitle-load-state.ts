import type { MediaTrack } from "../../../../../packages/protocol";
import { availableSubtitleTracks } from "./playback-selections";

export type SubtitleResource = Readonly<{
  index: number;
  label: string;
  language: string;
  url: string;
  /** Local DOM resource identity, including same-URL retry attempts. */
  key: number;
}>;

/** Tracks only subtitle resources. It never changes a playback session or clock. */
export class SubtitleLoadState {
  private sessionId: string | undefined;
  private serial = 0;
  private failures = new Set<SubtitleResource>();
  resources: readonly SubtitleResource[] = [];

  sync(sessionId: string | null | undefined, tracks: readonly MediaTrack[]) {
    const currentSession = sessionId ?? undefined;
    const previous = this.sessionId === currentSession ? this.resources : [];
    this.sessionId = currentSession;
    this.resources = currentSession
      ? availableSubtitleTracks(tracks).map((track) => {
          const existing = previous.find(
            (resource) =>
              resource.index === track.index &&
              resource.url === track.url &&
              resource.label === track.label &&
              resource.language === track.language,
          );
          return existing ?? this.bind(track);
        })
      : [];
    this.failures = new Set(
      [...this.failures].filter((resource) =>
        this.resources.includes(resource),
      ),
    );
    return this.resources;
  }

  private bind(track: MediaTrack): SubtitleResource {
    return Object.freeze({
      index: track.index,
      label: track.label,
      language: track.language,
      url: track.url!,
      key: ++this.serial,
    });
  }

  /** HTMLTrackElement states: 2 = LOADED, 3 = ERROR. Loading is not failure. */
  settle(resource: SubtitleResource, readyState: number) {
    if (!this.resources.includes(resource)) return false;
    if (readyState === 3) this.failures.add(resource);
    else if (readyState === 2) this.failures.delete(resource);
    else return false;
    return true;
  }

  failure(index: number | undefined) {
    if (index === undefined) return;
    return this.resources.find(
      (resource) => resource.index === index && this.failures.has(resource),
    );
  }

  /** One new resource per explicit retry; retain the exact authorized URL. */
  retry(resource: SubtitleResource) {
    if (!this.resources.includes(resource) || !this.failures.has(resource))
      return false;
    const replacement = Object.freeze({ ...resource, key: ++this.serial });
    this.resources = this.resources.map((current) =>
      current === resource ? replacement : current,
    );
    this.failures.delete(resource);
    return true;
  }
}
