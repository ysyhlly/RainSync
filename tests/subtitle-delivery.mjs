import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export async function subtitleDelivery({ plan, worker, sql, key, setBody }) {
  const url = worker + plan.subtitle_tracks[0].url;
  let response = await fetch(url);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("00:00:01.000 --> 00:00:05.000"));
  // Inject a known playback timeline into this disposable authorized grant.
  // This tests Worker delivery independently of upstream plan-origin detection.
  const cipher = Buffer.from(
    sql(
      `SELECT resource->>'encrypted' FROM playback_sessions WHERE id='${plan.session_id}'`,
    ),
    "base64",
  );
  const secret = Buffer.from(key, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secret,
    cipher.subarray(0, 12),
  );
  decipher.setAuthTag(cipher.subarray(-16));
  const resource = JSON.parse(
    Buffer.concat([
      decipher.update(cipher.subarray(12, -16)),
      decipher.final(),
    ]),
  );
  resource.timeline_origin_ms = 3000;
  const nonce = randomBytes(12);
  const encrypt = createCipheriv("aes-256-gcm", secret, nonce);
  const encrypted = Buffer.concat([
    nonce,
    encrypt.update(JSON.stringify(resource)),
    encrypt.final(),
    encrypt.getAuthTag(),
  ]).toString("base64");
  sql(
    `UPDATE playback_sessions SET resource=jsonb_build_object('encrypted','${encrypted}') WHERE id='${plan.session_id}'`,
  );
  response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/vtt/);
  const text = await response.text();
  assert.ok(text.includes("00:00:00.000 --> 00:00:02.000"));
  assert.ok(text.includes("中文跨越起点"));
  assert.ok(!text.includes("已结束"));
  response = await fetch(url, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  setBody("WEBVTT\n\n00:99.000 --> 00:01.000\nbroken\n");
  assert.ok((await fetch(url)).status >= 400);
  setBody("WEBVTT\n\n" + "x".repeat(2 * 1024 * 1024));
  assert.ok((await fetch(url)).status >= 400);
  setBody();
  console.log(
    "PASS: authorized remote WebVTT BOM, clipping, HEAD, malformed and oversized responses",
  );
}
