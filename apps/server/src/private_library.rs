//! HTTP adaptation for private libraries. Caller and room authority remain
//! transaction-local inside named catalog operations, never cached by adapters.
use super::*;
pub use catalog::libraries::{Create, Expected, Grant, IssuedSharesQuery, Rename, Transfer};
pub use catalog::library_authority::enabled;
pub(crate) use catalog::library_authority::retire_maintenance;
pub use catalog::private_sources::{Attach, Source, SourceChange, SourceExpected};
pub use catalog::room_shares::{Share, UpdateShare};

// Playback callers keep this adapter until their own context migration.
pub async fn authorize_media(
    app: &App,
    user: Uuid,
    media: Uuid,
    action: &str,
    room: Option<Uuid>,
) -> Result<()> {
    catalog::library_authority::authorize_media(&app.db, user, media, action, room).await
}

pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::list(app.identity_context(), h).await?,
    ))
}

pub async fn issued_shares(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<IssuedSharesQuery>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::issued_shares(app.identity_context(), h, query).await?,
    ))
}

pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Create>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::create(app.identity_context(), h, body).await?,
    ))
}

pub async fn detail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::detail(app.identity_context(), h, id).await?,
    ))
}

pub async fn rename(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Rename>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::rename(app.identity_context(), h, id, body).await?,
    ))
}

pub async fn grant(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Grant>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::grant(app.identity_context(), h, id, body).await?,
    ))
}

pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, target)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::revoke(app.identity_context(), h, id, target, body).await?,
    ))
}

pub async fn remove(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::remove(
            app.identity_context(),
            &app.catalog_encryptor(),
            h,
            id,
            body,
        )
        .await?,
    ))
}

pub async fn transfer(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Transfer>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::libraries::transfer(app.identity_context(), h, id, body).await?,
    ))
}

pub async fn share(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Share>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::room_shares::share(app.identity_context(), h, id, body).await?,
    ))
}

pub async fn update_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateShare>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::room_shares::update_share(app.identity_context(), h, id, grant, body).await?,
    ))
}

pub async fn revoke_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::room_shares::revoke_share(app.identity_context(), h, id, grant, body).await?,
    ))
}

pub async fn add_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Source>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::private_sources::add_source(
            app.identity_context(),
            &app.catalog_encryptor(),
            h,
            id,
            body,
        )
        .await?,
    ))
}

pub async fn source_detail(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::private_sources::source_detail(
            app.identity_context(),
            &app.catalog_decryptor(),
            h,
            library,
            source,
        )
        .await?,
    ))
}

pub async fn update_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceChange>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::private_sources::update_source(
            app.identity_context(),
            &app.catalog_encryptor(),
            &app.catalog_decryptor(),
            h,
            library,
            source,
            body,
        )
        .await?,
    ))
}

pub async fn remove_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceExpected>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::private_sources::remove_source(
            app.identity_context(),
            &app.catalog_encryptor(),
            h,
            library,
            source,
            body,
        )
        .await?,
    ))
}

pub async fn attach_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Attach>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::private_sources::attach_source(app.identity_context(), h, id, body).await?,
    ))
}

pub use catalog::media_reads::MediaQuery;
pub async fn media(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<MediaQuery>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::media_reads::list_private(app.identity_context(), h, id, q).await?,
    ))
}

pub use catalog::scan_pages::ScanRequest;
pub async fn scan_status(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::scan_pages::scan_status(app.identity_context(), h, lib, source).await?,
    ))
}
pub async fn scan(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<ScanRequest>,
) -> Result<Response> {
    Ok(responses::ok_json(
        catalog::scan_pages::scan(
            app.identity_context(),
            &app.catalog_decryptor(),
            h,
            lib,
            source,
            body,
        )
        .await?,
    ))
}
