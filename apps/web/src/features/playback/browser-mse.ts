/** Browser capability probing is independent of downloading a playback SDK. */
export function getPlaybackMediaSource(): typeof MediaSource | undefined {
  if (typeof self === "undefined") return undefined;
  const host = self as typeof self & {
    ManagedMediaSource?: typeof MediaSource;
    WebKitMediaSource?: typeof MediaSource;
  };
  return host.ManagedMediaSource || host.MediaSource || host.WebKitMediaSource;
}
export function hasPlaybackMseApi(): boolean {
  if (!getPlaybackMediaSource()) return false;
  const host = self as typeof self & {
    WebKitSourceBuffer?: typeof SourceBuffer;
  };
  const buffer = host.SourceBuffer || host.WebKitSourceBuffer;
  return (
    !buffer ||
    (!!buffer.prototype &&
      typeof buffer.prototype.appendBuffer === "function" &&
      typeof buffer.prototype.remove === "function")
  );
}
export function supportsHlsPlayback(): boolean {
  if (!hasPlaybackMseApi()) return false;
  const source = getPlaybackMediaSource();
  if (typeof source?.isTypeSupported !== "function") return false;
  return (
    ["avc1.42E01E,mp4a.40.2", "av01.0.01M.08", "vp09.00.50.08"].some((codec) =>
      source.isTypeSupported(`video/mp4;codecs=${codec}`),
    ) ||
    ["mp4a.40.2", "fLaC"].some((codec) =>
      source.isTypeSupported(`audio/mp4;codecs=${codec}`),
    )
  );
}
