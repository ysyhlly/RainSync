//! Text requests share the production public-DNS pinned transport but never the
//! broad CDN media allowlist. Redirects, encodings and response headers are not
//! forwarded; credentials can only go to the exact Bili player metadata API.
use super::*;
use crate::platform::text::{self, Endpoint as TextEndpoint, TextRequest, TextResponse};
impl text::Transport for PlatformHttp {
    fn get_text<'a>(
        &'a self,
        request: TextRequest,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = text::Result<TextResponse>> + Send + 'a>> {
        Box::pin(async move {
            let deadline = bounded_deadline(deadline, API_TIMEOUT)?;
            tokio::time::timeout_at(deadline, fetch_text(request, deadline))
                .await
                .map_err(|_| bilibili::Error::Deadline)?
        })
    }
}
async fn fetch_text(request: TextRequest, deadline: Instant) -> Result<TextResponse> {
    // Recheck the typed request before DNS and reject accidental cookie scope.
    let content = if request.endpoint() == TextEndpoint::YoutubeCaption {
        request
            .url()
            .query_pairs()
            .find(|(n, _)| n == "v")
            .map(|(_, v)| v.into_owned())
    } else {
        None
    };
    let content = if matches!(
        request.endpoint(),
        TextEndpoint::DouyinCaption | TextEndpoint::TikTokCaption
    ) {
        Some(
            request
                .content_id()
                .ok_or(bilibili::Error::InvalidResponse("caption_identity"))?
                .to_owned(),
        )
    } else {
        content
    };
    let url = text::validate_text_url(
        request.endpoint(),
        request.url().as_str(),
        content.as_deref(),
    )?;
    let provider = match request.endpoint() {
        TextEndpoint::YoutubeCaption => Provider::YouTube,
        TextEndpoint::DouyinCaption => Provider::Douyin,
        TextEndpoint::TikTokCaption => Provider::TikTok,
        _ => Provider::Bilibili,
    };
    let mut headers = media_headers(provider);
    if matches!(
        request.endpoint(),
        TextEndpoint::BilibiliLiveHistory | TextEndpoint::BilibiliLiveInfo
    ) {
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("https://live.bilibili.com/"),
        );
    }
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static(if request.endpoint() == TextEndpoint::BilibiliDanmaku {
            "application/xml,text/xml"
        } else if request.endpoint() == TextEndpoint::BilibiliSegment {
            "application/octet-stream"
        } else if matches!(
            request.endpoint(),
            TextEndpoint::DouyinCaption | TextEndpoint::TikTokCaption
        ) {
            "text/vtt,application/x-subrip,application/json"
        } else {
            "application/json"
        }),
    );
    if let Some(cookie) = request.cookie() {
        if !matches!(
            request.endpoint(),
            TextEndpoint::BilibiliPlayer | TextEndpoint::BilibiliLiveInfo
        ) {
            return Err(bilibili::Error::Restricted("platform_cookie_denied"));
        }
        let checked = bilibili::Cookie::from_header(cookie.expose_for_storage())?;
        let mut value = HeaderValue::from_str(checked.expose_for_storage())
            .map_err(|_| bilibili::Error::Restricted("platform_cookie_denied"))?;
        value.set_sensitive(true);
        headers.insert(header::COOKIE, value);
    }
    if let Some(client_id) = request.client_id() {
        if request.endpoint() != TextEndpoint::BilibiliLiveInfo {
            return Err(bilibili::Error::Restricted("live_client_id_scope_denied"));
        }
        let cookie = headers
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .map(|value| format!("{value}; buvid3={}", client_id.expose_for_metadata()))
            .unwrap_or_else(|| format!("buvid3={}", client_id.expose_for_metadata()));
        let mut value = HeaderValue::from_str(&cookie)
            .map_err(|_| bilibili::Error::Restricted("live_client_id_scope_denied"))?;
        value.set_sensitive(true);
        headers.insert(header::COOKIE, value);
    }
    let limit = request.max_response_bytes();
    if limit == 0 || limit > text::MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let client = pinned_client(&url, &SystemResolver, deadline).await?;
    let mut response = client
        .request(Method::GET)
        .headers(headers)
        .timeout(remaining(deadline)?)
        .send()
        .await
        .map_err(http_error)?;
    check_response_headers(response.headers())?;
    validate_media_encoding(response.headers())?;
    if response.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    for name in [header::CONTENT_LENGTH, header::CONTENT_TYPE] {
        if response.headers().get_all(name).iter().count() > 1 {
            return Err(bilibili::Error::InvalidResponse("platform_text_framing"));
        }
    }
    if response.headers().contains_key(header::CONTENT_RANGE) {
        return Err(bilibili::Error::InvalidResponse("platform_text_framing"));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(bilibili::Error::TooLarge);
    }
    let status = response.status().as_u16();
    let mut body = Vec::new();
    // Error pages are never consumed or parsed as platform content.
    if status != 200 {
        return Ok(TextResponse { status, body });
    }
    while let Some(chunk) = tokio::time::timeout_at(deadline, response.chunk())
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(http_error)?
    {
        append_bounded(&mut body, &chunk, limit)?
    }
    Ok(TextResponse { status, body })
}

