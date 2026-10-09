//! HTTP adaptation for private libraries. Caller and room authority remain
//! transaction-local inside named catalog operations, never cached by adapters.
use super::*;
pub use catalog::libraries::{Create, Expected, Grant, IssuedSharesQuery, Rename, Transfer};
pub use catalog::library_authority::enabled;
use catalog::library_authority::require_enabled;
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
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::libraries::list(&app.db, u).await?,
    ))
}

pub async fn issued_shares(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<IssuedSharesQuery>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::libraries::issued_shares(&app.db, u, query).await?,
    ))
}

pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Create>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::create(&app.db, u, h, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn detail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::libraries::detail(&app.db, u, id).await?,
    ))
}

pub async fn rename(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Rename>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::rename(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn grant(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Grant>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::grant(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, target)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::revoke(&app.db, u, h, id, target, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn remove(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceWriteContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
    };
    let committed = catalog::libraries::remove(context, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn transfer(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Transfer>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::transfer(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn share(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Share>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    Ok(responses::ok_json(
        catalog::room_shares::share(&app.db, u, h, id, body).await?,
    ))
}

pub async fn update_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateShare>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::room_shares::update_share(&app.db, u, h, id, grant, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn revoke_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let committed = catalog::room_shares::revoke_share(&app.db, u, h, id, grant, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn add_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Source>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceWriteContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
    };
    Ok(responses::ok_json(
        catalog::private_sources::add_source(context, u, h, id, body).await?,
    ))
}

pub async fn source_detail(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    let context = catalog::SourceReadContext {
        db: &app.db,
        decrypt: &|value| app.decrypt(value),
    };
    Ok(responses::ok_json(
        catalog::private_sources::source_detail(context, u, h, library, source).await?,
    ))
}

pub async fn update_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceChange>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceChangeContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
        decrypt: &|value| app.decrypt(value),
    };
    let committed =
        catalog::private_sources::update_source(context, u, h, library, source, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn remove_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceExpected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceWriteContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
    };
    let committed =
        catalog::private_sources::remove_source(context, u, h, library, source, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn attach_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Attach>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    admin(&u)?;
    let committed = catalog::private_sources::attach_source(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub use catalog::media_reads::MediaQuery;
pub async fn media(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<MediaQuery>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::media_reads::list_private(&app.db, u.id, id, q).await?,
    ))
}

pub use catalog::scan_pages::ScanRequest;
pub async fn scan_status(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::scan_pages::scan_status(&app.db, user.id, lib, source).await?,
    ))
}
pub async fn scan(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<ScanRequest>,
) -> Result<Response> {
    require_enabled()?;
    let user = auth(&app, &h, true).await?;
    let context = catalog::SourceReadContext {
        db: &app.db,
        decrypt: &|value| app.decrypt(value),
    };
    Ok(responses::ok_json(
        catalog::scan_pages::scan(&context, user, h, lib, source, body).await?,
    ))
}
