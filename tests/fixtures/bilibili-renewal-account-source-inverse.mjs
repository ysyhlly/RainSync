// Pure finite inverse of the complete renewal status/opt-out extraction.
// Callers supply source text. No filesystem, subprocess, database or network use.
import { rustFunction, replaceOnce } from "./bilibili-login-source-inverse.mjs";

export { rustFunction, replaceOnce };
const body = (text) => text.slice(text.indexOf("{\n") + 2, -2);
const signatures = {
  status: "pub async fn status(State(app): State<App>, headers: HeaderMap) -> Result<Response>",
  set_preference: `pub async fn set_preference(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Preference>,
) -> Result<Response>`,
};
function restoreOperation(core, name) {
  let restored = body(rustFunction(core, name));
  restored = replaceOnce(restored, "    let db = context.db;\n", "");
  const write = name === "status" ? "false" : "true";
  restored = replaceOnce(restored, `request::authenticate(context, &headers, ${write}, false)`, `auth(&app, &headers, ${write})`);
  restored = replaceOnce(restored, "maintenance::begin_db(db)", "maintenance::begin(&app)");
  restored = restored.replaceAll("maintenance::", "super::maintenance::");
  restored = replaceOnce(restored, "Ok(value)", "Ok(responses::private_json(StatusCode::OK, value))");
  return `${signatures[name]} {\n${restored}\n}`;
}

export function restoreBilibiliRenewalAccountParent(parent, core) {
  let restored = replaceOnce(parent, "mod account_operations;\n", "");
  restored = replaceOnce(restored, "pub async fn status(", `${rustFunction(core, "public_status")}\npub async fn status(`);
  for (const name of Object.keys(signatures)) {
    restored = replaceOnce(restored, rustFunction(restored, name), restoreOperation(core, name));
  }
  return restored;
}
