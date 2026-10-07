use crate::*;
use axum::extract::ConnectInfo;
use std::net::SocketAddr;

fn invalid_invite() -> Error {
    err(StatusCode::BAD_REQUEST, "registration_invite_invalid")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Validate {
    code: String,
}

pub async fn validate(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    h: HeaderMap,
    Json(body): Json<Validate>,
) -> Result<Response> {
    account_security::anonymous_json_request(&app, &h)?;
    let source = app.account_security.source(peer, &h).to_string();
    account_security::rate_limit(
        &app.db,
        "invite-validate",
        &source,
        app.account_security.validate_limit,
        60,
    )
    .await?;
    if persistence::admin_settings::registration_mode(&mut *app.db.acquire().await?).await?
        == "closed"
    {
        return Err(err(StatusCode::FORBIDDEN, "registration_closed"));
    }
    let normalized = registration::normalize_code(&body.code).ok_or_else(invalid_invite)?;
    let row = sqlx::query("SELECT code_suffix,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_at,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS server_time FROM registration_invites WHERE code_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()")
        .bind(registration::code_hash(&normalized)).fetch_optional(&app.db).await?.ok_or_else(invalid_invite)?;
    Ok(responses::private_json(
        StatusCode::OK,
        json!({"code_suffix":row.get::<String,_>("code_suffix"),"expires_at":row.get::<i64,_>("expires_at"),"server_time":row.get::<i64,_>("server_time")}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    code: Option<String>,
    username: String,
    password: String,
    display_name: Option<String>,
}

pub async fn register(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    h: HeaderMap,
    Json(body): Json<Register>,
) -> Result<Response> {
    account_security::anonymous_json_request(&app, &h)?;
    if cookie(&h).is_some() {
        match auth(&app, &h, false).await {
            Ok(_) => return Err(err(StatusCode::CONFLICT, "already_authenticated")),
            Err(error) if error.0 == StatusCode::UNAUTHORIZED => {}
            Err(error) => return Err(error),
        }
    }
    let source = app.account_security.source(peer, &h).to_string();
    account_security::rate_limit(
        &app.db,
        "register",
        &source,
        app.account_security.register_limit,
        600,
    )
    .await?;
    let account = account_rules::NewAccount {
        username: body.username,
        password: body.password,
        display_name: body.display_name,
    };
    let display_name = account.validate()?;
    let mode =
        persistence::admin_settings::registration_mode(&mut *app.db.acquire().await?).await?;
    if mode == "closed" {
        return Err(err(StatusCode::FORBIDDEN, "registration_closed"));
    }
    let code_hash = body
        .code
        .as_deref()
        .and_then(registration::normalize_code)
        .map(|code| registration::code_hash(&code));
    if mode == "invite_only" {
        let code = code_hash.as_deref().ok_or_else(invalid_invite)?;
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM registration_invites WHERE code_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())")
            .bind(code).fetch_one(&app.db).await?;
        if !valid {
            return Err(invalid_invite());
        }
    }
    let password_hash = account_security::password_hash(&app, account.password).await?;
    let mut tx = app.db.begin().await?;
    // Hashing happens outside the transaction. Pin current access policy only
    // for actual account issuance; reread after the row lock has waited. A
    // concurrent close/invite-only change cannot be bypassed by an earlier form.
    sqlx::query("SELECT singleton FROM admin_settings WHERE singleton FOR SHARE")
        .fetch_one(&mut *tx)
        .await?;
    let mode = persistence::admin_settings::registration_mode(&mut tx).await?;
    let invite = match mode.as_str() {
        "closed" => return Err(err(StatusCode::FORBIDDEN, "registration_closed")),
        "invite_only" => {
            let code = code_hash.as_deref().ok_or_else(invalid_invite)?;
            let row =
                sqlx::query("SELECT id FROM registration_invites WHERE code_hash=$1 FOR UPDATE")
                    .bind(code)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(invalid_invite)?;
            let invite: Uuid = row.get("id");
            // Capture real clock after invitation waits, never transaction now().
            let valid: bool = sqlx::query_scalar("SELECT used_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() FROM registration_invites WHERE id=$1")
                .bind(invite).fetch_one(&mut *tx).await?;
            if !valid {
                return Err(invalid_invite());
            }
            Some(invite)
        }
        "open" => None, // A real code-less account; never fabricate or consume an invite.
        _ => return Err(err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")),
    };
    let id = Uuid::new_v4();
    let session = token();
    let csrf = token();
    sqlx::query("INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,$3,false)")
        .bind(id)
        .bind(&account.username)
        .bind(password_hash)
        .execute(&mut *tx)
        .await
        .map_err(account_rules::insert_error)?;
    if let Some(name) = &display_name {
        sqlx::query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,$2)")
            .bind(id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(invite) = invite {
        sqlx::query(
            "UPDATE registration_invites SET used_by=$2,used_at=clock_timestamp() WHERE id=$1",
        )
        .bind(invite)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days')")
        .bind(hash(&session)).bind(id).bind(&csrf).execute(&mut *tx).await?;
    tx.commit().await?;
    // No post-commit query can turn a committed registration into an apparent failure.
    let mut response = responses::private_json(
        StatusCode::CREATED,
        json!({"id":id,"username":account.username,
        "display_name":display_name.as_ref().unwrap_or(&account.username),"admin":false,"csrf":csrf,"avatar_url":null,"avatar_version":null}),
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(&app, &session).parse().unwrap(),
    );
    Ok(response)
}
