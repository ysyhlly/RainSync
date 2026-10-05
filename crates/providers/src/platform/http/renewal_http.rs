//! Closed Bilibili renewal endpoints, without browser bootstrap/challenge APIs.
use super::*;
use crate::platform::bilibili::renewal;
impl renewal::Transport for PlatformHttp {
    fn send<'a>(
        &'a self,
        request: renewal::Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<renewal::Response>> + Send + 'a>> {
        Box::pin(async move {
            let deadline = bounded_deadline(deadline, API_TIMEOUT)?;
            tokio::time::timeout_at(deadline, fetch(request, deadline))
                .await
                .map_err(|_| bilibili::Error::Deadline)?
        })
    }
}
async fn fetch(request: renewal::Request, deadline: Instant) -> Result<renewal::Response> {
    let client = pinned_client(request.url(), &SystemResolver, deadline).await?;
    let method = if matches!(
        request.endpoint(),
        renewal::Endpoint::Info | renewal::Endpoint::Correspond
    ) {
        Method::GET
    } else {
        Method::POST
    };
    let mut builder = client
        .request(method)
        .header(header::COOKIE, request.cookie().expose_for_storage())
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::USER_AGENT, USER_AGENT)
        .header(header::REFERER, REFERER)
        .timeout(remaining(deadline)?);
    if !request.form().is_empty() {
        builder = builder.form(request.form());
    }
    let mut response = builder.send().await.map_err(http_error)?;
    check_response_headers(response.headers())?;
    validate_media_encoding(response.headers())?;
    if response.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    let set_cookie = if request.endpoint() == renewal::Endpoint::Refresh {
        capture_cookies(Endpoint::QrPoll, response.headers())?
    } else {
        Vec::new()
    };
    if response.content_length().is_some_and(|n| n > 64 * 1024) {
        return Err(bilibili::Error::TooLarge);
    }
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        append_bounded(&mut body, &chunk, 64 * 1024)?;
    }
    Ok(renewal::Response {
        status,
        body,
        set_cookie,
    })
}
