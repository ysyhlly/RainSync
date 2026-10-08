//! The PGC transport adds no origin or credential fallback. It shares the
//! existing full public-DNS answer validation, pinning and redirect denial.
use super::*;
use crate::platform::bilibili::pgc::{self, Request, Response};

impl pgc::Transport for PlatformHttp {
    fn get_pgc<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move {
            request.validate()?;
            let deadline = bounded_deadline(deadline, API_TIMEOUT)?;
            tokio::time::timeout_at(deadline, fetch(request, deadline))
                .await
                .map_err(|_| bilibili::Error::Deadline)?
        })
    }
}

fn pgc_headers(request: &Request) -> Result<HeaderMap> {
    request.validate()?;
    let mut headers = media_headers(Provider::Bilibili);
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(cookie) = request.cookie() {
        let checked = bilibili::Cookie::from_header(cookie.expose_for_storage())?;
        let mut value = HeaderValue::from_str(checked.expose_for_storage())
            .map_err(|_| bilibili::Error::Restricted("pgc_cookie_denied"))?;
        value.set_sensitive(true);
        headers.insert(header::COOKIE, value);
    }
    Ok(headers)
}

async fn fetch(request: Request, deadline: Instant) -> Result<Response> {
    request.validate()?;
    let headers = pgc_headers(&request)?;
    let limit = request.max_response_bytes();
    if limit == 0 || limit > MAX_JSON_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let client = pinned_client(request.url(), &SystemResolver, deadline).await?;
    let mut response = client
        .request(Method::GET)
        .headers(headers)
        .timeout(remaining(deadline)?)
        .send()
        .await
        .map_err(http_error)?;
    check_response_headers(response.headers())?;
    if response.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    validate_media_encoding(response.headers())?;
    for name in [header::CONTENT_LENGTH, header::CONTENT_TYPE] {
        if response.headers().get_all(name).iter().count() > 1 {
            return Err(bilibili::Error::InvalidResponse("pgc_api_framing"));
        }
    }
    if response.headers().contains_key(header::CONTENT_RANGE) {
        return Err(bilibili::Error::InvalidResponse("pgc_api_framing"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(bilibili::Error::TooLarge);
    }
    let status = response.status().as_u16();
    let mut body = Vec::new();
    if status != 200 {
        return Ok(Response { status, body });
    }
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        append_bounded(&mut body, &chunk, limit)?;
    }
    // Set-Cookie and every other account/entitlement header is discarded.
    Ok(Response { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pgc_http_credentials_stay_on_fixed_api_requests() {
        let cookie = bilibili::Cookie::from_header("SESSDATA=synthetic; DedeUserID=42").unwrap();
        let reference = pgc::parse_resource("ep123").unwrap();
        let authenticated = pgc::metadata_request(&reference, Some(&cookie)).unwrap();
        let headers = pgc_headers(&authenticated).unwrap();
        assert_eq!(authenticated.url().host_str(), Some("api.bilibili.com"));
        assert!(headers.get(header::COOKIE).unwrap().is_sensitive());
        assert!(!headers.contains_key(header::AUTHORIZATION));
        let anonymous = pgc::metadata_request(&reference, None).unwrap();
        assert!(
            !pgc_headers(&anonymous)
                .unwrap()
                .contains_key(header::COOKIE)
        );
        let media = media_headers(Provider::Bilibili);
        assert!(!media.contains_key(header::COOKIE));
        assert!(!media.contains_key(header::AUTHORIZATION));
        assert!(!format!("{authenticated:?}").contains("synthetic"));
    }
}
