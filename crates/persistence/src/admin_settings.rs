//! Closed runtime-admission allowlist. Call after the admission's existing locks
//! have waited, in the same READ COMMITTED transaction. There is no process cache
//! and missing/corrupt settings fail closed rather than admitting unlimited work.
use sqlx::PgConnection;

#[derive(Clone, Copy, Debug)]
pub enum Limit {
    PlaybackSessions,
    MediaQueue,
    RegistrationValidate,
    RegistrationAttempts,
}

pub async fn effective(
    connection: &mut PgConnection,
    setting: Limit,
    deployment: i64,
) -> Result<i64, sqlx::Error> {
    let query = match setting {
        Limit::PlaybackSessions => {
            "SELECT COALESCE(playback_session_limit,$1) FROM admin_settings WHERE singleton"
        }
        Limit::MediaQueue => {
            "SELECT COALESCE(media_queue_limit,$1) FROM admin_settings WHERE singleton"
        }
        Limit::RegistrationValidate => {
            "SELECT COALESCE(registration_validate_per_minute,$1) FROM admin_settings WHERE singleton"
        }
        Limit::RegistrationAttempts => {
            "SELECT COALESCE(registration_per_ten_minutes,$1) FROM admin_settings WHERE singleton"
        }
    };
    if !(1..=10000).contains(&deployment) {
        return Err(sqlx::Error::Protocol("invalid_admission_limit".into()));
    }
    let value: i64 = sqlx::query_scalar(query)
        .bind(deployment)
        .fetch_one(connection)
        .await?;
    if !(1..=10000).contains(&value) {
        return Err(sqlx::Error::Protocol("invalid_admission_limit".into()));
    }
    Ok(value)
}

/// Baselines preserve pre-settings behavior. These access modes have no legacy
/// deployment variable, so explicit reset always means invite-only / no guests.
pub const DEFAULT_REGISTRATION_MODE: &str = "invite_only";
pub const DEFAULT_GUESTS_ENABLED: bool = false;

pub async fn registration_mode(connection: &mut PgConnection) -> Result<String, sqlx::Error> {
    let mode: String = sqlx::query_scalar(
        "SELECT COALESCE(registration_mode,'invite_only') FROM admin_settings WHERE singleton",
    )
    .fetch_one(connection)
    .await?;
    if !matches!(mode.as_str(), "closed" | "invite_only" | "open") {
        return Err(sqlx::Error::Protocol("invalid_registration_mode".into()));
    }
    Ok(mode)
}
pub async fn guests_enabled(connection: &mut PgConnection) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE(guests_enabled,false) FROM admin_settings WHERE singleton")
        .fetch_one(connection)
        .await
}
