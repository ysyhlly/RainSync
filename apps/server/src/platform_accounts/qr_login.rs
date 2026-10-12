//! Exact-login Bilibili QR operations with request-scoped capabilities.
use super::{
    AccountScope, LoginRequest, OPERATION_LEASE_SECONDS, POLL_INTERVAL_SECONDS, PROVIDER,
    QR_KEY_PURPOSE, QR_LIFETIME_SECONDS, QR_PAYLOAD_PURPOSE, StartLogin, account_scope,
    can_complete, cookie_value, credential_error, deadline, fail_pending, guard_login,
    lock_account, lock_request, login_hash, renewal, scope, terminalize, upstream_error,
};
use crate::identity::{RequestContext, request};
use crate::{Result, account_security, err};
use axum::http::{HeaderMap, StatusCode};
use providers::platform::bilibili::{Client, QrKey, QrState};
use providers::platform::http::PlatformHttp;
use serde_json::{Value, json};
use uuid::Uuid;

/// The HTTP adapter owns the existing 200 replay / 201 admission distinction.
#[derive(Debug)]
pub(super) enum StartLoginOutcome {
    Replay(Value),
    Created(Value),
}

fn qr_payload(
    decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync),
    request: &LoginRequest,
) -> Result<Option<String>> {
    if request.status == "pending" && request.live {
        request
            .qr_payload_encrypted
            .as_deref()
            .map(|cipher| {
                decrypt(cipher)
                    .ok()
                    .and_then(|value| scope::qr_secret(&request.scope, QR_PAYLOAD_PURPOSE, value))
                    .ok_or_else(credential_error)
            })
            .transpose()
    } else {
        Ok(None)
    }
}

fn qr_response(request: &LoginRequest, payload: Option<String>, stage: Option<&str>) -> Value {
    json!({"id": request.scope.request_id, "provider": PROVIDER, "status": request.status,
        "stage": if request.status == "pending" { stage } else { None }, "qr_payload": payload, "expires_at": request.expires_at_ms,
        "next_poll_at": request.next_poll_at_ms, "server_time": request.server_time_ms})
}

