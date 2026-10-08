//! Request-boundary checks do not replace transaction-bound final authorization.
use super::{Failure, RequestContext, RequestIdentity};
use crate::{Error, Result, hash};
use axum::http::{HeaderMap, header};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(crate) fn cookie(h: &HeaderMap) -> Option<String> {
    h.get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|p| p.trim().strip_prefix("rainsync_session=").map(String::from))
}
pub(crate) fn origin(expected: &str, h: &HeaderMap) -> Result<()> {
    if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(expected) {
        return Err(Error::from(Failure::OriginRejected));
    };
    Ok(())
}
pub(crate) async fn authenticate(
    context: RequestContext<'_>,
    h: &HeaderMap,
    write: bool,
    allow_guest: bool,
) -> Result<RequestIdentity> {
    let token = cookie(h).ok_or_else(|| Error::from(Failure::LoginRequired))?;
    let row=sqlx::query("SELECT u.id,u.admin,s.csrf,u.principal_kind FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>clock_timestamp() AND playback_login_allowed(u.id,s.token_hash) AND NOT EXISTS(SELECT 1 FROM account_exits e WHERE e.user_id=u.id)").bind(hash(&token)).fetch_optional(context.db).await?.ok_or_else(||Error::from(Failure::SessionExpired))?;
    if !allow_guest && row.get::<String, _>("principal_kind") == "guest" {
        return Err(Error::from(Failure::GuestRestricted));
    }
    if write {
        origin(context.origin, h)?;
        if h.get("x-csrf-token").and_then(|v| v.to_str().ok())
            != Some(row.get::<String, _>("csrf").as_str())
        {
            return Err(Error::from(Failure::CsrfRejected));
        }
    }
    Ok(RequestIdentity {
        id: row.get("id"),
        admin: row.get("admin"),
    })
}
pub(crate) async fn member(db: &PgPool, user: &RequestIdentity, room: Uuid) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2 AND (guest_is_account($2) OR guest_room_allowed($2,$1)))",
    )
    .bind(room)
    .bind(user.id)
    .fetch_one(db)
    .await?;
    if !exists {
        return Err(Error::from(Failure::NotAMember));
    };
    Ok(())
}
pub(crate) fn admin(user: &RequestIdentity) -> Result<()> {
    if !user.admin {
        return Err(Error::from(Failure::AdminRequired));
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_keeps_exact_name_and_first_value_semantics() {
        let mut headers = HeaderMap::new();
        assert_eq!(cookie(&headers), None);
        headers.insert(
            header::COOKIE,
            "other=x; rainsync_session=first; rainsync_session=second"
                .parse()
                .unwrap(),
        );
        assert_eq!(cookie(&headers).as_deref(), Some("first"));
        headers.insert(
            header::COOKIE,
            "prefix_rainsync_session=wrong; rainsync_session="
                .parse()
                .unwrap(),
        );
        assert_eq!(cookie(&headers).as_deref(), Some(""));
        headers.insert(
            header::COOKIE,
            "prefix_rainsync_session=wrong".parse().unwrap(),
        );
        assert_eq!(cookie(&headers), None);
    }

    #[test]
    fn origin_requires_the_exact_deployment_origin() {
        let mut headers = HeaderMap::new();
        let expected = "https://rainsync.example";
        let failure = origin(expected, &headers).unwrap_err();
        assert_eq!(failure.1, "origin_rejected");
        for supplied in [
            "https://rainsync.example/",
            "http://rainsync.example",
            "https://other.example",
        ] {
            headers.insert(header::ORIGIN, supplied.parse().unwrap());
            assert!(origin(expected, &headers).is_err());
        }
        headers.insert(header::ORIGIN, expected.parse().unwrap());
        assert!(origin(expected, &headers).is_ok());
    }

    #[test]
    fn request_role_snapshot_only_performs_the_same_preliminary_check() {
        let id = Uuid::nil();
        assert_eq!(
            admin(&RequestIdentity { id, admin: false }).unwrap_err().1,
            "admin_required"
        );
        assert!(admin(&RequestIdentity { id, admin: true }).is_ok());
    }
}
