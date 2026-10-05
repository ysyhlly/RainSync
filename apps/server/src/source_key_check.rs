//! Shared read-only startup probe. No source rows or credentials are logged.
use aes_gcm::{Aes256Gcm, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::TryStreamExt;

pub async fn verify(db: &sqlx::PgPool, key: &Aes256Gcm) -> anyhow::Result<()> {
    for (table, column, predicate) in [
        ("sources", "config_encrypted", ""),
        ("source_access_policy_snapshots", "config_encrypted", ""),
        (
            "platform_accounts",
            "credential_encrypted",
            "WHERE credential_encrypted IS NOT NULL",
        ),
        (
            "platform_oauth_accounts",
            "token_encrypted",
            "WHERE token_encrypted IS NOT NULL",
        ),
        (
            "platform_oauth_requests",
            "secret_encrypted",
            "WHERE secret_encrypted IS NOT NULL",
        ),
        (
            "platform_account_renewals",
            "refresh_encrypted",
            "WHERE refresh_encrypted IS NOT NULL",
        ),
        (
            "platform_login_requests",
            "qr_key_encrypted",
            "WHERE status='pending' AND expires_at>clock_timestamp() AND qr_key_encrypted IS NOT NULL",
        ),
        (
            "platform_login_requests",
            "qr_payload_encrypted",
            "WHERE status='pending' AND expires_at>clock_timestamp() AND qr_payload_encrypted IS NOT NULL",
        ),
    ] {
        let present: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(format!("public.{table}"))
            .fetch_one(db)
            .await?;
        if !present {
            continue;
        }
        // Fixed identifiers only. Keep memory bounded for large source tables.
        let query = format!("SELECT {column} FROM {table} {predicate}");
        let mut rows = sqlx::query_scalar::<_, String>(&query).fetch(db);
        while let Some(value) = rows.try_next().await? {
            let valid = valid_ciphertext(key, &value);
            anyhow::ensure!(
                valid,
                "source_key_mismatch_or_corrupt_ciphertext: existing source or platform login cannot be decrypted; restore its matching SOURCE_ENCRYPTION_KEY and key version; startup stopped before library recovery"
            );
        }
    }
    Ok(())
}

fn valid_ciphertext(key: &Aes256Gcm, value: &str) -> bool {
    let Some(bytes) = STANDARD.decode(value).ok() else {
        return false;
    };
    if bytes.len() < 28 {
        return false;
    }
    let Some(plaintext) = key.decrypt(bytes[..12].into(), &bytes[12..]).ok() else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&plaintext).is_ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::KeyInit;
    #[test]
    fn wrong_source_key_or_corruption_fails_without_secret_output() {
        let key = Aes256Gcm::new_from_slice(&[7u8; 32]).unwrap();
        let wrong = Aes256Gcm::new_from_slice(&[8u8; 32]).unwrap();
        let nonce = [0u8; 12];
        let cipher = key
            .encrypt(
                (&nonce).into(),
                br#"{"fixture":"synthetic-only"}"#.as_slice(),
            )
            .unwrap();
        let stored = STANDARD.encode([nonce.to_vec(), cipher].concat());
        assert!(valid_ciphertext(&key, &stored));
        assert!(!valid_ciphertext(&wrong, &stored));
        assert!(!valid_ciphertext(&key, "synthetic-corruption"));
    }
}