pub(super) async fn start_login(
    context: RequestContext<'_>,
    http: &PlatformHttp,
    decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync),
    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    headers: HeaderMap,
    body: StartLogin,
) -> Result<StartLoginOutcome> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    if body.idempotency_key.is_nil() || !body.consent_to_store {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_storage_consent_required",
        ));
    }
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let previous = sqlx::query("SELECT id FROM platform_login_requests WHERE id=$1 FOR UPDATE")
        .bind(body.idempotency_key)
        .fetch_optional(&mut *tx)
        .await?;
    if previous.is_some() {
        let mut request = lock_request(&mut tx, body.idempotency_key, user.id, &login).await?;
        if request.consent_to_renew != body.consent_to_renew {
            return Err(err(StatusCode::CONFLICT, "platform_login_request_conflict"));
        }
        if request.status == "pending" {
            if !request.live {
                terminalize(&mut tx, request.scope.request_id, "expired").await?;
                request.status = "expired".into();
            } else if request.scope.account != account {
                terminalize(&mut tx, request.scope.request_id, "failed").await?;
                request.status = "failed".into();
            } else if request.qr_key_encrypted.is_none() && !request.operation_live {
                // Generation could have been sent before a process/HTTP loss.
                // An uncertain remote creation is never repeated for this ID.
                terminalize(&mut tx, request.scope.request_id, "failed").await?;
                request.status = "failed".into();
            }
        }
        let value = qr_response(&request, qr_payload(decrypt, &request)?, None);
        tx.commit().await?;
        return Ok(StartLoginOutcome::Replay(value));
    }
    // Retire expired requests and requests from a vanished originating login.
    // A live same-login request remains exclusive until cancel or expiry.
    sqlx::query("UPDATE platform_login_requests SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'failed' END,qr_key_encrypted=NULL,qr_payload_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND provider='bilibili' AND status='pending' AND (expires_at<=clock_timestamp() OR NOT playback_login_allowed(user_id,auth_login_hash))")
        .bind(user.id).execute(&mut *tx).await?;
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform_login_requests WHERE user_id=$1 AND provider='bilibili' AND status='pending')")
        .bind(user.id).fetch_one(&mut *tx).await?;
    if active {
        return Err(err(StatusCode::CONFLICT, "platform_login_in_progress"));
    }
    // Re-reading the same exact-login request never generates another QR.
    // Charge only a new admission, atomically with its exclusive request row.
    if let Some(seconds) = account_security::claim_rate_limit(
        &mut tx,
        "platform-login-start",
        &user.id.to_string(),
        10,
        600,
    )
    .await?
    {
        tx.commit().await?;
        return Err(account_security::limited(seconds));
    }
    let nonce = Uuid::new_v4();
    sqlx::query("INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,expires_at,next_poll_at,operation_nonce,operation_expires_at,account_id,account_revision,consent_to_renew) VALUES($1,$2,$3,'bilibili','pending',clock_timestamp()+$4*interval '1 second',clock_timestamp()+$5*interval '1 second',$6,clock_timestamp()+$7*interval '1 second',$8,$9,$10)")
        .bind(body.idempotency_key).bind(user.id).bind(&login).bind(QR_LIFETIME_SECONDS).bind(POLL_INTERVAL_SECONDS)
        .bind(nonce).bind(OPERATION_LEASE_SECONDS).bind(account.account_id).bind(account.revision).bind(body.consent_to_renew).execute(&mut *tx).await?;
    let request = lock_request(&mut tx, body.idempotency_key, user.id, &login).await?;
    let upstream_deadline = deadline(&request)?;
    tx.commit().await?;
    let upstream = Client::new(*http, None)
        .generate_qr(upstream_deadline)
        .await;
    // No database lock/transaction is retained across the provider call.
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let mut current = lock_request(&mut tx, request.scope.request_id, user.id, &login).await?;
    if current.status != "pending"
        || current.operation_nonce != Some(nonce)
        || account != request.scope.account
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    if !current.live {
        terminalize(&mut tx, current.scope.request_id, "expired").await?;
        current.status = "expired".into();
    } else {
        if !can_complete(&current, nonce, account) {
            return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
        }
        match upstream {
            Ok(challenge) => {
                let key = encrypt(&scope::qr_plaintext(
                    &current.scope,
                    QR_KEY_PURPOSE,
                    challenge.key.expose_for_storage(),
                ))
                .map_err(|_| credential_error())?;
                let payload = encrypt(&scope::qr_plaintext(
                    &current.scope,
                    QR_PAYLOAD_PURPOSE,
                    &challenge.login_url,
                ))
                .map_err(|_| credential_error())?;
                sqlx::query("UPDATE platform_login_requests SET qr_key_encrypted=$2,qr_payload_encrypted=$3,operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST(next_poll_at,clock_timestamp()+$4*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1")
                    .bind(current.scope.request_id).bind(key).bind(payload).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
            }
            Err(error) => {
                terminalize(&mut tx, current.scope.request_id, "failed").await?;
                tx.commit().await?;
                return Err(upstream_error("qr_generate", error));
            }
        }
    }
    let current = lock_request(&mut tx, current.scope.request_id, user.id, &login).await?;
    let value = qr_response(&current, qr_payload(decrypt, &current)?, Some("waiting"));
    tx.commit().await?;
    Ok(StartLoginOutcome::Created(value))
}

