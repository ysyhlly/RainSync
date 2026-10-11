//! Approved-app account operations own their original complete transactions.
//! OAuth accounts/requests remain separate from native playback credentials.
use super::{ACCOUNT, Preference, lock_account, parse_provider, scope, token_envelope, token_from};
use crate::identity::{RequestContext, request};
use crate::platform_accounts::{
    AccountScope, UnlinkCredential, credential_error, expected_revision, guard_login,
    guard_login_live, login_hash, maintenance, revision_matches,
};
use crate::{Result, err};
use axum::http::{HeaderMap, StatusCode};
use providers::platform::oauth::{Config, Provider, Registry};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

fn status_value(registry: &Registry, p: Provider, row: Option<&PgRow>, login: &str) -> Value {
    let config = registry.config(p);
    let connected = row.is_some_and(|r| {
        r.get::<String, _>("state") == "connected"
            && r.get::<Option<bool>, _>("access_live") == Some(true)
            && config.is_some_and(|c| {
                r.get::<Option<String>, _>("config_binding").as_deref() == Some(c.binding())
            })
    });
    let renewal_owned = row.is_some_and(|r| {
        r.get::<Option<String>, _>("consent_login_hash").as_deref() == Some(login)
    });
    json!({"provider":p.name(),"id":row.map(|r|r.get::<Uuid,_>("id")),"revision":row.map(|r|r.get::<i64,_>("revision").to_string()),
        "state":if connected{"connected"}else if row.is_some_and(|r|r.get::<String,_>("state")!="revoked"){"expired"}else{"revoked"},
        "available":config.is_some(),"missing_prerequisites":registry.missing(p),"authorization_kind":"official_oauth","playback_session":false,
        "authorization_mode":if config.is_some_and(Config::qr_enabled){"qr"}else{"web"},"scopes":row.map(|r|r.get::<Vec<String>,_>("granted_scopes")).unwrap_or_default(),
        "access_expires_at":row.and_then(|r|r.get::<Option<i64>,_>("access_ms")),"refresh_expires_at":row.and_then(|r|r.get::<Option<i64>,_>("refresh_ms")),
        "auto_renew":renewal_owned&&row.is_some_and(|r|r.get("auto_renew")),"renewal_state":if renewal_owned{row.map(|r|r.get::<String,_>("renewal_state")).unwrap_or_else(||"disabled".to_owned())}else{"disabled".to_owned()},
        "next_refresh_at":if renewal_owned{row.and_then(|r|r.get::<Option<i64>,_>("next_refresh_ms"))}else{None}})
}

pub(super) async fn status(
    context: RequestContext<'_>,
    registry: &Registry,
    raw: String,
    headers: HeaderMap,
) -> Result<Value> {
    let db = context.db;
    let p = parse_provider(&raw)?;
    let user = request::authenticate(context, &headers, false, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = maintenance::begin_db(db).await?;
    maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    // Expired refresh authority is discarded; OAuth and playback rows are separate.
    maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1 WHERE user_id=$1 AND provider=$2 AND token_encrypted IS NOT NULL AND config_binding IS DISTINCT FROM $3")
        .bind(user.id).bind(p.name()).bind(registry.config(p).map(Config::binding)).execute(&mut *tx)).await?;
    maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND provider=$2 AND token_encrypted IS NOT NULL AND refresh_expires_at<=clock_timestamp()")
        .bind(user.id).bind(p.name()).execute(&mut *tx)).await?;
    let row = maintenance::phase(
        sqlx::query(ACCOUNT)
            .bind(user.id)
            .bind(p.name())
            .fetch_optional(&mut *tx),
    )
    .await?;
    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let value = status_value(registry, p, row.as_ref(), &login);
    maintenance::commit(tx).await?;
    Ok(value)
}

