//! The course transport adds no origin or credential fallback. It shares the
//! existing full public-DNS answer validation, pinning and redirect denial.
use super::*;
use crate::platform::bilibili::course::{self, InitRequest, Request, Response};
use crate::platform::youtube::mp4;

impl course::Transport for PlatformHttp {
    fn get_course<'a>(
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
    fn read_course_init<'a>(
        &'a self,
        request: InitRequest,
    ) -> Pin<Box<dyn Future<Output = Result<mp4::RangeResponse>> + Send + 'a>> {
        Box::pin(async move {
            request.validate()?;
            let range_request = request.range_request();
            let range = range_request.range.header();
            let mut response = self
                .media_request_for(
                    "bilibili",
                    request.url().as_str(),
                    Method::GET,
                    Some(&range),
                    range_request.deadline,
                )
                .await?;
            let status = response.status().as_u16();
            let headers = init_headers(response.headers())?;
            // Inspect exact 206 framing and validators before consuming a chunk.
            mp4::validate_range_headers(range_request, status, &headers).map_err(init_error)?;
            let expected = range_request.range.len().map_err(init_error)?;
            let mut body = Vec::with_capacity(expected);
            while let Some(chunk) = response.next_chunk().await? {
                if body
                    .len()
                    .checked_add(chunk.len())
                    .is_none_or(|length| length > expected)
                {
                    return Err(bilibili::Error::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            if body.len() != expected {
                return Err(bilibili::Error::InvalidResponse("course_init_framing"));
            }
            Ok(mp4::RangeResponse {
                status,
                headers,
                body,
            })
        })
    }
}

fn course_headers(request: &Request) -> Result<HeaderMap> {
    request.validate()?;
    let mut headers = media_headers(Provider::Bilibili);
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(cookie) = request.cookie() {
        let checked = bilibili::Cookie::from_header(cookie.expose_for_storage())?;
        let mut value = HeaderValue::from_str(checked.expose_for_storage())
            .map_err(|_| bilibili::Error::Restricted("course_cookie_denied"))?;
        value.set_sensitive(true);
        headers.insert(header::COOKIE, value);
    }
    Ok(headers)
}

async fn fetch(request: Request, deadline: Instant) -> Result<Response> {
    request.validate()?;
    let headers = course_headers(&request)?;
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
            return Err(bilibili::Error::InvalidResponse("course_api_framing"));
        }
    }
    if response.headers().contains_key(header::CONTENT_RANGE) {
        return Err(bilibili::Error::InvalidResponse("course_api_framing"));
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

fn init_error(error: mp4::ProbeError) -> bilibili::Error {
    match error {
        mp4::ProbeError::Deadline => bilibili::Error::Deadline,
        mp4::ProbeError::TooLarge => bilibili::Error::TooLarge,
        mp4::ProbeError::Transport => bilibili::Error::Transport,
        _ => bilibili::Error::InvalidResponse("course_init_framing"),
    }
}
fn init_headers(headers: &HeaderMap) -> Result<mp4::RangeHeaders> {
    let values = |name: header::HeaderName| {
        headers
            .get_all(name)
            .iter()
            .map(|value| {
                value
                    .to_str()
                    .map(str::to_owned)
                    .map_err(|_| bilibili::Error::InvalidResponse("course_init_header"))
            })
            .collect::<Result<Vec<_>>>()
    };
    Ok(mp4::RangeHeaders {
        content_range: values(header::CONTENT_RANGE)?,
        content_length: values(header::CONTENT_LENGTH)?,
        content_encoding: values(header::CONTENT_ENCODING)?,
        etag: values(header::ETAG)?,
        last_modified: values(header::LAST_MODIFIED)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn course_http_credentials_stay_on_fixed_api_requests() {
        let cookie = bilibili::Cookie::from_header("SESSDATA=synthetic; DedeUserID=42").unwrap();
        let reference = course::parse_resource("course:ep123").unwrap();
        let authenticated = course::metadata_request(&reference, Some(&cookie)).unwrap();
        let headers = course_headers(&authenticated).unwrap();
        assert_eq!(authenticated.url().host_str(), Some("api.bilibili.com"));
        assert!(headers.get(header::COOKIE).unwrap().is_sensitive());
        assert!(!headers.contains_key(header::AUTHORIZATION));
        let anonymous = course::metadata_request(&reference, None).unwrap();
        assert!(
            !course_headers(&anonymous)
                .unwrap()
                .contains_key(header::COOKIE)
        );
        let media = media_headers(Provider::Bilibili);
        assert!(!media.contains_key(header::COOKIE));
        assert!(!media.contains_key(header::AUTHORIZATION));
        assert!(!format!("{authenticated:?}").contains("synthetic"));
    }
    #[test]
    fn course_init_preserves_raw_critical_headers_for_duplicate_checks() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::CONTENT_RANGE,
            HeaderValue::from_static("bytes 0-99/1000"),
        );
        headers.append(
            header::CONTENT_RANGE,
            HeaderValue::from_static("bytes 0-99/1000"),
        );
        headers.append(header::CONTENT_LENGTH, HeaderValue::from_static("100"));
        let collected = init_headers(&headers).unwrap();
        assert_eq!(collected.content_range.len(), 2);
        let request = mp4::RangeRequest {
            range: mp4::ByteRange { start: 0, end: 99 },
            deadline: Instant::now() + Duration::from_secs(1),
            max_body_bytes: 100,
            expected: None,
        };
        assert!(mp4::validate_range_headers(&request, 206, &collected).is_err());
    }
}
