//! HTTP adaptation for the complete registered-account room invitation family.
pub use super::invitation_operations::Join;
pub(crate) use super::invitation_operations::redeem_error;
use super::*;

pub async fn invite(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    Ok(Json(
        super::invitation_operations::invite(app.identity_context(), &h, room, &body).await?,
    ))
}
pub async fn list_invites(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Response> {
    Ok(responses::ok_json(
        super::invitation_operations::list_invites(app.identity_context(), &h, room).await?,
    ))
}
pub async fn revoke_invite(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, identity)): Path<(Uuid, String)>,
) -> Result<Json<Value>> {
    Ok(Json(
        super::invitation_operations::revoke_invite(app.identity_context(), &h, room, identity)
            .await?,
    ))
}
pub async fn join(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(body): Json<Join>,
) -> Result<Json<Value>> {
    Ok(Json(
        super::invitation_operations::join(app.identity_context(), &h, room, body).await?,
    ))
}
