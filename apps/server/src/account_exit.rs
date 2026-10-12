//! HTTP adaptation for explicit self-service retirement.
use crate::*;
pub use identity::account_exit::Delete;

pub async fn preview(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    Ok(responses::ok_json(
        identity::account_exit::preview(app.identity_context(), &h).await?,
    ))
}

pub async fn delete(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Delete>,
) -> Result<Response> {
    identity::account_exit::delete(app.identity_context(), &app.account_security, &h, body).await?;
    Ok((
        [
            (
                header::SET_COOKIE,
                "rainsync_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Json(json!({"ok":true})),
    )
        .into_response())
}