pub(super) async fn set_renewal(
    context: RequestContext<'_>,
    registry: &Registry,
    decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync),
    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    raw: String,
    headers: HeaderMap,
    body: Preference,
) -> Result<Value> {
    let db = context.db;
    let p = parse_provider(&raw)?;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = maintenance::begin_db(db).await?;
    maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, inserted) = lock_account(&mut tx, user.id, p).await?;
    let s = scope(&account);
    if !revision_matches(expected, s.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    if body.enabled {
        return Err(err(
            StatusCode::CONFLICT,
            "platform_renewal_new_consented_oauth_required",
        ));
    }
    let next = AccountScope {
        revision: s.revision.checked_add(1).ok_or_else(credential_error)?,
        ..s
    };
    let cipher = if let Some(old) = account.get::<Option<String>, _>("token_encrypted") {
        let binding = account
            .get::<Option<String>, _>("config_binding")
            .ok_or_else(credential_error)?;
        let t = token_from(
            s,
            p,
            &binding,
            decrypt(&old).map_err(|_| credential_error())?,
        )?;
        Some(encrypt(&token_envelope(next, p, &binding, &t)).map_err(|_| credential_error())?)
    } else {
        None
    };
    maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET auto_renew=false,consent_login_hash=NULL,renewal_state='disabled',operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=NULL,token_encrypted=$2,revision=$3 WHERE id=$1").bind(s.account_id).bind(cipher).bind(next.revision).execute(&mut *tx)).await?;
    let row = maintenance::phase(
        sqlx::query(ACCOUNT)
            .bind(user.id)
            .bind(p.name())
            .fetch_one(&mut *tx),
    )
    .await?;
    let value = status_value(registry, p, Some(&row), &login);
    maintenance::commit(tx).await?;
    Ok(value)
}

