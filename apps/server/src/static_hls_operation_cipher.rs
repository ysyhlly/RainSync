//! Inactive pure operation channel adapter. No App, route, DB or owner caller.
//! Compatible with the existing source-key AES-GCM channel: 12 nonce bytes,
//! encrypted plaintext + 16-byte tag, standard padded base64, no additional AAD.
//! Callers supply a fresh encryption nonce and trustworthy expected observations;
//! this module neither generates credentials nor consumes operation challenges.
#![allow(dead_code)]
use aes_gcm::{Aes256Gcm, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::contracts::{ContractError, Result, operation::*};

pub(super) fn seal_request(
    cipher: &Aes256Gcm,
    nonce: [u8; 12],
    request: &OperationRequest,
    action: Action,
    expected: &ExpectedBinding,
    now_ms: u64,
    authority: CallAuthority<'_>,
) -> Result<String> {
    request.validate_expected(action, expected, now_ms, authority)?;
    seal(
        cipher,
        nonce,
        request.private_transport_plaintext(),
        MAX_REQUEST_PLAINTEXT_BYTES,
        validate_request_ciphertext_size,
    )
}
pub(super) fn open_request(
    cipher: &Aes256Gcm,
    body: &[u8],
    action: Action,
    expected: &ExpectedBinding,
    now_ms: u64,
    authority: CallAuthority<'_>,
) -> Result<OperationRequest> {
    let plaintext = open(
        cipher,
        body,
        MAX_REQUEST_PLAINTEXT_BYTES,
        validate_request_ciphertext_size,
    )?;
    let request = OperationRequest::parse_private_plaintext(&plaintext)?;
    request.validate_expected(action, expected, now_ms, authority)?;
    Ok(request)
}
pub(super) fn seal_response(
    cipher: &Aes256Gcm,
    nonce: [u8; 12],
    response: &OperationResponse,
    action: Action,
    expected: &ExpectedBinding,
    now_ms: u64,
    authority: CallAuthority<'_>,
) -> Result<String> {
    response.validate_expected(action, expected, now_ms, authority)?;
    seal(
        cipher,
        nonce,
        response.private_transport_plaintext(),
        MAX_RESPONSE_PLAINTEXT_BYTES,
        validate_response_ciphertext_size,
    )
}
pub(super) fn open_response(
    cipher: &Aes256Gcm,
    body: &[u8],
    action: Action,
    expected: &ExpectedBinding,
    now_ms: u64,
    authority: CallAuthority<'_>,
) -> Result<OperationResponse> {
    let plaintext = open(
        cipher,
        body,
        MAX_RESPONSE_PLAINTEXT_BYTES,
        validate_response_ciphertext_size,
    )?;
    let response = OperationResponse::parse_private_plaintext(&plaintext)?;
    response.validate_expected(action, expected, now_ms, authority)?;
    Ok(response)
}

fn seal(
    cipher: &Aes256Gcm,
    nonce: [u8; 12],
    plaintext: &[u8],
    maximum: usize,
    ciphertext_size: fn(&[u8]) -> Result<()>,
) -> Result<String> {
    if plaintext.is_empty() || plaintext.len() > maximum {
        return Err(ContractError::Bounds);
    }
    let encrypted = cipher
        .encrypt((&nonce).into(), plaintext)
        .map_err(|_| ContractError::Facts)?;
    let mut bytes = Vec::with_capacity(12 + encrypted.len());
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&encrypted);
    let encoded = STANDARD.encode(bytes);
    ciphertext_size(encoded.as_bytes())?;
    Ok(encoded)
}
fn open(
    cipher: &Aes256Gcm,
    body: &[u8],
    maximum: usize,
    ciphertext_size: fn(&[u8]) -> Result<()>,
) -> Result<Vec<u8>> {
    // Bound the actual encoded body before base64 allocation. An eventual HTTP
    // consumer must independently bound streaming bodies before collecting them.
    ciphertext_size(body)?;
    let bytes = STANDARD.decode(body).map_err(|_| ContractError::Facts)?;
    if bytes.len() < 12 + 16 {
        return Err(ContractError::Facts);
    }
    let plaintext = cipher
        .decrypt(bytes[..12].into(), &bytes[12..])
        .map_err(|_| ContractError::Facts)?;
    if plaintext.is_empty() || plaintext.len() > maximum {
        return Err(ContractError::Bounds);
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::KeyInit;
    use media_core::static_hls::contracts::input::FrozenInput;

    fn cipher() -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&[0x42; 32]).unwrap()
    }
    fn expected() -> ExpectedBinding {
        let input = FrozenInput::parse_private_plaintext(include_bytes!(
            "../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json"
        ))
        .unwrap();
        ExpectedBinding::from_trusted_input(
            &input,
            &input.identity_statement(),
            ChallengeObservation {
                challenge: "00000000-0000-0000-0000-0000000000aa".into(),
                cache_challenge_sha256: "c".repeat(64),
                challenge_expires_at_ms: 8_000,
            },
            RpcWindow {
                issued_at_ms: 2_000,
                rpc_expires_at_ms: 8_000,
            },
            2_000,
        )
        .unwrap()
    }
    fn unchecked_seal(plaintext: &[u8]) -> String {
        // Synthetic fixture only: bypass size guard to test actual encrypted
        // oversize/old-purpose rejects. Never accepts a production key.
        let nonce = [0x17; 12];
        let encrypted = cipher().encrypt((&nonce).into(), plaintext).unwrap();
        STANDARD.encode([nonce.to_vec(), encrypted].concat())
    }
    #[test]
    fn actual_request_and_response_ciphertext_limits() {
        for (plain_limit, cipher_limit, validate) in [
            (
                MAX_REQUEST_PLAINTEXT_BYTES,
                MAX_REQUEST_CIPHERTEXT_BYTES,
                validate_request_ciphertext_size as fn(&[u8]) -> Result<()>,
            ),
            (
                MAX_RESPONSE_PLAINTEXT_BYTES,
                MAX_RESPONSE_CIPHERTEXT_BYTES,
                validate_response_ciphertext_size as fn(&[u8]) -> Result<()>,
            ),
        ] {
            let plaintext = vec![b'x'; plain_limit];
            let encoded = seal(&cipher(), [0x17; 12], &plaintext, plain_limit, validate).unwrap();
            assert_eq!(encoded.len(), cipher_limit);
            assert_eq!(
                open(&cipher(), encoded.as_bytes(), plain_limit, validate).unwrap(),
                plaintext
            );
            let too_large = vec![b'x'; plain_limit + 1];
            let actual = unchecked_seal(&too_large);
            assert_eq!(actual.len(), cipher_limit + 4);
            assert_eq!(validate(actual.as_bytes()), Err(ContractError::Bounds));
            assert_eq!(
                seal(&cipher(), [0x17; 12], &too_large, plain_limit, validate),
                Err(ContractError::Bounds)
            );
            // Also exercise authenticated plaintext overbound independently of
            // a larger body ceiling; real request/response ceilings reject first.
            assert_eq!(
                open(
                    &cipher(),
                    actual.as_bytes(),
                    plain_limit,
                    validate_response_ciphertext_size
                ),
                Err(ContractError::Bounds)
            );
            assert_eq!(
                seal(&cipher(), [0x17; 12], b"", plain_limit, validate),
                Err(ContractError::Bounds)
            );
        }
    }
    #[test]
    fn actual_maximum_sized_closed_envelopes_authenticate_before_typed_parsing() {
        let expected = expected();
        let request = OperationRequest::for_expected(
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        let response = OperationResponse::for_expected(
            Action::Query,
            &expected,
            OperationResult::Unknown {
                capture_id: None,
                reason: Reason::Unavailable,
            },
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        let mut request_plaintext = request.private_transport_plaintext().to_vec();
        request_plaintext.resize(MAX_REQUEST_PLAINTEXT_BYTES, b' ');
        let request_body = unchecked_seal(&request_plaintext);
        assert_eq!(request_plaintext.len(), 3_044);
        assert_eq!(request_body.len(), 4_096);
        open_request(
            &cipher(),
            request_body.as_bytes(),
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        let mut response_plaintext = response.private_transport_plaintext().to_vec();
        response_plaintext.resize(MAX_RESPONSE_PLAINTEXT_BYTES, b' ');
        let response_body = unchecked_seal(&response_plaintext);
        assert_eq!(response_plaintext.len(), 6_116);
        assert_eq!(response_body.len(), 8_192);
        open_response(
            &cipher(),
            response_body.as_bytes(),
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        request_plaintext.push(b' ');
        response_plaintext.push(b' ');
        assert!(matches!(
            open_request(
                &cipher(),
                unchecked_seal(&request_plaintext).as_bytes(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Bounds)
        ));
        assert!(matches!(
            open_response(
                &cipher(),
                unchecked_seal(&response_plaintext).as_bytes(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Bounds)
        ));
        for purpose in [
            "rainsync-static-hls-contract-request-v1",
            "rainsync-static-hls-query-response-v1",
        ] {
            let text = std::str::from_utf8(request.private_transport_plaintext())
                .unwrap()
                .replace("rainsync-static-hls-query-request-v1", purpose);
            assert!(matches!(
                open_request(
                    &cipher(),
                    unchecked_seal(text.as_bytes()).as_bytes(),
                    Action::Query,
                    &expected,
                    2_000,
                    CallAuthority::ObservationOnly
                ),
                Err(ContractError::Version)
            ));
        }
    }
    #[test]
    fn typed_round_trip_authentication_purpose_binding_and_expiry() {
        let expected = expected();
        let request = OperationRequest::for_expected(
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        let response = OperationResponse::for_expected(
            Action::Query,
            &expected,
            OperationResult::Unknown {
                capture_id: None,
                reason: Reason::LocalOwnerMissing,
            },
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        let encrypted = seal_request(
            &cipher(),
            [0x17; 12],
            &request,
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        assert!(
            open_request(
                &cipher(),
                encrypted.as_bytes(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            )
            .is_ok()
        );
        let encrypted = seal_response(
            &cipher(),
            [0x18; 12],
            &response,
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
        assert!(
            open_response(
                &cipher(),
                encrypted.as_bytes(),
                Action::Query,
                &expected,
                7_999,
                CallAuthority::ObservationOnly
            )
            .is_ok()
        );
        assert!(matches!(
            open_response(
                &cipher(),
                encrypted.as_bytes(),
                Action::Query,
                &expected,
                8_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Deadline)
        ));
        assert!(matches!(
            open_response(
                &cipher(),
                encrypted.as_bytes(),
                Action::Cancel,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Version)
        ));
        assert!(matches!(
            open_request(
                &cipher(),
                encrypted.as_bytes(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Shape)
        ));
        assert!(matches!(
            open_response(
                &cipher(),
                response.private_transport_plaintext(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Facts)
        ));
        for body in [b"%%%".as_slice(), b"AA==".as_slice(), b"".as_slice()] {
            assert!(
                open_response(
                    &cipher(),
                    body,
                    Action::Query,
                    &expected,
                    2_000,
                    CallAuthority::ObservationOnly
                )
                .is_err()
            );
        }
        let mut tampered = STANDARD.decode(&encrypted).unwrap();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(matches!(
            open_response(
                &cipher(),
                STANDARD.encode(tampered).as_bytes(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Facts)
        ));
        let wrong_key = Aes256Gcm::new_from_slice(&[0x43; 32]).unwrap();
        assert!(matches!(
            open_response(
                &wrong_key,
                encrypted.as_bytes(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Facts)
        ));
        for purpose in [
            "rainsync-static-hls-contract-response-v1",
            "rainsync-static-hls-contract-request-v1",
            "rainsync-static-hls-query-request-v1",
        ] {
            let text = std::str::from_utf8(response.private_transport_plaintext())
                .unwrap()
                .replace("rainsync-static-hls-query-response-v1", purpose);
            assert!(matches!(
                open_response(
                    &cipher(),
                    unchecked_seal(text.as_bytes()).as_bytes(),
                    Action::Query,
                    &expected,
                    2_000,
                    CallAuthority::ObservationOnly
                ),
                Err(ContractError::Version)
            ));
        }
        let text = std::str::from_utf8(response.private_transport_plaintext())
            .unwrap()
            .replace("cccccccc", "dddddddd");
        assert!(matches!(
            open_response(
                &cipher(),
                unchecked_seal(text.as_bytes()).as_bytes(),
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Identity)
        ));
    }
}
