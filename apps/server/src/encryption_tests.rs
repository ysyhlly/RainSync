//! Pure shared-cipher regression tests. All keys and values are synthetic;
//! these tests create no App, database pool, HTTP client or external account.
use crate::{decrypt_value, encrypt_value};
use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::HashSet;

#[test]
fn shared_encryption_keeps_standard_base64_nonce_ciphertext_tag_framing() {
    let key = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
    for value in [
        Value::Null,
        json!(true),
        json!(i64::MIN),
        json!(u64::MAX),
        json!("synthetic \"cookie\" \u{96e8}\n"),
        json!([null, false, 1.25, {"nested": ["value"]}]),
        json!({"version": 1, "revision": i64::MAX.to_string(), "value": "fixture-only"}),
    ] {
        let serialized = serde_json::to_vec(&value).unwrap();
        let encoded = encrypt_value(&key, &value).unwrap();
        let bytes = STANDARD.decode(&encoded).unwrap();
        assert_eq!(STANDARD.encode(&bytes), encoded);
        // Existing storage is STANDARD base64 of a 12-byte nonce followed by
        // AES-256-GCM ciphertext and its 16-byte tag, without a new prefix/AAD.
        assert_eq!(bytes.len(), 12 + serialized.len() + 16);
        let plaintext = key.decrypt(bytes[..12].into(), &bytes[12..]).unwrap();
        assert_eq!(plaintext, serialized);
        assert_eq!(serde_json::from_slice::<Value>(&plaintext).unwrap(), value);
    }
}

#[test]
fn shared_encryption_authenticates_nonce_ciphertext_tag_and_key_without_aad() {
    let key = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
    let wrong_key = Aes256Gcm::new_from_slice(&[0x43; 32]).unwrap();
    let bytes = STANDARD
        .decode(encrypt_value(&key, &json!({"value": "fixture-only"})).unwrap())
        .unwrap();
    for changed_index in [0, 12, bytes.len() - 1] {
        let mut changed = bytes.clone();
        changed[changed_index] ^= 1;
        assert!(key.decrypt(changed[..12].into(), &changed[12..]).is_err());
    }
    assert!(wrong_key.decrypt(bytes[..12].into(), &bytes[12..]).is_err());
    assert!(
        key.decrypt(
            bytes[..12].into(),
            Payload {
                msg: &bytes[12..],
                aad: b"not-part-of-the-original-framing",
            },
        )
        .is_err()
    );
}

#[test]
fn shared_encryption_uses_fresh_nonces_for_repeated_values() {
    let key = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
    let value = json!({"value": "fixture-only"});
    let mut nonces = HashSet::new();
    for _ in 0..8 {
        let bytes = STANDARD
            .decode(encrypt_value(&key, &value).unwrap())
            .unwrap();
        assert!(nonces.insert(bytes[..12].to_vec()));
    }
}

#[test]
fn shared_decryption_keeps_existing_framing_and_json_values() {
    let key = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
    for value in [
        Value::Null,
        json!(false),
        json!(u64::MAX),
        json!("雨"),
        json!({"nested": [1, null, "x"]}),
    ] {
        let cipher = encrypt_value(&key, &value).unwrap();
        assert_eq!(decrypt_value(&key, &cipher).unwrap(), value);
    }
}

#[test]
fn shared_decryption_preserves_failure_stages_without_accepting_corrupt_data() {
    let key = Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap();
    let error = decrypt_value(&key, "not standard base64!").unwrap_err();
    assert!(error.downcast_ref::<base64::DecodeError>().is_some());
    for size in 0..12 {
        assert_eq!(
            decrypt_value(&key, &STANDARD.encode(vec![0; size]))
                .unwrap_err()
                .to_string(),
            "invalid_ciphertext"
        );
    }
    for size in 12..28 {
        assert_eq!(
            decrypt_value(&key, &STANDARD.encode(vec![0; size]))
                .unwrap_err()
                .to_string(),
            "decryption_failed"
        );
    }
    let bytes = STANDARD
        .decode(encrypt_value(&key, &json!({"synthetic":true})).unwrap())
        .unwrap();
    for index in [0, 12, bytes.len() - 1] {
        let mut corrupt = bytes.clone();
        corrupt[index] ^= 1;
        assert_eq!(
            decrypt_value(&key, &STANDARD.encode(corrupt))
                .unwrap_err()
                .to_string(),
            "decryption_failed"
        );
    }
    let wrong_key = Aes256Gcm::new_from_slice(&[0x43; 32]).unwrap();
    assert_eq!(
        decrypt_value(&wrong_key, &STANDARD.encode(bytes))
            .unwrap_err()
            .to_string(),
        "decryption_failed"
    );
    let nonce = [7u8; 12];
    let invalid_json = key
        .encrypt((&nonce).into(), b"not-json".as_slice())
        .unwrap();
    let cipher = STANDARD.encode([nonce.to_vec(), invalid_json].concat());
    let error = decrypt_value(&key, &cipher).unwrap_err();
    assert!(error.downcast_ref::<serde_json::Error>().is_some());
}
