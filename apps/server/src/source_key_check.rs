//! Shared read-only startup probe. No source rows or credentials are logged.
use aes_gcm::{Aes256Gcm, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::TryStreamExt;

pub async fn verify(db: &sqlx::PgPool, key: &Aes256Gcm) -> anyhow::Result<()> {
    for table in ["sources", "source_access_policy_snapshots"] {
        let present: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(format!("public.{table}"))
            .fetch_one(db)
            .await?;
        if !present {
            continue;
        }
        // Fixed identifiers only. Keep memory bounded for large source tables.
        let query = format!("SELECT config_encrypted FROM {table}");
        let mut rows = sqlx::query_scalar::<_, String>(&query).fetch(db);
        while let Some(value) = rows.try_next().await? {
            let valid = (|| {
                let bytes = STANDARD.decode(value).ok()?;
                if bytes.len() < 28 {
                    return None;
                }
                let plaintext = key.decrypt(bytes[..12].into(), &bytes[12..]).ok()?;
                serde_json::from_slice::<serde_json::Value>(&plaintext).ok()
            })();
            anyhow::ensure!(
                valid.is_some(),
                "source_key_mismatch_or_corrupt_ciphertext: existing source cannot be decrypted; restore its matching SOURCE_ENCRYPTION_KEY and key version; startup stopped before library recovery"
            );
        }
    }
    Ok(())
}
