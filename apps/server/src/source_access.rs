//! Source policy changes fence grants without claiming physical resource drain.
use super::*;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    expected_revision: i64,
    policy: Value,
}
pub async fn guard(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: Uuid,
    revision: i64,
) -> Result<()> {
    let current: i64 =
        sqlx::query_scalar("SELECT access_policy_revision FROM sources WHERE id=$1 FOR SHARE")
            .bind(source)
            .fetch_one(&mut **tx)
            .await?;
    if current != revision {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(())
}
pub async fn change(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &headers, true).await?)?;
    let mut tx = app.db.begin().await?;
    let row = sqlx::query(
        "SELECT kind,config_encrypted,access_policy_revision FROM sources WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    let kind: String = row.get("kind");
    if !matches!(kind.as_str(), "http" | "jellyfin" | "emby") {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    let previous: i64 = row.get("access_policy_revision");
    if previous != body.expected_revision {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let next = previous
        .checked_add(1)
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_changed"))?;
    let mut config: providers::SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    config.access_policy = serde_json::from_value(body.policy)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    providers::access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    providers::validate_source_headers(&config.headers)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    let encrypted = app.encrypt(&serde_json::to_value(config).map_err(anyhow::Error::from)?)?;
    sqlx::query("UPDATE sources SET config_encrypted=$2,access_policy_revision=$3 WHERE id=$1")
        .bind(id)
        .bind(encrypted)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    // Migration 0024 invalidates previews once when config_encrypted changes.
    tx.commit().await?;
    // Release the source lock before taking session/cleanup locks. Readers and
    // final publication are already fenced by the committed source revision.
    // Reconciliation repeats this retirement if the HTTP waiter is interrupted.
    retire(&app.db).await?;
    Ok(Json(json!({"id":id,"access_policy_revision":next})))
}
pub async fn retire(db: &PgPool) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE playback_sessions p SET stopped=true FROM media_items m JOIN sources s ON s.id=m.source_id WHERE p.media_id=m.id AND NOT p.stopped AND COALESCE((p.resource->>'source_policy_revision')::bigint,0)<>s.access_policy_revision").execute(&mut *tx).await?;
    sqlx::query("UPDATE media_jobs j SET status='cancelled' FROM playback_sessions p WHERE j.session_id=p.id AND p.stopped AND j.status IN('queued','running')").execute(&mut *tx).await?;
    sqlx::query("UPDATE upstream_reservations u SET state='closing',close_reason=COALESCE(close_reason,'source_changed'),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() FROM sources s WHERE u.source_id=s.id AND u.source_policy_revision<>s.access_policy_revision AND u.state IN('preparing','active')").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
