// Evidence only: never changes or authorizes a request or retains raw identities.
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const numeric = new Set(["audiosamplerate", "aac-audiosamplerate", "audiobitrate", "audiostreamindex", "maxframerate", "h264-maxframerate", "framerate"]);
const boolean = new Set(["allowaudiostreamcopy", "allowvideostreamcopy", "enableautostreamcopy", "static"]);
const codecs = new Set(["audiocodec", "videocodec"]);
export function chainEvidence(value, base, expected = {}) {
  let url;
  try { url = new URL(value, base); } catch { return { valid_url: false }; }
  const fields = {};
  for (const [rawKey, value] of url.searchParams) {
    const key = rawKey.toLowerCase();
    if (!numeric.has(key) && !boolean.has(key) && !codecs.has(key)) continue;
    const safe = numeric.has(key) ? /^\d{1,9}(?:\.\d{1,6})?$/.test(value)
      : boolean.has(key) ? /^(true|false)$/i.test(value) : /^(aac|h264|hevc|copy|mp3|ac3|eac3)$/i.test(value);
    (fields[key] ??= []).push(safe ? value : "[unrecognized-value]");
  }
  const query = [...url.searchParams];
  const matches = (key, value) => value != null && query.filter(([k]) => k.toLowerCase() === key).length === 1 &&
    query.find(([k]) => k.toLowerCase() === key)?.[1] === value;
  const baseUrl = new URL(base);
  return { valid_url: true, url_sha256: hash(url.href), path_and_query_sha256: hash(url.pathname + url.search),
    route_category: /\/master\.m3u8$/i.test(url.pathname) ? "master" : /\.m3u8$/i.test(url.pathname) ? "variant" :
      /\.(ts|m4s|mp4|aac)$/i.test(url.pathname) ? "media" : "other",
    same_owned_origin: url.origin === baseUrl.origin, credentials_present: Boolean(url.username || url.password),
    fragment_present: Boolean(url.hash), fields,
    sid_matches: matches("playsessionid", expected.sid), source_matches: matches("mediasourceid", expected.source),
    device_matches: matches("deviceid", expected.device),
    sid_hash: expected.sid ? hash(expected.sid) : null };
}
export function manifestReferences(text) {
  if (Buffer.byteLength(text) > 256 * 1024) throw Error("chain manifest byte budget exceeded");
  const references = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("#")) references.push(line);
    else for (const match of line.matchAll(/\bURI="([^"\r\n]*)"/g)) references.push(match[1]);
    if (references.length > 256) throw Error("chain manifest reference budget exceeded");
  }
  return references;
}
