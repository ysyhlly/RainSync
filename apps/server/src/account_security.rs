use crate::*;
use ipnet::IpNet;
use sqlx::{Postgres, Transaction};
use std::net::{IpAddr, SocketAddr};
use tokio::sync::Semaphore;

// Initialize during server configuration so the first unknown username does
// not take a different path. Login verification still uses the existing worker
// and its shared permit; account-exit verification keeps its original API.
static DUMMY_PASSWORD_HASH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    Argon2::default()
        .hash_password(token().as_bytes(), &SaltString::generate(&mut OsRng))
        .expect("default Argon2 parameters are valid")
        .to_string()
});

pub fn anonymous_json_request(app: &App, h: &HeaderMap) -> Result<()> {
    origin(app, h)?;
    if h.get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(str::trim)
        != Some("application/json")
    {
        return Err(err(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        ));
    }
    Ok(())
}

/// Bounded, opaque guest-admission source. HTTP headers never directly become
/// this extension: control middleware first authenticates the forwarding peer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuestRateIdentity(String);
impl GuestRateIdentity {
    fn from_source(source: IpAddr) -> Self {
        Self(hash(&format!(
            "account-rate:guest-entry:{}",
            canonical_ip(source)
        )))
    }
    pub fn from_authenticated_peer(value: &str) -> Option<Self> {
        (value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone)]
pub struct Security {
    trusted: Vec<IpNet>,
    pub hashes: Arc<Semaphore>,
    pub validate_limit: i32,
    pub register_limit: i32,
}
impl Security {
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self {
            trusted: Vec::new(),
            hashes: Arc::new(Semaphore::new(1)),
            validate_limit: 30,
            register_limit: 10,
        }
    }
    pub fn configured() -> anyhow::Result<Self> {
        std::sync::LazyLock::force(&DUMMY_PASSWORD_HASH);
        let trusted = std::env::var("TRUSTED_PROXY_CIDRS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::parse)
            .collect::<std::result::Result<Vec<IpNet>, _>>()?;
        let hashes = limits::configured("ACCOUNT_HASH_CONCURRENCY", 2)?;
        anyhow::ensure!(
            hashes <= 32,
            "ACCOUNT_HASH_CONCURRENCY must be between 1 and 32"
        );
        Ok(Self {
            trusted,
            hashes: Arc::new(Semaphore::new(hashes as usize)),
            validate_limit: limits::configured("REGISTRATION_VALIDATE_PER_MINUTE", 30)? as i32,
            register_limit: limits::configured("REGISTRATION_PER_TEN_MINUTES", 10)? as i32,
        })
    }
    pub fn guest_rate_identity(&self, peer: SocketAddr, headers: &HeaderMap) -> GuestRateIdentity {
        GuestRateIdentity::from_source(self.source(peer, headers))
    }
    pub fn source(&self, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
        let peer = canonical_ip(peer.ip());
        if !self.trusted.iter().any(|net| net.contains(&peer)) {
            return peer;
        }
        let Some(raw) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .filter(|s| s.len() <= 1024)
        else {
            return peer;
        };
        let parts: Vec<&str> = raw.split(',').collect();
        if parts.len() > 16 {
            return peer;
        }
        let Ok(chain) = parts
            .iter()
            .map(|s| s.trim().parse::<IpAddr>().map(canonical_ip))
            .collect::<std::result::Result<Vec<_>, _>>()
        else {
            return peer;
        };
        let mut source = peer;
        for ip in chain.into_iter().rev() {
            if !self.trusted.iter().any(|net| net.contains(&source)) {
                break;
            }
            source = ip;
        }
        source
    }
}
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    }
}

pub fn limited(seconds: i64) -> Error {
    Error(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited".into(),
        Some(seconds.clamp(1, 3600) as u32),
    )
}

/// Database-shared, bounded fixed windows. Tokens, passwords and raw IPs are never stored.
pub async fn rate_limit(
    db: &PgPool,
    scope: &str,
    source: &str,
    limit: i32,
    seconds: i32,
) -> Result<()> {
    let key = hash(&format!("account-rate:{scope}:{source}"));
    rate_limit_key(db, scope, &key, limit, seconds).await
}

