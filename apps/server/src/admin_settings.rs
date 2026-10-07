//! Administrator-only, closed runtime settings. Deployment credentials, paths,
//! network/security configuration and arbitrary environment values are never projected.
use super::*;
use serde_json::Map;
use sqlx::{Postgres, Transaction, postgres::PgRow};

const FIELDS: [&str; 6] = [
    "playback_session_limit",
    "media_queue_limit",
    "registration_validate_per_minute",
    "registration_per_ten_minutes",
    "registration_mode",
    "guests_enabled",
];
const SELECT: &str = "SELECT revision,playback_session_limit,media_queue_limit,registration_validate_per_minute,registration_per_ten_minutes,registration_mode,guests_enabled,floor(extract(epoch FROM updated_at)*1000)::bigint AS updated_at_ms FROM admin_settings WHERE singleton";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    expected_revision: String,
    changes: Map<String, Value>,
}
fn invalid() -> Error {
    err(StatusCode::BAD_REQUEST, "invalid_admin_settings")
}
fn revision(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|parsed| *parsed > 0 && parsed.to_string() == value)
        .ok_or_else(invalid)
}
fn validate(changes: &Map<String, Value>) -> Result<()> {
    if changes.is_empty()
        || changes.iter().any(|(name, value)| {
            !FIELDS.contains(&name.as_str())
                || (!value.is_null()
                    && match name.as_str() {
                        "registration_mode" => {
                            !matches!(value.as_str(), Some("closed" | "invite_only" | "open"))
                        }
                        "guests_enabled" => !value.is_boolean(),
                        _ => !value.as_i64().is_some_and(|n| (1..=10000).contains(&n)),
                    })
        })
    {
        return Err(invalid());
    }
    Ok(())
}
fn defaults(app: &App) -> [Value; 6] {
    [
        json!(app.session_limit),
        json!(app.queue_limit),
        json!(app.account_security.validate_limit),
        json!(app.account_security.register_limit),
        json!(persistence::admin_settings::DEFAULT_REGISTRATION_MODE),
        json!(persistence::admin_settings::DEFAULT_GUESTS_ENABLED),
    ]
}
fn overrides(row: &PgRow) -> Result<[Value; 6]> {
    let values = [
        json!(row.try_get::<Option<i64>, _>(FIELDS[0])?),
        json!(row.try_get::<Option<i64>, _>(FIELDS[1])?),
        json!(row.try_get::<Option<i64>, _>(FIELDS[2])?),
        json!(row.try_get::<Option<i64>, _>(FIELDS[3])?),
        json!(row.try_get::<Option<String>, _>(FIELDS[4])?),
        json!(row.try_get::<Option<bool>, _>(FIELDS[5])?),
    ];
    validate(
        &FIELDS
            .iter()
            .zip(&values)
            .map(|(name, value)| ((*name).into(), value.clone()))
            .collect(),
    )
    .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "invalid_admin_settings"))?;
    Ok(values)
}
fn projection(app: &App, row: &PgRow) -> Result<Value> {
    let baseline = defaults(app);
    let configured = overrides(row)?;
    let mut values = Map::new();
    let mut defaults = Map::new();
    let mut overrides = Map::new();
    let mut origins = Map::new();
    for (index, name) in FIELDS.iter().enumerate() {
        values.insert(
            (*name).into(),
            if configured[index].is_null() {
                baseline[index].clone()
            } else {
                configured[index].clone()
            },
        );
        defaults.insert((*name).into(), json!(baseline[index]));
        overrides.insert((*name).into(), json!(configured[index]));
        origins.insert(
            (*name).into(),
            json!(if !configured[index].is_null() {
                "override"
            } else {
                "deployment"
            }),
        );
    }
    // These are configured feature states, not assertions of node health/readiness.
    Ok(json!({
        "revision": row.try_get::<i64,_>("revision")?.to_string(),
        "values": values,
        "defaults": defaults,
        "overrides": overrides,
        "origins": origins,
        "bounds": {"min": 1, "max": 10000},
        "updated_at": row.try_get::<Option<i64>,_>("updated_at_ms")?,
        "deployment": {
            "private_libraries_enabled": private_library::enabled(),
            "nas_compute_enabled": distributed_compute::enabled().is_ok(),
            "p2p_enabled": std::env::var("RAINSYNC_P2P_ENABLED").as_deref() == Ok("1"),
            "other_live_enabled": app.other_live_enabled,
            "preview": {
                "concurrency": app.preview_settings.concurrency,
                "timeout_seconds": app.preview_settings.timeout_seconds,
                "cache_bytes": app.preview_settings.cache_bytes,
                "queue_limit": app.preview_settings.queue_limit,
                "input_bytes": app.preview_settings.input_bytes,
            }
        }
    }))
}

