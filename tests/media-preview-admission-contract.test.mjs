// Source seam guards and in-memory mutation controls only. These do not prove
// PostgreSQL lock/expiry behavior, queue execution, or actual HTTP responses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const http = source("apps/server/src/media_previews.rs");
const core = source("apps/server/src/catalog/previews.rs").split("#[cfg(test)]")[0];
const persistence = source("crates/persistence/src/media_previews.rs");
const section = (text, start, end) => {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const until = end === undefined ? text.length : text.indexOf(end, from + start.length);
  assert.notEqual(until, -1, `missing ${end}`);
  return text.slice(from, until);
};
const inOrder = (text, parts) => {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered ${part}`);
    previous = found;
  }
};
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);

function narrowBoundary(text) {
  assert.doesNotMatch(text, /\b(?:App|State|Response|Json|Settings)\b|responses::|auth_viewer\(|authorize_media\(/);
  count(text, /context: RequestContext<'_>/g, 3);
  count(text, /h: &HeaderMap/g, 3);
  const limit = section(text, "pub(crate) struct QueueLimit", "#[derive(Serialize)]");
  assert.match(limit, /struct QueueLimit<'a> \{\s*value: &'a i64,\s*\}/);
  assert.match(limit, /fn new\(value: &'a i64\) -> Self \{\s*Self \{ value \}\s*\}/);
  assert.match(limit, /fn get\(&self\) -> i64 \{\s*\*self.value\s*\}/);
  assert.doesNotMatch(limit, /\bdyn\b|\bFn\b|\bArc\b|\bClone\b|\bpub value\b/);
}

function admissionAndQueue(text) {
  const request = section(text, "pub async fn request(", "pub async fn status(");
  const status = section(text, "pub async fn status(", "async fn states(");
  const image = section(text, "pub async fn image(");
  count(text, /identity_request::authenticate\(/g, 3);
  inOrder(request, [
    "let db = context.db;",
    "identity_request::authenticate(context, h, true, false)",
    "bounded(body.media_ids)?",
    "SELECT id FROM media_items WHERE id=ANY($1) AND library_media_allowed($2,id,'browse',NULL)",
    ".bind(&ids).bind(viewer).fetch_all(db).await?",
    "persistence::media_previews::enqueue(db, &ids, queue_limit.get()).await?",
    "StatusCode::SERVICE_UNAVAILABLE",
    '"media_preview_queue_full"',
    "states(db, viewer, &ids).await",
  ]);
  count(request, /queue_limit\.get\(/g, 1);
  count(text, /persistence::media_previews::enqueue\(/g, 1);
  assert.doesNotMatch(request, /\.begin\(|\.commit\(|INSERT INTO|UPDATE media_previews/);
  inOrder(status, [
    "identity_request::authenticate(context, h, false, false)",
    "if q.ids.is_empty()",
    ".split(',')",
    ".map(Uuid::parse_str)",
    'err(StatusCode::BAD_REQUEST, "invalid_request")',
    "states(db, viewer, &bounded(ids)?).await",
  ]);
  assert.doesNotMatch(status, /sqlx::|\.begin\(|\.commit\(|enqueue\(/);
  inOrder(image, [
    "identity_request::authenticate(context, h, false, true)",
    "let mut tx = db.begin().await?;",
  ]);
}

function imageOwner(text) {
  const image = section(text, "pub async fn image(");
  count(text, /\.begin\(/g, 1);
  count(text, /\.commit\(/g, 1);
  count(image, /sqlx::query(?:_scalar)?\(/g, 6);
  inOrder(image, [
    "db.begin().await?",
    "SELECT source_id FROM media_items WHERE id=$1 AND available AND library_media_allowed($2,id,CASE WHEN $3::uuid IS NULL THEN 'browse' ELSE 'play' END,$3)",
    ".bind(id).bind(viewer).bind(q.room_id)",
    'err(StatusCode::NOT_FOUND, "media_not_found")',
    "SELECT l.id FROM private_libraries l JOIN sources s ON s.library_id=l.id WHERE s.id=$1 FOR SHARE OF l",
    "SELECT id FROM media_items WHERE id=$1 AND available FOR SHARE",
    "SELECT id FROM agents WHERE id=$1 FOR SHARE",
    "library_media_allowed($3,m.id,CASE WHEN $4::uuid IS NULL THEN 'browse' ELSE 'play' END,$4)",
    "p.result_revision=$2 AND p.status='ready' AND {VALID} AND {FRESH}",
    ".bind(id).bind(q.revision).bind(viewer).bind(q.room_id)",
    'err(StatusCode::CONFLICT,"media_preview_stale")',
    "UPDATE media_previews SET accessed_at=clock_timestamp() WHERE media_id=$1 AND accessed_at<clock_timestamp()-interval '1 minute'",
    "tx.commit().await?",
    "Ok(ImageRead { row })",
  ]);
}

function httpAdapter(text) {
  assert.doesNotMatch(text, /\bauth(?:_viewer)?\(|authenticate\(|sqlx::|\.begin\(|\.commit\(|\buser\.id\b|&\|\|/);
  count(text, /app\.identity_context\(\)/g, 3);
  assert.match(text, /Json\(body\): Json<Request>/);
  assert.match(text, /axum::extract::Query\(q\): axum::extract::Query<Query>/);
  assert.match(text, /axum::extract::Query\(q\): axum::extract::Query<ImageQuery>/);
  assert.ok(text.includes("catalog::previews::QueueLimit::new(&app.preview_settings.queue_limit)"));
  const request = section(text, "pub async fn request(", "pub async fn status(");
  inOrder(request, ["catalog::previews::request(", "app.identity_context()", "&h,", "body,", "QueueLimit::new("]);
  assert.ok(text.includes("catalog::previews::status(app.identity_context(), &h, q).await?"));
  const image = section(text, "pub async fn image(");
  inOrder(image, [
    "catalog::previews::image(app.identity_context(), &h, id, q).await?",
    'format!("\\\"{}\\\"", row.sha256())',
    "h.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(&etag)",
    "if unchanged",
    "StatusCode::NOT_MODIFIED.into_response()",
    '([(header::CONTENT_TYPE, "image/webp")], row.into_bytes()).into_response()',
    ".insert(header::ETAG, etag.parse().unwrap())",
    '.insert(header::CACHE_CONTROL, "private, no-cache".parse().unwrap())',
  ]);
  count(image, /StatusCode::NOT_MODIFIED/g, 1);
}

test("preview operations accept only request admission and a borrowed queue limit", () => narrowBoundary(core));
test("registered request/status and viewer image admission precede their original work", () => admissionAndQueue(core));
test("image keeps one transaction, library/media/agent lock order, freshness, and throttled LRU", () => imageOwner(core));
test("HTTP owns extraction and conditional WebP response only, after image authorization", () => httpAdapter(http));

test("the existing persistence enqueue remains the single queue transaction owner", () => {
  const enqueue = section(persistence, "pub async fn enqueue(", "#[derive(Clone, Debug)]");
  count(enqueue, /\.begin\(/g, 1);
  count(enqueue, /\.commit\(/g, 1);
  inOrder(enqueue, [
    "let mut tx = db.begin().await?",
    "SELECT pg_advisory_xact_lock($1)",
    "for id in ids",
    "FOR UPDATE OF m",
    "SELECT count(*) FROM media_previews",
    "if count >= limit",
    "return Ok(false)",
    "INSERT INTO media_previews",
    "tx.commit().await?",
    "Ok(true)",
  ]);
  assert.match(source("apps/server/src/bootstrap/routes.rs"), /"\/api\/v1\/media\/previews",\s*get\(media_previews::status\)\.post\(media_previews::request\)/);
  assert.match(source("apps/server/src/bootstrap/routes.rs"), /"\/api\/v1\/media\/\{id\}\/cover",\s*get\(media_previews::image\)/);
});

// Mutate the actual production source in memory, then prove each guard rejects
// a concrete regression. No production file is modified by these controls.
const negatives = [
  ["full application reintroduced", core, narrowBoundary, "context: RequestContext<'_>", "context: App"],
  ["queue limit snapshotted in capability", core, narrowBoundary, "value: &'a i64,", "value: i64,"],
  ["registered request admits guests", core, admissionAndQueue, "authenticate(context, h, true, false)", "authenticate(context, h, true, true)"],
  ["registered status admits guests", core, admissionAndQueue, "authenticate(context, h, false, false)", "authenticate(context, h, false, true)"],
  ["image rejects viewer admission", core, admissionAndQueue, "authenticate(context, h, false, true)", "authenticate(context, h, false, false)"],
  ["queue limit read before visibility", core, admissionAndQueue, "let ids = bounded(body.media_ids)?;", "let early = queue_limit.get(); let ids = bounded(body.media_ids)?;"],
  ["second enqueue owner introduced", core, admissionAndQueue, "states(db, viewer, &ids).await", "persistence::media_previews::enqueue(db, &ids, 1).await?; states(db, viewer, &ids).await"],
  ["queue wrapper adds a transaction", core, admissionAndQueue, "let ids = bounded(body.media_ids)?;", "let tx = db.begin().await?; let ids = bounded(body.media_ids)?;"],
  ["library lock removed", core, imageOwner, "FOR SHARE OF l", ""],
  ["image revision no longer required", core, imageOwner, "p.result_revision=$2 AND ", ""],
  ["stale image status changes", core, imageOwner, 'err(StatusCode::CONFLICT,"media_preview_stale")', 'err(StatusCode::NOT_FOUND,"media_preview_stale")'],
  ["LRU writes no longer throttled", core, imageOwner, " AND accessed_at<clock_timestamp()-interval '1 minute'", ""],
  ["HTTP resumes broad authentication", http, httpAdapter, "let row = catalog::previews::image", "auth_viewer(&app, &h, false).await?; let row = catalog::previews::image"],
  ["304 bypasses image authorization", http, httpAdapter, "let row = catalog::previews::image", "if h.contains_key(header::IF_NONE_MATCH) { return Ok(StatusCode::NOT_MODIFIED.into_response()); } let row = catalog::previews::image"],
];
for (const [name, text, check, from, to] of negatives) {
  test(`negative control rejects: ${name}`, () => {
    assert.ok(text.includes(from), "mutation must touch current production source");
    const mutated = text.replace(from, to);
    assert.notEqual(mutated, text);
    assert.throws(() => check(mutated), { code: "ERR_ASSERTION" });
  });
}
