//! Real PostgreSQL regression, intentionally excluded from ordinary test runs.
//! Requires a separately authorized, disposable database already migrated through
//! 0088. Never starts a server, migration runner, maintenance owner or provider.
//! Synthetic JSON cipher callbacks exercise the real envelope and SQL operation.
use super::*;
use sqlx::{PgPool, postgres::PgConnectOptions, postgres::PgPoolOptions};
use std::{
    str::FromStr,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::time::{Instant, sleep, timeout};

#[derive(Clone, Copy, Debug)]
enum WaitAt {
    Account,
    Update,
}

#[derive(Clone, Copy, Debug)]
enum Expected {
    Expired,
    Live,
    RevisionConflict,
    EnableRejected,
    Overflow,
    BadEnvelope,
    EncryptFailure,
    NoTokenExpired,
}

async fn database() -> anyhow::Result<(PgPool, PgPool)> {
    anyhow::ensure!(
        std::env::var("RAINSYNC_OAUTH_GUARD_DB_TEST").as_deref()
            == Ok("disposable-database-authorized"),
        "explicit disposable PostgreSQL authorization marker is required"
    );
    // Deliberately no DATABASE_URL fallback and no provisioning/native runner.
    let url = std::env::var("RAINSYNC_OAUTH_GUARD_DATABASE_URL")?;
    let options = PgConnectOptions::from_str(&url)?
        .options([("search_path", "public"), ("statement_timeout", "5000")]);
    let observer = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options.clone())
        .await?;
    let actor_result = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options)
        .await;
    let actor = match actor_result {
        Ok(pool) => pool,
        Err(error) => {
            observer.close().await;
            return Err(error.into());
        }
    };
    let validation: anyhow::Result<()> = async {
        let name: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&observer)
            .await?;
        let owned = name
            .strip_prefix("rainsync_oauth_guard_test_")
            .filter(|suffix| suffix.len() == 32)
            .and_then(|suffix| Uuid::parse_str(suffix).ok());
        anyhow::ensure!(
            owned.is_some(),
            "refusing a database without the dedicated test-name prefix and UUID suffix"
        );
        let applied: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM _sqlx_migrations WHERE success AND version IN (66,81,88)",
        )
        .fetch_one(&observer)
        .await?;
        anyhow::ensure!(
            applied == 3,
            "full current migration chain must be provisioned separately"
        );
        Ok(())
    }
    .await;
    if let Err(error) = validation {
        actor.close().await;
        observer.close().await;
        return Err(error);
    }
    Ok((observer, actor))
}

async fn snapshot(db: &PgPool, account: Uuid) -> anyhow::Result<Value> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('account',to_jsonb(a),'requests',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM platform_oauth_requests r WHERE r.account_id=a.id),'[]'::jsonb)) FROM platform_oauth_accounts a WHERE a.id=$1")
        .bind(account).fetch_one(db).await?)
}

async fn wait_snapshot(db: &PgPool, actor: i32, login: &str) -> anyhow::Result<PgRow> {
    Ok(sqlx::query("SELECT query,wait_event_type,pg_blocking_pids(pid) AS blockers,s.expires_at::text AS deadline,s.expires_at>clock_timestamp() AS live FROM pg_stat_activity a CROSS JOIN sessions s WHERE a.pid=$1 AND s.token_hash=$2")
        .bind(actor).bind(login).fetch_one(db).await?)
}