impl PlatformHttp {
    /// Exactly the first advertised WSS host; full public DNS validation, pinned
    /// TCP address and normal TLS certificate/SNI verification. No proxy,
    /// redirects, arbitrary host, credential header or retry is possible.
    pub async fn connect_live_text(
        &self,
        discovery: &text::live::Discovery,
        deadline: Instant,
    ) -> Result<text::live::Socket> {
        use tokio_tungstenite::tungstenite::{
            client::IntoClientRequest, protocol::WebSocketConfig,
        };
        let url = text::live::validate_socket_url(discovery.url().as_str())?;
        let host = url
            .host_str()
            .ok_or(bilibili::Error::InvalidResponse("live_danmaku_host"))?;
        let port = url
            .port_or_known_default()
            .ok_or(bilibili::Error::InvalidResponse("live_danmaku_port"))?;
        let addresses = tokio::time::timeout_at(
            deadline.min(Instant::now() + DNS_TIMEOUT),
            SystemResolver.resolve(host, port),
        )
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(|_| bilibili::Error::Transport)?;
        if addresses.is_empty()
            || addresses.len() > MAX_DNS_ADDRESSES
            || addresses.iter().any(|address| {
                address.port() != port
                    || !public_address(address.ip())
                    || matches!(address,SocketAddr::V6(v) if v.scope_id()!=0 || v.flowinfo()!=0)
            })
        {
            return Err(bilibili::Error::Restricted("platform_address_denied"));
        }
        let stream =
            tokio::time::timeout_at(deadline, tokio::net::TcpStream::connect(addresses[0]))
                .await
                .map_err(|_| bilibili::Error::Deadline)?
                .map_err(|_| bilibili::Error::Transport)?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| bilibili::Error::InvalidResponse("live_danmaku_request"))?;
        request.headers_mut().insert(
            "Origin",
            HeaderValue::from_static("https://live.bilibili.com"),
        );
        request
            .headers_mut()
            .insert("User-Agent", HeaderValue::from_static(USER_AGENT));
        let config = WebSocketConfig::default()
            .max_message_size(Some(text::live::MAX_FRAME_BYTES))
            .max_frame_size(Some(text::live::MAX_FRAME_BYTES))
            .max_write_buffer_size(128 * 1024)
            .write_buffer_size(32 * 1024);
        let (socket, response) = tokio::time::timeout_at(
            deadline,
            tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), None),
        )
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(|_| bilibili::Error::Transport)?;
        if response.status().as_u16() != 101 {
            return Err(bilibili::Error::Restricted("live_danmaku_handshake_denied"));
        }
        Ok(text::live::Socket::new(socket))
    }
}