pub(super) async fn unlink(
    context: RequestContext<'_>,
    registry: &Registry,
    raw: String,
    headers: HeaderMap,
    body: UnlinkCredential,
) -> Result<Value> {
    let db = context.db;
    let p = parse_provider(&raw)?;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = maintenance::begin_db(db).await?;
    maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, inserted) = lock_account(&mut tx, user.id, p).await?;
    let s = scope(&account);
    if !revision_matches(expected, s.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='revoked',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='disabled',operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=NULL,revision=revision+1,granted_scopes='{}',access_expires_at=NULL,refresh_expires_at=NULL,config_binding=NULL WHERE id=$1")
        .bind(s.account_id).execute(&mut *tx)).await?;
    maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET status='failed',secret_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL WHERE account_id=$1 AND status='pending'").bind(s.account_id).execute(&mut *tx)).await?;
    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let row = maintenance::phase(
        sqlx::query(ACCOUNT)
            .bind(user.id)
            .bind(p.name())
            .fetch_one(&mut *tx),
    )
    .await?;
    let value = status_value(registry, p, Some(&row), &login);
    maintenance::commit(tx).await?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn closed_pool() -> sqlx::PgPool {
        // Closing the lazy pool first prevents even a regressed SQL path from
        // opening any database connection or socket.
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
    fn unavailable_status_keeps_the_complete_private_oauth_dto() {
        let registry = Registry::disabled();
        for provider in [Provider::Douyin, Provider::TikTok] {
            assert_eq!(
                status_value(&registry, provider, None, "synthetic-login"),
                json!({
                    "provider": provider.name(), "id": null, "revision": null,
                    "state": "revoked", "available": false,
                    "missing_prerequisites": ["approved_developer_application",
                        "server_client_key", "server_client_secret_file",
                        "registered_https_callback", "approved_identity_scope"],
                    "authorization_kind": "official_oauth", "playback_session": false,
                    "authorization_mode": "web", "scopes": [],
                    "access_expires_at": null, "refresh_expires_at": null,
                    "auto_renew": false, "renewal_state": "disabled", "next_refresh_at": null
                })
            );
        }
    }

    #[test]
    fn preference_keeps_existing_shape_without_early_revision_validation() {
        for enabled in [false, true] {
            for revision in [Value::Null, json!("3"), json!("invalid")] {
                let value = json!({"expected_revision": revision, "enabled": enabled});
                let parsed = serde_json::from_value::<Preference>(value.clone()).unwrap();
                assert_eq!(parsed.expected_revision, revision);
                assert_eq!(parsed.enabled, enabled);
                let mut unexpected = value;
                unexpected["consent_to_renew"] = json!(true);
                assert!(serde_json::from_value::<Preference>(unexpected).is_err());
            }
        }
        for value in [
            json!({"expected_revision":null}),
            json!({"expected_revision":null,"enabled":"false"}),
        ] {
            assert!(serde_json::from_value::<Preference>(value).is_err());
        }
    }

    #[tokio::test]
    async fn provider_validation_precedes_all_authentication_body_and_cipher_work() {
        let db = closed_pool().await;
        let registry = Registry::disabled();
        let decrypt =
            |_: &str| -> anyhow::Result<Value> { panic!("provider failure must not decrypt") };
        let encrypt =
            |_: &Value| -> anyhow::Result<String> { panic!("provider failure must not encrypt") };
        for raw in ["youtube", "bilibili", "Douyin", "", "tiktok/"] {
            failure(
                status(context(&db), &registry, raw.into(), HeaderMap::new())
                    .await
                    .unwrap_err(),
                StatusCode::BAD_REQUEST,
                "native_platform_invalid",
            );
            failure(
                unlink(
                    context(&db),
                    &registry,
                    raw.into(),
                    HeaderMap::new(),
                    UnlinkCredential {
                        expected_revision: json!("invalid"),
                    },
                )
                .await
                .unwrap_err(),
                StatusCode::BAD_REQUEST,
                "native_platform_invalid",
            );
            failure(
                set_renewal(
                    context(&db),
                    &registry,
                    &decrypt,
                    &encrypt,
                    raw.into(),
                    HeaderMap::new(),
                    Preference {
                        expected_revision: json!("invalid"),
                        enabled: true,
                    },
                )
                .await
                .unwrap_err(),
                StatusCode::BAD_REQUEST,
                "native_platform_invalid",
            );
        }
    }

    #[tokio::test]
    async fn missing_login_precedes_revision_enabled_configuration_and_callbacks() {
        let db = closed_pool().await;
        let registry = Registry::disabled();
        let cipher_calls = AtomicUsize::new(0);
        let decrypt = |_: &str| -> anyhow::Result<Value> {
            cipher_calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("synthetic decrypt must remain unused")
        };
        let encrypt = |_: &Value| -> anyhow::Result<String> {
            cipher_calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("synthetic encrypt must remain unused")
        };
        for raw in ["douyin", "tiktok"] {
            failure(
                status(context(&db), &registry, raw.into(), HeaderMap::new())
                    .await
                    .unwrap_err(),
                StatusCode::UNAUTHORIZED,
                "login_required",
            );
            failure(
                unlink(
                    context(&db),
                    &registry,
                    raw.into(),
                    HeaderMap::new(),
                    UnlinkCredential {
                        expected_revision: json!("invalid"),
                    },
                )
                .await
                .unwrap_err(),
                StatusCode::UNAUTHORIZED,
                "login_required",
            );
            for enabled in [false, true] {
                failure(
                    set_renewal(
                        context(&db),
                        &registry,
                        &decrypt,
                        &encrypt,
                        raw.into(),
                        HeaderMap::new(),
                        Preference {
                            expected_revision: json!("invalid"),
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
        assert_eq!(cipher_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn closed_authentication_storage_precedes_revision_enabled_and_cipher_work() {
        let db = closed_pool().await;
        let registry = Registry::disabled();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "rainsync_session=synthetic-session-only".parse().unwrap(),
        );
        let decrypt =
            |_: &str| -> anyhow::Result<Value> { panic!("storage failure must not decrypt") };
        let encrypt =
            |_: &Value| -> anyhow::Result<String> { panic!("storage failure must not encrypt") };
        for raw in ["douyin", "tiktok"] {
            let errors = [
                status(context(&db), &registry, raw.into(), headers.clone())
                    .await
                    .unwrap_err(),
                unlink(
                    context(&db),
                    &registry,
                    raw.into(),
                    headers.clone(),
                    UnlinkCredential {
                        expected_revision: json!("invalid"),
                    },
                )
                .await
                .unwrap_err(),
                set_renewal(
                    context(&db),
                    &registry,
                    &decrypt,
                    &encrypt,
                    raw.into(),
                    headers.clone(),
                    Preference {
                        expected_revision: json!("invalid"),
                        enabled: true,
                    },
                )
                .await
                .unwrap_err(),
            ];
            for error in errors {
                failure(error, StatusCode::INTERNAL_SERVER_ERROR, "database_error");
            }
        }
    }
}
