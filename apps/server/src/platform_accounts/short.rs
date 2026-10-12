//! Complete local Douyin/TikTok status/import/unlink operations.
//! Shared exact-login/account locks remain with their existing platform vault owner.
use super::{
    AccountScope, PROVIDER_ACCOUNT_SELECT, ShortCredential, ShortPlatform, UnlinkCredential,
    account_scope, credential_error, expected_revision, guard_login, guard_login_live,
    lock_provider_account, login_hash, revision_matches, scope, short_provider,
};
use crate::identity::{RequestContext, request};
use crate::{Result, account_security, err};
use aes_gcm::Aes256Gcm;
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;
pub(super) fn short_status_value(provider: ShortPlatform, row: Option<&PgRow>) -> Value {
    let mut value = match row {
        Some(row) => json!({"id": row.get::<Uuid, _>("id"), "provider": provider.id(),
            "revision": row.get::<i64, _>("revision").to_string(), "state": row.get::<String, _>("state"),
            "credential_expires_at": row.get::<Option<i64>, _>("credential_expires_at_ms")}),
        None => json!({"id": null, "provider": provider.id(), "revision": null,
            "state": "revoked", "credential_expires_at": null}),
    };
    value["login_method"] = json!("cookie_import");
    value["qr_available"] = json!(false);
    value["verification"] = json!(if value["state"] == "connected" {
        "unverified"
    } else {
        "none"
    });
    value
}

/// Deserialize-only ingress: never derive Debug or Serialize for raw cookies.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCredential {
    cookie: String,
    consent_to_store: bool,
    // Value deliberately requires the field, including explicit initial null.
    expected_revision: Value,
}

pub(crate) async fn status(
    context: RequestContext<'_>,
    provider: String,
    headers: HeaderMap,
) -> Result<Value> {
    let provider = short_provider(&provider)?;
    let db = context.db;
    let user = request::authenticate(context, &headers, false, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query("SELECT id FROM platform_accounts WHERE user_id=$1 AND provider=$2 FOR UPDATE")
        .bind(user.id)
        .bind(provider.id())
        .fetch_optional(&mut *tx)
        .await?;
    let mut row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind(provider.id())
        .fetch_optional(&mut *tx)
        .await?;
    if row.as_ref().is_some_and(|row| {
        row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")
    }) {
        row = Some(
            lock_provider_account(&mut tx, user.id, provider.id())
                .await?
                .0,
        );
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let value = short_status_value(provider, row.as_ref());
    tx.commit().await?;
    Ok(value)
}

pub(crate) async fn import(
    context: RequestContext<'_>,
    key: &Aes256Gcm,
    provider: String,
    headers: HeaderMap,
    body: ImportCredential,
) -> Result<Value> {
    let provider = short_provider(&provider)?;
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    if !body.consent_to_store {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_storage_consent_required",
        ));
    }
    let expected = expected_revision(&body.expected_revision)?;
    // Validate and reduce to the provider's allowlisted, bounded session fields.
    let credential = ShortCredential::parse(provider, &body.cookie)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_credential_invalid"))?;
    account_security::rate_limit(db, "platform-cookie-import", &user.id.to_string(), 10, 600)
        .await?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let (row, inserted) = lock_provider_account(&mut tx, user.id, provider.id()).await?;
    let account = account_scope(&row);
    if !revision_matches(expected, account.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(credential_error)?;
    let cipher = crate::encrypt_value(
        key,
        &scope::credential_plaintext_for_provider(
            AccountScope {
                revision,
                ..account
            },
            provider.id(),
            json!(credential.cookie_header()),
        ),
    )
    .map_err(|_| credential_error())?;
    // The import never asserts upstream validity or a guessed cookie expiry.
    const IMPORT_ACCOUNT_UPDATE: &str = "UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=NULL,revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND provider=$6 AND playback_login_allowed($5,$7)";
    let stored = sqlx::query(IMPORT_ACCOUNT_UPDATE)
        .bind(account.account_id)
        .bind(cipher)
        .bind(revision)
        .bind(account.revision)
        .bind(user.id)
        .bind(provider.id())
        .bind(&login)
        .execute(&mut *tx)
        .await?;
    if stored.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind(provider.id())
        .fetch_one(&mut *tx)
        .await?;
    let value = short_status_value(provider, Some(&row));
    tx.commit().await?;
    Ok(value)
}

pub(crate) async fn unlink(
    context: RequestContext<'_>,
    provider: String,
    headers: HeaderMap,
    body: UnlinkCredential,
) -> Result<Value> {
    let provider = short_provider(&provider)?;
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let (row, inserted) = lock_provider_account(&mut tx, user.id, provider.id()).await?;
    let account = account_scope(&row);
    if !revision_matches(expected, account.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(credential_error)?;
    let stored = sqlx::query("UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider=$5 AND playback_login_allowed($4,$6)")
        .bind(account.account_id).bind(revision).bind(account.revision)
        .bind(user.id).bind(provider.id()).bind(&login).execute(&mut *tx).await?;
    if stored.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind(provider.id())
        .fetch_one(&mut *tx)
        .await?;
    let value = short_status_value(provider, Some(&row));
    tx.commit().await?;
    // Historical grants retain immutable provenance; their stale provider-bound
    // revisions fail native_platform_source_allowed during delivery rechecks.
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::{KeyInit, aead::Aead};
    use base64::{Engine, engine::general_purpose::STANDARD};

    #[test]
    fn imported_short_credentials_keep_the_bound_envelope_through_shared_encryption() {
        let key = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
        let account = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: i64::MAX,
        };
        for provider in [ShortPlatform::Douyin, ShortPlatform::TikTok] {
            // The real parser requires at least 16 bytes of session state.
            // Keep the rejected short value as a negative case, not a parser exception.
            assert!(ShortCredential::parse(provider, "sessionid=fixture-only").is_err());
            let credential =
                ShortCredential::parse(provider, "sessionid=synthetic-private-session-value")
                    .unwrap();
            let plaintext = scope::credential_plaintext_for_provider(
                account,
                provider.id(),
                json!(credential.cookie_header()),
            );
            let bytes = STANDARD
                .decode(crate::encrypt_value(&key, &plaintext).unwrap())
                .unwrap();
            let decrypted = key.decrypt(bytes[..12].into(), &bytes[12..]).unwrap();
            let value: Value = serde_json::from_slice(&decrypted).unwrap();
            assert_eq!(value, plaintext);
            assert_eq!(value.as_object().unwrap().len(), 6);
            assert_eq!(value["revision"], i64::MAX.to_string());
            assert_eq!(
                scope::credential_cookies_for_provider(account, provider.id(), value.clone()),
                Some(json!(credential.cookie_header()))
            );
            for changed_account in [
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
                    scope::credential_cookies_for_provider(
                        changed_account,
                        provider.id(),
                        value.clone()
                    )
                    .is_none()
                );
            }
            for other_provider in ["bilibili", "douyin", "tiktok", "youtube", "unknown"] {
                if other_provider != provider.id() {
                    assert!(
                        scope::credential_cookies_for_provider(
                            account,
                            other_provider,
                            value.clone()
                        )
                        .is_none()
                    );
                }
            }
            let mut changed = value;
            changed["revision"] = json!(i64::MAX);
            assert!(
                scope::credential_cookies_for_provider(account, provider.id(), changed).is_none()
            );
        }
    }
}
