//! Read-only login validity check against the fixed Bilibili web account API.
//! https://api.bilibili.com/x/web-interface/nav is the primary endpoint; a
//! logged-out response explicitly contains code=-101 and data.isLogin=false.
//! This does not renew cookies, inspect membership or authorize a video.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginValidity {
    Verified,
    Invalid,
}

impl<T: Transport> Client<T> {
    /// Uses this client's caller-owned cookie exactly once. Errors are
    /// inconclusive, never evidence that a credential should be deleted.
    pub async fn check_login(&self, deadline: Instant) -> Result<LoginValidity> {
        let cookie = self.cookie.as_ref().ok_or(Error::InvalidResource)?;
        let response = self
            .send(ApiRequest::new(Endpoint::Nav, &[], Some(cookie)), deadline)
            .await?;
        parse_login_response(&response.body, cookie)
    }
}

fn parse_login_response(bytes: &[u8], cookie: &Cookie) -> Result<LoginValidity> {
    let value = strict_json(bytes, MAX_SMALL_BODY)?;
    let code = code(&value)?;
    if !matches!(code, 0 | -101) {
        return Err(Error::Api(code));
    }
    let data = object(field(&value, "data")?)?;
    // Missing, numeric or textual booleans are malformed, not logout evidence.
    let logged_in = field(data, "isLogin")?
        .as_bool()
        .ok_or(Error::InvalidResponse("login_state"))?;
    if !logged_in {
        return Ok(LoginValidity::Invalid);
    }
    if code != 0 {
        return Err(Error::InvalidResponse("login_state"));
    }
    let actual = id(field(data, "mid")?)?;
    let expected = cookie
        .expose_for_storage()
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find_map(|(key, value)| (key == "DedeUserID").then_some(value))
        .ok_or(Error::InvalidResponse("cookie_identity"))?;
    Ok(if actual == expected {
        LoginValidity::Verified
    } else {
        LoginValidity::Invalid
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn cookie() -> Cookie {
        Cookie::from_header("SESSDATA=synthetic-session; DedeUserID=42").unwrap()
    }

    #[test]
    fn explicit_login_state_and_exact_cookie_identity_are_required() {
        let cookie = cookie();
        for mid in [json!(42), json!("42")] {
            let body =
                serde_json::to_vec(&json!({"code":0,"data":{"isLogin":true,"mid":mid}})).unwrap();
            assert_eq!(
                parse_login_response(&body, &cookie).unwrap(),
                LoginValidity::Verified
            );
        }
        for body in [
            br#"{"code":-101,"data":{"isLogin":false}}"#.as_slice(),
            br#"{"code":0,"data":{"isLogin":false}}"#.as_slice(),
            br#"{"code":0,"data":{"isLogin":true,"mid":43}}"#.as_slice(),
        ] {
            assert_eq!(
                parse_login_response(body, &cookie).unwrap(),
                LoginValidity::Invalid
            );
        }
        for body in [
            br#"{"code":0,"data":{}}"#.as_slice(),
            br#"{"code":0,"data":{"isLogin":0}}"#.as_slice(),
            br#"{"code":0,"data":{"isLogin":"false"}}"#.as_slice(),
            br#"{"code":0,"data":{"isLogin":true}}"#.as_slice(),
            br#"{"code":-101,"data":{"isLogin":true,"mid":42}}"#.as_slice(),
            br#"{"code":-352,"data":{"isLogin":false}}"#.as_slice(),
            br#"{"code":0,"code":-101,"data":{"isLogin":false}}"#.as_slice(),
            br#"<html>challenge</html>"#.as_slice(),
        ] {
            assert!(parse_login_response(body, &cookie).is_err());
        }
    }

    struct Fixture {
        calls: Arc<Mutex<Vec<ApiRequest>>>,
        status: u16,
        body: Vec<u8>,
    }
    impl Transport for Fixture {
        fn get<'a>(
            &'a self,
            request: ApiRequest,
            _: Instant,
        ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + 'a>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(request);
                Ok(ApiResponse {
                    status: self.status,
                    body: self.body.clone(),
                    set_cookie: vec![],
                })
            })
        }
    }

    #[tokio::test]
    async fn check_sends_only_one_fixed_account_request_and_never_retries() {
        for status in [200, 403] {
            let calls = Arc::new(Mutex::new(vec![]));
            let client = Client::new(
                Fixture {
                    calls: calls.clone(),
                    status,
                    body: br#"{"code":0,"data":{"isLogin":true,"mid":42}}"#.to_vec(),
                },
                Some(cookie()),
            );
            let result = client
                .check_login(Instant::now() + Duration::from_secs(1))
                .await;
            assert_eq!(result.is_ok(), status == 200);
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].endpoint(), Endpoint::Nav);
            assert_eq!(
                calls[0].url().as_str(),
                "https://api.bilibili.com/x/web-interface/nav"
            );
            assert!(calls[0].headers().contains_key("Cookie"));
            assert!(!format!("{:?}", calls[0]).contains("synthetic-session"));
        }
    }

    #[tokio::test]
    async fn absent_cookie_or_elapsed_deadline_never_transmits() {
        let calls = Arc::new(Mutex::new(vec![]));
        let fixture = || Fixture {
            calls: calls.clone(),
            status: 200,
            body: vec![],
        };
        assert!(
            Client::new(fixture(), None)
                .check_login(Instant::now() + Duration::from_secs(1))
                .await
                .is_err()
        );
        assert!(
            Client::new(fixture(), Some(cookie()))
                .check_login(Instant::now())
                .await
                .is_err()
        );
        assert!(calls.lock().unwrap().is_empty());
    }
}
