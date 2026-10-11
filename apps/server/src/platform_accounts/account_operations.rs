//! Viewer-owned Bilibili account operations retain their complete transactions.
use super::{
    ACCOUNT_SELECT, AccountScope, CheckLogin, HTTP_SECONDS, account_scope, cookie_from_value,
    credential_error, expected_revision, fail_pending, guard_login, guard_login_live, lock_account,
    login_hash, scope, status_value,
};
use crate::identity::{RequestContext, request};
use crate::{Result, account_security, err};
use axum::http::{HeaderMap, StatusCode};
use providers::platform::bilibili::Client;
use providers::platform::bilibili::auth::LoginValidity;
use providers::platform::http::PlatformHttp;
use serde_json::{Value, json};
use sqlx::Row;
use tokio::time::{Duration, Instant as Deadline};
use uuid::Uuid;

pub(super) fn check_value(account: Value, verification: &str, checked_at: Option<i64>) -> Value {
    json!({"account": account, "verification": verification,
        "checked_at": checked_at, "renew_method": "qr_login"})
}

pub(super) fn check_revision_matches(expected: Option<i64>, scope: Option<AccountScope>) -> bool {
    expected == scope.map(|scope| scope.revision)
}

pub(super) fn check_snapshot_matches(
    observed: AccountScope,
    expiry: Option<i64>,
    current: Option<AccountScope>,
    live: bool,
    current_expiry: Option<i64>,
) -> bool {
    current == Some(observed) && live && current_expiry == expiry
}

pub(super) async fn status(context: RequestContext<'_>, headers: HeaderMap) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, false, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query(
        "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='bilibili' FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut row = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if row.as_ref().is_some_and(|row| {
        row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")
    }) {
        row = Some(lock_account(&mut tx, user.id).await?);
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let value = status_value(row.as_ref());
    tx.commit().await?;
    Ok(value)
}

pub(super) async fn check_login(
    context: RequestContext<'_>,
    http: PlatformHttp,
    decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync),
    headers: HeaderMap,
    body: CheckLogin,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    account_security::rate_limit(db, "platform-login-check", &user.id.to_string(), 20, 600).await?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query(
        "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='bilibili' FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut row = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    let observed = row.as_ref().map(account_scope);
    if !check_revision_matches(expected, observed) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    if row.as_ref().is_some_and(|row| {
        row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")
    }) {
        row = Some(lock_account(&mut tx, user.id).await?);
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let Some(account) = row
        .as_ref()
        .filter(|row| row.get::<bool, _>("credential_live"))
    else {
        let value = check_value(status_value(row.as_ref()), "none", None);
        tx.commit().await?;
        return Ok(value);
    };
    let scope = account_scope(account);
    let expires_at: Option<i64> = account.get("credential_expires_at_ms");
    let ciphertext: Option<String> = account.get("credential_encrypted");
    let plaintext = decrypt(ciphertext.as_deref().ok_or_else(credential_error)?)
        .map_err(|_| credential_error())?;
    let cookie = cookie_from_value(
        scope::credential_cookies(scope, plaintext).ok_or_else(credential_error)?,
    )?;
    tx.commit().await?;

    let upstream = Client::new(http, Some(cookie))
        .check_login(Deadline::now() + Duration::from_secs(HTTP_SECONDS))
        .await;

    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query(
        "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='bilibili' FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut current = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if !current.as_ref().is_some_and(|row| {
        check_snapshot_matches(
            scope,
            expires_at,
            Some(account_scope(row)),
            row.get::<bool, _>("credential_live"),
            row.get::<Option<i64>, _>("credential_expires_at_ms"),
        )
    }) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    let verification = match upstream {
        Ok(LoginValidity::Verified) => "verified",
        Ok(LoginValidity::Invalid) => {
            let revision = scope.revision.checked_add(1).ok_or_else(credential_error)?;
            let updated = sqlx::query("UPDATE platform_accounts SET state='expired',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider='bilibili' AND playback_login_allowed($4,$5)")
                .bind(scope.account_id).bind(revision).bind(scope.revision).bind(user.id).bind(&login).execute(&mut *tx).await?;
            if updated.rows_affected() != 1 {
                return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
            }
            fail_pending(&mut tx, user.id).await?;
            current = sqlx::query(ACCOUNT_SELECT)
                .bind(user.id)
                .fetch_optional(&mut *tx)
                .await?;
            "invalid"
        }
        Err(_) => "unknown",
    };
    guard_login_live(&mut tx, user.id, &login).await?;
    let checked_at: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *tx)
            .await?;
    let value = check_value(
        status_value(current.as_ref()),
        verification,
        Some(checked_at),
    );
    tx.commit().await?;
    Ok(value)
}

