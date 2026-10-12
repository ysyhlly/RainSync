//! Point-in-time viewer credential snapshots for media use-cases.
//!
//! Account mutation, QR/OAuth polling and revision ownership remain in the
//! account application. Media receives an opaque frozen snapshot; it must
//! reacquire the existing login/room/account guards after every relevant wait.
//! This boundary owns no network client or media/signing-key cache.
use super::{
    AccountScope, BiliCookie, PROVIDER, PROVIDER_ACCOUNT_SELECT, ShortCredential, account_provider,
    account_scope, cookie_from_value, credential_error, scope, short_provider,
};
use crate::{Result, err, hash};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

/// Decryption is deliberately local to account loading. No owner registry,
/// platform resolver, login mutation or room-role query is exposed here.
pub(super) struct Context<'a> {
    pub db: &'a PgPool,
    pub decrypt: &'a (dyn Fn(&str) -> anyhow::Result<Value> + Sync),
}

/// Not serializable or printable: the Cookie is an opaque server-only value.
pub(crate) struct FrozenAccount {
    viewer_id: Uuid,
    provider: &'static str,
    observed: Option<AccountScope>,
    credential_expires_at_ms: Option<i64>,
    cookie: Option<BiliCookie>,
    short_cookie: Option<ShortCredential>,
    youtube_cookie: Option<providers::platform::youtube::Credential>,
    explicit_anonymous: bool,
}

impl FrozenAccount {
    pub(crate) fn provider_name(&self) -> &'static str {
        self.provider
    }
    /// Explicit anonymous intent has no dependency on any account credential.
    pub(crate) fn anonymous(viewer_id: Uuid) -> Self {
        Self::anonymous_scoped(viewer_id, PROVIDER)
    }
    pub(crate) fn anonymous_for_provider(viewer_id: Uuid, provider: &str) -> Result<Self> {
        Ok(Self::anonymous_scoped(
            viewer_id,
            if provider == "youtube" {
                "youtube"
            } else {
                account_provider(provider)?
            },
        ))
    }
    fn anonymous_scoped(viewer_id: Uuid, provider: &'static str) -> Self {
        Self {
            viewer_id,
            provider,
            observed: None,
            credential_expires_at_ms: None,
            cookie: None,
            short_cookie: None,
            youtube_cookie: None,
            explicit_anonymous: true,
        }
    }
    fn has_credential(&self) -> bool {
        self.cookie.is_some() || self.short_cookie.is_some() || self.youtube_cookie.is_some()
    }

    /// Compare only the observation read after acquiring the account lock.
    /// This predicate is not a cached authorization decision.
    fn matches_current(
        &self,
        scope: AccountScope,
        live: bool,
        credential_expires_at_ms: Option<i64>,
    ) -> bool {
        self.observed == Some(scope)
            && live == self.has_credential()
            && (!live || credential_expires_at_ms == self.credential_expires_at_ms)
    }
    pub(crate) fn account_id(&self) -> Option<Uuid> {
        self.has_credential()
            .then_some(self.observed)
            .flatten()
            .map(|scope| scope.account_id)
    }
    pub(crate) fn revision(&self) -> Option<i64> {
        self.has_credential()
            .then_some(self.observed)
            .flatten()
            .map(|scope| scope.revision)
    }
    pub(crate) fn credential_expires_at_ms(&self) -> Option<i64> {
        self.has_credential()
            .then_some(self.credential_expires_at_ms)
            .flatten()
    }
    pub(crate) fn cookie(&self) -> Option<&BiliCookie> {
        self.cookie.as_ref()
    }
    pub(crate) fn short_cookie(&self) -> Option<&ShortCredential> {
        self.short_cookie.as_ref()
    }
    pub(crate) fn youtube_cookie(&self) -> Option<&providers::platform::youtube::Credential> {
        self.youtube_cookie.as_ref()
    }
    /// Non-secret exact snapshot for explicitly paged collection discovery.
    /// Include an observed disconnected account too: replacing such a row must
    /// not silently change an own-or-anonymous continuation's account basis.
    pub(crate) fn continuation_fingerprint(&self) -> String {
        hash(
            &json!({
                "purpose":"platform_collection_account_v1",
                "viewer":self.viewer_id,
                "provider":self.provider,
                "observed":self.observed.map(|scope| json!({
                    "id":scope.account_id,"revision":scope.revision
                })),
                "has_credential":self.has_credential(),
                "expires":self.credential_expires_at_ms,
                "explicit_anonymous":self.explicit_anonymous,
            })
            .to_string(),
        )
    }
}

