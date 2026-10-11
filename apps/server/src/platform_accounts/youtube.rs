//! YouTube session import is distinct from official Google OAuth and Bili QR.
//! The server must explicitly opt its trusted extractor in before accepting
//! viewer credentials. Secrets never leave the provider-bound encrypted vault.
use super::{
    AccountScope, PROVIDER_ACCOUNT_SELECT, UnlinkCredential, account_scope, credential_error,
    expected_revision, guard_login, guard_login_live, lock_provider_account, login_hash,
    revision_matches, scope,
};
use crate::identity::{RequestContext, request};
use crate::{Result, account_security, err};
use axum::http::{HeaderMap, StatusCode};
use providers::platform::youtube::Credential;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

fn status_value(available: bool, row: Option<&PgRow>) -> Value {
    let mut value = match row {
        Some(row) => json!({"id": row.get::<Uuid, _>("id"), "provider":"youtube",
            "revision": row.get::<i64, _>("revision").to_string(), "state": row.get::<String, _>("state"),
            "credential_expires_at": row.get::<Option<i64>, _>("credential_expires_at_ms")}),
        None => {
            json!({"id":null,"provider":"youtube","revision":null,"state":"revoked","credential_expires_at":null})
        }
    };
    value["login_method"] = json!("netscape_cookie_import");
    value["qr_available"] = json!(false);
    value["verification"] = json!(if value["state"] == "connected" {
        "unverified"
    } else {
        "none"
    });
    value["account_import_available"] = json!(available);
    value["availability_reason"] = json!(if available {
        None
    } else {
        Some("server_opt_in_required")
    });
    value
}

pub(crate) async fn status(
    context: RequestContext<'_>,
    import_available: bool,
    headers: HeaderMap,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, false, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query(
        "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='youtube' FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind("youtube")
        .fetch_optional(&mut *tx)
        .await?;
    if row.as_ref().is_some_and(|row| {
        row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")
    }) {
        row = Some(lock_provider_account(&mut tx, user.id, "youtube").await?.0);
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let value = status_value(import_available, row.as_ref());
    tx.commit().await?;
    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportYoutubeCredential {
    cookie_file: String,
    consent_to_store: bool,
    expected_revision: Value,
}

pub(crate) async fn import(
    context: RequestContext<'_>,
    import_available: bool,
    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    headers: HeaderMap,
    body: ImportYoutubeCredential,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    if !import_available {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "youtube_account_import_unavailable",
        ));
    }
    if !body.consent_to_store {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_storage_consent_required",
        ));
    }
    let expected = expected_revision(&body.expected_revision)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| credential_error())?
        .as_secs();
    let credential = Credential::parse(&body.cookie_file, now)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_credential_invalid"))?;
    account_security::rate_limit(db, "youtube-cookie-import", &user.id.to_string(), 10, 600)
        .await?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let (row, inserted) = lock_provider_account(&mut tx, user.id, "youtube").await?;
    let account = account_scope(&row);
    if !revision_matches(expected, account.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(credential_error)?;
    let cipher = encrypt(&scope::credential_plaintext_for_provider(
        AccountScope {
            revision,
            ..account
        },
        "youtube",
        json!(credential.expose_for_storage()),
    ))
    .map_err(|_| credential_error())?;
    guard_login_live(&mut tx, user.id, &login).await?;
    let updated = sqlx::query("UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=to_timestamp($8::double precision/1000),revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND provider=$6 AND playback_login_allowed($5,$7)")
        .bind(account.account_id).bind(cipher).bind(revision).bind(account.revision).bind(user.id)
        .bind("youtube").bind(&login).bind(credential.expires_at_ms()).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind("youtube")
        .fetch_one(&mut *tx)
        .await?;
    let value = status_value(import_available, Some(&row));
    tx.commit().await?;
    Ok(value)
}