pub async fn guest_rate_limit(db: &PgPool, identity: &GuestRateIdentity) -> Result<()> {
    // The opaque identity is already the established guest-entry bucket key,
    // preserving spent allowances from before control-peer source forwarding.
    rate_limit_key(db, "guest-entry", identity.as_str(), 10, 600).await
}

async fn rate_limit_key(
    db: &PgPool,
    scope: &str,
    key: &str,
    limit: i32,
    seconds: i32,
) -> Result<()> {
    let mut tx = db.begin().await?;
    let retry_after = claim_rate_limit_key(&mut tx, scope, key, limit, seconds).await?;
    tx.commit().await?;
    match retry_after {
        Some(seconds) => Err(limited(seconds)),
        None => Ok(()),
    }
}

/// Claim a fixed-window attempt in the caller's transaction. Returning the
/// delay separately lets the caller commit a denial without opening a second
/// database connection while holding its admission locks.
pub async fn claim_rate_limit(
    tx: &mut Transaction<'_, Postgres>,
    scope: &str,
    source: &str,
    limit: i32,
    seconds: i32,
) -> Result<Option<i64>> {
    let key = hash(&format!("account-rate:{scope}:{source}"));
    claim_rate_limit_key(tx, scope, &key, limit, seconds).await
}

async fn claim_rate_limit_key(
    tx: &mut Transaction<'_, Postgres>,
    scope: &str,
    key: &str,
    limit: i32,
    seconds: i32,
) -> Result<Option<i64>> {
    sqlx::query("LOCK TABLE account_rate_limits IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut **tx)
        .await?;
    let setting = match scope {
        "invite-validate" => Some(persistence::admin_settings::Limit::RegistrationValidate),
        "register" => Some(persistence::admin_settings::Limit::RegistrationAttempts),
        _ => None,
    };
    let limit = if let Some(setting) = setting {
        persistence::admin_settings::effective(&mut *tx, setting, i64::from(limit)).await? as i32
    } else {
        limit
    };
    // A lower runtime limit must not erase attempts already spent in this
    // window; a later increase must not recreate that spent allowance.
    let ceiling = if setting.is_some() { 10001 } else { limit + 1 };
    sqlx::query("DELETE FROM account_rate_limits WHERE expires_at<=clock_timestamp()")
        .execute(&mut **tx)
        .await?;
    let full: bool = sqlx::query_scalar("SELECT (SELECT count(*) FROM account_rate_limits)>=10000 AND NOT EXISTS(SELECT 1 FROM account_rate_limits WHERE scope=$1 AND key_hash=$2)")
        .bind(scope).bind(key).fetch_one(&mut **tx).await?;
    if full {
        return Ok(Some(60));
    }
    let row = sqlx::query("INSERT INTO account_rate_limits(scope,key_hash,window_started,expires_at,attempts) VALUES($1,$2,clock_timestamp(),clock_timestamp()+$3*interval '1 second',1) ON CONFLICT(scope,key_hash) DO UPDATE SET attempts=LEAST(account_rate_limits.attempts+1,$4) RETURNING attempts,ceil(extract(epoch FROM expires_at-clock_timestamp()))::bigint AS remaining")
        .bind(scope).bind(key).bind(seconds).bind(ceiling).fetch_one(&mut **tx).await?;
    Ok((row.get::<i32, _>("attempts") > limit).then(|| row.get("remaining")))
}

pub async fn password_hash(app: &App, password: String) -> Result<String> {
    let permit = app
        .account_security
        .hashes
        .clone()
        .try_acquire_owned()
        .map_err(|_| limited(1))?;
    // The permit lives inside the blocking worker, including after HTTP cancellation.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "hash_failed"))
    })
    .await
    .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "hash_failed"))?
}

pub async fn password_verify(
    security: &Security,
    stored: String,
    password: String,
) -> Result<bool> {
    password_verification_worker(security, stored, password)?
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "hash_failed"))
}