/// Credentials belong only to the viewing principal and the requested provider.
/// Imported short-video cookies are locally validated, never declared logged in.
pub(super) async fn load(
    context: Context<'_>,
    viewer_id: Uuid,
    provider: &str,
) -> Result<FrozenAccount> {
    let provider = account_provider(provider)?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(viewer_id)
        .bind(provider)
        .fetch_optional(context.db)
        .await?;
    let Some(row) = row else {
        let mut frozen = FrozenAccount::anonymous_scoped(viewer_id, provider);
        frozen.explicit_anonymous = false;
        return Ok(frozen);
    };
    let scope = account_scope(&row);
    let live: bool = row.get("credential_live");
    let expiry = row.get("credential_expires_at_ms");
    let mut frozen = FrozenAccount {
        viewer_id,
        provider,
        observed: Some(scope),
        credential_expires_at_ms: expiry,
        cookie: None,
        short_cookie: None,
        youtube_cookie: None,
        explicit_anonymous: false,
    };
    if live {
        let encrypted: Option<String> = row.get("credential_encrypted");
        let plaintext = (context.decrypt)(encrypted.as_deref().ok_or_else(credential_error)?)
            .map_err(|_| credential_error())?;
        let stored = if provider == PROVIDER {
            scope::credential_cookies(scope, plaintext)
        } else {
            scope::credential_cookies_for_provider(scope, provider, plaintext)
        }
        .ok_or_else(credential_error)?;
        if provider == PROVIDER {
            frozen.cookie = Some(cookie_from_value(stored)?);
        } else if provider == "youtube" {
            let raw = stored.as_str().ok_or_else(credential_error)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| credential_error())?
                .as_secs();
            frozen.youtube_cookie = Some(
                providers::platform::youtube::Credential::parse(raw, now)
                    .map_err(|_| credential_error())?,
            );
        } else {
            let raw = stored.as_str().ok_or_else(credential_error)?;
            frozen.short_cookie = Some(
                ShortCredential::parse(short_provider(provider)?, raw)
                    .map_err(|_| credential_error())?,
            );
        }
    }
    Ok(frozen)
}

