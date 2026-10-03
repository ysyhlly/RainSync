//! Bounded redirects for registered media reads, not a general HTTP proxy.
//!
//! Provider metadata, PlaybackInfo and lifecycle mutations continue to use the
//! no-follow source_request API. Only GET/HEAD are admitted here; neither a
//! request body nor caller-selected authority/credential headers can be replayed.
use crate::{
    SourceConfig,
    access_policy::{AccessError, Resolver, SourceAccess, SystemResolver},
};
use reqwest::{
    Method, Response, StatusCode, Url,
    header::{self, HeaderMap, HeaderName, HeaderValue},
};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaRequestError {
    Access(AccessError),
    InvalidHeaders,
    UnsupportedMethod,
    RedirectDisabled,
    RedirectLimit,
    RedirectLoop,
    InvalidLocation,
    RedirectDowngrade,
    RequestFailed,
    Timeout,
}
impl MediaRequestError {
    pub fn is_transient(self) -> bool {
        matches!(
            self,
            Self::RequestFailed
                | Self::Timeout
                | Self::Access(AccessError::DnsFailed | AccessError::DnsTimeout)
        )
    }
}
impl fmt::Display for MediaRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Access(error) => error.fmt(f),
            other => f.write_str(match other {
                Self::InvalidHeaders => "invalid_media_request_headers",
                Self::UnsupportedMethod => "unsupported_media_request_method",
                Self::RedirectDisabled => "source_redirect_disabled",
                Self::RedirectLimit => "source_redirect_limit",
                Self::RedirectLoop => "source_redirect_loop",
                Self::InvalidLocation => "invalid_source_redirect_location",
                Self::RedirectDowngrade => "source_redirect_downgrade",
                Self::RequestFailed => "source_media_request_failed",
                Self::Timeout => "source_media_request_timeout",
                Self::Access(_) => unreachable!(),
            }),
        }
    }
}
impl std::error::Error for MediaRequestError {}
impl From<AccessError> for MediaRequestError {
    fn from(error: AccessError) -> Self {
        Self::Access(error)
    }
}
type Result<T> = std::result::Result<T, MediaRequestError>;

/// Source credentials and representation-control headers have separate owners.
/// All source-configured headers stay on the exact primary origin, including
/// custom secrets and cookies. No cookie store or automatic Referer is enabled.
/// Only the narrow delivery header set can be carried to an authorized CDN.
pub struct MediaRequest {
    access: SourceAccess,
    target: Url,
    method: Method,
    source_headers: HeaderMap,
    delivery_headers: HeaderMap,
    invalid_headers: bool,
}

pub async fn source_media_request(
    config: &SourceConfig,
    target: &str,
    method: Method,
    headers: &BTreeMap<String, String>,
) -> Result<MediaRequest> {
    if !matches!(method, Method::GET | Method::HEAD) {
        return Err(MediaRequestError::UnsupportedMethod);
    }
    crate::validate_source_headers(headers).map_err(|_| MediaRequestError::InvalidHeaders)?;
    let access = SourceAccess::new(&config.url, config.access_policy.as_ref())?;
    let target = access.authorize_url(target)?;
    let mut source_headers = HeaderMap::new();
    for (name, value) in headers {
        let mut value =
            HeaderValue::from_str(value).map_err(|_| MediaRequestError::InvalidHeaders)?;
        value.set_sensitive(true);
        source_headers.insert(
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| MediaRequestError::InvalidHeaders)?,
            value,
        );
    }
    Ok(MediaRequest {
        access,
        target,
        method,
        source_headers,
        delivery_headers: HeaderMap::new(),
        invalid_headers: false,
    })
}

impl MediaRequest {
    pub fn header<V: TryInto<HeaderValue>>(mut self, name: HeaderName, value: V) -> Self {
        if !matches!(
            name,
            header::RANGE
                | header::IF_RANGE
                | header::IF_MATCH
                | header::IF_UNMODIFIED_SINCE
                | header::ACCEPT_ENCODING
        ) {
            self.invalid_headers = true;
        } else if let Ok(value) = value.try_into() {
            if name == header::ACCEPT_ENCODING && value != "identity" {
                self.invalid_headers = true;
            } else {
                self.delivery_headers.insert(name, value);
            }
        } else {
            self.invalid_headers = true;
        }
        self
    }

