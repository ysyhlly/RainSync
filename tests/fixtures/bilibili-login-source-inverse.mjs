// Pure, intentionally finite inverse of the reviewed Bilibili QR boundary edits.
// Callers supply source text; this module does not read files or execute tools.
import assert from "node:assert/strict";

export function rustFunction(text, name) {
  const start = new RegExp(`^(?:pub(?:\\([^)]*\\))? )?(?:async )?fn ${name}\\(`, "m").exec(text);
  assert.ok(start, `missing function ${name}`);
  const end = text.indexOf("\n}", start.index);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return text.slice(start.index, end + 2);
}
export function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length - 1, 1, `unique replacement: ${from}`);
  return text.replace(from, to);
}
const body = (text) => text.slice(text.indexOf("{\n") + 2, -2);
const signatures = {
  start_login: `pub async fn start_login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<StartLogin>,
) -> Result<Response>`,
  poll_login: `pub async fn poll_login(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response>`,
  cancel_login: `pub async fn cancel_login(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response>`,
};
function restoreOperation(core, name) {
  let restored = body(rustFunction(core, name));
  restored = replaceOnce(restored, "    let db = context.db;\n", "");
  restored = replaceOnce(restored, "request::authenticate(context, &headers, true, false)", "auth(&app, &headers, true)");
  restored = restored.replaceAll("db.begin()", "app.db.begin()");
  restored = restored.replaceAll("qr_response(&request, None, None)", "qr_response(&app, &request, false, None)?");
  restored = restored.replaceAll("qr_response(&current, None, stage)", "qr_response(&app, &current, false, stage)?");
  restored = restored.replaceAll("qr_response(&request, qr_payload(decrypt, &request)?, None)", "qr_response(&app, &request, true, None)?");
  restored = restored.replaceAll('qr_response(&current, qr_payload(decrypt, &current)?, Some("waiting"))', 'qr_response(&app, &current, true, Some("waiting"))?');
  if (name !== "cancel_login") restored = replaceOnce(restored, "Client::new(*http, None)", "Client::new(app.platform_http, None)");
  if (name === "start_login") {
    restored = replaceOnce(restored, "Ok(StartLoginOutcome::Replay(value))", "Ok(responses::private_json(StatusCode::OK, value))");
    restored = replaceOnce(restored, "Ok(StartLoginOutcome::Created(value))", "Ok(responses::private_json(StatusCode::CREATED, value))");
    for (const [variable, purpose, secret] of [
      ["key", "QR_KEY_PURPOSE", "challenge.key.expose_for_storage()"],
      ["payload", "QR_PAYLOAD_PURPOSE", "&challenge.login_url"],
    ]) {
      restored = replaceOnce(restored,
        `                let ${variable} = encrypt(&scope::qr_plaintext(
                    &current.scope,
                    ${purpose},
                    ${secret},
                ))
                .map_err(|_| credential_error())?;`,
        `                let ${variable} = app
                    .encrypt(&scope::qr_plaintext(
                        &current.scope,
                        ${purpose},
                        ${secret},
                    ))
                    .map_err(|_| credential_error())?;`);
    }
  } else {
    restored = restored.replaceAll("Ok(value)", "Ok(responses::private_json(StatusCode::OK, value))");
  }
  if (name === "poll_login") {
    restored = replaceOnce(restored, "    let key_secret = decrypt(cipher)", "    let key_secret = app\n        .decrypt(cipher)");
    restored = replaceOnce(restored,
      `                    let cipher = encrypt(&scope::credential_plaintext(
                        updated_scope,
                        cookie_value(&cookie),
                    ))
                    .map_err(|_| credential_error())?;`,
      `                    let cipher = app
                        .encrypt(&scope::credential_plaintext(
                            updated_scope,
                            cookie_value(&cookie),
                        ))
                        .map_err(|_| credential_error())?;`);
    restored = replaceOnce(restored, "renewal::store_grant(\n                        encrypt,", "renewal::store_grant(\n                        &app,");
  }
  if (name === "cancel_login") {
    restored = replaceOnce(restored,
      `    account_security::rate_limit(db, "platform-login-cancel", &user.id.to_string(), 30, 600)
        .await?;`,
      `    account_security::rate_limit(
        &app.db,
        "platform-login-cancel",
        &user.id.to_string(),
        30,
        600,
    )
    .await?;`);
  }
  return `${signatures[name]} {\n${restored}\n}`;
}

export function restoreBilibiliLoginParent(parent, core) {
  let restored = replaceOnce(parent, "mod qr_login;\n", "");
  restored = replaceOnce(restored,
    "use providers::platform::bilibili::{Client, Cookie as BiliCookie};",
    "use providers::platform::bilibili::{Client, Cookie as BiliCookie, QrKey, QrState};");
  let payload = body(rustFunction(core, "qr_payload"));
  payload = replaceOnce(payload, '    if request.status == "pending" && request.live {', '    let payload = if include_payload && request.status == "pending" && request.live {');
  payload = replaceOnce(payload, "                decrypt(cipher)", "                app.decrypt(cipher)");
  payload = replaceOnce(payload, "            .transpose()", "            .transpose()?");
  payload = replaceOnce(payload, "        Ok(None)\n    }", "        None\n    };");
  let projectionBody = body(rustFunction(core, "qr_response"));
  projectionBody = replaceOnce(projectionBody, "    json!", "        json!");
  projectionBody = replaceOnce(projectionBody, '"server_time": request.server_time_ms})', '"server_time": request.server_time_ms}),');
  const projection = `fn qr_response(
    app: &App,
    request: &LoginRequest,
    include_payload: bool,
    stage: Option<&str>,
) -> Result<Value> {\n${payload}\n    Ok(\n${projectionBody}\n    )\n}`;
  restored = replaceOnce(restored, "async fn terminalize(", `${projection}\n\nasync fn terminalize(`);
  for (const name of Object.keys(signatures)) {
    restored = replaceOnce(restored, rustFunction(restored, name), restoreOperation(core, name));
  }
  return restored;
}

export function restoreBilibiliRenewal(parent) {
  const original = rustFunction(parent, "store_grant");
  let restored = replaceOnce(original, "    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),", "    app: &App,");
  restored = replaceOnce(restored,
    "    let cipher = encrypt(&envelope(scope, login, &token)).map_err(|_| credential_error())?;",
    "    let cipher = app\n        .encrypt(&envelope(scope, login, &token))\n        .map_err(|_| credential_error())?;");
  return replaceOnce(parent, original, restored);
}
