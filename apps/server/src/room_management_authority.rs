//! Transaction-local authority for lifecycle and ownership management.
//! Call after room -> snapshot -> all relevant membership locks. Current role
//! and the originating login are held through commit; no pool query is needed.
use crate::*;

pub(crate) struct Authority {
    user_id: Uuid,
    login_hash: String,
    actor_is_admin: bool,
    delegated: Option<(Uuid, protocol::RoomPermission)>,
}

impl Authority {
    pub(crate) async fn admit(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        headers: &HeaderMap,
        user_id: Uuid,
        owner_id: Uuid,
        actor_is_member: bool,
    ) -> Result<Self> {
        Self::admit_action(tx, headers, user_id, owner_id, actor_is_member, None).await
    }

    pub(crate) async fn admit_action(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        headers: &HeaderMap,
        user_id: Uuid,
        owner_id: Uuid,
        actor_is_member: bool,
        delegated_action: Option<(Uuid, protocol::RoomPermission)>,
    ) -> Result<Self> {
        let delegated = if let Some((room, permission)) = delegated_action {
            if actor_is_member
                && user_id != owner_id
                && persistence::room_permissions::allowed(tx, room, user_id, permission).await?
            {
                Some((room, permission))
            } else {
                None
            }
        } else {
            None
        };
        // Match controller/command ordering: memberships -> user -> login.
        // SHARE also blocks non-key role and expiry changes, unlike KEY SHARE.
        let current_admin: Option<bool> =
            sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 FOR SHARE")
                .bind(user_id)
                .fetch_optional(&mut **tx)
                .await?;
        let login_hash =
            hash(&cookie(headers).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?);
        let csrf: Option<String> = sqlx::query_scalar(
            "SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(&login_hash)
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await?;
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())",
        )
        .bind(&login_hash)
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;
        let actor_is_admin = authorize(
            user_id,
            if delegated.is_some() {
                user_id
            } else {
                owner_id
            },
            actor_is_member,
            current_admin,
            csrf.as_deref(),
            headers
                .get("x-csrf-token")
                .and_then(|value| value.to_str().ok()),
            valid,
        )?;
        Ok(Self {
            user_id,
            login_hash,
            actor_is_admin,
            delegated: if actor_is_admin { None } else { delegated },
        })
    }

    pub(crate) fn actor_is_admin(&self) -> bool {
        self.actor_is_admin
    }

    pub(crate) fn actor_permission(&self) -> Option<protocol::RoomPermission> {
        self.delegated.map(|(_, permission)| permission)
    }

    pub(crate) async fn commit(self, mut tx: sqlx::Transaction<'_, sqlx::Postgres>) -> Result<()> {
        // Locks fence explicit revocation and demotion, but not the passage of
        // time while later resource writes wait. Check this exact login last.
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())",
        )
        .bind(&self.login_hash)
        .bind(self.user_id)
        .fetch_one(&mut *tx)
        .await?;
        require_live_login(valid)?;
        if let Some((room, permission)) = self.delegated {
            persistence::room_permissions::require(&mut tx, room, self.user_id, permission)
                .await
                .map_err(|_| err(StatusCode::FORBIDDEN, "forbidden"))?;
        }
        tx.commit().await?;
        Ok(())
    }
}

fn require_live_login(valid: bool) -> Result<()> {
    if !valid {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}

fn authorize(
    user_id: Uuid,
    owner_id: Uuid,
    actor_is_member: bool,
    current_admin: Option<bool>,
    session_csrf: Option<&str>,
    supplied_csrf: Option<&str>,
    valid_login: bool,
) -> Result<bool> {
    require_live_login(valid_login && session_csrf.is_some() && current_admin.is_some())?;
    if supplied_csrf != session_csrf {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    let actor_is_admin = current_admin == Some(true);
    if !actor_is_admin {
        if !actor_is_member {
            return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
        }
        if owner_id != user_id {
            return Err(err(StatusCode::FORBIDDEN, "forbidden"));
        }
    }
    Ok(actor_is_admin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(
        user_id: Uuid,
        owner_id: Uuid,
        member: bool,
        current_admin: Option<bool>,
        csrf: Option<&str>,
        supplied_csrf: Option<&str>,
        login_live: bool,
    ) -> std::result::Result<bool, (StatusCode, String)> {
        authorize(
            user_id,
            owner_id,
            member,
            current_admin,
            csrf,
            supplied_csrf,
            login_live,
        )
        .map_err(|error| (error.0, error.1))
    }

    #[test]
    fn current_role_controls_the_nonmember_admin_override() {
        let actor = Uuid::new_v4();
        let owner = Uuid::new_v4();
        assert_eq!(
            policy(
                actor,
                owner,
                false,
                Some(true),
                Some("csrf"),
                Some("csrf"),
                true
            ),
            Ok(true)
        );
        // A role snapshot taken before a lock wait is not an input to this gate.
        assert_eq!(
            policy(
                actor,
                owner,
                false,
                Some(false),
                Some("csrf"),
                Some("csrf"),
                true
            ),
            Err((StatusCode::FORBIDDEN, "not_a_member".into()))
        );
        assert_eq!(
            policy(
                actor,
                owner,
                true,
                Some(false),
                Some("csrf"),
                Some("csrf"),
                true
            ),
            Err((StatusCode::FORBIDDEN, "forbidden".into()))
        );
    }

    #[test]
    fn owner_requires_current_membership_but_demotion_does_not_remove_ownership() {
        let owner = Uuid::new_v4();
        assert_eq!(
            policy(
                owner,
                owner,
                true,
                Some(false),
                Some("csrf"),
                Some("csrf"),
                true
            ),
            Ok(false)
        );
        assert_eq!(
            policy(
                owner,
                owner,
                false,
                Some(false),
                Some("csrf"),
                Some("csrf"),
                true
            ),
            Err((StatusCode::FORBIDDEN, "not_a_member".into()))
        );
    }

    #[test]
    fn revoked_or_expired_login_and_deleted_actor_fail_closed_even_for_admin() {
        let actor = Uuid::new_v4();
        for (role, csrf, live) in [
            (Some(true), None, true),
            (Some(true), Some("csrf"), false),
            (None, Some("csrf"), true),
        ] {
            assert_eq!(
                policy(actor, actor, true, role, csrf, Some("csrf"), live),
                Err((StatusCode::UNAUTHORIZED, "session_expired".into()))
            );
        }
    }

    #[test]
    fn csrf_uses_the_locked_login_value_and_never_accepts_a_missing_header() {
        let owner = Uuid::new_v4();
        for supplied in [Some("old-csrf"), None] {
            assert_eq!(
                policy(
                    owner,
                    owner,
                    true,
                    Some(false),
                    Some("new-csrf"),
                    supplied,
                    true
                ),
                Err((StatusCode::FORBIDDEN, "csrf_rejected".into()))
            );
        }
    }

    #[test]
    fn natural_login_expiry_is_denied_at_final_commit_admission() {
        assert!(require_live_login(true).is_ok());
        let error = require_live_login(false).unwrap_err();
        assert_eq!(error.0, StatusCode::UNAUTHORIZED);
        assert_eq!(error.1, "session_expired");
    }
}
