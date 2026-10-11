// Pure, finite inverse of the complete Bilibili account operation extraction.
// Input is source text only: no filesystem, subprocess, database or network use.
import { rustFunction, replaceOnce } from "./bilibili-login-source-inverse.mjs";

export { rustFunction, replaceOnce };
const body = (text) => text.slice(text.indexOf("{\n") + 2, -2);
const signatures = {
  status: "pub async fn status(State(app): State<App>, headers: HeaderMap) -> Result<Response>",
  check_login: `pub async fn check_login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<CheckLogin>,
) -> Result<Response>`,
  unlink: "pub async fn unlink(State(app): State<App>, headers: HeaderMap) -> Result<Response>",
};
function restoreOperation(core, name) {
  let restored = body(rustFunction(core, name));
  restored = replaceOnce(restored, "    let db = context.db;\n", "");
  const write = name === "status" ? "false" : "true";
  restored = replaceOnce(restored, `request::authenticate(context, &headers, ${write}, false)`, `auth(&app, &headers, ${write})`);
  restored = restored.replaceAll("db.begin()", "app.db.begin()");
  restored = restored.replaceAll("Ok(value)", "Ok(responses::private_json(StatusCode::OK, value))");
  if (name === "check_login") {
    restored = replaceOnce(restored,
      '    account_security::rate_limit(db, "platform-login-check", &user.id.to_string(), 20, 600).await?;',
      `    account_security::rate_limit(
        &app.db,
        "platform-login-check",
        &user.id.to_string(),
        20,
        600,
    )
    .await?;`);
    restored = replaceOnce(restored,
      "    let plaintext = decrypt(ciphertext.as_deref().ok_or_else(credential_error)?)",
      "    let plaintext = app\n        .decrypt(ciphertext.as_deref().ok_or_else(credential_error)?)");
    restored = replaceOnce(restored, "Client::new(http, Some(cookie))", "Client::new(app.platform_http, Some(cookie))");
  }
  return `${signatures[name]} {\n${restored}\n}`;
}

export function restoreBilibiliAccountParent(parent, core) {
  let restored = replaceOnce(parent, "mod account_operations;\n", "");
  restored = replaceOnce(restored,
    "    use super::account_operations::{check_revision_matches, check_snapshot_matches, check_value};\n", "");
  const helpers = ["check_value", "check_revision_matches", "check_snapshot_matches"]
    .map((name) => replaceOnce(rustFunction(core, name), "pub(super) fn ", "fn "))
    .join("\n\n");
  restored = replaceOnce(restored, "/// Check only this viewer's current credential.",
    `${helpers}\n\n/// Check only this viewer's current credential.`);
  for (const name of Object.keys(signatures)) {
    restored = replaceOnce(restored, rustFunction(restored, name), restoreOperation(core, name));
  }
  return restored;
}
