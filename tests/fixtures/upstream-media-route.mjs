import assert from "node:assert/strict";

// Pinned Emby exposes both origin-root and API-base-prefixed video controllers.
// Accept only this owned item's namespace, retaining standard URL resolution.
// Unlike the production adapter, this raw diagnostic must not rebase a leading /.
export function ownedEmbyMediaPath(reference, parent, base, item, sid, master = false) {
  assert.equal(typeof reference, "string"); assert.ok(reference.length > 0 && reference.length <= 16384);
  assert.equal(typeof item, "string"); assert.ok(item.length > 0 && item.length <= 512 && !/[\x00-\x1f]/.test(item));
  assert.equal(typeof sid, "string"); assert.ok(sid.length > 0 && sid.length <= 512 && !/[\x00-\x1f]/.test(sid));
  const configured = new URL(base), url = new URL(reference, parent);
  assert.ok(["http:", "https:"].includes(configured.protocol));
  assert.ok(!configured.username && !configured.password && !configured.hash && !configured.search);
  assert.equal(url.origin, configured.origin);
  assert.ok(!url.username && !url.password && !url.hash);
  const prefix = configured.pathname.replace(/\/$/, "");
  const namespaces = [...new Set([`/videos/${encodeURIComponent(item)}/`, `${prefix}/videos/${encodeURIComponent(item)}/`].map((path) => path.toLowerCase()))];
  const namespace = namespaces.find((path) => url.pathname.toLowerCase().startsWith(path));
  assert.ok(namespace, "same owned item in root or configured video namespace only");
  if (master) assert.equal(url.pathname.toLowerCase(), namespace + "master.m3u8");
  else {
    const previous = new URL(parent);
    assert.equal(previous.origin, configured.origin);
    assert.ok(!previous.username && !previous.password && !previous.hash);
    assert.ok(previous.pathname.toLowerCase().startsWith(namespace), "child stays in the originally selected controller namespace");
  }
  const query = new Map();
  for (const [key, value] of url.searchParams) {
    const normalized = key.toLowerCase(); assert.ok(!query.has(normalized), "no duplicate query keys");
    query.set(normalized, value);
  }
  if (master || query.has("playsessionid")) assert.equal(query.get("playsessionid"), sid);
  return { url, path: url.pathname + url.search, query };
}

export async function fetchOwnedEmbyMedia({ reference, parent, base, item, sid, master = false,
  ownedItems, source, headers, signal, timeout = 15000 }, fetcher = fetch) {
  assert.ok(ownedItems.get(item)?.has(source), "media fetch belongs to this fixture's exact synthetic item/source");
  assert.ok(Number.isInteger(timeout) && timeout > 0 && timeout <= 15000);
  signal?.throwIfAborted();
  // parent is the originally negotiated master, not a caller-selected child.
  const selected = ownedEmbyMediaPath(parent, base + "/", base, item, sid, true);
  assert.equal(selected.query.get("mediasourceid"), source);
  const route = ownedEmbyMediaPath(reference, selected.url, base, item, sid, master);
  const namespace = selected.url.pathname.slice(0, selected.url.pathname.lastIndexOf("/") + 1).toLowerCase();
  assert.ok(route.url.pathname.toLowerCase().startsWith(namespace), "authenticated fetch stays in selected namespace");
  if (master || route.query.has("mediasourceid")) assert.equal(route.query.get("mediasourceid"), source);
  return fetcher(route.url.href, { method: "GET", headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    redirect: "error" });
}
