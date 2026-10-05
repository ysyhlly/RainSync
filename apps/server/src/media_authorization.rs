//! Authenticated caller checks. Expired authority does not prevent internal cleanup.
use super::*;

pub fn login_hash(headers: &HeaderMap) -> Result<String> {
    cookie(headers)
        .map(|value| hash(&value))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))
}

/// Call after room/snapshot/membership admission, before source/grant mutation.
/// A legacy grant has no knowable login owner; it keeps account ownership until
/// its original expiry, and cannot be renewed or used to mint new grants.
pub async fn lock_caller(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    user: Uuid,
    login: &str,
) -> Result<()> {
    if !persistence::media_authorization::lock_login(tx, user, login).await? {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    let allowed: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND user_id=$2 AND (auth_login_hash IS NULL OR auth_login_hash=$3))")
        .bind(id).bind(user).bind(login).fetch_one(&mut **tx).await?;
    if !allowed {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    Ok(())
}
