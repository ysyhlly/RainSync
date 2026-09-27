use crate::*;
use ipnet::IpNet;
use std::net::{IpAddr, SocketAddr};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Security {
    trusted: Vec<IpNet>,
    pub hashes: Arc<Semaphore>,
    pub validate_limit: i32,
    pub register_limit: i32,
}
impl Security {
    pub fn configured() -> anyhow::Result<Self> {
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
    let mut tx = db.begin().await?;
    sqlx::query("LOCK TABLE account_rate_limits IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM account_rate_limits WHERE expires_at<=clock_timestamp()")
        .execute(&mut *tx)
        .await?;
    let full: bool = sqlx::query_scalar("SELECT (SELECT count(*) FROM account_rate_limits)>=10000 AND NOT EXISTS(SELECT 1 FROM account_rate_limits WHERE scope=$1 AND key_hash=$2)")
        .bind(scope).bind(&key).fetch_one(&mut *tx).await?;
    if full {
        return Err(limited(60));
    }
    let row = sqlx::query("INSERT INTO account_rate_limits(scope,key_hash,window_started,expires_at,attempts) VALUES($1,$2,clock_timestamp(),clock_timestamp()+$3*interval '1 second',1) ON CONFLICT(scope,key_hash) DO UPDATE SET attempts=LEAST(account_rate_limits.attempts+1,$4+1) RETURNING attempts,ceil(extract(epoch FROM expires_at-clock_timestamp()))::bigint AS remaining")
        .bind(scope).bind(key).bind(seconds).bind(limit).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    if row.get::<i32, _>("attempts") > limit {
        return Err(limited(row.get("remaining")));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
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