// Same user-before-session lock order as existing administrator settings writes.
// Hold both through commit; recheck real-clock expiry after settings-row waits.
async fn lock_admin(
    tx: &mut Transaction<'_, Postgres>,
    user: &User,
    headers: &HeaderMap,
    write: bool,
) -> Result<String> {
    let role: Option<bool> =
        sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 AND account_active(id) FOR SHARE")
            .bind(user.id)
            .fetch_optional(&mut **tx)
            .await?;
    if role != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    let login = media_authorization::login_hash(headers)?;
    let row = sqlx::query("SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(&login).bind(user.id).fetch_optional(&mut **tx).await?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "session_expired"))?;
    if write
        && headers.get("x-csrf-token").and_then(|v| v.to_str().ok())
            != Some(row.get::<String, _>("csrf").as_str())
    {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    Ok(login)
}
async fn finish(tx: Transaction<'_, Postgres>, user: &User, login: &str) -> Result<()> {
    let mut tx = tx;
    let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>clock_timestamp() AND u.admin AND account_active(u.id))")
        .bind(login).bind(user.id).fetch_one(&mut *tx).await?;
    if !live {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    tx.commit().await?;
    Ok(())
}

pub async fn get(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let user = auth(&app, &headers, false).await?;
    admin(&user)?;
    let mut tx = app.db.begin().await?;
    let login = lock_admin(&mut tx, &user, &headers, false).await?;
    let row = sqlx::query(SELECT).fetch_one(&mut *tx).await?;
    let value = projection(&app, &row)?;
    finish(tx, &user, &login).await?;
    Ok(media_titles::private_json(value))
}

pub async fn change(
    State(app): State<App>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response> {
    let user = auth(&app, &headers, true).await?;
    admin(&user)?;
    let body: Change = serde_json::from_slice(&body).map_err(|_| invalid())?;
    let expected = revision(&body.expected_revision)?;
    validate(&body.changes)?;
    let mut tx = app.db.begin().await?;
    let login = lock_admin(&mut tx, &user, &headers, true).await?;
    let row = sqlx::query(&format!("{SELECT} FOR UPDATE"))
        .fetch_one(&mut *tx)
        .await?;
    if row.try_get::<i64, _>("revision")? != expected {
        return Err(err(StatusCode::CONFLICT, "settings_revision_conflict"));
    }
    let old = overrides(&row)?;
    let mut next = old.clone();
    for (index, name) in FIELDS.iter().enumerate() {
        if let Some(value) = body.changes.get(*name) {
            next[index] = value.clone(); // Validated null explicitly restores deployment inheritance.
        }
    }
    let row = if old != next {
        let revision = expected
            .checked_add(1)
            .ok_or_else(|| err(StatusCode::CONFLICT, "settings_revision_conflict"))?;
        let changed = sqlx::query("UPDATE admin_settings SET revision=$1,playback_session_limit=$2,media_queue_limit=$3,registration_validate_per_minute=$4,registration_per_ten_minutes=$5,registration_mode=$6,guests_enabled=$7,updated_at=clock_timestamp(),updated_by=$8 WHERE singleton AND revision=$9")
            .bind(revision).bind(next[0].as_i64()).bind(next[1].as_i64()).bind(next[2].as_i64()).bind(next[3].as_i64()).bind(next[4].as_str()).bind(next[5].as_bool()).bind(user.id).bind(expected)
            .execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(err(StatusCode::CONFLICT, "settings_revision_conflict"));
        }
        sqlx::query(SELECT).fetch_one(&mut *tx).await?
    } else {
        row
    };
    let value = projection(&app, &row)?;
    finish(tx, &user, &login).await?;
    Ok(media_titles::private_json(value))
}

/// Public access-policy discovery contains only two intentional public flags.
pub async fn registration_policy(State(app): State<App>) -> Result<Response> {
    let mut tx = app.db.begin().await?;
    let row = sqlx::query("SELECT COALESCE(registration_mode,'invite_only') AS registration_mode,COALESCE(guests_enabled,false) AS guests_enabled FROM admin_settings WHERE singleton")
        .fetch_one(&mut *tx).await?;
    let mode: String = row.try_get("registration_mode")?;
    if !matches!(mode.as_str(), "closed" | "invite_only" | "open") {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"));
    }
    let value =
        json!({"registration_mode":mode,"guests_enabled":row.try_get::<bool,_>("guests_enabled")?});
    tx.commit().await?;
    Ok(media_titles::private_json(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_are_lossless_positive_decimal_strings() {
        assert_eq!(revision("1").unwrap(), 1);
        assert_eq!(revision("9223372036854775807").unwrap(), i64::MAX);
        for value in ["0", "-1", "01", "+1", " 1", "1.0", "9223372036854775808"] {
            assert!(revision(value).is_err(), "{value}");
        }
    }

    #[test]
    fn closed_patch_rejects_unknown_keys_types_and_out_of_bounds_values() {
        for value in [
            json!({}),
            json!({"database_url":"private"}),
            json!({"media_queue_limit":0}),
            json!({"media_queue_limit":10001}),
            json!({"media_queue_limit":1.5}),
            json!({"media_queue_limit":"2"}),
            json!({"media_queue_limit":true}),
            json!({"media_queue_limit":{}}),
            json!({"registration_mode":"anonymous"}),
            json!({"registration_mode":true}),
            json!({"guests_enabled":1}),
            json!({"guests_enabled":"true"}),
        ] {
            assert!(validate(value.as_object().unwrap()).is_err());
        }
        for name in &FIELDS[..4] {
            for value in [Value::Null, json!(1), json!(10000)] {
                assert!(validate(&Map::from_iter([((*name).into(), value)])).is_ok());
            }
        }
        for changes in [
            json!({"registration_mode":"closed"}),
            json!({"registration_mode":"invite_only"}),
            json!({"registration_mode":"open"}),
            json!({"registration_mode":null,"guests_enabled":null}),
            json!({"guests_enabled":false}),
            json!({"guests_enabled":true}),
        ] {
            assert!(validate(changes.as_object().unwrap()).is_ok());
        }
        assert!(serde_json::from_value::<Change>(json!({"expected_revision":"1","changes":{"media_queue_limit":2},"config_file":"secret"})).is_err());
    }
}
