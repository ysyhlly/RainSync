//! Strict, origin-bound import of existing browser login cookies. This parser
//! does not authenticate an account, refresh a session, execute a challenge, or
//! accept exported browser databases/Set-Cookie/Netscape/JSON formats.
//!
//! Login-cookie provenance: TikTok's first-party cookie policy identifies sid_tt
//! as login state (https://www.tiktok.com/legal/tiktok-website-cookies-policy).
//! The platform-session cookie names are also documented by the adapter author:
//! https://www.douyin.wtf/identities-and-proxies/ . No anti-bot/fingerprint or
//! cross-site SSO cookies are permitted by this intentionally narrow policy.

use super::{Error, Platform, Result};
use std::{collections::BTreeMap, fmt};

pub const MAX_COOKIE_HEADER_BYTES: usize = 8192;
const MAX_COOKIES: usize = 32;
const MAX_COOKIE_VALUE_BYTES: usize = 2048;

/// Opaque server-side session state. Deliberately has no Serialize/Deserialize
/// implementation. The bound platform cannot be changed after parsing.
#[derive(Clone)]
pub struct Credential {
    platform: Platform,
    header: String,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("platform", &self.platform)
            .field("cookie", &"[REDACTED]")
            .finish()
    }
}

impl Credential {
    /// Parse a bounded ASCII Cookie header value, not a complete HTTP header.
    /// Exactly one name/value pair is required per semicolon-separated entry.
    /// Unrecognized names, attributes, duplicate names (including case aliases),
    /// controls, whitespace in values, quotes and escaping are all rejected.
    /// Requiring a session cookie is only a syntactic check, never login proof.
    pub fn parse(platform: Platform, raw_cookie: &str) -> Result<Self> {
        let invalid = || Error::InvalidResponse("credential");
        if raw_cookie.is_empty()
            || raw_cookie.len() > MAX_COOKIE_HEADER_BYTES
            || !raw_cookie.is_ascii()
            || raw_cookie.bytes().any(|b| b < b' ' || b == 0x7f)
        {
            return Err(invalid());
        }
        let mut cookies = BTreeMap::new();
        let mut session = false;
        for pair in raw_cookie.split(';') {
            let pair = pair.trim_matches(' ');
            let (name, value) = pair.split_once('=').ok_or_else(invalid)?;
            if cookies.len() >= MAX_COOKIES
                || !allowed_cookie(platform, name)
                || value.is_empty()
                || value.len() > MAX_COOKIE_VALUE_BYTES
                || !value.bytes().all(cookie_octet)
                || cookies.insert(name, value).is_some()
            {
                return Err(invalid());
            }
            if matches!(name, "sessionid" | "sessionid_ss" | "sid_tt") {
                if value.len() < 16 {
                    return Err(invalid());
                }
                session = true;
            }
        }
        if !session {
            return Err(invalid());
        }
        let header = cookies
            .into_iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        if header.len() > MAX_COOKIE_HEADER_BYTES {
            return Err(invalid());
        }
        Ok(Self { platform, header })
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    /// Secret transport/encrypted-storage accessor. Do not log, serialize into
    /// DTOs, return to a browser, or include in a media URL or playback grant.
    pub fn cookie_header(&self) -> &str {
        &self.header
    }
}

fn cookie_octet(byte: u8) -> bool {
    // RFC 6265 cookie-octet: excludes controls, whitespace, DQUOTE, comma,
    // semicolon and backslash. Values are preserved, never percent-decoded.
    matches!(byte, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e)
}

fn allowed_cookie(platform: Platform, name: &str) -> bool {
    matches!(
        name,
        "sessionid"
            | "sessionid_ss"
            | "sid_tt"
            | "sid_guard"
            | "uid_tt"
            | "uid_tt_ss"
            | "sid_ucp_v1"
            | "ssid_ucp_v1"
            | "passport_csrf_token"
            | "passport_csrf_token_default"
            | "ttwid"
    ) || match platform {
        Platform::Douyin => matches!(name, "passport_auth_status" | "passport_auth_status_ss"),
        Platform::TikTok => matches!(name, "tt_csrf_token" | "tt_chain_token"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "synthetic-private-session-value";

    #[test]
    fn credentials_are_provider_bound_canonical_and_redacted() {
        for platform in [Platform::Douyin, Platform::TikTok] {
            let credential = Credential::parse(
                platform,
                &format!(" ttwid=1%7Cfixture%3D ; sessionid={SESSION} "),
            )
            .unwrap();
            assert_eq!(credential.platform(), platform);
            assert_eq!(
                credential.cookie_header(),
                format!("sessionid={SESSION}; ttwid=1%7Cfixture%3D")
            );
            assert!(!format!("{credential:?}").contains(SESSION));
            assert!(Credential::parse(platform, &format!("sid_tt={SESSION}")).is_ok());
            assert!(Credential::parse(platform, &format!("sessionid_ss={SESSION}")).is_ok());
        }
        assert!(
            Credential::parse(
                Platform::Douyin,
                &format!("sessionid={SESSION}; tt_csrf_token=fixture")
            )
            .is_err()
        );
        assert!(
            Credential::parse(
                Platform::TikTok,
                &format!("sessionid={SESSION}; passport_auth_status=fixture")
            )
            .is_err()
        );
    }

    #[test]
    fn credentials_reject_ambiguous_exports_injection_and_challenge_state() {
        for cookie in [
            "".to_owned(),
            "sessionid=short".to_owned(),
            "ttwid=anonymous-only".to_owned(),
            format!("Cookie: sessionid={SESSION}"),
            format!("sessionid={SESSION};"),
            format!("sessionid={SESSION};; ttwid=fixture"),
            format!("sessionid={SESSION}; sessionid=another-private-session"),
            format!("sessionid={SESSION}; SessionId=another-private-session"),
            format!("sessionid={SESSION}; Domain=.tiktok.com"),
            format!("sessionid={SESSION}; Path=/"),
            format!("sessionid={SESSION}; Secure"),
            format!("sessionid={SESSION}; HttpOnly"),
            format!("sessionid={SESSION}; _wafchallengeid=private-challenge"),
            format!("sessionid={SESSION}; s_v_web_id=private-fingerprint"),
            format!("sessionid={SESSION}; msToken=private-challenge"),
            format!("sessionid={SESSION}\r\nHost:evil.example"),
            format!("sessionid={SESSION}\t"),
            format!("sessionid=\"{SESSION}\""),
            format!("sessionid={SESSION}\\escape"),
            format!("sessionid={SESSION},evil=value"),
            format!("sessionid={SESSION} extra=value"),
            format!("sessionid = {SESSION}"),
            format!("sessionid={SESSION}\u{00a0}"),
            format!("{{\"sessionid\":\"{SESSION}\"}}"),
            format!(
                "# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\t{SESSION}"
            ),
            format!("sessionid={}", "x".repeat(MAX_COOKIE_VALUE_BYTES + 1)),
            format!("sessionid={}", "x".repeat(MAX_COOKIE_HEADER_BYTES + 1)),
        ] {
            for platform in [Platform::Douyin, Platform::TikTok] {
                let error = Credential::parse(platform, &cookie).unwrap_err();
                assert_eq!(error, Error::InvalidResponse("credential"));
                let error = format!("{error} {error:?}");
                assert!(!error.contains(SESSION));
                assert!(!error.contains("private-challenge"));
            }
        }
    }
}
