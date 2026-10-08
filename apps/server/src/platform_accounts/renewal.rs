//! Exact-owner/login/revision Bilibili refresh grants. No automatic opt-in.
use super::*;
use providers::platform::bilibili::renewal::{self, RefreshToken, Transport};
const PURPOSE: &str = "bilibili_refresh_token_v1";
fn envelope(scope: AccountScope, login: &str, token: &RefreshToken) -> Value {
    json!({"version":1,"purpose":PURPOSE,"provider":"bilibili","user_id":scope.user_id,"account_id":scope.account_id,"revision":scope.revision.to_string(),"auth_login_hash":login,"token":token.expose_for_storage()})
}
fn token_from(scope: AccountScope, login: &str, value: Value) -> Result<RefreshToken> {
    let revision = scope.revision.to_string();
    if value.as_object().is_none_or(|v| v.len() != 8)
        || value["version"] != 1
        || value["purpose"] != PURPOSE
        || value["provider"] != "bilibili"
        || value["user_id"] != scope.user_id.to_string()
        || value["account_id"] != scope.account_id.to_string()
        || value["revision"].as_str() != Some(revision.as_str())
        || value["auth_login_hash"] != login
    {
        return Err(credential_error());
    }
    RefreshToken::from_secret(value["token"].as_str().ok_or_else(credential_error)?)
        .map_err(|_| credential_error())
}
pub(super) async fn store_grant(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    scope: AccountScope,
    login: &str,
    token: Option<RefreshToken>,
    consent: bool,
) -> Result<()> {
    if !consent {
        return Ok(());
    }
    let Some(token) = token else {
        return Ok(());
    };
    let cipher = app
        .encrypt(&envelope(scope, login, &token))
        .map_err(|_| credential_error())?;
    super::maintenance::phase(sqlx::query("INSERT INTO platform_account_renewals(account_id,credential_revision,consent_login_hash,refresh_encrypted,state,next_refresh_at) VALUES($1,$2,$3,$4,'scheduled',clock_timestamp()+interval '1 day')")
        .bind(scope.account_id).bind(scope.revision).bind(login).bind(cipher).execute(&mut **tx)).await?;
    Ok(())
}
fn public_status(account: Value, row: Option<&PgRow>) -> Value {
    json!({"account":account,"method":"web_cookie_refresh","supported":true,"enabled":row.is_some_and(|r|matches!(r.get::<String,_>("state").as_str(),"scheduled"|"running")),
        "state":row.map(|r|r.get::<String,_>("state")).unwrap_or_else(||"disabled".to_owned()),
        "next_refresh_at":row.and_then(|r|r.get::<Option<i64>,_>("next_refresh_at_ms")),
        "enable_requires":"new_consented_qr_login"})
}
pub async fn status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let user = auth(&app, &headers, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let account = super::maintenance::phase(
        sqlx::query(ACCOUNT_SELECT)
            .bind(user.id)
            .fetch_optional(&mut *tx),
    )
    .await?;
    // Renewal is scoped to the originating login. A different browser login
    // may inspect account state, but cannot inherit background renewal consent.
    let row=super::maintenance::phase(sqlx::query("SELECT r.state,floor(extract(epoch FROM r.next_refresh_at)*1000)::bigint AS next_refresh_at_ms FROM platform_account_renewals r JOIN platform_accounts a ON a.id=r.account_id AND a.revision=r.credential_revision WHERE a.user_id=$1 AND a.provider='bilibili' AND a.state='connected' AND r.consent_login_hash=$2 AND playback_login_allowed($1,$2)")
        .bind(user.id).bind(&login).fetch_optional(&mut *tx)).await?;
    super::maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let value = public_status(status_value(account.as_ref()), row.as_ref());
    super::maintenance::commit(tx).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preference {
    expected_revision: Value,
    enabled: bool,
}
pub async fn set_preference(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Preference>,
) -> Result<Response> {
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    if body.enabled {
        return Err(err(
            StatusCode::CONFLICT,
            "platform_renewal_new_consented_qr_required",
        ));
    }
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let row = super::maintenance::phase(lock_account(&mut tx, user.id)).await?;
    if expected != Some(row.get("revision")) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    super::maintenance::phase(
        sqlx::query("DELETE FROM platform_account_renewals WHERE account_id=$1")
            .bind(row.get::<Uuid, _>("id"))
            .execute(&mut *tx),
    )
    .await?;
    super::maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let value = public_status(status_value(Some(&row)), None);
    super::maintenance::commit(tx).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}
/// One bounded pass. Caller supplies shutdown-aware cadence; nothing runs at
/// import/startup and no account can be renewed without a fresh QR opt-in.
pub(super) async fn refresh_due_inner(
    app: &App,
    closing: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let mut recovery = super::maintenance::begin(app).await?;
    super::maintenance::phase(sqlx::query("DELETE FROM platform_account_renewals r USING platform_accounts a WHERE a.id=r.account_id AND (a.revision<>r.credential_revision OR a.state<>'connected' OR NOT playback_login_allowed(a.user_id,r.consent_login_hash))").execute(&mut *recovery)).await?;
    // A process/response loss after mutation is never retried with old material.
    super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state='uncertain',operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE state='running' AND operation_expires_at<=clock_timestamp()").execute(&mut *recovery)).await?;
    let users:Vec<Uuid>=super::maintenance::phase(sqlx::query_scalar("SELECT a.user_id FROM platform_account_renewals r JOIN platform_accounts a ON a.id=r.account_id AND a.revision=r.credential_revision WHERE r.state='scheduled' AND r.next_refresh_at<=clock_timestamp() ORDER BY r.next_refresh_at LIMIT 16").fetch_all(&mut *recovery)).await?;
    super::maintenance::commit(recovery).await?;
    let mut failure = None;
    for user in users {
        if closing.load(std::sync::atomic::Ordering::Acquire) {
            break;
        }
        if let Err(error) = refresh_one(app, user).await {
            tracing::warn!(
                event = "platform_renewal_account_failed",
                provider = "bilibili"
            );
            if failure
                .as_ref()
                .is_none_or(|e: &Error| e.1 != "platform_renewal_durability_unconfirmed")
            {
                failure = Some(error);
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}
async fn refresh_one(app: &App, user: Uuid) -> Result<()> {
    let mut tx = super::maintenance::begin(app).await?;
    let login:Option<String>=super::maintenance::phase(sqlx::query_scalar("SELECT r.consent_login_hash FROM platform_account_renewals r JOIN platform_accounts a ON a.id=r.account_id WHERE a.user_id=$1 AND a.provider='bilibili' AND r.state='scheduled' AND r.next_refresh_at<=clock_timestamp()").bind(user).fetch_optional(&mut *tx)).await?;
    let Some(login) = login else {
        return Ok(());
    };
    super::maintenance::phase(guard_login(&mut tx, user, &login)).await?;
    let account = super::maintenance::phase(lock_account(&mut tx, user)).await?;
    let scope = account_scope(&account);
    let row=super::maintenance::phase(sqlx::query("SELECT refresh_encrypted FROM platform_account_renewals WHERE account_id=$1 AND credential_revision=$2 AND consent_login_hash=$3 AND state='scheduled' AND next_refresh_at<=clock_timestamp() FOR UPDATE")
        .bind(scope.account_id).bind(scope.revision).bind(&login).fetch_optional(&mut *tx)).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let token = token_from(
        scope,
        &login,
        app.decrypt(&row.get::<String, _>("refresh_encrypted"))
            .map_err(|_| credential_error())?,
    )?;
    let cookie = cookie_from_value(
        scope::credential_cookies(
            scope,
            app.decrypt(&account.get::<String, _>("credential_encrypted"))
                .map_err(|_| credential_error())?,
        )
        .ok_or_else(credential_error)?,
    )?;
    let nonce = Uuid::new_v4();
    super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state='running',operation_nonce=$2,operation_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() WHERE account_id=$1")
        .bind(scope.account_id).bind(nonce).execute(&mut *tx)).await?;
    super::maintenance::phase(guard_login_live(&mut tx, user, &login)).await?;
    let recovery_deadline = Deadline::now() + Duration::from_secs(180);
    let outcome:Result<()> = async {
    super::maintenance::commit(tx).await?;
    let deadline=Deadline::now()+Duration::from_secs(20);
    let info=app.platform_http.send(renewal::info_request(&cookie).map_err(|_|credential_error())?,deadline).await;
    let needs=info.and_then(|r|{if r.status!=200{return Err(providers::platform::bilibili::Error::Status(r.status));}renewal::parse_info(&r.body)});
    if !matches!(needs,Ok(true)) {
        let mut tx=super::maintenance::begin(app).await?;super::maintenance::phase(guard_login(&mut tx,user,&login)).await?;let current=super::maintenance::phase(lock_account(&mut tx,user)).await?;
        if account_scope(&current)!=scope{return Ok(());}
        if matches!(needs,Err(providers::platform::bilibili::Error::Restricted("authentication_required"))) {
            super::maintenance::phase(sqlx::query("UPDATE platform_accounts SET state='expired',credential_encrypted=NULL,credential_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND playback_login_allowed(user_id,$3)")
                .bind(scope.account_id).bind(scope.revision).bind(&login).execute(&mut *tx)).await?;
            super::maintenance::phase(fail_pending(&mut tx,user)).await?;super::maintenance::commit(tx).await?;return Ok(());
        }
        let state="scheduled";
        super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state=$4,operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=clock_timestamp()+interval '1 day',updated_at=clock_timestamp() WHERE account_id=$1 AND credential_revision=$2 AND operation_nonce=$3")
            .bind(scope.account_id).bind(scope.revision).bind(nonce).bind(state).execute(&mut *tx)).await?;super::maintenance::commit(tx).await?;return Ok(());
    }
    // A cookie label alone does not establish the actual SESSDATA owner.
    let old_identity=Client::new(app.platform_http,Some(cookie.clone()))
        .check_login(Deadline::now()+Duration::from_secs(20)).await;
    if !matches!(old_identity,Ok(LoginValidity::Verified)) {
        let mut tx=super::maintenance::begin(app).await?;super::maintenance::phase(guard_login(&mut tx,user,&login)).await?;
        let current=super::maintenance::phase(lock_account(&mut tx,user)).await?;
        if account_scope(&current)!=scope{return Ok(());}
        if matches!(old_identity,Ok(LoginValidity::Invalid)) {
            super::maintenance::phase(sqlx::query("UPDATE platform_accounts SET state='expired',credential_encrypted=NULL,credential_expires_at=NULL,revision=revision+1 WHERE id=$1 AND revision=$2 AND playback_login_allowed(user_id,$3)").bind(scope.account_id).bind(scope.revision).bind(&login).execute(&mut *tx)).await?;
            super::maintenance::phase(fail_pending(&mut tx,user)).await?;
        }else{
            super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state='scheduled',operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=clock_timestamp()+interval '1 day' WHERE account_id=$1 AND credential_revision=$2 AND operation_nonce=$3").bind(scope.account_id).bind(scope.revision).bind(nonce).execute(&mut *tx)).await?;
        }
        super::maintenance::commit(tx).await?;return Ok(());
    }
    // Reacquire authority immediately before the potentially rotating call.
    let mut tx=super::maintenance::begin(app).await?;super::maintenance::phase(guard_login(&mut tx,user,&login)).await?;let current=super::maintenance::phase(lock_account(&mut tx,user)).await?;
    let valid:bool=super::maintenance::phase(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform_account_renewals WHERE account_id=$1 AND credential_revision=$2 AND operation_nonce=$3 AND state='running' AND operation_expires_at>clock_timestamp())")
        .bind(scope.account_id).bind(scope.revision).bind(nonce).fetch_one(&mut *tx)).await?;
    if account_scope(&current)!=scope||!valid{return Ok(());}super::maintenance::phase(guard_login_live(&mut tx,user,&login)).await?;super::maintenance::commit(tx).await?;
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|credential_error())?.as_millis() as i64;
    let result=renewal::prepare(&app.platform_http,&cookie,&token,now,Deadline::now()+Duration::from_secs(40)).await;
    let result=match result {
        Ok(renewed)=>match Client::new(app.platform_http,Some(renewed.cookie.clone()))
            .check_login(Deadline::now()+Duration::from_secs(20)).await {
                Ok(LoginValidity::Verified)=>Ok(renewed),
                Ok(LoginValidity::Invalid)=>Err(providers::platform::bilibili::Error::InvalidResponse("refresh_actual_identity_mismatch")),
                Err(error)=>Err(error),
            },
        Err(error)=>Err(error),
    };
    let renewed=match result {Ok(value)=>value,Err(_)=>{retire_bili(app,scope.account_id,nonce).await?;return Ok(());}};
    let next=AccountScope {revision:scope.revision.checked_add(1).ok_or_else(credential_error)?,..scope};
    // Retain the rotated result while retrying local publication only. Never
    // repeat cookie/refresh or confirm/refresh after an uncertain response.
    let ready=loop {match publish_bili(app,scope,next,&login,nonce,&renewed).await {
        Ok(ready)=>break ready,Err(error)=>{if Deadline::now()>=recovery_deadline{return Err(error);}tokio::time::sleep(Duration::from_secs(1)).await;}
    }};
    if !ready{return Ok(());}
    // Re-fence immediately before the one consuming confirmation request.
    let ready=loop {match publish_bili(app,scope,next,&login,nonce,&renewed).await {
        Ok(ready)=>break ready,Err(error)=>{if Deadline::now()>=recovery_deadline{return Err(error);}tokio::time::sleep(Duration::from_secs(1)).await;}
    }};
    if !ready{return Ok(());}
    let confirmed=renewal::confirm(&app.platform_http,&renewed.cookie,&token,Deadline::now()+Duration::from_secs(20)).await.is_ok();
    loop {match complete_bili(app,next,&login,nonce,confirmed).await {
        Ok(())=>return Ok(()),Err(error)=>{if Deadline::now()>=recovery_deadline{return Err(error);}tokio::time::sleep(Duration::from_secs(1)).await;}
    }}
    }.await;
    if outcome.is_err() {
        let recovery:Result<()> = async {
            let mut tx=super::maintenance::begin(app).await?;
            super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state='uncertain',operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE account_id=$1 AND operation_nonce=$2").bind(scope.account_id).bind(nonce).execute(&mut *tx)).await?;
            super::maintenance::commit(tx).await
        }.await;
        if recovery.is_err() {
            return Err(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "platform_renewal_durability_unconfirmed",
            ));
        }
    }
    outcome
}
async fn retire_bili(app: &App, account: Uuid, nonce: Uuid) -> Result<()> {
    let mut tx = super::maintenance::begin(app).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state='uncertain',operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE account_id=$1 AND operation_nonce=$2").bind(account).bind(nonce).execute(&mut *tx)).await?;
    super::maintenance::commit(tx).await
}
async fn publish_bili(
    app: &App,
    old: AccountScope,
    next: AccountScope,
    login: &str,
    nonce: Uuid,
    renewed: &renewal::Renewed,
) -> Result<bool> {
    let mut tx = super::maintenance::begin(app).await?;
    if let Err(error) = super::maintenance::phase(guard_login(&mut tx, old.user_id, login)).await {
        if !super::maintenance::authority_expired(&error) {
            return Err(error);
        }
        super::maintenance::phase(sqlx::query("DELETE FROM platform_account_renewals WHERE account_id=$1 AND operation_nonce=$2 AND consent_login_hash=$3").bind(old.account_id).bind(nonce).bind(login).execute(&mut *tx)).await?;
        super::maintenance::commit(tx).await?;
        return Ok(false);
    }
    let current = super::maintenance::phase(lock_account(&mut tx, old.user_id)).await?;
    let current_scope = account_scope(&current);
    let grant=super::maintenance::phase(sqlx::query("SELECT refresh_encrypted,credential_revision,operation_expires_at>clock_timestamp() AS live FROM platform_account_renewals WHERE account_id=$1 AND operation_nonce=$2 AND consent_login_hash=$3 AND state='running' FOR UPDATE").bind(old.account_id).bind(nonce).bind(login).fetch_optional(&mut *tx)).await?;
    let Some(grant) = grant else {
        super::maintenance::commit(tx).await?;
        return Ok(false);
    };
    if !grant.get::<bool, _>("live") {
        super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state='uncertain',operation_nonce=NULL,operation_expires_at=NULL WHERE account_id=$1 AND operation_nonce=$2").bind(old.account_id).bind(nonce).execute(&mut *tx)).await?;
        super::maintenance::commit(tx).await?;
        return Ok(false);
    }
    if current_scope == next && grant.get::<i64, _>("credential_revision") == next.revision {
        // Exact-result reconciliation after COMMIT transport loss.
        let actual_cookie = cookie_from_value(
            scope::credential_cookies(
                next,
                app.decrypt(&current.get::<String, _>("credential_encrypted"))
                    .map_err(|_| credential_error())?,
            )
            .ok_or_else(credential_error)?,
        )?;
        let actual_token = token_from(
            next,
            login,
            app.decrypt(&grant.get::<String, _>("refresh_encrypted"))
                .map_err(|_| credential_error())?,
        )?;
        if actual_cookie.expose_for_storage() != renewed.cookie.expose_for_storage()
            || actual_token.expose_for_storage() != renewed.token.expose_for_storage()
        {
            return Err(credential_error());
        }
        // This branch is also the fence immediately before confirmation.
        // Reconciliation proves custody, but lock waits may outlive the login.
        super::maintenance::phase(guard_login_live(&mut tx, old.user_id, login)).await?;
        super::maintenance::commit(tx).await?;
        return Ok(true);
    }
    if current_scope != old
        || grant.get::<i64, _>("credential_revision") != old.revision
        || current.get::<String, _>("state") != "connected"
    {
        super::maintenance::commit(tx).await?;
        return Ok(false);
    }
    let cookie_cipher = app
        .encrypt(&scope::credential_plaintext(
            next,
            cookie_value(&renewed.cookie),
        ))
        .map_err(|_| credential_error())?;
    let token_cipher = app
        .encrypt(&envelope(next, login, &renewed.token))
        .map_err(|_| credential_error())?;
    super::maintenance::phase(guard_login_live(&mut tx, old.user_id, login)).await?;
    let changed=super::maintenance::phase(sqlx::query("UPDATE platform_accounts SET credential_encrypted=$2,revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND state='connected' AND playback_login_allowed(user_id,$5)").bind(old.account_id).bind(cookie_cipher).bind(next.revision).bind(old.revision).bind(login).execute(&mut *tx)).await?;
    if changed.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    super::maintenance::phase(sqlx::query("INSERT INTO platform_account_renewals(account_id,credential_revision,consent_login_hash,refresh_encrypted,state,operation_nonce,operation_expires_at,next_refresh_at) VALUES($1,$2,$3,$4,'running',$5,clock_timestamp()+interval '60 seconds',clock_timestamp()+interval '1 day')").bind(next.account_id).bind(next.revision).bind(login).bind(token_cipher).bind(nonce).execute(&mut *tx)).await?;
    super::maintenance::phase(fail_pending(&mut tx, old.user_id)).await?;
    super::maintenance::commit(tx).await?;
    Ok(true)
}
async fn complete_bili(
    app: &App,
    next: AccountScope,
    login: &str,
    nonce: Uuid,
    confirmed: bool,
) -> Result<()> {
    let mut tx = super::maintenance::begin(app).await?;
    super::maintenance::phase(sqlx::query("DELETE FROM platform_account_renewals r WHERE account_id=$1 AND credential_revision=$2 AND operation_nonce=$3 AND consent_login_hash=$4 AND NOT EXISTS(SELECT 1 FROM platform_accounts a WHERE a.id=r.account_id AND a.revision=r.credential_revision AND a.state='connected' AND playback_login_allowed(a.user_id,$4))").bind(next.account_id).bind(next.revision).bind(nonce).bind(login).execute(&mut *tx)).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_account_renewals SET state=$4,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE account_id=$1 AND credential_revision=$2 AND operation_nonce=$3").bind(next.account_id).bind(next.revision).bind(nonce).bind(if confirmed{"scheduled"}else{"uncertain"}).execute(&mut *tx)).await?;
    super::maintenance::commit(tx).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_envelope_requires_owner_revision_login_and_purpose() {
        let s = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        let t = RefreshToken::from_secret("fixture-refresh-token").unwrap();
        let v = envelope(s, "fixture-login", &t);
        assert!(token_from(s, "fixture-login", v.clone()).is_ok());
        for (key, value) in [
            ("user_id", json!(Uuid::from_u128(99))),
            ("revision", json!("4")),
            ("revision", json!(3)),
            ("revision", json!("03")),
            ("auth_login_hash", json!("other-login")),
            ("purpose", json!("other-purpose")),
        ] {
            let mut changed = v.clone();
            changed[key] = value;
            assert!(token_from(s, "fixture-login", changed).is_err());
        }
    }
}
