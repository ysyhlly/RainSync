//! Inner authenticated bindings for ciphertexts encrypted without AAD.
//!
//! The envelopes are intentionally constructed/validated explicitly. Neither
//! account credentials nor QR polling secrets implement Debug or Serialize.
use serde_json::{Value, json};
use uuid::Uuid;

pub(super) const PROVIDER: &str = "bilibili";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct AccountScope {
    pub user_id: Uuid,
    pub account_id: Uuid,
    pub revision: i64,
}

pub(super) fn credential_plaintext(scope: AccountScope, cookies: Value) -> Value {
    credential_plaintext_for_provider(scope, PROVIDER, cookies)
}

pub(super) fn credential_plaintext_for_provider(
    scope: AccountScope,
    provider: &str,
    cookies: Value,
) -> Value {
    json!({
        "version": 1,
        "user_id": scope.user_id,
        "provider": provider,
        "account_id": scope.account_id,
        "revision": scope.revision.to_string(),
        "cookies": cookies,
    })
}

pub(super) fn credential_cookies(scope: AccountScope, value: Value) -> Option<Value> {
    credential_cookies_for_provider(scope, PROVIDER, value)
}

pub(super) fn credential_cookies_for_provider(
    scope: AccountScope,
    provider: &str,
    value: Value,
) -> Option<Value> {
    if !matches!(provider, "bilibili" | "douyin" | "tiktok" | "youtube") {
        return None;
    }
    let fields = value.as_object()?;
    if fields.len() != 6
        || fields.get("version")?.as_u64()? != 1
        || fields.get("user_id")?.as_str()? != scope.user_id.to_string()
        || fields.get("provider")?.as_str()? != provider
        || fields.get("account_id")?.as_str()? != scope.account_id.to_string()
        || fields.get("revision")?.as_str()? != scope.revision.to_string()
        || scope.revision <= 0
    {
        return None;
    }
    fields.get("cookies").cloned()
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct QrScope {
    pub account: AccountScope,
    pub request_id: Uuid,
    pub login_hash: String,
}

pub(super) fn qr_plaintext(scope: &QrScope, purpose: &str, secret: &str) -> Value {
    json!({
        "version": 1,
        "purpose": purpose,
        "provider": PROVIDER,
        "user_id": scope.account.user_id,
        "account_id": scope.account.account_id,
        "account_revision": scope.account.revision.to_string(),
        "request_id": scope.request_id,
        "auth_login_hash": scope.login_hash,
        "value": secret,
    })
}

pub(super) fn qr_secret(scope: &QrScope, purpose: &str, value: Value) -> Option<String> {
    let fields = value.as_object()?;
    if fields.len() != 9
        || fields.get("version")?.as_u64()? != 1
        || fields.get("purpose")?.as_str()? != purpose
        || fields.get("provider")?.as_str()? != PROVIDER
        || fields.get("user_id")?.as_str()? != scope.account.user_id.to_string()
        || fields.get("account_id")?.as_str()? != scope.account.account_id.to_string()
        || fields.get("account_revision")?.as_str()? != scope.account.revision.to_string()
        || fields.get("request_id")?.as_str()? != scope.request_id.to_string()
        || fields.get("auth_login_hash")?.as_str()? != scope.login_hash
        || scope.account.revision <= 0
    {
        return None;
    }
    Some(fields.get("value")?.as_str()?.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> AccountScope {
        AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 9,
        }
    }

    #[test]
    fn credential_envelope_requires_every_exact_binding() {
        let scope = account();
        let cookies = json!({"SESSDATA": "pure-fixture-secret"});
        let value = credential_plaintext(scope, cookies.clone());
        assert_eq!(credential_cookies(scope, value.clone()), Some(cookies));
        for (field, other) in [
            ("version", json!(2)),
            ("user_id", json!(Uuid::from_u128(10))),
            ("provider", json!("another_provider")),
            ("account_id", json!(Uuid::from_u128(20))),
            ("revision", json!("10")),
            ("revision", json!(9)),
            ("revision", json!("09")),
        ] {
            let mut changed = value.clone();
            changed[field] = other;
            assert!(credential_cookies(scope, changed).is_none());
        }
        let mut changed = value;
        changed["unexpected"] = json!(true);
        assert!(credential_cookies(scope, changed).is_none());
    }

    #[test]
    fn short_credential_envelopes_are_provider_user_account_and_revision_bound() {
        let scope = account();
        for provider in ["douyin", "tiktok", "youtube"] {
            let cookies = json!("sessionid=fixture-not-a-real-session");
            let value = credential_plaintext_for_provider(scope, provider, cookies.clone());
            assert_eq!(
                credential_cookies_for_provider(scope, provider, value.clone()),
                Some(cookies)
            );
            for other in ["bilibili", "douyin", "tiktok", "youtube", "unknown"] {
                if provider != other {
                    assert!(credential_cookies_for_provider(scope, other, value.clone()).is_none());
                }
            }
            for changed_scope in [
                AccountScope {
                    user_id: Uuid::from_u128(99),
                    ..scope
                },
                AccountScope {
                    account_id: Uuid::from_u128(99),
                    ..scope
                },
                AccountScope {
                    revision: scope.revision + 1,
                    ..scope
                },
            ] {
                assert!(
                    credential_cookies_for_provider(changed_scope, provider, value.clone())
                        .is_none()
                );
            }
            let mut changed = value.clone();
            changed["unexpected"] = json!(true);
            assert!(credential_cookies_for_provider(scope, provider, changed).is_none());
            let mut changed = value;
            changed["revision"] = json!(scope.revision);
            assert!(credential_cookies_for_provider(scope, provider, changed).is_none());
        }
        // The original six-field Bilibili cookie-object envelope remains valid.
        let legacy = credential_plaintext(scope, json!({"SESSDATA": "fixture-only"}));
        assert!(credential_cookies(scope, legacy).is_some());
    }

    #[test]
    fn qr_ciphertext_cannot_move_between_requests_logins_or_purposes() {
        let scope = QrScope {
            account: account(),
            request_id: Uuid::from_u128(3),
            login_hash: "a".repeat(64),
        };
        let value = qr_plaintext(&scope, "qr_poll_key", "fixture-key");
        assert_eq!(
            qr_secret(&scope, "qr_poll_key", value.clone()).as_deref(),
            Some("fixture-key")
        );
        assert!(qr_secret(&scope, "qr_payload", value.clone()).is_none());
        let mut other = scope.clone();
        other.request_id = Uuid::from_u128(4);
        assert!(qr_secret(&other, "qr_poll_key", value.clone()).is_none());
        other = scope.clone();
        other.login_hash = "b".repeat(64);
        assert!(qr_secret(&other, "qr_poll_key", value.clone()).is_none());
        other = scope.clone();
        other.account.revision += 1;
        assert!(qr_secret(&other, "qr_poll_key", value).is_none());
    }
}