pub(super) async fn poll_login(
    context: RequestContext<'_>,
    http: &PlatformHttp,
    decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync),
    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    id: Uuid,
    headers: HeaderMap,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let mut request = lock_request(&mut tx, id, user.id, &login).await?;
    if request.status == "pending" && !request.live {
        terminalize(&mut tx, id, "expired").await?;
        request.status = "expired".into();
    } else if request.status == "pending" && request.scope.account != account {
        terminalize(&mut tx, id, "failed").await?;
        request.status = "failed".into();
    }
    if request.status != "pending" || request.operation_live || !request.ready_to_poll {
        let value = qr_response(&request, None, None);
        tx.commit().await?;
        return Ok(value);
    }
    let Some(cipher) = request.qr_key_encrypted.as_deref() else {
        // Never recreate a QR key when its generation outcome is unknown.
        terminalize(&mut tx, id, "failed").await?;
        request.status = "failed".into();
        let value = qr_response(&request, None, None);
        tx.commit().await?;
        return Ok(value);
    };
    let key_secret = decrypt(cipher)
        .ok()
        .and_then(|value| scope::qr_secret(&request.scope, QR_KEY_PURPOSE, value))
        .ok_or_else(credential_error)?;
    let key = QrKey::from_secret(&key_secret).map_err(|_| credential_error())?;
    let nonce = Uuid::new_v4();
    sqlx::query("UPDATE platform_login_requests SET operation_nonce=$2,operation_expires_at=LEAST(expires_at,clock_timestamp()+$3*interval '1 second'),next_poll_at=clock_timestamp()+$4*interval '1 second',updated_at=clock_timestamp() WHERE id=$1")
        .bind(id).bind(nonce).bind(OPERATION_LEASE_SECONDS).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
    let upstream_deadline = deadline(&request)?;
    tx.commit().await?;
    let upstream = Client::new(*http, None)
        .poll_qr(&key, upstream_deadline)
        .await;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let mut current = lock_request(&mut tx, id, user.id, &login).await?;
    if current.status != "pending"
        || current.operation_nonce != Some(nonce)
        || account != request.scope.account
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    let stage;
    if !current.live {
        terminalize(&mut tx, id, "expired").await?;
        current.status = "expired".into();
        stage = None;
    } else {
        if !can_complete(&current, nonce, account) {
            return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
        }
        match upstream {
            Ok(poll) => match poll.state {
                QrState::Waiting | QrState::Scanned => {
                    stage = Some(if poll.state == QrState::Scanned {
                        "scanned"
                    } else {
                        "waiting"
                    });
                    sqlx::query("UPDATE platform_login_requests SET operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST(next_poll_at,clock_timestamp()+$2*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1")
                        .bind(id).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
                }
                QrState::Expired => {
                    terminalize(&mut tx, id, "expired").await?;
                    current.status = "expired".into();
                    stage = None;
                }
                QrState::Confirmed => {
                    let cookie = poll.session.ok_or_else(credential_error)?;
                    let revision = account
                        .revision
                        .checked_add(1)
                        .ok_or_else(credential_error)?;
                    let updated_scope = AccountScope {
                        revision,
                        ..account
                    };
                    let cipher = encrypt(&scope::credential_plaintext(
                        updated_scope,
                        cookie_value(&cookie),
                    ))
                    .map_err(|_| credential_error())?;
                    let stored = sqlx::query("UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=NULL,revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND playback_login_allowed($5,$6) AND EXISTS(SELECT 1 FROM platform_login_requests WHERE id=$7 AND user_id=$5 AND auth_login_hash=$6 AND account_id=$1 AND account_revision=$4 AND status='pending' AND expires_at>clock_timestamp() AND operation_nonce=$8 AND operation_expires_at>clock_timestamp())")
                        .bind(account.account_id).bind(cipher).bind(revision).bind(account.revision).bind(user.id).bind(&login).bind(id).bind(nonce).execute(&mut *tx).await?;
                    if stored.rows_affected() != 1 {
                        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
                    }
                    renewal::store_grant(
                        encrypt,
                        &mut tx,
                        updated_scope,
                        &login,
                        poll.refresh_token,
                        request.consent_to_renew,
                    )
                    .await?;
                    terminalize(&mut tx, id, "confirmed").await?;
                    current.status = "confirmed".into();
                    // Clear any other requests before a credential can be reused.
                    fail_pending(&mut tx, user.id).await?;
                    stage = None;
                }
            },
            Err(error) => {
                // This read-only poll can be retried for the same original key.
                // Retain its immutable overall deadline and release this claim.
                sqlx::query("UPDATE platform_login_requests SET operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST(next_poll_at,clock_timestamp()+$2*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1")
                    .bind(id).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
                tx.commit().await?;
                return Err(upstream_error("qr_poll", error));
            }
        }
    }
    let current = lock_request(&mut tx, id, user.id, &login).await?;
    let value = qr_response(&current, None, stage);
    tx.commit().await?;
    Ok(value)
}