pub(crate) async fn unlink(
    context: RequestContext<'_>,
    import_available: bool,
    headers: HeaderMap,
    body: UnlinkCredential,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let (row, inserted) = lock_provider_account(&mut tx, user.id, "youtube").await?;
    let account = account_scope(&row);
    if !revision_matches(expected, account.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(credential_error)?;
    let updated = sqlx::query("UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider='youtube' AND playback_login_allowed($4,$5)")
        .bind(account.account_id).bind(revision).bind(account.revision).bind(user.id).bind(&login).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind("youtube")
        .fetch_one(&mut *tx)
        .await?;
    let value = status_value(import_available, Some(&row));
    tx.commit().await?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_discloses_opt_in_without_cookie_or_identity_fields() {
        for available in [true, false] {
            let value = status_value(available, None);
            assert_eq!(value.as_object().unwrap().len(), 10);
            assert_eq!(value["provider"], "youtube");
            assert_eq!(value["verification"], "none");
            assert_eq!(value["account_import_available"], available);
            assert_eq!(value["availability_reason"].is_null(), available);
            for field in [
                "cookies",
                "cookie_file",
                "user_id",
                "credential_encrypted",
                "auth_login_hash",
            ] {
                assert!(!value.as_object().unwrap().contains_key(field));
            }
        }
    }
    #[test]
    fn import_requires_explicit_consent_revision_and_closed_cookie_file_shape() {
        let value = json!({"cookie_file":"# Netscape HTTP Cookie File\n","consent_to_store":true,"expected_revision":null});
        assert!(serde_json::from_value::<ImportYoutubeCredential>(value.clone()).is_ok());
        for field in ["cookie_file", "consent_to_store", "expected_revision"] {
            let mut invalid = value.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<ImportYoutubeCredential>(invalid).is_err());
        }
        let mut invalid = value;
        invalid["cookie"] = json!("synthetic");
        assert!(serde_json::from_value::<ImportYoutubeCredential>(invalid).is_err());
    }

    async fn closed_pool() -> sqlx::PgPool {
        // Close the lazy pool before any operation can reach authentication.
        // Even a regression reaching SQL cannot open a connection or socket.
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

    fn login_required(error: crate::Error) {
        assert_eq!(error.0, StatusCode::UNAUTHORIZED);
        assert_eq!(error.1, "login_required");
        assert_eq!(error.2, None);
    }

    #[tokio::test]
    async fn status_authenticates_with_either_startup_opt_in_value() {
        let db = closed_pool().await;
        for available in [false, true] {
            login_required(
                status(context(&db), available, HeaderMap::new())
                    .await
                    .unwrap_err(),
            );
        }
    }

    #[tokio::test]
    async fn import_authentication_precedes_opt_in_body_and_encryption() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let db = closed_pool().await;
        let encrypt_calls = AtomicUsize::new(0);
        let encrypt = |_: &Value| -> anyhow::Result<String> {
            encrypt_calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("synthetic encrypt callback must remain unused")
        };
        for available in [false, true] {
            for consent_to_store in [false, true] {
                login_required(
                    import(
                        context(&db),
                        available,
                        &encrypt,
                        HeaderMap::new(),
                        ImportYoutubeCredential {
                            cookie_file: "invalid synthetic cookie file".into(),
                            consent_to_store,
                            expected_revision: json!("invalid"),
                        },
                    )
                    .await
                    .unwrap_err(),
                );
            }
        }
        assert_eq!(encrypt_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn unlink_authentication_precedes_revision_and_has_no_opt_in_gate() {
        let db = closed_pool().await;
        for available in [false, true] {
            login_required(
                unlink(
                    context(&db),
                    available,
                    HeaderMap::new(),
                    UnlinkCredential {
                        expected_revision: json!("invalid"),
                    },
                )
                .await
                .unwrap_err(),
            );
        }
    }

    #[tokio::test]
    async fn closed_authentication_storage_error_precedes_import_gate_and_callback() {
        let db = closed_pool().await;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "rainsync_session=synthetic-session-only".parse().unwrap(),
        );
        let encrypt = |_: &Value| -> anyhow::Result<String> {
            panic!("authentication storage failure must not encrypt")
        };
        for available in [false, true] {
            let error = import(
                context(&db),
                available,
                &encrypt,
                headers.clone(),
                ImportYoutubeCredential {
                    cookie_file: "invalid synthetic cookie file".into(),
                    consent_to_store: false,
                    expected_revision: json!("invalid"),
                },
            )
            .await
            .unwrap_err();
            assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(error.1, "database_error");
            assert_eq!(error.2, None);
        }
    }

    #[test]
    fn credential_dtos_leave_semantic_validation_in_the_operation() {
        // Value is intentionally not tightened to a typed revision. All JSON
        // shapes still deserialize; canonical revision checks happen after auth.
        for expected in [
            Value::Null,
            json!("1"),
            json!("01"),
            json!("invalid"),
            json!(0),
            json!(-1),
            json!({"unexpected": true}),
            json!([1]),
            json!(false),
        ] {
            let decoded: ImportYoutubeCredential = serde_json::from_value(json!({
                "cookie_file": "invalid", "consent_to_store": false,
                "expected_revision": expected
            }))
            .unwrap();
            assert_eq!(decoded.cookie_file, "invalid");
            assert!(!decoded.consent_to_store);
            assert_eq!(decoded.expected_revision, expected);
            let decoded: UnlinkCredential = serde_json::from_value(json!({
                "expected_revision": expected
            }))
            .unwrap();
            assert_eq!(decoded.expected_revision, expected);
        }
        for invalid in [
            json!({"cookie_file": null, "consent_to_store": true, "expected_revision": null}),
            json!({"cookie_file": "synthetic", "consent_to_store": "true", "expected_revision": null}),
            json!({"cookie_file": "synthetic", "consent_to_store": true, "expected_revision": null, "extra": true}),
        ] {
            assert!(serde_json::from_value::<ImportYoutubeCredential>(invalid).is_err());
        }
        for invalid in [json!({}), json!({"expected_revision": null, "extra": true})] {
            assert!(serde_json::from_value::<UnlinkCredential>(invalid).is_err());
        }
    }

    #[test]
    fn youtube_cookie_envelope_roundtrips_through_an_encrypt_only_callback() {
        use aes_gcm::{Aes256Gcm, KeyInit};
        let key = Aes256Gcm::new_from_slice(&[0x59; 32]).unwrap();
        let encrypt = |value: &Value| crate::encrypt_value(&key, value);
        let credential = Credential::parse(
            "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t200\tSAPISID\tsynthetic-session-only\n.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tsynthetic-session-only\n",
            100,
        )
        .unwrap();
        assert_eq!(credential.expires_at_ms(), Some(200000));
        let account = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: i64::MAX,
        };
        let plaintext = scope::credential_plaintext_for_provider(
            account,
            "youtube",
            json!(credential.expose_for_storage()),
        );
        let stored = encrypt(&plaintext).unwrap();
        let value = crate::decrypt_value(&key, &stored).unwrap();
        assert_eq!(value, plaintext);
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert_eq!(value["revision"], i64::MAX.to_string());
        assert_eq!(
            scope::credential_cookies_for_provider(account, "youtube", value.clone()),
            Some(json!(credential.expose_for_storage()))
        );
        for changed in [
            AccountScope {
                user_id: Uuid::from_u128(3),
                ..account
            },
            AccountScope {
                account_id: Uuid::from_u128(3),
                ..account
            },
            AccountScope {
                revision: i64::MAX - 1,
                ..account
            },
        ] {
            assert!(
                scope::credential_cookies_for_provider(changed, "youtube", value.clone()).is_none()
            );
        }
        for other in ["bilibili", "douyin", "tiktok", "unknown"] {
            assert!(
                scope::credential_cookies_for_provider(account, other, value.clone()).is_none()
            );
        }
        let mut changed = value;
        changed["revision"] = json!(i64::MAX);
        assert!(scope::credential_cookies_for_provider(account, "youtube", changed).is_none());
    }
}
