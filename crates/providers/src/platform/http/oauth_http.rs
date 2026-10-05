//! Official Open Platform POSTs use the same fixed-origin, DNS-pinned transport.
//! No Cookie, caller URL/header, environment proxy, redirect or retry is used.
use super::*;
use crate::platform::oauth;
impl oauth::Transport for PlatformHttp {
    fn send<'a>(
        &'a self,
        request: oauth::Request,
        deadline: Instant,
    ) -> Pin<
        Box<dyn Future<Output = std::result::Result<serde_json::Value, oauth::Error>> + Send + 'a>,
    > {
        Box::pin(async move {
            let deadline =
                bounded_deadline(deadline, API_TIMEOUT).map_err(|_| oauth::Error::Uncertain)?;
            tokio::time::timeout_at(deadline, fetch(request, deadline))
                .await
                .map_err(|_| oauth::Error::Uncertain)?
        })
    }
}
async fn fetch(
    request: oauth::Request,
    deadline: Instant,
) -> std::result::Result<serde_json::Value, oauth::Error> {
    let url = Url::parse(request.endpoint().url()).map_err(|_| oauth::Error::Invalid)?;
    let client = pinned_client(&url, &SystemResolver, deadline)
        .await
        .map_err(|_| oauth::Error::Uncertain)?;
    let mut response = client
        .request(Method::POST)
        .header(header::ACCEPT, "application/json")
        .header(header::ACCEPT_ENCODING, "identity")
        .form(request.form())
        .timeout(remaining(deadline).map_err(|_| oauth::Error::Uncertain)?)
        .send()
        .await
        .map_err(|_| oauth::Error::Uncertain)?;
    check_response_headers(response.headers()).map_err(|_| oauth::Error::Invalid)?;
    validate_media_encoding(response.headers()).map_err(|_| oauth::Error::Invalid)?;
    if response.status().is_redirection() || !response.status().is_success() {
        return Err(oauth::Error::Upstream);
    }
    if response.content_length().is_some_and(|n| n > 64 * 1024) {
        return Err(oauth::Error::Invalid);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| oauth::Error::Uncertain)?
    {
        append_bounded(&mut body, &chunk, 64 * 1024).map_err(|_| oauth::Error::Invalid)?;
    }
    crate::platform::bilibili::strict_json(&body, 64 * 1024).map_err(|_| oauth::Error::Invalid)
}
