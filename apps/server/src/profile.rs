//! HTTP extraction and private response construction stay at the route boundary.
use crate::*;

pub async fn get_profile(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    Ok(responses::private_json(
        StatusCode::OK,
        identity::profiles::get_profile(app.identity_context(), &h).await?,
    ))
}

pub async fn update(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<identity::profiles::Update>,
) -> Result<Response> {
    Ok(responses::private_json(
        StatusCode::OK,
        identity::profiles::update(app.identity_context(), &h, body).await?,
    ))
}