/// Call after the normal room, membership, current-login and request fences.
/// Account SHARE locks are retained until the grant publication commits.
pub(crate) async fn guard_for_publish(
    tx: &mut Transaction<'_, Postgres>,
    viewer_id: Uuid,
    frozen: &FrozenAccount,
) -> Result<()> {
    let changed = || err(StatusCode::CONFLICT, "platform_account_changed");
    if frozen.viewer_id != viewer_id {
        return Err(changed());
    }
    if frozen.explicit_anonymous {
        return Ok(());
    }
    // Lock first, then project liveness in a fresh statement. PostgreSQL may
    // evaluate the first SELECT before a lock wait crosses the expiry cutoff.
    sqlx::query("SELECT id FROM platform_accounts WHERE user_id=$1 AND provider=$2 FOR SHARE")
        .bind(viewer_id)
        .bind(frozen.provider)
        .fetch_optional(&mut **tx)
        .await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(viewer_id)
        .bind(frozen.provider)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return if frozen.observed.is_none() {
            Ok(())
        } else {
            Err(changed())
        };
    };
    let scope = account_scope(&row);
    let live: bool = row.get("credential_live");
    if !frozen.matches_current(scope, live, row.get("credential_expires_at_ms")) {
        return Err(changed());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use providers::platform::short_video::Platform as ShortPlatform;

    #[test]
    fn frozen_account_rejects_late_revision_identity_liveness_and_expiry_changes() {
        let scope = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        let mut frozen = FrozenAccount {
            viewer_id: scope.user_id,
            provider: "bilibili",
            observed: Some(scope),
            credential_expires_at_ms: Some(100),
            cookie: Some(BiliCookie::from_header("SESSDATA=synthetic; DedeUserID=1").unwrap()),
            short_cookie: None,
            youtube_cookie: None,
            explicit_anonymous: false,
        };
        assert!(frozen.matches_current(scope, true, Some(100)));
        for changed in [
            AccountScope {
                user_id: Uuid::from_u128(4),
                ..scope
            },
            AccountScope {
                account_id: Uuid::from_u128(4),
                ..scope
            },
            AccountScope {
                revision: 4,
                ..scope
            },
        ] {
            assert!(!frozen.matches_current(changed, true, Some(100)));
        }
        assert!(!frozen.matches_current(scope, false, Some(100)));
        assert!(!frozen.matches_current(scope, true, Some(101)));
        assert!(!frozen.matches_current(scope, true, None));
        // Disconnected snapshots still bind the observed account revision;
        // expiry remains irrelevant while there is no live credential.
        frozen.cookie = None;
        assert!(frozen.matches_current(scope, false, None));
        assert!(frozen.matches_current(scope, false, Some(101)));
        assert!(!frozen.matches_current(scope, true, Some(100)));
        assert!(!frozen.matches_current(
            AccountScope {
                revision: 4,
                ..scope
            },
            false,
            None
        ));
    }

    #[test]
    fn provider_lookup_and_anonymous_context_do_not_expand_credential_support() {
        assert!(short_provider("bilibili").is_err());
        assert!(short_provider("youtube").is_err());
        assert!(short_provider("Douyin").is_err());
        assert_eq!(account_provider("youtube").unwrap(), "youtube");
        let viewer = Uuid::from_u128(1);
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            let frozen = FrozenAccount::anonymous_for_provider(viewer, provider).unwrap();
            assert_eq!(frozen.provider, provider);
            assert!(frozen.explicit_anonymous);
            assert!(frozen.account_id().is_none());
            assert!(frozen.revision().is_none());
            assert!(frozen.cookie().is_none());
            assert!(frozen.short_cookie().is_none());
        }
        assert!(FrozenAccount::anonymous_for_provider(viewer, "unknown").is_err());
    }

    #[test]
    fn short_frozen_context_uses_only_active_provider_credentials() {
        let account = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        let mut frozen = FrozenAccount {
            viewer_id: account.user_id,
            provider: "douyin",
            observed: Some(account),
            credential_expires_at_ms: None,
            cookie: None,
            short_cookie: Some(
                ShortCredential::parse(ShortPlatform::Douyin, "sessionid=fixture-only-session")
                    .unwrap(),
            ),
            youtube_cookie: None,
            explicit_anonymous: false,
        };
        assert_eq!(frozen.account_id(), Some(account.account_id));
        assert_eq!(frozen.revision(), Some(3));
        assert!(frozen.cookie().is_none());
        assert!(frozen.short_cookie().is_some());
        frozen.short_cookie = None;
        assert!(frozen.account_id().is_none());
        assert!(frozen.revision().is_none());
    }

    #[test]
    fn youtube_frozen_session_is_opaque_and_revision_bound_without_borrowing_other_providers() {
        let account = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        let credential = providers::platform::youtube::Credential::parse(
            "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-session-only\n.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tsynthetic-login-only\n", 100).unwrap();
        let stored = scope::credential_plaintext_for_provider(
            account,
            "youtube",
            json!(credential.expose_for_storage()),
        );
        assert!(
            scope::credential_cookies_for_provider(account, "bilibili", stored.clone()).is_none()
        );
        assert!(
            scope::credential_cookies_for_provider(account, "douyin", stored.clone()).is_none()
        );
        assert!(
            scope::credential_cookies_for_provider(
                AccountScope {
                    revision: 4,
                    ..account
                },
                "youtube",
                stored.clone()
            )
            .is_none()
        );
        assert!(scope::credential_cookies_for_provider(account, "youtube", stored).is_some());
        let frozen = FrozenAccount {
            viewer_id: account.user_id,
            provider: "youtube",
            observed: Some(account),
            credential_expires_at_ms: None,
            cookie: None,
            short_cookie: None,
            youtube_cookie: Some(credential),
            explicit_anonymous: false,
        };
        assert_eq!(frozen.account_id(), Some(account.account_id));
        assert_eq!(frozen.revision(), Some(3));
        assert!(frozen.cookie().is_none());
        assert!(frozen.short_cookie().is_none());
        assert!(frozen.youtube_cookie().is_some());
    }
}
