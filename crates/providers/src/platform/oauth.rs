//! Official developer-app authorization, separate from consumer web cookies.
//! No OAuth token in this module is usable as a playback account credential.
//! Sources (checked 2026-10-05): TikTok Login Kit QR/token docs and Douyin
//! account-permission get-code/get-access-token/refresh-access-token docs.
use reqwest::Url;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, future::Future, pin::Pin};
use tokio::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Douyin,
    TikTok,
}
impl Provider {
    pub fn parse(value: &str) -> Result<Self, Error> {
        match value {
            "douyin" => Ok(Self::Douyin),
            "tiktok" => Ok(Self::TikTok),
            _ => Err(Error::Invalid),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Douyin => "douyin",
            Self::TikTok => "tiktok",
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Self::Douyin => "DOUYIN_OAUTH",
            Self::TikTok => "TIKTOK_OAUTH",
        }
    }
    fn identity_scope(self) -> &'static str {
        match self {
            Self::Douyin => "user_info",
            Self::TikTok => "user.info.basic",
        }
    }
    pub fn callback_path(self) -> String {
        format!("/api/v1/platform-accounts/{}/oauth/callback", self.name())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Denied,
    Expired,
    Upstream,
    Uncertain,
}
/// Contains an application secret. Deliberately not Debug/Serialize.
pub struct Config {
    provider: Provider,
    client_key: String,
    client_secret: String,
    redirect_uri: Url,
    qr: bool,
    binding: String,
}
struct Slot {
    config: Option<Config>,
    missing: Vec<&'static str>,
}
pub struct Registry {
    douyin: Slot,
    tiktok: Slot,
}
impl Registry {
    pub fn disabled() -> Self {
        let slot = || Slot {
            config: None,
            missing: vec![
                "approved_developer_application",
                "server_client_key",
                "server_client_secret_file",
                "registered_https_callback",
                "approved_identity_scope",
            ],
        };
        Self {
            douyin: slot(),
            tiktok: slot(),
        }
    }
    /// Reads server configuration only. Never creates an app or performs login.
    /// Application approval is an explicit operator assertion, not auto-detected.
    pub fn from_env(origin: &str) -> Result<Self, Error> {
        Ok(Self {
            douyin: load_slot(Provider::Douyin, origin)?,
            tiktok: load_slot(Provider::TikTok, origin)?,
        })
    }
    fn slot(&self, provider: Provider) -> &Slot {
        match provider {
            Provider::Douyin => &self.douyin,
            Provider::TikTok => &self.tiktok,
        }
    }
    pub fn config(&self, provider: Provider) -> Option<&Config> {
        self.slot(provider).config.as_ref()
    }
    pub fn missing(&self, provider: Provider) -> &[&'static str] {
        &self.slot(provider).missing
    }
}
fn load_slot(provider: Provider, origin: &str) -> Result<Slot, Error> {
    let env = |suffix: &str| {
        std::env::var(format!("{}_{}", provider.prefix(), suffix)).unwrap_or_default()
    };
    let approved = env("APPLICATION_APPROVED") == "true";
    let key = env("CLIENT_KEY");
    let file = env("CLIENT_SECRET_FILE");
    let callback = env("REDIRECT_URI");
    let scope_approved = env("IDENTITY_SCOPE_APPROVED") == "true";
    let mut missing = Vec::new();
    if !approved {
        missing.push("approved_developer_application");
    }
    if key.is_empty() {
        missing.push("server_client_key");
    }
    if file.is_empty() {
        missing.push("server_client_secret_file");
    }
    if callback.is_empty() {
        missing.push("registered_https_callback");
    }
    if !scope_approved {
        missing.push("approved_identity_scope");
    }
    if !missing.is_empty() {
        return Ok(Slot {
            config: None,
            missing,
        });
    }
    // Never read an application secret for a disabled/unapproved application.
    let path = std::path::Path::new(&file);
    let meta = std::fs::symlink_metadata(path).map_err(|_| Error::Invalid)?;
    if !path.is_absolute() || !meta.is_file() || meta.len() > 4096 {
        return Err(Error::Invalid);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(Error::Invalid);
        }
    }
    let secret = std::fs::read_to_string(path).map_err(|_| Error::Invalid)?;
    let qr = provider == Provider::TikTok && env("QR_APPROVED") == "true";
    let config = Config::new(
        provider,
        key,
        secret.trim_end_matches(['\r', '\n']).to_owned(),
        &callback,
        origin,
        qr,
    )?;
    Ok(Slot {
        config: Some(config),
        missing,
    })
}
impl Config {
    fn new(
        provider: Provider,
        client_key: String,
        client_secret: String,
        callback: &str,
        origin: &str,
        qr: bool,
    ) -> Result<Self, Error> {
        secret(&client_key, 256)?;
        secret(&client_secret, 4096)?;
        let redirect_uri = Url::parse(callback).map_err(|_| Error::Invalid)?;
        let origin_url = Url::parse(origin).map_err(|_| Error::Invalid)?;
        if redirect_uri.scheme() != "https"
            || redirect_uri.origin() != origin_url.origin()
            || redirect_uri.path() != provider.callback_path()
            || redirect_uri.query().is_some()
            || redirect_uri.fragment().is_some()
            || !redirect_uri.username().is_empty()
            || redirect_uri.password().is_some()
            || redirect_uri.port().is_some()
            || callback != redirect_uri.as_str()
        {
            return Err(Error::Invalid);
        }
        let mut hash = Sha256::new();
        for field in [
            provider.name(),
            &client_key,
            &client_secret,
            callback,
            provider.identity_scope(),
            if qr { "qr" } else { "web" },
        ] {
            hash.update((field.len() as u64).to_be_bytes());
            hash.update(field.as_bytes());
        }
        let binding = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self {
            provider,
            client_key,
            client_secret,
            redirect_uri,
            qr,
            binding,
        })
    }
    pub fn provider(&self) -> Provider {
        self.provider
    }
    pub fn binding(&self) -> &str {
        &self.binding
    }
    pub fn qr_enabled(&self) -> bool {
        self.qr
    }
    pub fn redirect_uri(&self) -> &str {
        self.redirect_uri.as_str()
    }
    pub fn scopes(&self) -> Vec<&'static str> {
        vec![self.provider.identity_scope()]
    }
    pub fn authorize_url(&self, state: &str) -> Result<String, Error> {
        secret(state, 128)?;
        let mut url = Url::parse(match self.provider {
            Provider::Douyin => "https://open.douyin.com/platform/oauth/connect/",
            Provider::TikTok => "https://www.tiktok.com/v2/auth/authorize/",
        })
        .unwrap();
        url.query_pairs_mut()
            .append_pair("client_key", &self.client_key)
            .append_pair("response_type", "code")
            .append_pair("scope", self.provider.identity_scope())
            .append_pair("redirect_uri", self.redirect_uri.as_str())
            .append_pair("state", state);
        Ok(url.to_string())
    }
    pub fn generate_qr_request(&self, state: &str) -> Result<Request, Error> {
        if self.provider != Provider::TikTok || !self.qr {
            return Err(Error::Denied);
        }
        secret(state, 128)?;
        Ok(self.request(
            Endpoint::TikTokQr,
            vec![
                ("client_key", self.client_key.clone()),
                ("scope", self.provider.identity_scope().to_owned()),
                ("state", state.to_owned()),
            ],
        ))
    }
    pub fn poll_request(&self, token: &str) -> Result<Request, Error> {
        if !self.qr {
            return Err(Error::Denied);
        }
        secret(token, 2048)?;
        Ok(self.request(
            Endpoint::TikTokQrPoll,
            vec![
                ("client_key", self.client_key.clone()),
                ("client_secret", self.client_secret.clone()),
                ("token", token.to_owned()),
            ],
        ))
    }
    pub fn exchange_request(&self, code: &str) -> Result<Request, Error> {
        secret(code, 2048)?;
        let mut fields = vec![
            ("client_key", self.client_key.clone()),
            ("client_secret", self.client_secret.clone()),
            ("code", code.to_owned()),
            ("grant_type", "authorization_code".to_owned()),
        ];
        if self.provider == Provider::TikTok {
            fields.push(("redirect_uri", self.redirect_uri.to_string()));
        }
        Ok(self.request(
            match self.provider {
                Provider::Douyin => Endpoint::DouyinExchange,
                Provider::TikTok => Endpoint::TikTokToken,
            },
            fields,
        ))
    }
    pub fn refresh_request(&self, tokens: &Tokens) -> Result<Request, Error> {
        let mut fields = vec![
            ("client_key", self.client_key.clone()),
            ("grant_type", "refresh_token".to_owned()),
            ("refresh_token", tokens.refresh_token.clone()),
        ];
        if self.provider == Provider::TikTok {
            fields.push(("client_secret", self.client_secret.clone()));
        }
        Ok(self.request(
            match self.provider {
                Provider::Douyin => Endpoint::DouyinRefresh,
                Provider::TikTok => Endpoint::TikTokToken,
            },
            fields,
        ))
    }
    fn request(&self, endpoint: Endpoint, fields: Vec<(&'static str, String)>) -> Request {
        Request { endpoint, fields }
    }
    pub fn parse_tokens(
        &self,
        value: &Value,
        now_ms: i64,
        previous: Option<&Tokens>,
    ) -> Result<Tokens, Error> {
        let data = match self.provider {
            Provider::Douyin => {
                let data = value.get("data").ok_or(Error::Invalid)?;
                match data.get("error_code").and_then(Value::as_i64) {
                    Some(0) => {}
                    Some(10010) => return Err(Error::Expired),
                    Some(_) => return Err(Error::Upstream),
                    None => return Err(Error::Invalid),
                }
                data
            }
            Provider::TikTok => {
                if value.get("error").is_some() {
                    return Err(if value["error"] == "invalid_grant" {
                        Error::Expired
                    } else {
                        Error::Upstream
                    });
                }
                if value["token_type"] != "Bearer" {
                    return Err(Error::Invalid);
                }
                value
            }
        };
        let access_token = text(data, "access_token", 4096)?;
        let refresh_token = text(data, "refresh_token", 4096)?;
        let open_id = text(data, "open_id", 256)?;
        let scopes = parse_scopes(&text(data, "scope", 1024)?)?;
        let permitted = BTreeSet::from([self.provider.identity_scope().to_owned()]);
        if scopes.is_empty() || !scopes.is_subset(&permitted) {
            return Err(Error::Denied);
        }
        let access_max = match self.provider {
            Provider::Douyin => 15 * 86400,
            Provider::TikTok => 86400,
        };
        let refresh_max = match self.provider {
            Provider::Douyin => 30 * 86400,
            Provider::TikTok => 365 * 86400,
        };
        let access_expires_at = expiry(data, "expires_in", now_ms, access_max)?;
        let mut refresh_expires_at = expiry(data, "refresh_expires_in", now_ms, refresh_max)?;
        if let Some(old) = previous {
            if old.open_id != open_id || !scopes.is_subset(&old.scopes) {
                return Err(Error::Denied);
            }
            if self.provider == Provider::Douyin && old.refresh_token != refresh_token {
                return Err(Error::Denied);
            }
            // Access refresh cannot extend the original refresh authorization.
            // Douyin renew_refresh_token is a separately permissioned API and
            // is deliberately not requested/called by this identity integration.
            refresh_expires_at = refresh_expires_at.min(old.refresh_expires_at);
        }
        if refresh_expires_at <= now_ms {
            return Err(Error::Expired);
        }
        Ok(Tokens {
            access_token,
            refresh_token,
            open_id,
            scopes,
            access_expires_at,
            refresh_expires_at,
        })
    }
    pub fn parse_qr(&self, value: &Value, ticket: &str) -> Result<Qr, Error> {
        if !self.qr || value.get("error").is_some() {
            return Err(Error::Upstream);
        }
        secret(ticket, 128)?;
        let token = text(value, "token", 2048)?;
        let raw = text(value, "scan_qrcode_url", 8192)?;
        let mut url = Url::parse(&raw).map_err(|_| Error::Invalid)?;
        if url.scheme() != "aweme"
            || url.host_str() != Some("authorize")
            || !url.path().is_empty()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err(Error::Invalid);
        }
        let mut pairs = Vec::new();
        let mut names = BTreeSet::new();
        let mut key_valid = false;
        let mut ticket_present = false;
        for (key, value) in url.query_pairs() {
            if !names.insert(key.to_string()) {
                return Err(Error::Invalid);
            }
            if key == "client_key" {
                key_valid = value == self.client_key;
            }
            if key == "client_ticket" {
                ticket_present = true;
                pairs.push((key.to_string(), ticket.to_owned()));
            } else {
                pairs.push((key.to_string(), value.to_string()));
            }
        }
        if !key_valid || !ticket_present {
            return Err(Error::Invalid);
        }
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(pairs);
        Ok(Qr {
            payload: url.to_string(),
            token,
        })
    }
    pub fn parse_poll(&self, value: &Value, ticket: &str, state: &str) -> Result<QrState, Error> {
        if value.get("error").is_some() {
            return Err(Error::Upstream);
        }
        match value.get("status").and_then(Value::as_str) {
            Some("new") => Ok(QrState::Waiting),
            Some("expired") | Some("utilised") => Ok(QrState::Expired),
            Some("scanned") => {
                if value["client_ticket"] != ticket {
                    return Err(Error::Denied);
                }
                Ok(QrState::Scanned)
            }
            Some("confirmed") => {
                if value["client_ticket"] != ticket {
                    return Err(Error::Denied);
                }
                let raw = text(value, "redirect_uri", 8192)?;
                let url = Url::parse(&raw).map_err(|_| Error::Invalid)?;
                if url.origin() != self.redirect_uri.origin()
                    || url.path() != self.redirect_uri.path()
                    || url.fragment().is_some()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err(Error::Denied);
                }
                let mut code = None;
                let mut returned_state = None;
                let mut seen = BTreeSet::new();
                for (key, val) in url.query_pairs() {
                    if !seen.insert(key.to_string()) {
                        return Err(Error::Denied);
                    }
                    match key.as_ref() {
                        "code" => code = Some(val.to_string()),
                        "state" => returned_state = Some(val.to_string()),
                        _ => {}
                    }
                }
                // Docs show state both as response and redirect parameter.
                let returned_state = returned_state
                    .or_else(|| {
                        value
                            .get("state")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .ok_or(Error::Denied)?;
                if returned_state != state || value.get("state").is_some_and(|v| v != state) {
                    return Err(Error::Denied);
                }
                let code = code.ok_or(Error::Invalid)?;
                secret(&code, 2048)?;
                Ok(QrState::Confirmed(code))
            }
            _ => Err(Error::Invalid),
        }
    }
}
fn secret(value: &str, max: usize) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > max
        || value
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        Err(Error::Invalid)
    } else {
        Ok(())
    }
}
fn text(value: &Value, key: &str, max: usize) -> Result<String, Error> {
    let v = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::Invalid)?;
    secret(v, max)?;
    Ok(v.to_owned())
}
fn parse_scopes(raw: &str) -> Result<BTreeSet<String>, Error> {
    let mut scopes = BTreeSet::new();
    for s in raw.split(',') {
        if s.is_empty()
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._".contains(&b))
            || !scopes.insert(s.to_owned())
        {
            return Err(Error::Invalid);
        }
    }
    Ok(scopes)
}
fn expiry(v: &Value, key: &str, now: i64, max: i64) -> Result<i64, Error> {
    let raw = v.get(key).ok_or(Error::Invalid)?;
    let seconds = raw
        .as_i64()
        .or_else(|| {
            raw.as_str()
                .filter(|s| s.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|s| s.parse().ok())
        })
        .ok_or(Error::Invalid)?;
    if seconds <= 0 || seconds > max || now <= 0 {
        return Err(Error::Invalid);
    }
    now.checked_add(seconds.checked_mul(1000).ok_or(Error::Invalid)?)
        .ok_or(Error::Invalid)
}