pub(super) async fn cancel_login(
    context: RequestContext<'_>,
    id: Uuid,
    headers: HeaderMap,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, &headers, true, false).await?;
    let login = login_hash(&headers)?;
    account_security::rate_limit(db, "platform-login-cancel", &user.id.to_string(), 30, 600)
        .await?;
    let mut tx = db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    if id.is_nil() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_login_request_invalid",
        ));
    }
    let account = account_scope(&lock_account(&mut tx, user.id).await?);
    // A stable local tombstone fences a reordered start even if its response
    // never reached the browser. Cancellation never generates a remote QR.
    sqlx::query("INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,expires_at,next_poll_at,account_id,account_revision) VALUES($1,$2,$3,'bilibili','failed',clock_timestamp()+$4*interval '1 second',clock_timestamp(),$5,$6) ON CONFLICT(id) DO NOTHING")
        .bind(id).bind(user.id).bind(&login).bind(QR_LIFETIME_SECONDS).bind(account.account_id).bind(account.revision).execute(&mut *tx).await?;
    let mut request = lock_request(&mut tx, id, user.id, &login).await?;
    if request.status == "pending" {
        terminalize(&mut tx, id, "failed").await?;
        request.status = "failed".into();
    }
    let value = qr_response(&request, None, None);
    tx.commit().await?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn pending_request() -> LoginRequest {
        LoginRequest {
            scope: scope::QrScope {
                account: AccountScope {
                    user_id: Uuid::from_u128(1),
                    account_id: Uuid::from_u128(2),
                    revision: 3,
                },
                request_id: Uuid::from_u128(4),
                login_hash: "synthetic-login".into(),
            },
            status: "pending".into(),
            qr_key_encrypted: Some("synthetic-key-cipher".into()),
            qr_payload_encrypted: Some("synthetic-payload-cipher".into()),
            expires_at_ms: 180000,
            next_poll_at_ms: 3000,
            server_time_ms: 1000,
            live: true,
            operation_live: true,
            operation_nonce: Some(Uuid::from_u128(5)),
            ready_to_poll: false,
            consent_to_renew: true,
        }
    }

    async fn closed_pool() -> sqlx::PgPool {
        // Close before passing the pool to any operation. Even a regressed
        // SQL path cannot open a database connection or socket in these tests.
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
    fn start_ingress_retains_required_consent_and_optional_renewal_shape() {
        let id = Uuid::from_u128(7);
        let parsed = serde_json::from_value::<StartLogin>(
            json!({"idempotency_key":id,"consent_to_store":true}),
        )
        .unwrap();
        assert_eq!(parsed.idempotency_key, id);
        assert!(parsed.consent_to_store);
        assert!(!parsed.consent_to_renew);
        // Deserialization never adds the operation's post-authentication checks.
        let parsed = serde_json::from_value::<StartLogin>(json!({
            "idempotency_key":Uuid::nil(),"consent_to_store":false,"consent_to_renew":true,
        }))
        .unwrap();
        assert!(parsed.idempotency_key.is_nil());
        assert!(!parsed.consent_to_store);
        assert!(parsed.consent_to_renew);
        for value in [
            json!({"idempotency_key":id}),
            json!({"consent_to_store":true}),
            json!({"idempotency_key":"not-a-uuid","consent_to_store":true}),
            json!({"idempotency_key":id,"consent_to_store":true,"consent_to_renew":"true"}),
            json!({"idempotency_key":id,"consent_to_store":true,"cookie":"synthetic"}),
        ] {
            assert!(serde_json::from_value::<StartLogin>(value).is_err());
        }
    }

    #[test]
    fn qr_projection_preserves_complete_dto_and_exact_payload_gate() {
        for status in ["pending", "failed", "expired", "confirmed"] {
            for live in [false, true] {
                for include_payload in [false, true] {
                    let mut request = pending_request();
                    request.status = status.into();
                    request.live = live;
                    let calls = AtomicUsize::new(0);
                    let decrypt = |cipher: &str| -> anyhow::Result<Value> {
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(cipher, "synthetic-payload-cipher");
                        Ok(scope::qr_plaintext(
                            &request.scope,
                            QR_PAYLOAD_PURPOSE,
                            "synthetic-payload",
                        ))
                    };
                    let eligible = include_payload && status == "pending" && live;
                    assert_eq!(
                        qr_response(
                            &request,
                            if include_payload {
                                qr_payload(&decrypt, &request).unwrap()
                            } else {
                                None
                            },
                            Some("waiting"),
                        ),
                        json!({
                            "id":request.scope.request_id,"provider":"bilibili","status":status,
                            "stage":if status == "pending" {Some("waiting")} else {None},
                            "qr_payload":if eligible {Some("synthetic-payload")} else {None},
                            "expires_at":180000,"next_poll_at":3000,"server_time":1000,
                        })
                    );
                    assert_eq!(calls.load(Ordering::SeqCst), usize::from(eligible));
                }
            }
        }
        let mut request = pending_request();
        request.qr_payload_encrypted = None;
        let decrypt = |_: &str| -> anyhow::Result<Value> { panic!("absent payload") };
        assert!(qr_payload(&decrypt, &request).unwrap().is_none());
    }

    #[test]
    fn qr_projection_rejects_corrupt_cipher_and_every_envelope_binding() {
        let request = pending_request();
        let decrypt = |_: &str| -> anyhow::Result<Value> {
            anyhow::bail!("synthetic-private-decryption-detail")
        };
        failure(
            qr_payload(&decrypt, &request).unwrap_err(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "platform_credential_invalid",
        );
        let envelope = scope::qr_plaintext(&request.scope, QR_PAYLOAD_PURPOSE, "synthetic");
        for (field, replacement) in [
            ("version", json!(2)),
            ("purpose", json!(QR_KEY_PURPOSE)),
            ("provider", json!("youtube")),
            ("user_id", json!(Uuid::from_u128(99))),
            ("account_id", json!(Uuid::from_u128(99))),
            ("account_revision", json!("4")),
            ("account_revision", json!(3)),
            ("request_id", json!(Uuid::from_u128(99))),
            ("auth_login_hash", json!("different-login")),
            ("value", json!(false)),
            ("unexpected", json!("extra")),
        ] {
            let mut changed = envelope.clone();
            changed[field] = replacement;
            let decrypt = |_: &str| -> anyhow::Result<Value> { Ok(changed.clone()) };
            failure(
                qr_payload(&decrypt, &request).unwrap_err(),
                StatusCode::INTERNAL_SERVER_ERROR,
                "platform_credential_invalid",
            );
        }
    }

    #[test]
    fn named_start_outcomes_keep_replay_and_created_distinct_without_changing_value() {
        let value = json!({"id":Uuid::from_u128(7),"status":"pending"});
        match StartLoginOutcome::Replay(value.clone()) {
            StartLoginOutcome::Replay(actual) => assert_eq!(actual, value),
            StartLoginOutcome::Created(_) => panic!("replay became created"),
        }
        match StartLoginOutcome::Created(value.clone()) {
            StartLoginOutcome::Created(actual) => assert_eq!(actual, value),
            StartLoginOutcome::Replay(_) => panic!("created became replay"),
        }
    }

    #[tokio::test]
    async fn missing_login_precedes_invalid_input_and_all_cipher_callbacks() {
        let db = closed_pool().await;
        let http = PlatformHttp::new();
        let calls = AtomicUsize::new(0);
        let decrypt = |_: &str| -> anyhow::Result<Value> {
            calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("must remain unused")
        };
        let encrypt = |_: &Value| -> anyhow::Result<String> {
            calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("must remain unused")
        };
        let errors = [
            start_login(
                context(&db),
                &http,
                &decrypt,
                &encrypt,
                HeaderMap::new(),
                StartLogin {
                    idempotency_key: Uuid::nil(),
                    consent_to_store: false,
                    consent_to_renew: true,
                },
            )
            .await
            .unwrap_err(),
            poll_login(
                context(&db),
                &http,
                &decrypt,
                &encrypt,
                Uuid::nil(),
                HeaderMap::new(),
            )
            .await
            .unwrap_err(),
            cancel_login(context(&db), Uuid::nil(), HeaderMap::new())
                .await
                .unwrap_err(),
        ];
        for error in errors {
            failure(error, StatusCode::UNAUTHORIZED, "login_required");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn closed_authentication_storage_precedes_origin_consent_id_and_cipher_work() {
        let db = closed_pool().await;
        let http = PlatformHttp::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "rainsync_session=synthetic-session-only".parse().unwrap(),
        );
        let decrypt = |_: &str| -> anyhow::Result<Value> { panic!("storage failure") };
        let encrypt = |_: &Value| -> anyhow::Result<String> { panic!("storage failure") };
        let errors = [
            start_login(
                context(&db),
                &http,
                &decrypt,
                &encrypt,
                headers.clone(),
                StartLogin {
                    idempotency_key: Uuid::nil(),
                    consent_to_store: false,
                    consent_to_renew: true,
                },
            )
            .await
            .unwrap_err(),
            poll_login(
                context(&db),
                &http,
                &decrypt,
                &encrypt,
                Uuid::nil(),
                headers.clone(),
            )
            .await
            .unwrap_err(),
            cancel_login(context(&db), Uuid::nil(), headers)
                .await
                .unwrap_err(),
        ];
        for error in errors {
            failure(error, StatusCode::INTERNAL_SERVER_ERROR, "database_error");
        }
    }
}