pub async fn login_verify(
    security: &Security,
    stored: Option<String>,
    password: String,
) -> Result<bool> {
    let exists = stored.is_some();
    let encoded = stored.unwrap_or_else(|| DUMMY_PASSWORD_HASH.clone());
    let valid = password_verify(security, encoded, password).await?;
    Ok(exists && valid)
}

/// Caller source is bounded and proxy-trusted; supplied usernames allocate no
/// global bookkeeping slots. The legacy column now stores source-key digests.
pub async fn login_admit(db: &PgPool, source: &str) -> Result<()> {
    let attempts: Option<i32> = sqlx::query_scalar("SELECT attempts FROM login_attempts WHERE username_hash=$1 AND window_started>clock_timestamp()-interval '60 seconds'")
        .bind(hash(&format!("login-source:{source}"))).fetch_optional(db).await?;
    if attempts.is_some_and(|attempts| attempts >= 10) {
        return Err(limited(60));
    }
    Ok(())
}

pub async fn login_failed(db: &PgPool, source: &str) -> Result<()> {
    let key = hash(&format!("login-source:{source}"));
    let mut tx = db.begin().await?;
    sqlx::query("LOCK TABLE login_attempts IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM login_attempts WHERE window_started<=clock_timestamp()-interval '60 seconds'",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM login_attempts WHERE username_hash=(SELECT username_hash FROM login_attempts ORDER BY window_started,username_hash LIMIT 1) AND (SELECT count(*) FROM login_attempts)>=1000 AND NOT EXISTS(SELECT 1 FROM login_attempts WHERE username_hash=$1)")
        .bind(&key).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO login_attempts(username_hash,window_started,attempts) VALUES($1,clock_timestamp(),1) ON CONFLICT(username_hash) DO UPDATE SET attempts=LEAST(login_attempts.attempts+1,11)")
        .bind(key).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub fn password_verification_worker(
    security: &Security,
    stored: String,
    password: String,
) -> Result<tokio::task::JoinHandle<bool>> {
    let permit = security
        .hashes
        .clone()
        .try_acquire_owned()
        .map_err(|_| limited(1))?;
    // Verification shares the creation budget, including after HTTP cancellation.
    Ok(tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&stored).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn unknown_accounts_use_the_same_bounded_verification_worker() {
        let security = Security::for_test();
        std::sync::LazyLock::force(&DUMMY_PASSWORD_HASH);
        let held = security.hashes.clone().acquire_owned().await.unwrap();
        assert!(matches!(
            login_verify(&security, None, "password".into()).await,
            Err(Error(StatusCode::TOO_MANY_REQUESTS, _, Some(1)))
        ));
        drop(held);
        assert!(
            !login_verify(&security, None, "password".into())
                .await
                .unwrap()
        );
        assert_eq!(security.hashes.available_permits(), 1);
    }
    #[tokio::test]
    async fn verification_uses_the_shared_password_work_budget() {
        let security = Security {
            trusted: Vec::new(),
            hashes: Arc::new(Semaphore::new(1)),
            validate_limit: 30,
            register_limit: 10,
        };
        let held = security.hashes.clone().acquire_owned().await.unwrap();
        assert!(matches!(
            password_verify(&security, "invalid hash".into(), "password".into()).await,
            Err(Error(StatusCode::TOO_MANY_REQUESTS, _, Some(1)))
        ));
        drop(held);
        assert!(
            !password_verify(&security, "invalid hash".into(), "password".into())
                .await
                .unwrap()
        );
        assert_eq!(security.hashes.available_permits(), 1);
    }

    #[tokio::test]
    async fn verification_worker_keeps_password_matching_semantics() {
        let security = Security {
            trusted: Vec::new(),
            hashes: Arc::new(Semaphore::new(1)),
            validate_limit: 30,
            register_limit: 10,
        };
        let stored = Argon2::default()
            .hash_password(b"legacy password", &SaltString::generate(&mut OsRng))
            .unwrap()
            .to_string();
        for (password, expected) in [("legacy password", true), ("wrong password", false)] {
            assert_eq!(
                password_verification_worker(&security, stored.clone(), password.into())
                    .unwrap()
                    .await
                    .unwrap(),
                expected
            );
            assert_eq!(security.hashes.available_permits(), 1);
        }
    }

    #[test]
    fn cancelling_a_verification_waiter_does_not_release_the_workers_budget() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let security = Security {
                trusted: Vec::new(),
                hashes: Arc::new(Semaphore::new(1)),
                validate_limit: 30,
                register_limit: 10,
            };
            // Keep the verification queued so cancellation cannot race its end.
            let (release, blocked) = std::sync::mpsc::channel();
            let (started, ready) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                blocked.recv().unwrap();
            });
            ready.await.unwrap();
            let worker =
                password_verification_worker(&security, "invalid hash".into(), "password".into())
                    .unwrap();
            let waiter = tokio::spawn(worker);
            waiter.abort();
            assert!(waiter.await.unwrap_err().is_cancelled());
            assert_eq!(security.hashes.available_permits(), 0);
            assert!(matches!(
                password_verification_worker(&security, "invalid hash".into(), "password".into()),
                Err(Error(StatusCode::TOO_MANY_REQUESTS, _, Some(1)))
            ));
            release.send(()).unwrap();
            blocker.await.unwrap();
            // Queued behind verification on the single blocking thread.
            tokio::task::spawn_blocking(|| ()).await.unwrap();
            assert_eq!(security.hashes.available_permits(), 1);
        });
    }

    #[test]
    fn guest_identity_is_canonical_bounded_and_respects_proxy_trust() {
        let security = Security {
            trusted: vec!["10.0.0.0/8".parse().unwrap()],
            hashes: Arc::new(Semaphore::new(1)),
            validate_limit: 30,
            register_limit: 10,
        };
        let mut headers = HeaderMap::new();
        let direct = security.guest_rate_identity("192.0.2.1:1".parse().unwrap(), &headers);
        assert_eq!(direct.as_str().len(), 64);
        assert_eq!(direct.as_str(), hash("account-rate:guest-entry:192.0.2.1"));
        assert_eq!(
            direct,
            security.guest_rate_identity("[::ffff:192.0.2.1]:2".parse().unwrap(), &headers)
        );
        assert_ne!(
            direct,
            security.guest_rate_identity("192.0.2.2:1".parse().unwrap(), &headers)
        );
        headers.insert("x-forwarded-for", "192.0.2.2".parse().unwrap());
        assert_eq!(
            direct,
            security.guest_rate_identity("192.0.2.1:3".parse().unwrap(), &headers)
        );
        headers.insert(
            "x-forwarded-for",
            "203.0.113.7, 192.0.2.1, 10.0.0.2".parse().unwrap(),
        );
        assert_eq!(
            direct,
            security.guest_rate_identity("10.0.0.1:4".parse().unwrap(), &headers)
        );
        assert_eq!(
            GuestRateIdentity::from_authenticated_peer(direct.as_str()),
            Some(direct)
        );
        for invalid in [
            "".to_string(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
            format!("{},{}", "a".repeat(64), "b".repeat(64)),
        ] {
            assert!(GuestRateIdentity::from_authenticated_peer(&invalid).is_none());
        }
    }

    #[test]
    fn forwarding_is_accepted_only_from_a_trusted_right_hand_chain() {
        let security = Security {
            trusted: vec![
                "127.0.0.1/32".parse().unwrap(),
                "10.0.0.0/8".parse().unwrap(),
            ],
            hashes: Arc::new(Semaphore::new(1)),
            validate_limit: 30,
            register_limit: 10,
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "1.2.3.4, 198.51.100.8, 10.0.0.1".parse().unwrap(),
        );
        assert_eq!(
            security
                .source("127.0.0.1:1".parse().unwrap(), &headers)
                .to_string(),
            "198.51.100.8"
        );
        assert_eq!(
            security
                .source("192.0.2.1:1".parse().unwrap(), &headers)
                .to_string(),
            "192.0.2.1"
        );
        headers.insert("x-forwarded-for", "bad, 198.51.100.8".parse().unwrap());
        assert_eq!(
            security
                .source("127.0.0.1:1".parse().unwrap(), &headers)
                .to_string(),
            "127.0.0.1"
        );
    }
}