async fn observe_wait_and_expiry(
    db: &PgPool,
    actor_pid: i32,
    blocker_pid: i32,
    login: &str,
    wait_at: WaitAt,
    expire: bool,
) -> anyhow::Result<()> {
    let expected_query = match wait_at {
        WaitAt::Account => {
            "SELECT id FROM platform_oauth_accounts WHERE user_id=$1 AND provider=$2 FOR UPDATE"
        }
        WaitAt::Update => {
            "UPDATE platform_oauth_accounts SET auto_renew=false,consent_login_hash=NULL,renewal_state='disabled',operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=NULL,token_encrypted=$2,revision=$3 WHERE id=$1"
        }
    };
    let still_waiting = |row: &PgRow| {
        row.get::<Option<String>, _>("wait_event_type").as_deref() == Some("Lock")
            && row.get::<Vec<i32>, _>("blockers") == vec![blocker_pid]
            && row.get::<String, _>("query") == expected_query
    };
    let started = Instant::now();
    let deadline = loop {
        let row = wait_snapshot(db, actor_pid, login).await?;
        if still_waiting(&row) {
            anyhow::ensure!(
                row.get::<bool, _>("live"),
                "did not observe lock entry while the exact login was live"
            );
            break row.get::<String, _>("deadline");
        }
        anyhow::ensure!(
            started.elapsed() < Duration::from_millis(1500),
            "application never reached the expected wait while its exact login was live"
        );
        sleep(Duration::from_millis(10)).await;
    };
    loop {
        // Revalidate exact statement, actor, sole blocker and unchanged session
        // deadline in the same observation immediately before blocker release.
        let row = wait_snapshot(db, actor_pid, login).await?;
        anyhow::ensure!(
            still_waiting(&row),
            "application left the controlled lock wait before release"
        );
        anyhow::ensure!(
            row.get::<String, _>("deadline") == deadline,
            "session deadline changed instead of naturally expiring"
        );
        if row.get::<bool, _>("live") != expire {
            break;
        }
        anyhow::ensure!(
            started.elapsed() < Duration::from_secs(4),
            "natural expiry did not occur inside the existing five-second phase budget"
        );
        sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

async fn run_case(
    db: &PgPool,
    actor: &PgPool,
    provider: Provider,
    wait_at: WaitAt,
    expected: Expected,
) -> anyhow::Result<()> {
    let user = Uuid::new_v4();
    let account = Uuid::new_v4();
    let request_id = Uuid::new_v4();
    // IDs used by finally-style cleanup exist before any fallible setup step.
    let trigger = format!("oauth_guard_test_{}", Uuid::new_v4().simple());
    let mut blocker = None;
    let outcome: anyhow::Result<()> = async {
        let token = format!("synthetic-guard-{}", Uuid::new_v4());
        let login = crate::hash(&token);
        let sibling = crate::hash(&format!("synthetic-sibling-{}", Uuid::new_v4()));
        let binding = "f".repeat(64);
        let revision = if matches!(expected, Expected::Overflow) {
            i64::MAX
        } else {
            7
        };
        let scope = AccountScope {
            user_id: user,
            account_id: account,
            revision,
        };
        let token_values = json!({"access_token":"synthetic-access", "refresh_token":"synthetic-refresh",
            "open_id":"synthetic-owner", "scope":if provider == Provider::Douyin {"user_info"} else {"user.info.basic"},
            "access_expires_at":9999999990000_i64, "refresh_expires_at":9999999999999_i64});
        let tokens = providers::platform::oauth::Tokens::from_storage(&token_values)
            .map_err(|_| anyhow::anyhow!("invalid synthetic token fixture"))?;
        let mut envelope = token_envelope(scope, provider, &binding, &tokens);
        if matches!(expected, Expected::BadEnvelope) {
            envelope["revision"] = json!("6");
        }
        let no_token = matches!(expected, Expected::NoTokenExpired);
        let cipher = (!no_token).then(|| envelope.to_string());
        sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'!')")
            .bind(user)
            .bind(format!("oauth-guard-{user}"))
            .execute(db)
            .await?;
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$3,'synthetic-csrf',clock_timestamp()+interval '1 hour'),($2,$3,'sibling-csrf',clock_timestamp()+interval '1 hour')")
            .bind(&login).bind(&sibling).bind(user).execute(db).await?;
        sqlx::query("INSERT INTO platform_oauth_accounts(id,user_id,provider,revision,state,token_encrypted,access_expires_at,refresh_expires_at,config_binding,granted_scopes,auto_renew,consent_login_hash,renewal_state,operation_nonce,operation_expires_at,next_refresh_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day',$7,ARRAY['fixture-scope'],$8,$9,$10,$11,clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 hour')")
            .bind(account).bind(user).bind(provider.name()).bind(revision)
            .bind(if no_token { "revoked" } else { "connected" }).bind(cipher)
            .bind(&binding).bind(!no_token).bind(&sibling)
            .bind(if no_token { "disabled" } else { "running" })
            .bind(Uuid::new_v4()).execute(db).await?;
        sqlx::query("INSERT INTO platform_oauth_requests(id,user_id,provider,auth_login_hash,account_id,account_revision,config_binding,status,mode,state_hash,secret_encrypted,consent_to_renew,expires_at,next_poll_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending','web',$8,'synthetic-request-secret',true,clock_timestamp()+interval '3 minutes',clock_timestamp())")
            .bind(request_id).bind(user).bind(provider.name()).bind(&login).bind(account)
            .bind(revision).bind(&binding).bind(crate::hash(&request_id.to_string())).execute(db).await?;
        let before = snapshot(db, account).await?;
        let advisory_key = i64::from_be_bytes(account.as_bytes()[..8].try_into()?);
        if matches!(wait_at, WaitAt::Update) {
            sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='{account}'::uuid AND OLD.auto_renew AND NOT NEW.auto_renew THEN PERFORM pg_advisory_xact_lock({advisory_key}); END IF; RETURN NEW; END $$"))
                .execute(db).await?;
            sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON platform_oauth_accounts FOR EACH ROW EXECUTE FUNCTION {trigger}()"))
                .execute(db).await?;
        }
        blocker = Some(db.begin().await?);
        let lock = blocker.as_mut().expect("new blocker transaction");
        let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut **lock)
            .await?;
        match wait_at {
            WaitAt::Account => {
                sqlx::query("SELECT id FROM platform_oauth_accounts WHERE id=$1 FOR UPDATE")
                    .bind(account)
                    .fetch_one(&mut **lock)
                    .await?;
            }
            WaitAt::Update => {
                sqlx::query("SELECT pg_advisory_xact_lock($1)")
                    .bind(advisory_key)
                    .execute(&mut **lock)
                    .await?;
            }
        }
        let actor_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(actor)
            .await?;
        let expire = !matches!(expected, Expected::Live);
        if expire {
            // Set the deadline BEFORE the operation starts and let time alone expire
            // it. Updating the session while guard_login holds FOR SHARE would block.
            sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1")
                .bind(&login).execute(db).await?;
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            format!("rainsync_session={token}").parse()?,
        );
        headers.insert(
            axum::http::header::ORIGIN,
            "https://rainsync.example".parse()?,
        );
        headers.insert("x-csrf-token", "synthetic-csrf".parse()?);
        let decrypted = AtomicUsize::new(0);
        let encrypted = AtomicUsize::new(0);
        let decrypt = |value: &str| -> anyhow::Result<Value> {
            decrypted.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::from_str(value)?)
        };
        let encrypt = |value: &Value| -> anyhow::Result<String> {
            encrypted.fetch_add(1, Ordering::SeqCst);
            anyhow::ensure!(
                !matches!(expected, Expected::EncryptFailure),
                "synthetic encryption failure"
            );
            Ok(serde_json::to_string(value)?)
        };
        let registry = Registry::disabled();
        let operation = set_renewal(
            RequestContext {
                db: actor,
                origin: "https://rainsync.example",
            },
            &registry,
            &decrypt,
            &encrypt,
            provider.name().into(),
            headers,
            Preference {
                expected_revision: json!(if matches!(expected, Expected::RevisionConflict) {
                    "6".to_owned()
                } else {
                    revision.to_string()
                }),
                enabled: matches!(expected, Expected::EnableRejected),
            },
        );
        tokio::pin!(operation);
        let observer = observe_wait_and_expiry(db, actor_pid, blocker_pid, &login, wait_at, expire);
        tokio::select! {
            result = &mut operation => anyhow::bail!("operation completed before the controlled wait: {:?}", result.map(|_| ())),
            observed = observer => observed?,
        }
        blocker.take().expect("held blocker").rollback().await?;
        let result = timeout(Duration::from_secs(8), &mut operation).await?;
        // A read through the single-connection actor pool forces any dropped-tx
        // rollback to finish before another connection takes the durable snapshot.
        sqlx::query("SELECT 1").execute(actor).await?;
        let after = snapshot(db, account).await?;
        let sibling_live: bool =
            sqlx::query_scalar("SELECT expires_at>clock_timestamp() FROM sessions WHERE token_hash=$1")
                .bind(&sibling)
                .fetch_one(db)
                .await?;
        anyhow::ensure!(sibling_live, "live sibling login control was lost");

        let verdict: anyhow::Result<()> = (|| {
            if matches!(expected, Expected::Live) {
                let value = result.map_err(|e| anyhow::anyhow!("live control failed: {}", e.1))?;
                anyhow::ensure!(
                    value["revision"] == "8"
                        && value["auto_renew"] == false
                        && value["renewal_state"] == "disabled"
                );
                let mut wanted = before.clone();
                wanted["account"]["revision"] = json!(8);
                for field in [
                    "consent_login_hash",
                    "operation_nonce",
                    "operation_expires_at",
                    "next_refresh_at",
                ] {
                    wanted["account"][field] = Value::Null;
                }
                wanted["account"]["auto_renew"] = json!(false);
                wanted["account"]["renewal_state"] = json!("disabled");
                let next = AccountScope {
                    revision: 8,
                    ..scope
                };
                wanted["account"]["token_encrypted"] =
                    json!(token_envelope(next, provider, &binding, &tokens).to_string());
                anyhow::ensure!(
                    after == wanted,
                    "live control changed unexpected account/request columns"
                );
            } else {
                let error = result
                    .err()
                    .ok_or_else(|| anyhow::anyhow!("expired operation unexpectedly committed"))?;
                let (status, reason) = match expected {
                    Expected::RevisionConflict => (StatusCode::CONFLICT, "platform_account_changed"),
                    Expected::EnableRejected => (
                        StatusCode::CONFLICT,
                        "platform_renewal_new_consented_oauth_required",
                    ),
                    Expected::Overflow | Expected::BadEnvelope | Expected::EncryptFailure => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "platform_credential_invalid",
                    ),
                    _ => (StatusCode::UNAUTHORIZED, "session_expired"),
                };
                anyhow::ensure!(
                    error.0 == status && error.1 == reason && error.2.is_none(),
                    "unexpected error priority for {expected:?}: {}",
                    error.1
                );
                anyhow::ensure!(
                    after == before,
                    "the rejected transaction did not roll back every account/request column"
                );
            }
            let calls = match expected {
                Expected::RevisionConflict
                | Expected::EnableRejected
                | Expected::Overflow
                | Expected::NoTokenExpired => (0, 0),
                Expected::BadEnvelope => (1, 0),
                _ => (1, 1),
            };
            anyhow::ensure!(
                (
                    decrypted.load(Ordering::SeqCst),
                    encrypted.load(Ordering::SeqCst)
                ) == calls,
                "cipher work/order changed"
            );
            Ok(())
        })();
        verdict
    }
    .await;
    // The operation future and its borrowed callbacks have been dropped before
    // any cleanup. Always release the blocker, flush actor rollback, then remove
    // only generated fixtures. Preserve all independent cleanup errors.
    let mut errors = Vec::new();
    if let Err(error) = outcome {
        errors.push(format!(
            "case {provider:?}/{wait_at:?}/{expected:?}: {error}"
        ));
    }
    if let Some(tx) = blocker {
        if let Err(error) = tx.rollback().await {
            errors.push(format!("blocker rollback: {error}"));
        }
    }
    if let Err(error) = sqlx::query("SELECT 1").execute(actor).await {
        errors.push(format!("actor rollback barrier: {error}"));
    }
    for sql in [
        format!("DROP TRIGGER IF EXISTS {trigger} ON platform_oauth_accounts"),
        format!("DROP FUNCTION IF EXISTS {trigger}()"),
    ] {
        if let Err(error) = sqlx::query(&sql).execute(db).await {
            errors.push(format!("fixture DDL cleanup: {error}"));
        }
    }
    for (sql, id) in [
        ("DELETE FROM platform_oauth_accounts WHERE id=$1", account),
        ("DELETE FROM sessions WHERE user_id=$1", user),
        ("DELETE FROM users WHERE id=$1", user),
    ] {
        if let Err(error) = sqlx::query(sql).bind(id).execute(db).await {
            errors.push(format!("fixture row cleanup: {error}"));
        }
    }
    anyhow::ensure!(errors.is_empty(), "{}", errors.join("; "));
    Ok(())
}

#[tokio::test]
#[ignore = "requires separate authorization and a disposable PostgreSQL database; never part of pure/native owner gates"]
async fn exact_login_disable_regression_matrix() -> anyhow::Result<()> {
    let (db, actor) = database().await?;
    // One test serializes all 20 cases, including test-only trigger DDL.
    let outcome: anyhow::Result<()> = async {
        for provider in [Provider::Douyin, Provider::TikTok] {
            for wait_at in [WaitAt::Account, WaitAt::Update] {
                for expected in [Expected::Live, Expected::Expired] {
                    run_case(&db, &actor, provider, wait_at, expected).await?;
                }
            }
            for expected in [
                Expected::RevisionConflict,
                Expected::EnableRejected,
                Expected::Overflow,
                Expected::BadEnvelope,
                Expected::EncryptFailure,
                Expected::NoTokenExpired,
            ] {
                run_case(&db, &actor, provider, WaitAt::Account, expected).await?;
            }
        }
        Ok(())
    }
    .await;
    // Close on success and on any returned infrastructure/assertion failure.
    actor.close().await;
    db.close().await;
    outcome
}
