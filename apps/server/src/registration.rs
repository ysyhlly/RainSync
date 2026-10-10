//! HTTP extractors and private responses stay at the original route boundary.
use crate::*;
use axum::extract::Query;

// The anonymous issuance owner keeps its existing imports without an App shim.
pub(crate) use identity::registration_invites::{code_hash, normalize_code};

pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<identity::registration_invites::CreateBatch>,
) -> Result<Response> {
    Ok(responses::private_json(
        StatusCode::CREATED,
        identity::registration_invites::create(app.identity_context(), &h, body).await?,
    ))
}

pub async fn list(
    State(app): State<App>,
    h: HeaderMap,
    Query(query): Query<identity::registration_invites::ListQuery>,
) -> Result<Response> {
    Ok(responses::private_json(
        StatusCode::OK,
        identity::registration_invites::list(app.identity_context(), &h, query).await?,
    ))
}

pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok(responses::private_json(
        StatusCode::OK,
        identity::registration_invites::revoke(app.identity_context(), &h, id).await?,
    ))
}
