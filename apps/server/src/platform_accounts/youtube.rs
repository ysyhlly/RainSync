//! YouTube session import is distinct from official Google OAuth and Bili QR.
//! The server must explicitly opt its trusted extractor in before accepting
//! viewer credentials. Secrets never leave the provider-bound encrypted vault.
use super::*;
use providers::platform::youtube::Credential;

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

pub async fn youtube_status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let user = auth(&app, &headers, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = app.db.begin().await?;
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
    let value = status_value(app.youtube.viewer_credentials_enabled(), row.as_ref());
    tx.commit().await?;
    Ok(registration::private_json(StatusCode::OK, value))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportYoutubeCredential {
    cookie_file: String,
    consent_to_store: bool,
    expected_revision: Value,
}

pub async fn import_youtube_credential(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<ImportYoutubeCredential>,
) -> Result<Response> {
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    if !app.youtube.viewer_credentials_enabled() {
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
    account_security::rate_limit(
        &app.db,
        "youtube-cookie-import",
        &user.id.to_string(),
        10,
        600,
    )
    .await?;
    let mut tx = app.db.begin().await?;
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
    let cipher = app
        .encrypt(&scope::credential_plaintext_for_provider(
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
    let value = status_value(app.youtube.viewer_credentials_enabled(), Some(&row));
    tx.commit().await?;
    Ok(registration::private_json(StatusCode::OK, value))
}

pub async fn unlink_youtube(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<UnlinkCredential>,
) -> Result<Response> {
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = app.db.begin().await?;
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
    let value = status_value(app.youtube.viewer_credentials_enabled(), Some(&row));
    tx.commit().await?;
    Ok(registration::private_json(StatusCode::OK, value))
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
}
