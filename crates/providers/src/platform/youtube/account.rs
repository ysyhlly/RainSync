//! Opaque viewer-owned YouTube session, reduced to a bounded cookie file.
//! No browser extraction, Google-domain cookies, OAuth tokens or executable
//! configuration are accepted. Import does not assert an upstream login.
use super::{Error, Result};
use std::{collections::BTreeMap, fmt};

pub(crate) mod custody;

pub const MAX_COOKIE_FILE_BYTES: usize = 32 * 1024;
const MAX_COOKIES: usize = 32;
const MAX_VALUE_BYTES: usize = 4096;

#[derive(Clone)]
pub struct Credential {
    file: String,
    expires_at_ms: Option<i64>,
}
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("YoutubeCredential([REDACTED])")
    }
}
impl Credential {
    /// Only the Netscape export format and youtube.com host family are allowed.
    /// Non-account YouTube cookies are discarded; a foreign-domain line fails
    /// the entire import instead of retaining another service's credentials.
    pub fn parse(input: &str, now_seconds: u64) -> Result<Self> {
        if input.is_empty()
            || input.len() > MAX_COOKIE_FILE_BYTES
            || !input.is_ascii()
            || input
                .bytes()
                .any(|b| b.is_ascii_control() && !matches!(b, b'\t' | b'\r' | b'\n'))
        {
            return Err(Error::InvalidResource);
        }
        if !matches!(
            input.lines().next(),
            Some("# Netscape HTTP Cookie File" | "# HTTP Cookie File")
        ) {
            return Err(Error::InvalidResource);
        }
        let mut cookies = BTreeMap::new();
        let mut lines = 0;
        let mut earliest = None::<u64>;
        for raw in input.lines() {
            let raw = raw.strip_suffix('\r').unwrap_or(raw);
            if raw.is_empty() || (raw.starts_with('#') && !raw.starts_with("#HttpOnly_")) {
                continue;
            }
            lines += 1;
            if lines > MAX_COOKIES {
                return Err(Error::InvalidResource);
            }
            let raw = raw.strip_prefix("#HttpOnly_").unwrap_or(raw);
            let fields = raw.split('\t').collect::<Vec<_>>();
            if fields.len() != 7 {
                return Err(Error::InvalidResource);
            }
            let [domain, subdomains, path, secure, expires, name, value] = fields.as_slice() else {
                unreachable!()
            };
            if !matches!(*domain, ".youtube.com" | "youtube.com" | "www.youtube.com")
                || !matches!(*subdomains, "TRUE" | "FALSE")
                || (*subdomains == "TRUE" && *domain != ".youtube.com")
                || expires.is_empty()
                || !expires.bytes().all(|b| b.is_ascii_digit())
                || expires.len() > 11
                || name.is_empty()
                || value.is_empty()
                || value.len() > MAX_VALUE_BYTES
                || value
                    .bytes()
                    .any(|b| b.is_ascii_whitespace() || matches!(b, b';' | b',' | b'\\' | b'"'))
            {
                return Err(Error::InvalidResource);
            }
            let expires = expires.parse::<u64>().map_err(|_| Error::InvalidResource)?;
            if expires > i64::MAX as u64 / 1000 {
                return Err(Error::InvalidResource);
            }
            if !allowed_cookie(name) {
                continue;
            }
            if *path != "/" || !matches!(*secure, "TRUE" | "FALSE") {
                return Err(Error::InvalidResource);
            }
            if expires != 0 && expires <= now_seconds {
                return Err(Error::InvalidResource);
            }
            if expires != 0 {
                earliest = Some(earliest.map_or(expires, |old| old.min(expires)));
            }
            if account_cookie(name) && value.len() < 16 {
                return Err(Error::InvalidResource);
            }
            if cookies
                .insert(
                    (*name).to_owned(),
                    // Upgrade every retained cookie to HTTPS-only, including older
                    // exports whose account cookie did not carry the Secure flag.
                    format!("{domain}\t{subdomains}\t/\tTRUE\t{expires}\t{name}\t{value}\n"),
                )
                .is_some()
            {
                return Err(Error::InvalidResource);
            }
        }
        // Match the maintained extractor's minimum account-cookie shape. SID
        // alone is not enough: it would silently leave extraction anonymous.
        // https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/extractor/youtube/_base.py#L812-L817
        if !cookies.contains_key("LOGIN_INFO")
            || !["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]
                .iter()
                .any(|key| cookies.contains_key(*key))
        {
            return Err(Error::InvalidResource);
        }
        let mut file = String::from("# Netscape HTTP Cookie File\n");
        for line in cookies.values() {
            file.push_str(line);
        }
        if file.len() > MAX_COOKIE_FILE_BYTES {
            return Err(Error::InvalidResource);
        }
        Ok(Self {
            file,
            expires_at_ms: earliest.map(|value| (value * 1000) as i64),
        })
    }
    /// Encrypted vault use only; never serialize this value into a public DTO.
    pub fn expose_for_storage(&self) -> &str {
        &self.file
    }
    pub fn expires_at_ms(&self) -> Option<i64> {
        self.expires_at_ms
    }
}

fn account_cookie(name: &str) -> bool {
    matches!(
        name,
        "SID"
            | "SAPISID"
            | "LOGIN_INFO"
            | "__Secure-1PSID"
            | "__Secure-3PSID"
            | "__Secure-1PAPISID"
            | "__Secure-3PAPISID"
    )
}
fn allowed_cookie(name: &str) -> bool {
    account_cookie(name)
        || matches!(
            name,
            "HSID"
                | "SSID"
                | "APISID"
                | "__Secure-1PSIDTS"
                | "__Secure-3PSIDTS"
                | "__Secure-1PSIDCC"
                | "__Secure-3PSIDCC"
                | "SIDCC"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(name: &str, expires: u64) -> String {
        format!(".youtube.com\tTRUE\t/\tTRUE\t{expires}\t{name}\tsynthetic-session-only\n")
    }
    fn file(lines: String) -> String {
        format!("# Netscape HTTP Cookie File\n{lines}")
    }
    #[test]
    fn bounded_netscape_import_reduces_to_youtube_session_fields() {
        let input = format!(
            "# Netscape HTTP Cookie File\n# comment\n#HttpOnly_{}{}{}",
            line("SAPISID", 200),
            line("LOGIN_INFO", 200),
            line("VISITOR_INFO1_LIVE", 500)
        );
        let parsed = Credential::parse(&input, 100).unwrap();
        assert!(parsed.expose_for_storage().contains("\tSAPISID\t"));
        assert!(!parsed.expose_for_storage().contains("VISITOR_INFO"));
        assert_eq!(parsed.expires_at_ms(), Some(200000));
        assert!(!format!("{parsed:?}").contains("synthetic-session"));
        let parsed = Credential::parse(
            &file(format!("{}{}", line("SAPISID", 200), line("LOGIN_INFO", 0))),
            100,
        )
        .unwrap();
        assert_eq!(parsed.expires_at_ms(), Some(200000));
    }
    #[test]
    fn foreign_malformed_expired_duplicate_and_injected_lines_fail_closed() {
        let good = file(format!(
            "{}{}",
            line("SAPISID", 200),
            line("LOGIN_INFO", 200)
        ));
        for input in [
            good.replace(".youtube.com", ".google.com"),
            good.replace(".youtube.com", ".youtube.com.attacker.test"),
            good.replace("\tTRUE\t200", "\tmaybe\t200"),
            file(line("SID", 99)),
            format!("{good}{good}"),
            good.replace("\t/\t", "\t/private\t"),
            good.replace("synthetic-session-only", "injected;cookie=value"),
            good.replace("synthetic-session-only", "short"),
            good.replace("\t200\t", "\t-1\t"),
            "SID=synthetic-session-only".into(),
            file(line("VISITOR_INFO1_LIVE", 200)),
        ] {
            assert!(Credential::parse(&input, 100).is_err());
        }
        assert!(Credential::parse(&"x".repeat(MAX_COOKIE_FILE_BYTES + 1), 100).is_err());
    }
    #[test]
    fn legacy_secure_flag_is_upgraded_and_known_expiry_is_never_hidden_by_session_fields() {
        let input = file(format!(
            "{}{}",
            line("SAPISID", 200).replace("\tTRUE\t200", "\tFALSE\t200"),
            line("LOGIN_INFO", 0)
        ));
        let parsed = Credential::parse(&input, 100).unwrap();
        assert!(!parsed.expose_for_storage().contains("\tFALSE\t200"));
        assert!(parsed.expose_for_storage().contains("\tTRUE\t200"));
        assert_eq!(parsed.expires_at_ms(), Some(200000));
        assert_eq!(
            Credential::parse(
                &file(format!("{}{}", line("LOGIN_INFO", 0), line("SAPISID", 0))),
                100
            )
            .unwrap()
            .expires_at_ms(),
            None
        );
    }
    #[test]
    fn single_auth_cookie_cannot_accidentally_choose_anonymous_extraction() {
        for name in [
            "SID",
            "SAPISID",
            "LOGIN_INFO",
            "__Secure-1PAPISID",
            "__Secure-3PAPISID",
        ] {
            assert!(Credential::parse(&file(line(name, 0)), 100).is_err());
        }
        for name in ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"] {
            assert!(
                Credential::parse(
                    &file(format!("{}{}", line(name, 0), line("LOGIN_INFO", 0))),
                    100
                )
                .is_ok()
            );
        }
    }
}
