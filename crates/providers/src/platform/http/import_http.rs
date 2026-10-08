//! Import metadata transport reuses the fixed-origin public-DNS-pinned client.
//! Short redirects are captured without reading any body. Every hop gets a new
//! DNS authorization; no cookies, authorization, caller headers or proxy exist.
use super::*;
use crate::platform::imports::{self, Endpoint, Request, Response};

impl imports::Transport for PlatformHttp {
    fn get<'a>(
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
fn import_headers(request: &Request) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static(
            if request.provider() == imports::Provider::TikTok
                && request.endpoint() == Endpoint::ShortRedirect
            {
                "facebookexternalhit/1.1"
            } else {
                USER_AGENT
            },
        ),
    );
    headers.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static(if request.endpoint() == Endpoint::ShortRedirect {
            "text/html"
        } else {
            "application/json"
        }),
    );
    if let Some(referer) = request.referer() {
        headers.insert(
            header::REFERER,
            HeaderValue::from_str(&referer).map_err(|_| bilibili::Error::InvalidResource)?,
        );
    }
    if let Some(cookie) = request.cookie() {
        let mut value = HeaderValue::from_str(cookie.expose_for_storage())
            .map_err(|_| bilibili::Error::InvalidResource)?;
        value.set_sensitive(true);
        headers.insert(header::COOKIE, value);
    }
    Ok(headers)
}
fn location(headers: &HeaderMap) -> Result<String> {
    let mut values = headers.get_all(header::LOCATION).iter();
    let value = values.next().ok_or(bilibili::Error::InvalidResponse(
        "missing_platform_redirect",
    ))?;
    if values.next().is_some() || value.as_bytes().len() > 2048 {
        return Err(bilibili::Error::InvalidResponse(
            "invalid_platform_redirect",
        ));
    }
    value
        .to_str()
        .map(str::to_owned)
        .map_err(|_| bilibili::Error::InvalidResponse("invalid_platform_redirect"))
}
async fn fetch(request: Request, deadline: Instant) -> Result<Response> {
    // HEAD is used only for shortlink discovery. Unlike GET it cannot consume a
    // stream if the upstream returns an unexpected 200. No fallback follows it.
    let short = request.endpoint() == Endpoint::ShortRedirect;
    let client = pinned_client(request.url(), &SystemResolver, deadline).await?;
    let mut response = client
        .request(if short { Method::HEAD } else { Method::GET })
        .headers(import_headers(&request)?)
        .timeout(remaining(deadline)?)
        .send()
        .await
        .map_err(http_error)?;
    check_response_headers(response.headers())?;
    if short {
        let redirect = if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            Some(location(response.headers())?)
        } else {
            None
        };
        return Ok(Response {
            status: response.status().as_u16(),
            body: Vec::new(),
            location: redirect,
        });
    }
    if response.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    validate_media_encoding(response.headers())?;
    if response
        .content_length()
        .is_some_and(|v| v > MAX_JSON_BYTES as u64)
    {
        return Err(bilibili::Error::TooLarge);
    }
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        append_bounded(&mut body, &chunk, MAX_JSON_BYTES)?;
    }
    Ok(Response {
        status,
        body,
        location: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redirect_cardinality_and_bounds() {
        let mut headers = HeaderMap::new();
        assert!(location(&headers).is_err());
        headers.insert(
            header::LOCATION,
            HeaderValue::from_static("https://www.douyin.com/video/123"),
        );
        assert!(location(&headers).is_ok());
        headers.append(
            header::LOCATION,
            HeaderValue::from_static("https://evil.test/"),
        );
        assert!(location(&headers).is_err());
        headers.clear();
        headers.insert(
            header::LOCATION,
            HeaderValue::from_str(&"x".repeat(2049)).unwrap(),
        );
        assert!(location(&headers).is_err());
    }
    #[test]
    fn tiktok_collection_headers_are_public_fixed_and_never_borrow_session_or_shortlink_agent() {
        let collection = imports::parse_collection(
            "https://www.tiktok.com/@creator/collection/example-123",
            imports::Provider::TikTok,
        )
        .unwrap();
        // Request construction is exercised through the pure transport seam.
        struct Inspect;
        impl imports::Transport for Inspect {
            fn get<'a>(
                &'a self,
                request: Request,
                _: Instant,
            ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
                Box::pin(async move {
                    request.validate()?;
                    let headers = import_headers(&request)?;
                    assert!(!headers.contains_key(header::COOKIE));
                    assert!(!headers.contains_key(header::AUTHORIZATION));
                    assert_eq!(headers[header::USER_AGENT], USER_AGENT);
                    assert_eq!(headers[header::REFERER], "https://www.tiktok.com/");
                    assert_eq!(headers[header::ACCEPT], "application/json");
                    assert_eq!(headers[header::ACCEPT_ENCODING], "identity");
                    assert_eq!(headers.len(), 4);
                    Ok(Response {
                        status: 200,
                        body: br#"{"statusCode":0,"hasMore":false,"itemList":[]}"#.to_vec(),
                        location: None,
                    })
                })
            }
        }
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime
            .block_on(imports::preview_collection(
                &Inspect,
                &collection,
                Instant::now() + Duration::from_secs(1),
            ))
            .unwrap();
    }
}