/// Server-only token set. No Debug, Serialize, or browser-facing bearer access.
pub struct Tokens {
    access_token: String,
    refresh_token: String,
    open_id: String,
    scopes: BTreeSet<String>,
    pub access_expires_at: i64,
    pub refresh_expires_at: i64,
}
impl Tokens {
    pub fn scopes(&self) -> Vec<&str> {
        self.scopes.iter().map(String::as_str).collect()
    }
    pub fn storage_value(&self) -> Value {
        json!({"access_token":self.access_token,"refresh_token":self.refresh_token,"open_id":self.open_id,"scope":self.scopes.iter().cloned().collect::<Vec<_>>().join(","),"access_expires_at":self.access_expires_at,"refresh_expires_at":self.refresh_expires_at})
    }
    pub fn from_storage(value: &Value) -> Result<Self, Error> {
        if value.as_object().is_none_or(|v| v.len() != 6) {
            return Err(Error::Invalid);
        }
        let access_expires_at = value["access_expires_at"]
            .as_i64()
            .filter(|x| *x > 0)
            .ok_or(Error::Invalid)?;
        let refresh_expires_at = value["refresh_expires_at"]
            .as_i64()
            .filter(|x| *x > 0)
            .ok_or(Error::Invalid)?;
        Ok(Self {
            access_token: text(value, "access_token", 4096)?,
            refresh_token: text(value, "refresh_token", 4096)?,
            open_id: text(value, "open_id", 256)?,
            scopes: parse_scopes(&text(value, "scope", 1024)?)?,
            access_expires_at,
            refresh_expires_at,
        })
    }
}
pub struct Qr {
    pub payload: String,
    pub token: String,
}
pub enum QrState {
    Waiting,
    Scanned,
    Expired,
    Confirmed(String),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint {
    DouyinExchange,
    DouyinRefresh,
    TikTokToken,
    TikTokQr,
    TikTokQrPoll,
}
impl Endpoint {
    pub fn url(self) -> &'static str {
        match self {
            Self::DouyinExchange => "https://open.douyin.com/oauth/access_token/",
            Self::DouyinRefresh => "https://open.douyin.com/oauth/refresh_token/",
            Self::TikTokToken => "https://open.tiktokapis.com/v2/oauth/token/",
            Self::TikTokQr => "https://open.tiktokapis.com/v2/oauth/get_qrcode/",
            Self::TikTokQrPoll => "https://open.tiktokapis.com/v2/oauth/check_qrcode/",
        }
    }
}
/// Closed endpoint/form object, never constructed by browser input.
pub struct Request {
    endpoint: Endpoint,
    fields: Vec<(&'static str, String)>,
}
impl Request {
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }
    pub(crate) fn form(&self) -> &[(&'static str, String)] {
        &self.fields
    }
}
pub trait Transport: Send + Sync {
    fn send<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Value, Error>> + Send + 'a>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(p: Provider, qr: bool) -> Config {
        let uri = format!("https://fixture.example{}", p.callback_path());
        Config::new(
            p,
            "fixture-client".into(),
            "fixture-secret".into(),
            &uri,
            "https://fixture.example",
            qr,
        )
        .unwrap()
    }
    fn tokens(p: Provider, _now: i64) -> Value {
        let d = json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","open_id":"fixture-owner","scope":p.identity_scope(),"expires_in":3600,"refresh_expires_in":86400,"token_type":"Bearer","error_code":0});
        if p == Provider::Douyin {
            json!({"data":d})
        } else {
            d
        }
    }
    #[test]
    fn configured_authorization_is_api_identity_only_and_callback_exact() {
        let disabled = Registry::disabled();
        for p in [Provider::Douyin, Provider::TikTok] {
            assert!(disabled.config(p).is_none());
            assert_eq!(disabled.missing(p).len(), 5);
        }
        for p in [Provider::Douyin, Provider::TikTok] {
            let c = config(p, false);
            let u = Url::parse(&c.authorize_url("fixture-state").unwrap()).unwrap();
            assert_eq!(
                u.query_pairs().find(|(k, _)| k == "scope").unwrap().1,
                p.identity_scope()
            );
            assert!(
                Config::new(
                    p,
                    "fixture-client".into(),
                    "fixture-secret".into(),
                    "https://other.example/callback",
                    "https://fixture.example",
                    false
                )
                .is_err()
            );
            assert!(
                Config::new(
                    p,
                    "fixture-client".into(),
                    "fixture-secret".into(),
                    &format!("https://fixture.example{}?q=1", p.callback_path()),
                    "https://fixture.example",
                    false
                )
                .is_err()
            );
        }
    }
    #[test]
    fn provider_requests_never_contain_cookie_or_arbitrary_origin() {
        for p in [Provider::Douyin, Provider::TikTok] {
            let c = config(p, false);
            let r = c.exchange_request("fixture-code").unwrap();
            assert!(
                r.form()
                    .iter()
                    .all(|(k, _)| !matches!(*k, "cookie" | "url" | "headers"))
            );
            assert_eq!(Url::parse(r.endpoint().url()).unwrap().scheme(), "https");
            assert_eq!(
                r.form().iter().any(|(k, _)| *k == "redirect_uri"),
                p == Provider::TikTok
            );
        }
    }
    #[test]
    fn token_rotation_preserves_identity_scope_and_absolute_refresh_lifetime() {
        let now = 100_000;
        for p in [Provider::Douyin, Provider::TikTok] {
            let c = config(p, false);
            let v = tokens(p, now);
            let old = c.parse_tokens(&v, now, None).unwrap();
            let new = c.parse_tokens(&v, now + 1000, Some(&old)).unwrap();
            assert_eq!(new.refresh_expires_at, old.refresh_expires_at);
            let mut changed = v.clone();
            let d = if p == Provider::Douyin {
                &mut changed["data"]
            } else {
                &mut changed
            };
            d["open_id"] = json!("another-owner");
            assert!(matches!(
                c.parse_tokens(&changed, now, Some(&old)),
                Err(Error::Denied)
            ));
            let mut changed = v.clone();
            let d = if p == Provider::Douyin {
                &mut changed["data"]
            } else {
                &mut changed
            };
            d["scope"] = json!(format!("{},video.list", p.identity_scope()));
            assert!(matches!(
                c.parse_tokens(&changed, now, None),
                Err(Error::Denied)
            ));
            assert!(Tokens::from_storage(&old.storage_value()).is_ok());
        }
    }
    #[test]
    fn douyin_access_refresh_never_renews_refresh_token() {
        let c = config(Provider::Douyin, false);
        let v = tokens(Provider::Douyin, 1000);
        let old = c.parse_tokens(&v, 1000, None).unwrap();
        let mut changed = v;
        changed["data"]["refresh_token"] = json!("rotated-fixture");
        assert!(matches!(
            c.parse_tokens(&changed, 1001, Some(&old)),
            Err(Error::Denied)
        ));
        let request = c.refresh_request(&old).unwrap();
        assert_eq!(request.endpoint(), Endpoint::DouyinRefresh);
        assert!(!request.form().iter().any(|(k, _)| *k == "client_secret"));
    }
    #[test]
    fn qrcode_validates_ticket_client_origin_state_and_duplicate_fields() {
        let c = config(Provider::TikTok, true);
        let raw = json!({"scan_qrcode_url":"aweme://authorize?authType=100&client_key=fixture-client&client_ticket=tobefilled","token":"fixture-poll-token"});
        let q = c.parse_qr(&raw, "fixture-ticket").unwrap();
        assert!(q.payload.contains("client_ticket=fixture-ticket"));
        let confirmed = json!({"status":"confirmed","client_ticket":"fixture-ticket","state":"fixture-state","redirect_uri":format!("{}?code=fixture-code&state=fixture-state",c.redirect_uri())});
        assert!(matches!(
            c.parse_poll(&confirmed, "fixture-ticket", "fixture-state"),
            Ok(QrState::Confirmed(_))
        ));
        for (key, value) in [
            ("client_ticket", json!("wrong")),
            ("state", json!("wrong")),
            (
                "redirect_uri",
                json!("https://attacker.example/?code=fixture-code&state=fixture-state"),
            ),
        ] {
            let mut v = confirmed.clone();
            v[key] = value;
            assert!(c.parse_poll(&v, "fixture-ticket", "fixture-state").is_err());
        }
        let mut v = confirmed;
        v["redirect_uri"] = json!(format!(
            "{}?code=one&code=two&state=fixture-state",
            c.redirect_uri()
        ));
        assert!(c.parse_poll(&v, "fixture-ticket", "fixture-state").is_err());
        assert!(
            config(Provider::Douyin, false)
                .generate_qr_request("fixture-state")
                .is_err()
        );
    }
}
