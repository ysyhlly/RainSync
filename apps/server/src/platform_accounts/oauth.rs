//! Optional approved-app OAuth. Its tokens never enter platform_accounts or
//! native playback grants. Every operation is owner/login/revision/config-bound.
use super::*;
use axum::http::HeaderValue;
use providers::platform::oauth::{self as provider, Config, Provider, QrState, Tokens, Transport};
use sha2::{Digest, Sha256};
const ACCOUNT: &str = "SELECT *,floor(extract(epoch FROM access_expires_at)*1000)::bigint AS access_ms,floor(extract(epoch FROM refresh_expires_at)*1000)::bigint AS refresh_ms,floor(extract(epoch FROM next_refresh_at)*1000)::bigint AS next_refresh_ms,access_expires_at>clock_timestamp() AS access_live,refresh_expires_at>clock_timestamp() AS refresh_live FROM platform_oauth_accounts WHERE user_id=$1 AND provider=$2";
const REQUEST: &str = "SELECT *,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms,floor(extract(epoch FROM next_poll_at)*1000)::bigint AS poll_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms,expires_at>clock_timestamp() AS live,COALESCE(operation_expires_at>clock_timestamp(),false) AS operation_live,next_poll_at<=clock_timestamp() AS poll_ready FROM platform_oauth_requests WHERE id=$1";
fn parse_provider(value: &str) -> Result<Provider> {
    Provider::parse(value).map_err(|_| err(StatusCode::BAD_REQUEST, "native_platform_invalid"))
}
fn configured(app: &App, p: Provider) -> Result<&Config> {
    app.platform_oauth.config(p).ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "platform_oauth_application_configuration_required",
        )
    })
}
fn hash(value: &str) -> String {
    Sha256::digest(value)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn random() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn scope(row: &PgRow) -> AccountScope {
    AccountScope {
        user_id: row.get("user_id"),
        account_id: row.get("id"),
        revision: row.get("revision"),
    }
}
fn token_envelope(s: AccountScope, p: Provider, binding: &str, tokens: &Tokens) -> Value {
    json!({"version":1,"purpose":"platform_oauth_tokens_v1","provider":p.name(),"user_id":s.user_id,"account_id":s.account_id,"revision":s.revision.to_string(),"config_binding":binding,"tokens":tokens.storage_value()})
}
fn token_from(s: AccountScope, p: Provider, binding: &str, v: Value) -> Result<Tokens> {
    let revision = s.revision.to_string();
    if v.as_object().is_none_or(|v| v.len() != 8)
        || v["version"] != 1
        || v["purpose"] != "platform_oauth_tokens_v1"
        || v["provider"] != p.name()
        || v["user_id"] != s.user_id.to_string()
        || v["account_id"] != s.account_id.to_string()
        || v["revision"].as_str() != Some(revision.as_str())
        || v["config_binding"] != binding
    {
        return Err(credential_error());
    }
    Tokens::from_storage(&v["tokens"]).map_err(|_| credential_error())
}
fn request_envelope(row: &PgRow, values: Value) -> Value {
    json!({"version":1,"purpose":"platform_oauth_request_v1","request_id":row.get::<Uuid,_>("id"),"user_id":row.get::<Uuid,_>("user_id"),"provider":row.get::<String,_>("provider"),"account_id":row.get::<Uuid,_>("account_id"),"revision":row.get::<i64,_>("account_revision").to_string(),"auth_login_hash":row.get::<String,_>("auth_login_hash"),"config_binding":row.get::<String,_>("config_binding"),"values":values})
}
fn request_values(app: &App, row: &PgRow) -> Result<Value> {
    let cipher: Option<String> = row.get("secret_encrypted");
    let v = app
        .decrypt(cipher.as_deref().ok_or_else(credential_error)?)
        .map_err(|_| credential_error())?;
    let expected = request_envelope(row, Value::Null);
    let object = v.as_object().ok_or_else(credential_error)?;
    if object.len() != 10
        || expected
            .as_object()
            .unwrap()
            .iter()
            .any(|(k, x)| k != "values" && object.get(k) != Some(x))
    {
        return Err(credential_error());
    }
    Ok(v["values"].clone())
}
async fn lock_account(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    p: Provider,
) -> Result<(PgRow, bool)> {
    let inserted:Option<Uuid>=super::maintenance::phase(sqlx::query_scalar("INSERT INTO platform_oauth_accounts(id,user_id,provider) VALUES($1,$2,$3) ON CONFLICT(user_id,provider) DO NOTHING RETURNING id")
        .bind(Uuid::new_v4()).bind(user).bind(p.name()).fetch_optional(&mut **tx)).await?;
    super::maintenance::phase(
        sqlx::query(
            "SELECT id FROM platform_oauth_accounts WHERE user_id=$1 AND provider=$2 FOR UPDATE",
        )
        .bind(user)
        .bind(p.name())
        .fetch_one(&mut **tx),
    )
    .await?;
    Ok((
        super::maintenance::phase(
            sqlx::query(ACCOUNT)
                .bind(user)
                .bind(p.name())
                .fetch_one(&mut **tx),
        )
        .await?,
        inserted.is_some(),
    ))
}
async fn lock_request(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    user: Uuid,
    login: &str,
    p: Provider,
) -> Result<PgRow> {
    super::maintenance::phase(
        sqlx::query("SELECT id FROM platform_oauth_requests WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut **tx),
    )
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "platform_login_request_not_found"))?;
    let row = super::maintenance::phase(sqlx::query(REQUEST).bind(id).fetch_one(&mut **tx)).await?;
    if row.get::<Uuid, _>("user_id") != user
        || row.get::<String, _>("auth_login_hash") != login
        || row.get::<String, _>("provider") != p.name()
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_request_conflict"));
    }
    super::maintenance::phase(guard_login_live(tx, user, login)).await?;
    Ok(row)
}
fn request_matches(row: &PgRow, s: AccountScope, c: &Config) -> bool {
    row.get::<Uuid, _>("account_id") == s.account_id
        && row.get::<i64, _>("account_revision") == s.revision
        && row.get::<String, _>("config_binding") == c.binding()
}
async fn terminal(tx: &mut Transaction<'_, Postgres>, id: Uuid, state: &str) -> Result<()> {
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET status=$2,secret_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='pending'").bind(id).bind(state).execute(&mut **tx)).await?;
    Ok(())
}
fn status_value(app: &App, p: Provider, row: Option<&PgRow>, login: &str) -> Value {
    let config = app.platform_oauth.config(p);
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
        "available":config.is_some(),"missing_prerequisites":app.platform_oauth.missing(p),"authorization_kind":"official_oauth","playback_session":false,
        "authorization_mode":if config.is_some_and(Config::qr_enabled){"qr"}else{"web"},"scopes":row.map(|r|r.get::<Vec<String>,_>("granted_scopes")).unwrap_or_default(),
        "access_expires_at":row.and_then(|r|r.get::<Option<i64>,_>("access_ms")),"refresh_expires_at":row.and_then(|r|r.get::<Option<i64>,_>("refresh_ms")),
        "auto_renew":renewal_owned&&row.is_some_and(|r|r.get("auto_renew")),"renewal_state":if renewal_owned{row.map(|r|r.get::<String,_>("renewal_state")).unwrap_or_else(||"disabled".to_owned())}else{"disabled".to_owned()},
        "next_refresh_at":if renewal_owned{row.and_then(|r|r.get::<Option<i64>,_>("next_refresh_ms"))}else{None}})
}
fn login_value(app: &App, row: &PgRow, stage: Option<&str>) -> Result<Value> {
    let pending = row.get::<String, _>("status") == "pending" && row.get::<bool, _>("live");
    let values = if pending && row.get::<Option<String>, _>("secret_encrypted").is_some() {
        Some(request_values(app, row)?)
    } else {
        None
    };
    Ok(
        json!({"id":row.get::<Uuid,_>("id"),"provider":row.get::<String,_>("provider"),"status":row.get::<String,_>("status"),"mode":row.get::<String,_>("mode"),
        "stage":if pending{stage}else{None},"authorization_url":values.as_ref().and_then(|v|v["authorization_url"].as_str()),"qr_payload":values.as_ref().and_then(|v|v["qr_payload"].as_str()),
        "expires_at":row.get::<i64,_>("expires_ms"),"next_poll_at":row.get::<i64,_>("poll_ms"),"server_time":row.get::<i64,_>("now_ms")}),
    )
}
pub async fn status(
    State(app): State<App>,
    Path(raw): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    // Expired refresh authority is discarded; OAuth and playback rows are separate.
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1 WHERE user_id=$1 AND provider=$2 AND token_encrypted IS NOT NULL AND config_binding IS DISTINCT FROM $3")
        .bind(user.id).bind(p.name()).bind(app.platform_oauth.config(p).map(Config::binding)).execute(&mut *tx)).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND provider=$2 AND token_encrypted IS NOT NULL AND refresh_expires_at<=clock_timestamp()")
        .bind(user.id).bind(p.name()).execute(&mut *tx)).await?;
    let row = super::maintenance::phase(
        sqlx::query(ACCOUNT)
            .bind(user.id)
            .bind(p.name())
            .fetch_optional(&mut *tx),
    )
    .await?;
    super::maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let value = status_value(&app, p, row.as_ref(), &login);
    super::maintenance::commit(tx).await?;
    Ok(registration::private_json(StatusCode::OK, value))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    idempotency_key: Uuid,
    expected_revision: Value,
    consent_to_store: bool,
    consent_to_renew: bool,
}
pub async fn start(
    State(app): State<App>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Start>,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let c = configured(&app, p)?;
    let expected = expected_revision(&body.expected_revision)?;
    if !body.consent_to_store || body.idempotency_key.is_nil() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_storage_consent_required",
        ));
    }
    account_security::rate_limit(
        &app.db,
        "platform-oauth-start",
        &user.id.to_string(),
        10,
        600,
    )
    .await?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, inserted) = lock_account(&mut tx, user.id, p).await?;
    let s = scope(&account);
    let exists: bool = super::maintenance::phase(
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform_oauth_requests WHERE id=$1)")
            .bind(body.idempotency_key)
            .fetch_one(&mut *tx),
    )
    .await?;
    if exists {
        let mut row = lock_request(&mut tx, body.idempotency_key, user.id, &login, p).await?;
        if row.get::<bool, _>("consent_to_renew") != body.consent_to_renew
            || (row.get::<String, _>("status") == "pending" && !request_matches(&row, s, c))
        {
            return Err(err(StatusCode::CONFLICT, "platform_login_request_conflict"));
        }
        if row.get::<String, _>("status") == "pending"
            && (!row.get::<bool, _>("live")
                || (!row.get::<bool, _>("operation_live")
                    && row.get::<Option<String>, _>("secret_encrypted").is_none()))
        {
            terminal(&mut tx, body.idempotency_key, "failed").await?;
            row = lock_request(&mut tx, body.idempotency_key, user.id, &login, p).await?;
        }
        let value = login_value(&app, &row, None)?;
        super::maintenance::commit(tx).await?;
        return Ok(registration::private_json(StatusCode::OK, value));
    }
    if !revision_matches(expected, s.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET status='expired',secret_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL WHERE user_id=$1 AND provider=$2 AND status='pending' AND (expires_at<=clock_timestamp() OR NOT playback_login_allowed(user_id,auth_login_hash))")
        .bind(user.id).bind(p.name()).execute(&mut *tx)).await?;
    let active:bool=super::maintenance::phase(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform_oauth_requests WHERE user_id=$1 AND provider=$2 AND status='pending')").bind(user.id).bind(p.name()).fetch_one(&mut *tx)).await?;
    if active {
        return Err(err(StatusCode::CONFLICT, "platform_login_in_progress"));
    }
    let state = random();
    let ticket = random();
    let nonce = Uuid::new_v4();
    let mode = if c.qr_enabled() { "qr" } else { "web" };
    super::maintenance::phase(sqlx::query("INSERT INTO platform_oauth_requests(id,user_id,provider,auth_login_hash,account_id,account_revision,config_binding,status,mode,state_hash,consent_to_renew,expires_at,next_poll_at,operation_nonce,operation_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,clock_timestamp()+interval '3 minutes',clock_timestamp()+interval '3 seconds',$11,clock_timestamp()+interval '45 seconds')")
        .bind(body.idempotency_key).bind(user.id).bind(p.name()).bind(&login).bind(s.account_id).bind(s.revision).bind(c.binding()).bind(mode).bind(hash(&state)).bind(body.consent_to_renew).bind(nonce).execute(&mut *tx)).await?;
    let row = lock_request(&mut tx, body.idempotency_key, user.id, &login, p).await?;
    let values = json!({"state":state,"ticket":ticket,"poll_token":null,"qr_payload":null,"authorization_url":if mode=="web"{Some(c.authorize_url(&state).map_err(|_|credential_error())?)}else{None}});
    let cipher = app
        .encrypt(&request_envelope(&row, values.clone()))
        .map_err(|_| credential_error())?;
    super::maintenance::phase(
        sqlx::query("UPDATE platform_oauth_requests SET secret_encrypted=$2 WHERE id=$1")
            .bind(body.idempotency_key)
            .bind(cipher)
            .execute(&mut *tx),
    )
    .await?;
    super::maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    super::maintenance::commit(tx).await?;
    let generated = if mode == "qr" {
        Some(
            app.platform_http
                .send(
                    c.generate_qr_request(&state)
                        .map_err(|_| credential_error())?,
                    Deadline::now() + Duration::from_secs(20),
                )
                .await
                .and_then(|v| c.parse_qr(&v, &ticket)),
        )
    } else {
        None
    };
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, _) = lock_account(&mut tx, user.id, p).await?;
    let row = lock_request(&mut tx, body.idempotency_key, user.id, &login, p).await?;
    if row.get::<String, _>("status") != "pending"
        || row.get::<Option<Uuid>, _>("operation_nonce") != Some(nonce)
        || !row.get::<bool, _>("live")
        || !row.get::<bool, _>("operation_live")
        || !request_matches(&row, scope(&account), c)
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    let mut values = values;
    match generated {
        Some(Ok(qr)) => {
            values["qr_payload"] = json!(qr.payload);
            values["poll_token"] = json!(qr.token);
        }
        Some(Err(_)) => {
            terminal(&mut tx, body.idempotency_key, "failed").await?;
            let row = lock_request(&mut tx, body.idempotency_key, user.id, &login, p).await?;
            let value = login_value(&app, &row, None)?;
            super::maintenance::commit(tx).await?;
            return Ok(registration::private_json(StatusCode::OK, value));
        }
        None => {}
    }
    let cipher = app
        .encrypt(&request_envelope(&row, values))
        .map_err(|_| credential_error())?;
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET secret_encrypted=$2,operation_nonce=NULL,operation_expires_at=NULL WHERE id=$1").bind(body.idempotency_key).bind(cipher).execute(&mut *tx)).await?;
    let row = lock_request(&mut tx, body.idempotency_key, user.id, &login, p).await?;
    let value = login_value(&app, &row, Some("waiting"))?;
    super::maintenance::commit(tx).await?;
    Ok(registration::private_json(StatusCode::OK, value))
}
pub async fn read_login(
    State(app): State<App>,
    Path((raw, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, _) = lock_account(&mut tx, user.id, p).await?;
    let mut row = lock_request(&mut tx, id, user.id, &login, p).await?;
    if row.get::<String, _>("status") == "pending"
        && (!row.get::<bool, _>("live")
            || app
                .platform_oauth
                .config(p)
                .is_none_or(|c| !request_matches(&row, scope(&account), c)))
    {
        terminal(&mut tx, id, "expired").await?;
        row = lock_request(&mut tx, id, user.id, &login, p).await?;
    }
    let value = login_value(&app, &row, None)?;
    super::maintenance::commit(tx).await?;
    Ok(registration::private_json(StatusCode::OK, value))
}
pub async fn cancel(
    State(app): State<App>,
    Path((raw, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let binding = app
        .platform_oauth
        .config(p)
        .map(|c| c.binding().to_owned())
        .unwrap_or_else(|| "0".repeat(64));
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, _) = lock_account(&mut tx, user.id, p).await?;
    // A cancel arriving before start makes an immutable failed request tombstone.
    super::maintenance::phase(sqlx::query("INSERT INTO platform_oauth_requests(id,user_id,provider,auth_login_hash,account_id,account_revision,config_binding,status,mode,state_hash,expires_at,next_poll_at) VALUES($1,$2,$3,$4,$5,$6,$7,'failed','web',$8,clock_timestamp()+interval '3 minutes',clock_timestamp()) ON CONFLICT(id) DO NOTHING")
        .bind(id).bind(user.id).bind(p.name()).bind(&login).bind(account.get::<Uuid,_>("id")).bind(account.get::<i64,_>("revision")).bind(&binding).bind(hash(&random())).execute(&mut *tx)).await?;
    let row = lock_request(&mut tx, id, user.id, &login, p).await?;
    if row.get::<String, _>("status") == "pending" {
        terminal(&mut tx, id, "failed").await?;
    }
    let row = lock_request(&mut tx, id, user.id, &login, p).await?;
    let value = login_value(&app, &row, None)?;
    super::maintenance::commit(tx).await?;
    Ok(registration::private_json(StatusCode::OK, value))
}
pub async fn poll(
    State(app): State<App>,
    Path((raw, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let c = configured(&app, p)?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, _) = lock_account(&mut tx, user.id, p).await?;
    let mut row = lock_request(&mut tx, id, user.id, &login, p).await?;
    if row.get::<String, _>("status") != "pending" {
        let value = login_value(&app, &row, None)?;
        super::maintenance::commit(tx).await?;
        return Ok(registration::private_json(StatusCode::OK, value));
    }
    if !row.get::<bool, _>("live") || !request_matches(&row, scope(&account), c) {
        terminal(&mut tx, id, "expired").await?;
        row = lock_request(&mut tx, id, user.id, &login, p).await?;
        let value = login_value(&app, &row, None)?;
        super::maintenance::commit(tx).await?;
        return Ok(registration::private_json(StatusCode::OK, value));
    }
    if row.get::<String, _>("mode") == "web"
        || row.get::<bool, _>("operation_live")
        || !row.get::<bool, _>("poll_ready")
    {
        let value = login_value(&app, &row, None)?;
        super::maintenance::commit(tx).await?;
        return Ok(registration::private_json(StatusCode::OK, value));
    }
    if row.get::<bool, _>("exchange_started") {
        terminal(&mut tx, id, "failed").await?;
        super::maintenance::commit(tx).await?;
        return Err(err(
            StatusCode::CONFLICT,
            "platform_oauth_exchange_uncertain",
        ));
    }
    let values = request_values(&app, &row)?;
    let state = values["state"]
        .as_str()
        .ok_or_else(credential_error)?
        .to_owned();
    let ticket = values["ticket"]
        .as_str()
        .ok_or_else(credential_error)?
        .to_owned();
    let token = values["poll_token"]
        .as_str()
        .ok_or_else(credential_error)?
        .to_owned();
    let nonce = Uuid::new_v4();
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET operation_nonce=$2,operation_expires_at=LEAST(expires_at,clock_timestamp()+interval '45 seconds'),next_poll_at=clock_timestamp()+interval '3 seconds' WHERE id=$1").bind(id).bind(nonce).execute(&mut *tx)).await?;
    super::maintenance::commit(tx).await?;
    let result = app
        .platform_http
        .send(
            c.poll_request(&token).map_err(|_| credential_error())?,
            Deadline::now() + Duration::from_secs(20),
        )
        .await
        .and_then(|v| c.parse_poll(&v, &ticket, &state));
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, _) = lock_account(&mut tx, user.id, p).await?;
    let row = lock_request(&mut tx, id, user.id, &login, p).await?;
    if row.get::<String, _>("status") != "pending"
        || row.get::<Option<Uuid>, _>("operation_nonce") != Some(nonce)
        || !row.get::<bool, _>("live")
        || !request_matches(&row, scope(&account), c)
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    match result {
        Ok(QrState::Confirmed(code)) => {
            super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET exchange_started=true WHERE id=$1 AND NOT exchange_started").bind(id).execute(&mut *tx)).await?;
            super::maintenance::commit(tx).await?;
            exchange(&app, p, user.id, &login, id, nonce, &code).await
        }
        other => {
            let stage = match other {
                Ok(QrState::Waiting) => Some("waiting"),
                Ok(QrState::Scanned) => Some("scanned"),
                Ok(QrState::Expired) => {
                    terminal(&mut tx, id, "expired").await?;
                    None
                }
                Err(provider::Error::Denied | provider::Error::Invalid) => {
                    terminal(&mut tx, id, "failed").await?;
                    None
                }
                Err(_) => None,
                _ => None,
            };
            super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET operation_nonce=NULL,operation_expires_at=NULL WHERE id=$1 AND status='pending'").bind(id).execute(&mut *tx)).await?;
            let row = lock_request(&mut tx, id, user.id, &login, p).await?;
            let value = login_value(&app, &row, stage)?;
            super::maintenance::commit(tx).await?;
            Ok(registration::private_json(StatusCode::OK, value))
        }
    }
}
fn callback_values(raw: &str) -> Result<(String, Option<String>)> {
    if raw.len() > 8192 || raw.bytes().any(|b| b.is_ascii_control()) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let url = reqwest::Url::parse(&format!("https://callback.invalid/?{raw}"))
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let mut seen = std::collections::HashSet::new();
    let mut state = None;
    let mut code = None;
    let mut denied = false;
    for (k, v) in url.query_pairs() {
        if !seen.insert(k.to_string()) {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
        }
        match k.as_ref() {
            "state" => state = Some(v.to_string()),
            "code" => code = Some(v.to_string()),
            "error" => denied = true,
            _ => {}
        }
    }
    let state = state
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "platform_oauth_state_invalid"))?;
    if denied {
        code = None;
    }
    if code.as_ref().is_some_and(|c| {
        c.is_empty()
            || c.len() > 2048
            || c.bytes()
                .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    }) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok((state, code))
}
/// The platform redirect arrives without SameSite=Strict cookies. Serve only a
/// fixed same-origin bridge; authenticated mutation happens in POST claim.
pub async fn callback(
    Path(raw): Path<String>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    callback_values(query.as_deref().unwrap_or(""))?;
    let nonce = random();
    let document = format!(
        r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>确认平台授权</title><p id="status">正在安全确认平台授权…</p><script nonce="{nonce}">
(() => {{
  const query = new URLSearchParams(location.search);
  history.replaceState(null, '', '/account/profile');
  const state = query.get('state');
  let code = query.has('error') ? null : query.get('code');
  const status = document.getElementById('status');
  (async () => {{
    const identity = await fetch('/api/v1/auth/me', {{credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'}});
    if (!identity.ok) throw new Error('identity unavailable');
    const user = await identity.json();
    if (typeof user.csrf !== 'string') throw new Error('identity unavailable');
    const response = await fetch('/api/v1/platform-accounts/{provider}/oauth/claim', {{method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{{'Content-Type':'application/json','x-csrf-token':user.csrf}},body:JSON.stringify({{state,code}})}});
    code = null;
    if (!response.ok) throw new Error('authorization unavailable');
    location.replace('/account/profile');
  }})().catch(() => {{code=null;status.textContent='授权结果未确认，请回到账号页刷新状态。不要重复提交授权码';}});
}})();
</script></html>"#,
        provider = p.name()
    );
    let mut response = axum::response::Html(document).into_response();
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response.headers_mut().insert("content-security-policy",HeaderValue::from_str(&format!("default-src 'none'; script-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")).map_err(|_|credential_error())?);
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("x-frame-options", HeaderValue::from_static("DENY"));
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    state: String,
    code: Option<String>,
}
pub async fn claim(
    State(app): State<App>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Claim>,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let c = configured(&app, p)?;
    let mut query = reqwest::Url::parse("https://callback.invalid/").unwrap();
    query.query_pairs_mut().append_pair("state", &body.state);
    if let Some(code) = &body.code {
        query.query_pairs_mut().append_pair("code", code);
    }
    let (state, code) = callback_values(query.query().unwrap_or(""))?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, _) = lock_account(&mut tx, user.id, p).await?;
    let id: Uuid = super::maintenance::phase(
        sqlx::query_scalar(
            "SELECT id FROM platform_oauth_requests WHERE state_hash=$1 AND provider=$2",
        )
        .bind(hash(&state))
        .bind(p.name())
        .fetch_optional(&mut *tx),
    )
    .await?
    .ok_or_else(|| err(StatusCode::BAD_REQUEST, "platform_oauth_state_invalid"))?;
    let row = lock_request(&mut tx, id, user.id, &login, p).await?;
    if row.get::<String, _>("mode") != "web"
        || row.get::<String, _>("status") != "pending"
        || !row.get::<bool, _>("live")
        || row.get::<bool, _>("exchange_started")
        || row.get::<bool, _>("operation_live")
        || !request_matches(&row, scope(&account), c)
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    let stored = request_values(&app, &row)?;
    if stored["state"] != state {
        return Err(err(StatusCode::BAD_REQUEST, "platform_oauth_state_invalid"));
    }
    let nonce = Uuid::new_v4();
    if let Some(code) = code {
        super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET exchange_started=true,operation_nonce=$2,operation_expires_at=LEAST(expires_at,clock_timestamp()+interval '45 seconds') WHERE id=$1").bind(id).bind(nonce).execute(&mut *tx)).await?;
        super::maintenance::commit(tx).await?;
        exchange(&app, p, user.id, &login, id, nonce, &code).await
    } else {
        terminal(&mut tx, id, "failed").await?;
        let row = lock_request(&mut tx, id, user.id, &login, p).await?;
        let value = login_value(&app, &row, None)?;
        super::maintenance::commit(tx).await?;
        Ok(registration::private_json(StatusCode::OK, value))
    }
}
async fn exchange(
    app: &App,
    p: Provider,
    user: Uuid,
    login: &str,
    id: Uuid,
    nonce: Uuid,
    code: &str,
) -> Result<Response> {
    let owned = app.clone();
    let login = login.to_owned();
    let code = code.to_owned();
    let receive = app
        .platform_oauth_exchanges
        .launch(async move { exchange_owned(&owned, p, user, &login, id, nonce, &code).await })?;
    let value = receive.await.map_err(|_| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "platform_oauth_exchange_unknown",
        )
    })??;
    Ok(registration::private_json(StatusCode::OK, value))
}
async fn exchange_preflight(
    app: &App,
    p: Provider,
    user: Uuid,
    login: &str,
    id: Uuid,
    nonce: Uuid,
) -> Result<(AccountScope, i64)> {
    let c = configured(app, p)?;
    let mut tx = super::maintenance::begin(app).await?;
    super::maintenance::phase(guard_login(&mut tx, user, login)).await?;
    let (account, _) = lock_account(&mut tx, user, p).await?;
    let row = lock_request(&mut tx, id, user, login, p).await?;
    if row.get::<String, _>("status") != "pending"
        || !row.get::<bool, _>("live")
        || !row.get::<bool, _>("operation_live")
        || row.get::<Option<Uuid>, _>("operation_nonce") != Some(nonce)
        || !request_matches(&row, scope(&account), c)
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    let s = scope(&account);
    let remaining = row
        .get::<i64, _>("expires_ms")
        .saturating_sub(row.get("now_ms"))
        .clamp(0, 180000);
    super::maintenance::commit(tx).await?;
    Ok((s, remaining))
}
// Keep the independently validated owner/login/request/nonce/account bindings
// explicit at this custody boundary; never infer them from a replacement row.
#[allow(clippy::too_many_arguments)]
async fn persist_exchange(
    app: &App,
    p: Provider,
    user: Uuid,
    login: &str,
    id: Uuid,
    nonce: Uuid,
    observed: AccountScope,
    tokens: &std::result::Result<Tokens, provider::Error>,
) -> Result<Value> {
    let c = configured(app, p)?;
    let mut tx = super::maintenance::begin(app).await?;
    if let Err(error) = super::maintenance::phase(guard_login(&mut tx, user, login)).await {
        if !super::maintenance::authority_expired(&error) {
            return Err(error);
        }
        super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET status='failed',secret_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL WHERE id=$1 AND user_id=$2 AND auth_login_hash=$3 AND operation_nonce=$4 AND status='pending'").bind(id).bind(user).bind(login).bind(nonce).execute(&mut *tx)).await?;
        super::maintenance::commit(tx).await?;
        return Ok(
            json!({"id":id,"provider":p.name(),"status":"failed","mode":"web","stage":null,"authorization_url":null,"qr_payload":null,"expires_at":1,"next_poll_at":1,"server_time":1}),
        );
    }
    let (account, _) = lock_account(&mut tx, user, p).await?;
    let row = lock_request(&mut tx, id, user, login, p).await?;
    // A prior commit may have completed after a client-side timeout. Observe its
    // terminal result rather than replaying exchange or advancing revision twice.
    if row.get::<String, _>("status") != "pending" {
        let value = login_value(app, &row, None)?;
        super::maintenance::commit(tx).await?;
        return Ok(value);
    }
    if scope(&account) != observed
        || !row.get::<bool, _>("live")
        || !row.get::<bool, _>("operation_live")
        || row.get::<Option<Uuid>, _>("operation_nonce") != Some(nonce)
        || !request_matches(&row, observed, c)
    {
        terminal(&mut tx, id, "failed").await?;
    } else {
        match tokens {
            Ok(tokens) => {
                let next = AccountScope {
                    revision: observed
                        .revision
                        .checked_add(1)
                        .ok_or_else(credential_error)?,
                    ..observed
                };
                let cipher = app
                    .encrypt(&token_envelope(next, p, c.binding(), tokens))
                    .map_err(|_| credential_error())?;
                let renew: bool = row.get("consent_to_renew");
                let scopes = tokens
                    .scopes()
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>();
                super::maintenance::phase(guard_login_live(&mut tx, user, login)).await?;
                let changed=super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='connected',token_encrypted=$2,access_expires_at=to_timestamp($3::double precision/1000),refresh_expires_at=to_timestamp($4::double precision/1000),config_binding=$5,granted_scopes=$6,revision=$7,auto_renew=$8,consent_login_hash=CASE WHEN $8 THEN $9 ELSE NULL END,renewal_state=CASE WHEN $8 THEN 'scheduled' ELSE 'disabled' END,next_refresh_at=CASE WHEN $8 THEN to_timestamp(($3-300000)::double precision/1000) ELSE NULL END,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND revision=$10")
            .bind(next.account_id).bind(cipher).bind(tokens.access_expires_at).bind(tokens.refresh_expires_at).bind(c.binding()).bind(scopes).bind(next.revision).bind(renew).bind(login).bind(observed.revision).execute(&mut *tx)).await?;
                if changed.rows_affected() != 1 {
                    return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
                }
                terminal(&mut tx, id, "confirmed").await?;
            }
            Err(_) => terminal(&mut tx, id, "failed").await?,
        }
    }
    let row = lock_request(&mut tx, id, user, login, p).await?;
    let value = login_value(app, &row, None)?;
    super::maintenance::commit(tx).await?;
    Ok(value)
}
async fn retire_exchange(app: &App, id: Uuid, user: Uuid, login: &str, nonce: Uuid) -> Result<()> {
    let mut tx = super::maintenance::begin(app).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET status='failed',secret_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL WHERE id=$1 AND user_id=$2 AND auth_login_hash=$3 AND operation_nonce=$4 AND status='pending'").bind(id).bind(user).bind(login).bind(nonce).execute(&mut *tx)).await?;
    super::maintenance::commit(tx).await
}
async fn exchange_owned(
    app: &App,
    p: Provider,
    user: Uuid,
    login: &str,
    id: Uuid,
    nonce: Uuid,
    code: &str,
) -> (Result<Value>, bool) {
    let (observed, remaining) = match exchange_preflight(app, p, user, login, id, nonce).await {
        Ok(value) => value,
        Err(error) => {
            let durable = retire_exchange(app, id, user, login, nonce).await.is_ok();
            return (Err(error), durable);
        }
    };
    let c = match configured(app, p) {
        Ok(c) => c,
        Err(error) => {
            return (
                Err(error),
                retire_exchange(app, id, user, login, nonce).await.is_ok(),
            );
        }
    };
    let request = match c.exchange_request(code) {
        Ok(request) => request,
        Err(_) => {
            return (
                Err(credential_error()),
                retire_exchange(app, id, user, login, nonce).await.is_ok(),
            );
        }
    };
    let recovery_deadline = Deadline::now() + Duration::from_millis(remaining as u64);
    // No timeout/cancellation of this owner encloses provider rotation or the
    // resulting token custody. Only individual transport/DB phases are bounded.
    let upstream = app
        .platform_http
        .send(request, Deadline::now() + Duration::from_secs(20))
        .await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|t| t.as_millis() as i64)
        .unwrap_or(0);
    let tokens = upstream.and_then(|v| c.parse_tokens(&v, now, None));
    loop {
        match persist_exchange(app, p, user, login, id, nonce, observed, &tokens).await {
            Ok(value) => return (Ok(value), true),
            Err(error) => {
                if Deadline::now() >= recovery_deadline {
                    let durable = retire_exchange(app, id, user, login, nonce).await.is_ok();
                    return (Err(error), durable);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preference {
    expected_revision: Value,
    enabled: bool,
}
pub async fn set_renewal(
    State(app): State<App>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Preference>,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
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
            app.decrypt(&old).map_err(|_| credential_error())?,
        )?;
        Some(
            app.encrypt(&token_envelope(next, p, &binding, &t))
                .map_err(|_| credential_error())?,
        )
    } else {
        None
    };
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET auto_renew=false,consent_login_hash=NULL,renewal_state='disabled',operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=NULL,token_encrypted=$2,revision=$3 WHERE id=$1").bind(s.account_id).bind(cipher).bind(next.revision).execute(&mut *tx)).await?;
    let row = super::maintenance::phase(
        sqlx::query(ACCOUNT)
            .bind(user.id)
            .bind(p.name())
            .fetch_one(&mut *tx),
    )
    .await?;
    let value = status_value(&app, p, Some(&row), &login);
    super::maintenance::commit(tx).await?;
    Ok(registration::private_json(StatusCode::OK, value))
}
pub async fn unlink(
    State(app): State<App>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    Json(body): Json<UnlinkCredential>,
) -> Result<Response> {
    let p = parse_provider(&raw)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = super::maintenance::begin(&app).await?;
    super::maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;
    let (account, inserted) = lock_account(&mut tx, user.id, p).await?;
    let s = scope(&account);
    if !revision_matches(expected, s.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='revoked',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='disabled',operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=NULL,revision=revision+1,granted_scopes='{}',access_expires_at=NULL,refresh_expires_at=NULL,config_binding=NULL WHERE id=$1")
        .bind(s.account_id).execute(&mut *tx)).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET status='failed',secret_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL WHERE account_id=$1 AND status='pending'").bind(s.account_id).execute(&mut *tx)).await?;
    super::maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
    let row = super::maintenance::phase(
        sqlx::query(ACCOUNT)
            .bind(user.id)
            .bind(p.name())
            .fetch_one(&mut *tx),
    )
    .await?;
    let value = status_value(&app, p, Some(&row), &login);
    super::maintenance::commit(tx).await?;
    Ok(registration::private_json(StatusCode::OK, value))
}
/// Bounded background pass; opt-in, originating login, configuration, exact
/// revision and one-time operation nonce all remain required on publication.
pub(super) async fn refresh_due_inner(
    app: &App,
    closing: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let mut recovery = super::maintenance::begin(app).await?;
    for p in [Provider::Douyin, Provider::TikTok] {
        super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1 WHERE provider=$1 AND token_encrypted IS NOT NULL AND config_binding IS DISTINCT FROM $2")
            .bind(p.name()).bind(app.platform_oauth.config(p).map(Config::binding)).execute(&mut *recovery)).await?;
    }
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,state='expired',renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1 WHERE token_encrypted IS NOT NULL AND refresh_expires_at<=clock_timestamp()").execute(&mut *recovery)).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET renewal_state='uncertain',operation_nonce=NULL,operation_expires_at=NULL WHERE renewal_state='running' AND operation_expires_at<=clock_timestamp()").execute(&mut *recovery)).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_requests SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'failed' END,secret_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL WHERE status='pending' AND (expires_at<=clock_timestamp() OR (exchange_started AND operation_expires_at<=clock_timestamp()))").execute(&mut *recovery)).await?;
    let rows=super::maintenance::phase(sqlx::query("SELECT user_id,provider FROM platform_oauth_accounts WHERE auto_renew AND renewal_state='scheduled' AND next_refresh_at<=clock_timestamp() ORDER BY next_refresh_at LIMIT 16").fetch_all(&mut *recovery)).await?;
    super::maintenance::commit(recovery).await?;
    let mut failure = None;
    for row in rows {
        if closing.load(std::sync::atomic::Ordering::Acquire) {
            break;
        }
        let p = parse_provider(&row.get::<String, _>("provider"))?;
        if let Err(error) = refresh_one(app, row.get("user_id"), p).await {
            tracing::warn!(
                event = "platform_renewal_account_failed",
                provider = "oauth"
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
async fn refresh_one(app: &App, user: Uuid, p: Provider) -> Result<()> {
    let c = configured(app, p)?;
    let mut tx = super::maintenance::begin(app).await?;
    let original = super::maintenance::phase(
        sqlx::query(ACCOUNT)
            .bind(user)
            .bind(p.name())
            .fetch_optional(&mut *tx),
    )
    .await?;
    let Some(original) = original else {
        return Ok(());
    };
    let observed = scope(&original);
    let Some(login) = original.get::<Option<String>, _>("consent_login_hash") else {
        return Ok(());
    };
    if !original.get::<bool, _>("auto_renew")
        || original.get::<String, _>("renewal_state") != "scheduled"
    {
        return Ok(());
    }
    if let Err(error) = super::maintenance::phase(guard_login(&mut tx, user, &login)).await {
        if !super::maintenance::authority_expired(&error) {
            return Err(error);
        }
        // The snapshot can change while authority locks are acquired. Only an
        // explicitly expired originating login may retire this exact grant.
        super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1 WHERE id=$1 AND user_id=$2 AND provider=$3 AND revision=$4 AND consent_login_hash=$5 AND auto_renew AND renewal_state='scheduled'")
            .bind(observed.account_id).bind(user).bind(p.name()).bind(observed.revision).bind(&login).execute(&mut *tx)).await?;
        super::maintenance::commit(tx).await?;
        return Ok(());
    }
    let (account, _) = lock_account(&mut tx, user, p).await?;
    let s = scope(&account);
    if s != observed
        || account
            .get::<Option<String>, _>("consent_login_hash")
            .as_deref()
            != Some(&login)
    {
        return Ok(());
    }
    if !account.get::<bool, _>("auto_renew")
        || account.get::<String, _>("renewal_state") != "scheduled"
        || account.get::<Option<bool>, _>("refresh_live") != Some(true)
        || account
            .get::<Option<String>, _>("config_binding")
            .as_deref()
            != Some(c.binding())
    {
        return Ok(());
    }
    let t = token_from(
        s,
        p,
        c.binding(),
        app.decrypt(&account.get::<String, _>("token_encrypted"))
            .map_err(|_| credential_error())?,
    )?;
    let nonce = Uuid::new_v4();
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET renewal_state='running',operation_nonce=$2,operation_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1 AND revision=$3 AND consent_login_hash=$4").bind(s.account_id).bind(nonce).bind(s.revision).bind(&login).execute(&mut *tx)).await?;
    // Natural login expiry can occur while the account lock is awaited. Fence
    // admission again after the claim, before any potentially rotating call.
    super::maintenance::phase(guard_login_live(&mut tx, user, &login)).await?;
    if let Err(error) = super::maintenance::commit(tx).await {
        if retire_refresh(app, s, nonce).await.is_err() {
            return Err(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "platform_renewal_durability_unconfirmed",
            ));
        }
        return Err(error);
    }
    let recovery_deadline = Deadline::now() + Duration::from_secs(45);
    let upstream = app
        .platform_http
        .send(
            c.refresh_request(&t).map_err(|_| credential_error())?,
            Deadline::now() + Duration::from_secs(20),
        )
        .await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|t| t.as_millis() as i64)
        .unwrap_or(0);
    // Hold the issued result through local publication/reconciliation retries.
    // The token endpoint itself is called exactly once.
    let tokens = upstream.and_then(|v| c.parse_tokens(&v, now, Some(&t)));
    loop {
        match publish_refresh(app, p, user, &login, s, nonce, &tokens).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                if Deadline::now() >= recovery_deadline {
                    if retire_refresh(app, s, nonce).await.is_err() {
                        return Err(err(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "platform_renewal_durability_unconfirmed",
                        ));
                    }
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
async fn retire_refresh(app: &App, s: AccountScope, nonce: Uuid) -> Result<()> {
    let mut tx = super::maintenance::begin(app).await?;
    super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET renewal_state='uncertain',operation_nonce=NULL,operation_expires_at=NULL WHERE id=$1 AND revision=$2 AND operation_nonce=$3").bind(s.account_id).bind(s.revision).bind(nonce).execute(&mut *tx)).await?;
    super::maintenance::commit(tx).await
}
async fn publish_refresh(
    app: &App,
    p: Provider,
    user: Uuid,
    login: &str,
    s: AccountScope,
    nonce: Uuid,
    tokens: &std::result::Result<Tokens, provider::Error>,
) -> Result<()> {
    let c = configured(app, p)?;
    let mut tx = super::maintenance::begin(app).await?;
    if let Err(error) = super::maintenance::phase(guard_login(&mut tx, user, login)).await {
        if !super::maintenance::authority_expired(&error) {
            return Err(error);
        }
        super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1 WHERE id=$1 AND revision=$2 AND consent_login_hash=$3 AND operation_nonce=$4").bind(s.account_id).bind(s.revision).bind(login).bind(nonce).execute(&mut *tx)).await?;
        return super::maintenance::commit(tx).await;
    }
    let (current, _) = lock_account(&mut tx, user, p).await?;
    let observed = scope(&current);
    let next = AccountScope {
        revision: s.revision.checked_add(1).ok_or_else(credential_error)?,
        ..s
    };
    // Reconcile an ambiguous successful COMMIT using the exact issued result.
    if observed == next
        && current.get::<String, _>("renewal_state") == "scheduled"
        && current
            .get::<Option<String>, _>("consent_login_hash")
            .as_deref()
            == Some(login)
        && let (Ok(expected), Some(cipher)) =
            (tokens, current.get::<Option<String>, _>("token_encrypted"))
    {
        let actual = token_from(
            next,
            p,
            c.binding(),
            app.decrypt(&cipher).map_err(|_| credential_error())?,
        )?;
        if actual.storage_value() == expected.storage_value() {
            return super::maintenance::commit(tx).await;
        }
    }
    // Replacement, disabled renewal or an already-retired nonce wins; do not
    // erase a newer credential just to settle this old attempt.
    if observed != s
        || !current.get::<bool, _>("auto_renew")
        || current.get::<Option<Uuid>, _>("operation_nonce") != Some(nonce)
        || current
            .get::<Option<String>, _>("consent_login_hash")
            .as_deref()
            != Some(login)
        || current
            .get::<Option<String>, _>("config_binding")
            .as_deref()
            != Some(c.binding())
    {
        return super::maintenance::commit(tx).await;
    }
    let lease_live:bool=super::maintenance::phase(sqlx::query_scalar("SELECT operation_expires_at>clock_timestamp() FROM platform_oauth_accounts WHERE id=$1").bind(s.account_id).fetch_one(&mut *tx)).await?;
    if !lease_live {
        super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET renewal_state='uncertain',operation_nonce=NULL,operation_expires_at=NULL WHERE id=$1 AND revision=$2 AND operation_nonce=$3").bind(s.account_id).bind(s.revision).bind(nonce).execute(&mut *tx)).await?;
    } else {
        match tokens {
            Ok(tokens) => {
                let cipher = app
                    .encrypt(&token_envelope(next, p, c.binding(), tokens))
                    .map_err(|_| credential_error())?;
                let changed=super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET token_encrypted=$2,revision=$3,access_expires_at=to_timestamp($4::double precision/1000),refresh_expires_at=to_timestamp($5::double precision/1000),next_refresh_at=to_timestamp(($4-300000)::double precision/1000),state='connected',renewal_state='scheduled',operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND revision=$6 AND operation_nonce=$7 AND operation_expires_at>clock_timestamp() AND playback_login_allowed(user_id,$8)")
            .bind(s.account_id).bind(cipher).bind(next.revision).bind(tokens.access_expires_at).bind(tokens.refresh_expires_at).bind(s.revision).bind(nonce).bind(login).execute(&mut *tx)).await?;
                if changed.rows_affected() != 1 {
                    return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
                }
            }
            Err(provider::Error::Expired | provider::Error::Denied) => {
                super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET state='expired',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='reauthorization_required',operation_nonce=NULL,operation_expires_at=NULL,revision=revision+1 WHERE id=$1 AND revision=$2 AND operation_nonce=$3").bind(s.account_id).bind(s.revision).bind(nonce).execute(&mut *tx)).await?;
            }
            Err(_) => {
                super::maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET renewal_state='uncertain',operation_nonce=NULL,operation_expires_at=NULL WHERE id=$1 AND revision=$2 AND operation_nonce=$3").bind(s.account_id).bind(s.revision).bind(nonce).execute(&mut *tx)).await?;
            }
        }
    }
    super::maintenance::phase(guard_login_live(&mut tx, user, login)).await?;
    super::maintenance::commit(tx).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_envelope_revision_is_an_exact_canonical_string() {
        let s = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        let tokens = Tokens::from_storage(&json!({
            "access_token":"fixture-access", "refresh_token":"fixture-refresh",
            "open_id":"fixture-owner", "scope":"user_info",
            "access_expires_at":1, "refresh_expires_at":2
        }))
        .unwrap();
        let v = token_envelope(s, Provider::Douyin, "fixture-binding", &tokens);
        assert!(token_from(s, Provider::Douyin, "fixture-binding", v.clone()).is_ok());
        for revision in [json!(3), json!("03"), json!("4")] {
            let mut changed = v.clone();
            changed["revision"] = revision;
            assert!(token_from(s, Provider::Douyin, "fixture-binding", changed).is_err());
        }
    }
    #[test]
    fn callbacks_reject_duplicate_or_missing_state() {
        let s = "a".repeat(64);
        assert!(callback_values(&format!("state={s}&code=fixture-code")).is_ok());
        assert!(callback_values(&format!("state={s}&state={s}&code=fixture-code")).is_err());
        assert!(callback_values("code=fixture-code").is_err());
        assert!(
            callback_values(&format!("state={s}&code=fixture-code&error=access_denied"))
                .unwrap()
                .1
                .is_none()
        );
    }
    #[tokio::test]
    async fn strict_cookie_callback_is_resource_free_same_origin_bridge_not_authenticated_exchange()
    {
        let state = "a".repeat(64);
        let code = "synthetic-one-use-code";
        let response = callback(
            Path("douyin".to_owned()),
            axum::extract::RawQuery(Some(format!("state={state}&code={code}"))),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("script-src 'nonce-")
        );
        let body = axum::body::to_bytes(response.into_body(), 65536)
            .await
            .unwrap();
        let html = std::str::from_utf8(&body).unwrap();
        assert!(!html.contains(&state) && !html.contains(code));
        assert!(!html.contains("https://") && !html.contains("src="));
        assert!(
            html.contains("credentials:'same-origin'")
                && html.contains("x-csrf-token")
                && html.contains("/oauth/claim")
        );
        assert!(html.find("history.replaceState").unwrap() < html.find("fetch(").unwrap());
    }
}
