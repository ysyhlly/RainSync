// Pure observation helpers. These do not rewrite URLs or supply missing bounds.
export function sameProfileItemMasterPath(kind, basePath, item, actualPath) {
  const expected = (id) => `${basePath}videos/${id}/master.m3u8`.toLowerCase();
  if (actualPath.toLowerCase() === expected(item)) return true;
  if (kind !== "jellyfin" || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(item)) return false;
  const compact = item.replaceAll("-", "");
  const alternate = item.length === 36 ? compact :
    `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  return actualPath.toLowerCase() === expected(alternate);
}

export function profileSubtitleSelectionSupported(kind, fields) {
  const indices = fields.subtitlestreamindex;
  if (indices != null && (indices.length !== 1 || indices[0] !== "-1")) return false;
  const methods = fields.subtitlemethod;
  if (methods == null) return true;
  if (methods.length !== 1) return false;
  // Pinned Jellyfin's omitted index does not select a subtitle. Encode is its
  // inert default in that case. Do not extrapolate the behavior to Emby.
  return kind === "jellyfin" || methods[0].toLowerCase() !== "encode";
}
