//! Inactive pure storage adapter. No App, database, endpoint or prepare caller.
//! The caller owns nonce freshness; tests use a synthetic key and nonce only.
use aes_gcm::{Aes256Gcm, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::contracts::{
    ContractError, MAX_INPUT_PLAINTEXT_BYTES, Result, validate_input_ciphertext_size,
};

#[allow(dead_code)]
pub(super) fn seal_private_input_plaintext(
    cipher: &Aes256Gcm,
    nonce: [u8; 12],
    plaintext: &[u8],
) -> Result<String> {
    if plaintext.is_empty() || plaintext.len() > MAX_INPUT_PLAINTEXT_BYTES {
        return Err(ContractError::Bounds);
    }
    let encoded = encode_ciphertext(cipher, nonce, plaintext)?;
    validate_input_ciphertext_size(encoded.as_bytes())?;
    Ok(encoded)
}
fn encode_ciphertext(cipher: &Aes256Gcm, nonce: [u8; 12], plaintext: &[u8]) -> Result<String> {
    let encrypted = cipher
        .encrypt((&nonce).into(), plaintext)
        .map_err(|_| ContractError::Facts)?;
    let mut bytes = Vec::with_capacity(nonce.len() + encrypted.len());
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&encrypted);
    Ok(STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::KeyInit;

    #[test]
    fn actual_aes_gcm_padded_base64_boundary_and_round_trip() {
        let cipher = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
        let nonce = [0x17; 12];
        let plaintext = vec![b'x'; MAX_INPUT_PLAINTEXT_BYTES];
        let encoded = seal_private_input_plaintext(&cipher, nonce, &plaintext).unwrap();
        assert_eq!(encoded.len(), 65_536);
        let bytes = STANDARD.decode(encoded).unwrap();
        assert_eq!(&bytes[..12], &nonce);
        assert_eq!(
            cipher.decrypt(bytes[..12].into(), &bytes[12..]).unwrap(),
            plaintext
        );
        let oversized = vec![b'x'; MAX_INPUT_PLAINTEXT_BYTES + 1];
        let actual = encode_ciphertext(&cipher, nonce, &oversized).unwrap();
        assert_eq!(actual.len(), 65_540);
        assert_eq!(
            validate_input_ciphertext_size(actual.as_bytes()),
            Err(ContractError::Bounds)
        );
        assert_eq!(
            seal_private_input_plaintext(&cipher, nonce, &oversized),
            Err(ContractError::Bounds)
        );
        assert_eq!(
            seal_private_input_plaintext(&cipher, nonce, b""),
            Err(ContractError::Bounds)
        );
    }

    #[test]
    fn equal_input_reencrypted_with_new_nonce_is_not_immutable_storage_replay() {
        use media_core::static_hls::contracts::input::FrozenInput;
        let frozen = FrozenInput::parse_private_plaintext(include_bytes!(
            "../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json"
        ))
        .unwrap();
        let cipher = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
        let stored =
            seal_private_input_plaintext(&cipher, [0x17; 12], frozen.private_storage_plaintext())
                .unwrap();
        let renewed =
            seal_private_input_plaintext(&cipher, [0x18; 12], frozen.private_storage_plaintext())
                .unwrap();
        frozen
            .require_same_private_storage_statement(&frozen, stored.as_bytes(), stored.as_bytes())
            .unwrap();
        assert_eq!(
            frozen.require_same_private_storage_statement(
                &frozen,
                stored.as_bytes(),
                renewed.as_bytes()
            ),
            Err(ContractError::Immutable)
        );
    }
}
