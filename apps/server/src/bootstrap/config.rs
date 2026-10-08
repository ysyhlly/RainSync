//! Deployment-only values. Database overrides are deliberately not captured here.
use crate::control_cluster;
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::{Engine, engine::general_purpose::STANDARD};

pub(super) struct DatabaseSettings {
    pub deployment: media_core::deployment_config::Settings,
    pub cipher: Aes256Gcm,
    pub control: Option<control_cluster::Settings>,
    pub database_url: String,
}
impl DatabaseSettings {
    pub fn from_env() -> anyhow::Result<Self> {
        let deployment = media_core::deployment_config::Settings::from_env(
            media_core::deployment_config::Role::Server,
        )?;
        let cipher = source_cipher(&std::env::var("SOURCE_ENCRYPTION_KEY")?)?;
        let control = control_cluster::Settings::from_env()?;
        let database_url = std::env::var("DATABASE_URL")?;
        Ok(Self {
            deployment,
            cipher,
            control,
            database_url,
        })
    }
}

fn source_cipher(encoded: &str) -> anyhow::Result<Aes256Gcm> {
    let key = STANDARD.decode(encoded)?;
    anyhow::ensure!(
        key.len() == 32,
        "SOURCE_ENCRYPTION_KEY must decode to 32 bytes"
    );
    Ok(Aes256Gcm::new_from_slice(&key).unwrap())
}

// Keep Tokio's address handling, including host names accepted by the old entrypoint.
pub(super) fn listener_address() -> String {
    std::env::var("BIND").unwrap_or("0.0.0.0:8080".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_cipher_requires_exactly_32_decoded_bytes() {
        assert!(source_cipher(&STANDARD.encode([7u8; 32])).is_ok());
        for length in [0, 16, 31, 33, 64] {
            let failure = source_cipher(&STANDARD.encode(vec![7u8; length]))
                .err()
                .unwrap();
            assert_eq!(
                failure.to_string(),
                "SOURCE_ENCRYPTION_KEY must decode to 32 bytes"
            );
        }
        assert!(source_cipher("not base64").is_err());
    }
}