    pub async fn send(self) -> Result<Response> {
        self.send_with_resolver(&SystemResolver).await
    }

    /// Resolver injection still goes through the same whole-answer validation
    /// and fresh address-pinned client for every hop, even on the same origin.
    pub async fn send_with_resolver(self, resolver: &impl Resolver) -> Result<Response> {
        tokio::time::timeout(Duration::from_secs(30), self.send_inner(resolver))
            .await
            .map_err(|_| MediaRequestError::Timeout)?
    }

    async fn send_inner(self, resolver: &impl Resolver) -> Result<Response> {
        if self.invalid_headers {
            return Err(MediaRequestError::InvalidHeaders);
        }
        let mut target = self.target;
        let mut visited = HashSet::new();
        visited.insert(target.as_str().to_owned());
        let max_hops = self.access.max_redirects();
        let mut hops = 0;
        loop {
            let client = self
                .access
                .client_for_with_resolver(target.as_str(), resolver)
                .await?;
            let mut request = client.request(self.method.clone());
            if client.source_credentials_allowed() {
                request = request.headers(self.source_headers.clone());
            }
            // Application-owned range/identity decisions override source config.
            request = request.headers(self.delivery_headers.clone());
            let response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    MediaRequestError::Timeout
                } else {
                    MediaRequestError::RequestFailed
                }
            })?;
            if !is_redirect(response.status()) {
                return Ok(response);
            }
            if max_hops == 0 {
                return Err(MediaRequestError::RedirectDisabled);
            }
            if hops >= max_hops {
                return Err(MediaRequestError::RedirectLimit);
            }
            let next = redirect_target(&self.access, &target, response.headers())?;
            if !visited.insert(next.as_str().to_owned()) {
                return Err(MediaRequestError::RedirectLoop);
            }
            // Do not consume unbounded redirect bodies and never copy response
            // cookies, request queries, Referer, or headers into the next hop.
            drop(response);
            target = next;
            hops += 1;
        }
    }
}
fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn redirect_target(access: &SourceAccess, target: &Url, headers: &HeaderMap) -> Result<Url> {
    let location = headers.get_all(header::LOCATION);
    let mut locations = location.iter();
    let location = locations.next().ok_or(MediaRequestError::InvalidLocation)?;
    if locations.next().is_some() {
        return Err(MediaRequestError::InvalidLocation);
    }
    let location = location
        .to_str()
        .map_err(|_| MediaRequestError::InvalidLocation)?;
    if location.is_empty()
        || location.len() > 16 * 1024
        || location.trim() != location
        || location
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'\\')
    {
        return Err(MediaRequestError::InvalidLocation);
    }
    let next = target
        .join(location)
        .map_err(|_| MediaRequestError::InvalidLocation)?;
    let next = access.authorize_url(next.as_str())?;
    if target.scheme() == "https" && next.scheme() == "http" {
        return Err(MediaRequestError::RedirectDowngrade);
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permitted_http_origin_does_not_authorize_https_downgrade() {
        let policy = serde_json::from_value(serde_json::json!({"schema_version":1,"origins":[
            {"origin":"https://media.invalid","cidrs":["192.0.2.0/24"]},
            {"origin":"http://media.invalid","cidrs":["192.0.2.0/24"]}
        ],"redirects":{"max_hops":5}}))
        .unwrap();
        let access = SourceAccess::new("https://media.invalid", Some(&policy)).unwrap();
        let target = Url::parse("https://media.invalid/start?signature=secret").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::LOCATION,
            "http://media.invalid/final".parse().unwrap(),
        );
        assert_eq!(
            redirect_target(&access, &target, &headers),
            Err(MediaRequestError::RedirectDowngrade)
        );
        headers.insert(header::LOCATION, "/final".parse().unwrap());
        assert_eq!(
            redirect_target(&access, &target, &headers)
                .unwrap()
                .as_str(),
            "https://media.invalid/final"
        );
    }
}
