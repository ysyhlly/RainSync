//! Complete viewer-owned Bilibili renewal status and opt-out transactions.
use super::super::{
    ACCOUNT_SELECT, expected_revision, guard_login, guard_login_live, lock_account, login_hash,
    maintenance, status_value,
};
use super::Preference;
use crate::identity::{RequestContext, request};
use crate::{Result, err};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

fn public_status(account: Value, row: Option<&PgRow>) -> Value {
    json!({"account":account,"method":"web_cookie_refresh","supported":true,"enabled":row.is_some_and(|r|matches!(r.get::<String,_>("state").as_str(),"scheduled"|"running")),
        "state":row.map(|r|r.get::<String,_>("state")).unwrap_or_else(||"disabled".to_owned()),
        "next_refresh_at":row.and_then(|r|r.get::<Option<i64>,_>("next_refresh_at_ms")),
        "enable_requires":"new_consented_qr_login"})
}

pub(super) async fn status(context: RequestContext<'_>, headers: HeaderMap) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, false, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = maintenance::begin_db(db).await?;
    maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let account = maintenance::phase(
        sqlx::query(ACCOUNT_SELECT)
            .bind(user.id)
            .fetch_optional(&mut *tx),
    )
    .await?;
    // Renewal is scoped to the originating login. A different browser login
    // may inspect account state, but cannot inherit background renewal consent.
    let row=maintenance::phase(sqlx::query("SELECT r.state,floor(extract(epoch FROM r.next_refresh_at)*1000)::bigint AS next_refresh_at_ms FROM platform_account_renewals r JOIN platform_accounts a ON a.id=r.account_id AND a.revision=r.credential_revision WHERE a.user_id=$1 AND a.provider='bilibili' AND a.state='connected' AND r.consent_login_hash=$2 AND playback_login_allowed($1,$2)")
        .bind(user.id).bind(&login).fetch_optional(&mut *tx)).await?;
    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let value = public_status(status_value(account.as_ref()), row.as_ref());
    maintenance::commit(tx).await?;
    Ok(value)
}

pub(super) async fn set_preference(
    context: RequestContext<'_>,
    headers: HeaderMap,
    body: Preference,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    if body.enabled {
        return Err(err(
            StatusCode::CONFLICT,
            "platform_renewal_new_consented_qr_required",
        ));
    }
    let mut tx = maintenance::begin_db(db).await?;
    maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let row = maintenance::phase(lock_account(&mut tx, user.id)).await?;
    if expected != Some(row.get("revision")) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    maintenance::phase(
        sqlx::query("DELETE FROM platform_account_renewals WHERE account_id=$1")
            .bind(row.get::<Uuid, _>("id"))
            .execute(&mut *tx),
    )
    .await?;
    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let value = public_status(status_value(Some(&row)), None);
    maintenance::commit(tx).await?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn closed_pool() -> sqlx::PgPool {
        // Close before entering either operation. These authentication probes
        // cannot open a database connection, even if a SQL branch regresses.
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
    fn preference_ingress_preserves_raw_revision_and_denies_unknown_fields() {
        for enabled in [false, true] {
            for revision in [json!(null), json!("3"), json!("03"), json!(3), json!({})] {
                let preference = serde_json::from_value::<Preference>(
                    json!({"expected_revision":revision.clone(),"enabled":enabled}),
                )
                .unwrap();
                assert_eq!(preference.expected_revision, revision);
                assert_eq!(preference.enabled, enabled);
            }
        }
        for input in [
            json!({}),
            json!(null),
            json!([]),
            json!({"expected_revision":"3"}),
            json!({"enabled":false}),
            json!({"expected_revision":"3","enabled":null}),
            json!({"expected_revision":"3","enabled":"false"}),
            json!({"expected_revision":"3","enabled":false,"cookie":"synthetic"}),
            json!({"expected_revision":"3","enabled":false,"refresh_token":"synthetic"}),
            json!({"expected_revision":"3","enabled":false,"provider":"bilibili"}),
        ] {
            assert!(serde_json::from_value::<Preference>(input).is_err());
        }
    }

    #[test]
    fn preference_revision_retains_null_and_exact_positive_i64_strings() {
        assert_eq!(expected_revision(&json!(null)).unwrap(), None);
        for revision in [1, 3, 9_007_199_254_740_993, i64::MAX] {
            assert_eq!(
                expected_revision(&json!(revision.to_string())).unwrap(),
                Some(revision),
            );
        }
        for revision in [
            json!(0),
            json!(3),
            json!({}),
            json!(false),
            json!(""),
            json!("0"),
            json!("03"),
            json!("+3"),
            json!("-3"),
            json!("3.0"),
            json!(" 3"),
            json!("9223372036854775808"),
        ] {
            failure(
                expected_revision(&revision).unwrap_err(),
                StatusCode::BAD_REQUEST,
                "invalid_request",
            );
        }
    }

    #[test]
    fn renewal_projection_keeps_seven_fields_and_complete_nested_account() {
        let absent = json!({"id":null,"provider":"bilibili","revision":null,"state":"revoked"});
        assert_eq!(status_value(None), absent);
        assert_eq!(
            public_status(status_value(None), None),
            json!({"account":absent,"method":"web_cookie_refresh","supported":true,
                "enabled":false,"state":"disabled","next_refresh_at":null,
                "enable_requires":"new_consented_qr_login"}),
        );
        for state in ["connected", "expired", "revoked"] {
            let account = json!({"id":Uuid::from_u128(2),"provider":"bilibili",
                "revision":"9007199254740993","state":state});
            assert_eq!(
                public_status(account.clone(), None),
                json!({"account":account,"method":"web_cookie_refresh","supported":true,
                    "enabled":false,"state":"disabled","next_refresh_at":null,
                    "enable_requires":"new_consented_qr_login"}),
            );
        }
    }

    #[tokio::test]
    async fn missing_login_precedes_revision_opt_in_and_transaction_work() {
        let db = closed_pool().await;
        failure(
            status(context(&db), HeaderMap::new()).await.unwrap_err(),
            StatusCode::UNAUTHORIZED,
            "login_required",
        );
        for enabled in [false, true] {
            for expected_revision in [json!(null), json!("invalid"), json!("3")] {
                failure(
                    set_preference(
                        context(&db),
                        HeaderMap::new(),
                        Preference {
                            expected_revision,
                            enabled,
                        },
                    )
                    .await
                    .unwrap_err(),
                    StatusCode::UNAUTHORIZED,
                    "login_required",
                );
            }
        }
    }

    #[tokio::test]
    async fn closed_authentication_storage_precedes_origin_revision_opt_in_and_transaction_work() {
        let db = closed_pool().await;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "rainsync_session=synthetic-session-only".parse().unwrap(),
        );
        failure(
            status(context(&db), headers.clone()).await.unwrap_err(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "database_error",
        );
        for enabled in [false, true] {
            for expected_revision in [json!(null), json!("invalid"), json!("3")] {
                failure(
                    set_preference(
                        context(&db),
                        headers.clone(),
                        Preference {
                            expected_revision,
                            enabled,
                        },
                    )
                    .await
                    .unwrap_err(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "database_error",
                );
            }
        }
    }
}