pub(super) async fn unlink(context: RequestContext<'_>, headers: HeaderMap) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let revision = account
        .get::<i64, _>("revision")
        .checked_add(1)
        .ok_or_else(credential_error)?;
    sqlx::query("UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1")
        .bind(account.get::<Uuid, _>("id")).bind(revision).execute(&mut *tx).await?;
    fail_pending(&mut tx, user.id).await?;
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
    let value = status_value(Some(&row));
    tx.commit().await?;
    // Existing and historical native grants retain their immutable provenance.
    // The current-account SQL predicate rejects the old revision immediately;
    // delivery revalidation drains active streams without an account→room lock.
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn closed_pool() -> sqlx::PgPool {
        // Close before operation entry. Even a regressed SQL branch cannot open
        // a database connection or socket in these authentication-only tests.
        let db = sqlx::postgres::PgPoolOptions::new()
            .min_connections(0)
            .connect_lazy_with(sqlx::postgres::PgConnectOptions::new());
        db.close().await;
        assert!(db.is_closed());
        db
    }

    fn context(db: &sqlx::PgPool) -> RequestContext<'_> {
        RequestContext {
            db,
            origin: "https://rainsync.example",
        }
    }

    fn failure(error: crate::Error, status: StatusCode, reason: &str) {
        assert_eq!(error.0, status);
        assert_eq!(error.1, reason);
        assert_eq!(error.2, None);
    }

    #[test]
    fn check_ingress_keeps_required_raw_revision_and_defers_semantic_validation() {
        for revision in [json!(null), json!("3"), json!("03"), json!(3), json!({})] {
            let parsed =
                serde_json::from_value::<CheckLogin>(json!({"expected_revision":revision.clone()}))
                    .unwrap();
            assert_eq!(parsed.expected_revision, revision);
        }
        for input in [
            json!({}),
            json!(null),
            json!([]),
            json!({"expected_revision":"3","cookie":"synthetic"}),
            json!({"expected_revision":"3","provider":"bilibili"}),
        ] {
            assert!(serde_json::from_value::<CheckLogin>(input).is_err());
        }
    }

    #[test]
    fn check_projection_preserves_complete_receipts_and_absent_account_shape() {
        let absent = json!({"id":null,"provider":"bilibili","revision":null,"state":"revoked"});
        assert_eq!(status_value(None), absent);
        assert_eq!(
            check_value(status_value(None), "none", None),
            json!({"account":absent,"verification":"none","checked_at":null,"renew_method":"qr_login"}),
        );
        for (verification, state) in [
            ("verified", "connected"),
            ("invalid", "expired"),
            ("unknown", "connected"),
        ] {
            let account = json!({"id":Uuid::from_u128(2),"provider":"bilibili","revision":"9007199254740993","state":state});
            assert_eq!(
                check_value(account.clone(), verification, Some(123456789)),
                json!({"account":account,"verification":verification,"checked_at":123456789,"renew_method":"qr_login"}),
            );
        }
    }

    #[test]
    fn exact_revision_and_expiry_snapshot_match_without_lossy_numeric_conversion() {
        let scope = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 9_007_199_254_740_993,
        };
        assert!(check_revision_matches(Some(scope.revision), Some(scope)));
        assert!(!check_revision_matches(
            Some(scope.revision - 1),
            Some(scope)
        ));
        assert!(!check_revision_matches(None, Some(scope)));
        assert!(check_revision_matches(None, None));
        for expiry in [None, Some(0), Some(123), Some(i64::MAX)] {
            assert!(check_snapshot_matches(
                scope,
                expiry,
                Some(scope),
                true,
                expiry
            ));
            assert!(!check_snapshot_matches(
                scope,
                expiry,
                Some(scope),
                false,
                expiry
            ));
            assert!(!check_snapshot_matches(scope, expiry, None, true, expiry));
            assert!(!check_snapshot_matches(
                scope,
                expiry,
                Some(AccountScope {
                    revision: scope.revision + 1,
                    ..scope
                }),
                true,
                expiry,
            ));
            let changed_expiry = if expiry.is_some() { None } else { Some(123) };
            assert!(!check_snapshot_matches(
                scope,
                expiry,
                Some(scope),
                true,
                changed_expiry
            ));
        }
    }

    #[tokio::test]
    async fn missing_login_precedes_revision_and_all_credential_work() {
        let db = closed_pool().await;
        let http = PlatformHttp::new();
        let calls = AtomicUsize::new(0);
        let decrypt = |_: &str| -> anyhow::Result<Value> {
            calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("must remain unused")
        };
        let errors = [
            status(context(&db), HeaderMap::new()).await.unwrap_err(),
            check_login(
                context(&db),
                http,
                &decrypt,
                HeaderMap::new(),
                CheckLogin {
                    expected_revision: json!("invalid"),
                },
            )
            .await
            .unwrap_err(),
            unlink(context(&db), HeaderMap::new()).await.unwrap_err(),
        ];
        for error in errors {
            failure(error, StatusCode::UNAUTHORIZED, "login_required");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn closed_authentication_storage_precedes_origin_revision_and_credential_work() {
        let db = closed_pool().await;
        let http = PlatformHttp::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "rainsync_session=synthetic-session-only".parse().unwrap(),
        );
        let decrypt = |_: &str| -> anyhow::Result<Value> { panic!("storage failure") };
        let errors = [
            status(context(&db), headers.clone()).await.unwrap_err(),
            check_login(
                context(&db),
                http,
                &decrypt,
                headers.clone(),
                CheckLogin {
                    expected_revision: json!("invalid"),
                },
            )
            .await
            .unwrap_err(),
            unlink(context(&db), headers).await.unwrap_err(),
        ];
        for error in errors {
            failure(error, StatusCode::INTERNAL_SERVER_ERROR, "database_error");
        }
    }
}
