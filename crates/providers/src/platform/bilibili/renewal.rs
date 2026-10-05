//! Owner-consented web Cookie renewal, not a browser challenge bypass.
//! Grounding: amtoaer/bili-sync credential.rs (checked 2026-10-05),
//! https://raw.githubusercontent.com/amtoaer/bili-sync/master/crates/bili_sync/src/bilibili/credential.rs
//! Only the refresh flow is ported; fingerprint/bootstrap APIs are absent.
use super::*;
use rsa::{Oaep, RsaPublicKey, pkcs8::DecodePublicKey};
use sha2::Sha256;

#[derive(Clone)]
pub struct RefreshToken(String);
impl fmt::Debug for RefreshToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RefreshToken([REDACTED])")
    }
}
impl RefreshToken {
    pub fn from_secret(value: &str) -> Result<Self> {
        if !(16..=2048).contains(&value.len())
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(Error::InvalidResponse("refresh_token"));
        }
        Ok(Self(value.to_owned()))
    }
    pub fn expose_for_storage(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Info,
    Correspond,
    Refresh,
    Confirm,
}
pub struct Request {
    endpoint: Endpoint,
    url: Url,
    cookie: Cookie,
    form: Vec<(&'static str, String)>,
}
impl Request {
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }
    pub(crate) fn url(&self) -> &Url {
        &self.url
    }
    pub(crate) fn cookie(&self) -> &Cookie {
        &self.cookie
    }
    pub(crate) fn form(&self) -> &[(&'static str, String)] {
        &self.form
    }
    fn new(
        endpoint: Endpoint,
        path: Option<&str>,
        cookie: &Cookie,
        form: Vec<(&'static str, String)>,
    ) -> Result<Self> {
        let target = match endpoint {
            Endpoint::Info => {
                "https://passport.bilibili.com/x/passport-login/web/cookie/info".to_owned()
            }
            Endpoint::Correspond => {
                let path = path.ok_or(Error::InvalidResource)?;
                if path.len() != 256
                    || !path
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                {
                    return Err(Error::InvalidResource);
                }
                format!("https://www.bilibili.com/correspond/1/{path}")
            }
            Endpoint::Refresh => {
                "https://passport.bilibili.com/x/passport-login/web/cookie/refresh".to_owned()
            }
            Endpoint::Confirm => {
                "https://passport.bilibili.com/x/passport-login/web/confirm/refresh".to_owned()
            }
        };
        Ok(Self {
            endpoint,
            url: Url::parse(&target).map_err(|_| Error::InvalidResource)?,
            cookie: cookie.clone(),
            form,
        })
    }
}
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
    pub set_cookie: Vec<String>,
}
pub trait Transport: Send + Sync {
    fn send<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>>;
}
pub struct Renewed {
    pub cookie: Cookie,
    pub token: RefreshToken,
}
fn csrf(cookie: &Cookie) -> Result<String> {
    cookie
        .expose_for_storage()
        .split(';')
        .find_map(|p| p.trim().strip_prefix("bili_jct="))
        .map(str::to_owned)
        .ok_or(Error::InvalidResponse("refresh_csrf_required"))
}
pub fn info_request(cookie: &Cookie) -> Result<Request> {
    Request::new(Endpoint::Info, None, cookie, Vec::new())
}
pub fn parse_info(bytes: &[u8]) -> Result<bool> {
    let value = strict_json(bytes, MAX_SMALL_BODY)?;
    check_code(&value)?;
    field(field(&value, "data")?, "refresh")?
        .as_bool()
        .ok_or(Error::InvalidResponse("refresh_info"))
}
pub fn correspond_path(timestamp_ms: i64) -> Result<String> {
    if timestamp_ms <= 20_000 {
        return Err(Error::InvalidResource);
    }
    let key=RsaPublicKey::from_public_key_pem("-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg\nUc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71\nnzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40\nJNrRuoEUXpabUzGB8QIDAQAB\n-----END PUBLIC KEY-----").map_err(|_|Error::InvalidResource)?;
    let data = format!("refresh_{}", timestamp_ms - 20_000);
    let encrypted = key
        .encrypt(
            &mut rand::rngs::OsRng,
            Oaep::new::<Sha256>(),
            data.as_bytes(),
        )
        .map_err(|_| Error::InvalidResource)?;
    Ok(encrypted.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn parse_csrf(bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_SMALL_BODY {
        return Err(Error::TooLarge);
    }
    let html = std::str::from_utf8(bytes).map_err(|_| Error::InvalidResponse("refresh_csrf"))?;
    let marker = "<div id=\"1-name\">";
    if html.matches(marker).count() != 1 {
        return Err(Error::InvalidResponse("refresh_csrf"));
    }
    let value = html
        .split_once(marker)
        .and_then(|(_, x)| x.split_once("</div>"))
        .map(|(x, _)| x)
        .ok_or(Error::InvalidResponse("refresh_csrf"))?;
    if value.len() != 32 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::InvalidResponse("refresh_csrf"));
    }
    Ok(value.to_owned())
}
pub fn parse_refreshed(bytes: &[u8], set_cookie: &[String], old: &Cookie) -> Result<Renewed> {
    let value = strict_json(bytes, MAX_SMALL_BODY)?;
    check_code(&value)?;
    let data = field(&value, "data")?;
    if field(data, "status")?.as_i64() != Some(0) {
        return Err(Error::InvalidResponse("refresh_status"));
    }
    let token = RefreshToken::from_secret(text(field(data, "refresh_token")?, 2048)?)?;
    let session = parse_qr_poll_response(b"{\"code\":0,\"data\":{\"code\":0}}", set_cookie)?
        .session
        .ok_or(Error::InvalidResponse("refresh_cookie"))?;
    let uid = |cookie: &Cookie| {
        cookie
            .expose_for_storage()
            .split(';')
            .find_map(|p| p.trim().strip_prefix("DedeUserID="))
            .map(str::to_owned)
    };
    if uid(&session) != uid(old) || csrf(&session).is_err() {
        return Err(Error::InvalidResponse("refresh_identity"));
    }
    Ok(Renewed {
        cookie: session,
        token,
    })
}
/// Read-only info can be retried; a refresh/confirm is never retried implicitly.
pub async fn prepare(
    transport: &impl Transport,
    cookie: &Cookie,
    token: &RefreshToken,
    timestamp_ms: i64,
    deadline: Instant,
) -> Result<Renewed> {
    let path = correspond_path(timestamp_ms)?;
    let response = transport
        .send(
            Request::new(Endpoint::Correspond, Some(&path), cookie, Vec::new())?,
            deadline,
        )
        .await?;
    if response.status != 200 {
        return Err(Error::Status(response.status));
    }
    let refresh_csrf = parse_csrf(&response.body)?;
    let response = transport
        .send(
            Request::new(
                Endpoint::Refresh,
                None,
                cookie,
                vec![
                    ("csrf", csrf(cookie)?),
                    ("refresh_csrf", refresh_csrf),
                    ("source", "main_web".to_owned()),
                    ("refresh_token", token.0.clone()),
                ],
            )?,
            deadline,
        )
        .await?;
    if response.status != 200 {
        return Err(Error::Status(response.status));
    }
    parse_refreshed(&response.body, &response.set_cookie, cookie)
}
pub async fn confirm(
    transport: &impl Transport,
    new: &Cookie,
    old_token: &RefreshToken,
    deadline: Instant,
) -> Result<()> {
    let response = transport
        .send(
            Request::new(
                Endpoint::Confirm,
                None,
                new,
                vec![("csrf", csrf(new)?), ("refresh_token", old_token.0.clone())],
            )?,
            deadline,
        )
        .await?;
    if response.status != 200 {
        return Err(Error::Status(response.status));
    }
    check_code(&strict_json(&response.body, MAX_SMALL_BODY)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csrf_and_correspond_are_bounded_and_do_not_bootstrap_fingerprints() {
        assert_eq!(correspond_path(1_800_000_000_000).unwrap().len(), 256);
        assert!(correspond_path(0).is_err());
        assert!(parse_csrf(b"<div id=\"1-name\">0123456789abcdef0123456789abcdef</div>").is_ok());
        assert!(parse_csrf(b"<div id=\"1-name\">evil</div>").is_err());
        assert!(parse_csrf(b"<div id=\"1-name\">0123456789abcdef0123456789abcdef</div><div id=\"1-name\">0123456789abcdef0123456789abcdef</div>").is_err());
    }
    #[test]
    fn refresh_parser_rejects_account_swap_and_missing_secret() {
        let old =
            Cookie::from_header("SESSDATA=fixture-old; DedeUserID=123; bili_jct=fixture-csrf")
                .unwrap();
        let body =
            b"{\"code\":0,\"data\":{\"status\":0,\"refresh_token\":\"fixture-refresh-token\"}}";
        let cookies = vec![
            "SESSDATA=fixture-new; Domain=.bilibili.com; Path=/".into(),
            "bili_jct=fixture-new-csrf; Domain=.bilibili.com; Path=/".into(),
            "DedeUserID=123; Domain=.bilibili.com; Path=/".into(),
        ];
        assert!(parse_refreshed(body, &cookies, &old).is_ok());
        let mut swapped = cookies;
        swapped[2] = "DedeUserID=456; Domain=.bilibili.com; Path=/".into();
        assert!(parse_refreshed(body, &swapped, &old).is_err());
        assert!(parse_refreshed(body, &[], &old).is_err());
        assert!(
            !format!(
                "{:?}",
                RefreshToken::from_secret("fixture-refresh-token").unwrap()
            )
            .contains("fixture")
        );
    }
    type ObservedRequest = (Endpoint, String, Vec<(&'static str, String)>);
    struct Fixtures {
        responses: std::sync::Mutex<std::collections::VecDeque<(Endpoint, Response)>>,
        seen: std::sync::Mutex<Vec<ObservedRequest>>,
    }
    impl Transport for Fixtures {
        fn send<'a>(
            &'a self,
            request: Request,
            _deadline: Instant,
        ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push((
                    request.endpoint(),
                    request.cookie().expose_for_storage().to_owned(),
                    request.form().to_vec(),
                ));
                let (expected, response) = self
                    .responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("only synthetic fixture requests are allowed");
                assert_eq!(request.endpoint(), expected);
                Ok(response)
            })
        }
    }
    #[tokio::test]
    async fn refresh_and_confirm_use_new_cookie_old_token_without_implicit_retry() {
        let fixture=Fixtures {responses:std::sync::Mutex::new(std::collections::VecDeque::from([
            (Endpoint::Correspond,Response {status:200,body:b"<div id=\"1-name\">0123456789abcdef0123456789abcdef</div>".to_vec(),set_cookie:vec![]}),
            (Endpoint::Refresh,Response {status:200,body:b"{\"code\":0,\"data\":{\"status\":0,\"refresh_token\":\"fixture-new-refresh-token\"}}".to_vec(),set_cookie:vec!["SESSDATA=fixture-new; Domain=.bilibili.com; Path=/".into(),"DedeUserID=123; Domain=.bilibili.com; Path=/".into(),"bili_jct=fixture-new-csrf; Domain=.bilibili.com; Path=/".into()]}),
            (Endpoint::Confirm,Response {status:200,body:b"{\"code\":0}".to_vec(),set_cookie:vec![]}),
        ])),seen:std::sync::Mutex::new(Vec::new())};
        let old =
            Cookie::from_header("SESSDATA=fixture-old; DedeUserID=123; bili_jct=fixture-old-csrf")
                .unwrap();
        let old_token = RefreshToken::from_secret("fixture-old-refresh-token").unwrap();
        let renewed = prepare(
            &fixture,
            &old,
            &old_token,
            1_800_000_000_000,
            Instant::now() + std::time::Duration::from_secs(20),
        )
        .await
        .unwrap();
        confirm(
            &fixture,
            &renewed.cookie,
            &old_token,
            Instant::now() + std::time::Duration::from_secs(20),
        )
        .await
        .unwrap();
        let seen = fixture.seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert!(seen[1].1.contains("SESSDATA=fixture-old"));
        assert!(seen[2].1.contains("SESSDATA=fixture-new"));
        assert!(seen[2].2.iter().any(|(key,value)|*key=="refresh_token"&&value=="fixture-old-refresh-token"));
        assert!(
            seen[2]
                .2
                .iter()
                .any(|(key, value)| *key == "csrf" && value == "fixture-new-csrf")
        );
        assert_eq!(
            renewed.token.expose_for_storage(),
            "fixture-new-refresh-token"
        );
        assert!(fixture.responses.lock().unwrap().is_empty());
    }
}
