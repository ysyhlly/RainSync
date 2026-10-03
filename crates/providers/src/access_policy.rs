//! Source-scoped HTTP authorization and direct, address-pinned connections.
//!
//! This module does not authorize a playback session or track a source revision.
//! Callers must check those owners before using the returned request builder and
//! throughout long-lived responses. Missing policy is deliberately named legacy
//! origin-only mode: it preserves administrator-configured LAN/loopback sources
//! and does NOT promise an address boundary against DNS rebinding.
use reqwest::{Client, Method, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    pin::Pin,
    sync::{Arc, OnceLock},
    time::Duration,
};

const MAX_ORIGINS: usize = 16;
const MAX_CIDRS: usize = 64;
const MAX_ADDRESSES: usize = 64;
const DNS_TIMEOUT: Duration = Duration::from_secs(3);

/// This version supports exact origins and explicit CIDRs only. Unknown fields
/// (including unsupported path or proxy policy) fail deserialization closed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceAccessPolicy {
    pub schema_version: u8,
    pub origins: Vec<OriginRule>,
    /// Media GET/HEAD only. Omission preserves conservative no-follow behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirects: Option<RedirectPolicy>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedirectPolicy {
    pub max_hops: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OriginRule {
    pub origin: String,
    pub cidrs: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Enforcement {
    LegacyOriginOnly,
    StrictCidrsV1,
}

/// Errors contain no URL, query, header, credential, DNS response or IP address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessError {
    InvalidUrl,
    InvalidPolicy,
    UnsupportedVersion,
    OriginDenied,
    AddressDenied,
    InvalidAddress,
    DnsFailed,
    DnsTimeout,
    DnsAnswerLimit,
    EmptyDnsAnswer,
    ClientUnavailable,
}

impl fmt::Display for AccessError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::InvalidUrl => "invalid_source_url",
            Self::InvalidPolicy => "invalid_source_access_policy",
            Self::UnsupportedVersion => "unsupported_source_access_policy",
            Self::OriginDenied => "source_origin_denied",
            Self::AddressDenied => "source_address_denied",
            Self::InvalidAddress => "invalid_source_address",
            Self::DnsFailed => "source_dns_failed",
            Self::DnsTimeout => "source_dns_timeout",
            Self::DnsAnswerLimit => "source_dns_answer_limit",
            Self::EmptyDnsAnswer => "source_dns_empty",
            Self::ClientUnavailable => "source_client_unavailable",
        })
    }
}
impl std::error::Error for AccessError {}
pub type Result<T> = std::result::Result<T, AccessError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Cidr {
    network: IpAddr,
    prefix: u8,
}

fn normalized_ip(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(address)),
        other => other,
    }
}

impl Cidr {
    fn parse(value: &str) -> Result<Self> {
        let (network, prefix) = value.split_once('/').ok_or(AccessError::InvalidPolicy)?;
        if prefix.is_empty()
            || !prefix.bytes().all(|byte| byte.is_ascii_digit())
            || (prefix.len() > 1 && prefix.starts_with('0'))
        {
            return Err(AccessError::InvalidPolicy);
        }
        let network: IpAddr = network.parse().map_err(|_| AccessError::InvalidPolicy)?;
        let mut prefix: u8 = prefix.parse().map_err(|_| AccessError::InvalidPolicy)?;
        if let IpAddr::V6(address) = network
            && address.to_ipv4_mapped().is_some()
        {
            // Broader mapped ranges also cover native IPv6 and are ambiguous.
            prefix = prefix.checked_sub(96).ok_or(AccessError::InvalidPolicy)?;
        }
        let network = normalized_ip(network);
        let canonical = match network {
            IpAddr::V4(address) if prefix <= 32 => {
                let mask = u32::MAX.checked_shl(u32::from(32 - prefix)).unwrap_or(0);
                IpAddr::V4(Ipv4Addr::from(u32::from(address) & mask))
            }
            IpAddr::V6(address) if prefix <= 128 => {
                let mask = u128::MAX.checked_shl(u32::from(128 - prefix)).unwrap_or(0);
                IpAddr::V6(Ipv6Addr::from(u128::from(address) & mask))
            }
            _ => return Err(AccessError::InvalidPolicy),
        };
        if canonical != network {
            return Err(AccessError::InvalidPolicy);
        }
        Ok(Self { network, prefix })
    }

    fn contains(self, address: IpAddr) -> bool {
        match (self.network, normalized_ip(address)) {
            (IpAddr::V4(network), IpAddr::V4(address)) => {
                let mask = u32::MAX
                    .checked_shl(u32::from(32 - self.prefix))
                    .unwrap_or(0);
                u32::from(network) == u32::from(address) & mask
            }
            (IpAddr::V6(network), IpAddr::V6(address)) => {
                let mask = u128::MAX
                    .checked_shl(u32::from(128 - self.prefix))
                    .unwrap_or(0);
                u128::from(network) == u128::from(address) & mask
            }
            _ => false,
        }
    }
}

fn target_url(value: &str) -> Result<Url> {
    // Avoid WHATWG cleanup turning confusing input into a different authority.
    if value
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte == b'\\')
        || value.trim() != value
    {
        return Err(AccessError::InvalidUrl);
    }
    let mut url = Url::parse(value).map_err(|_| AccessError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.host_str().is_some_and(|host| host.contains('*'))
        || url.port_or_known_default().is_none_or(|port| port == 0)
    {
        return Err(AccessError::InvalidUrl);
    }
    // Fragments are not sent to the origin and must not create grant aliases.
    url.set_fragment(None);
    Ok(url)
}

fn origin(value: &str) -> Result<String> {
    let url = target_url(value).map_err(|_| AccessError::InvalidPolicy)?;
    let authority = value
        .split_once("://")
        .map(|(_, value)| value)
        .ok_or(AccessError::InvalidPolicy)?;
    // Inspect original input as target_url intentionally strips a fragment.
    if url.path() != "/"
        || url.query().is_some()
        || value.contains('#')
        || authority
            .split_once('/')
            .is_some_and(|(_, path)| !path.is_empty())
        || authority.contains('%')
    {
        return Err(AccessError::InvalidPolicy);
    }
    Ok(url.origin().ascii_serialization())
}

/// A compiled source policy. The primary origin alone may receive the source's
/// existing credentials; extra explicitly allowed origins are anonymous.
#[derive(Clone)]
pub struct SourceAccess {
    primary_origin: String,
    rules: Option<BTreeMap<String, Vec<Cidr>>>,
    max_redirects: u8,
}

impl SourceAccess {
    pub fn new(configured_url: &str, policy: Option<&SourceAccessPolicy>) -> Result<Self> {
        let primary_origin = target_url(configured_url)?.origin().ascii_serialization();
        let rules = if let Some(policy) = policy {
            if policy.schema_version != 1 {
                return Err(AccessError::UnsupportedVersion);
            }
            if policy
                .redirects
                .as_ref()
                .is_some_and(|redirects| !(1..=5).contains(&redirects.max_hops))
            {
                return Err(AccessError::InvalidPolicy);
            }
            if policy.origins.is_empty() || policy.origins.len() > MAX_ORIGINS {
                return Err(AccessError::InvalidPolicy);
            }
            let mut rules = BTreeMap::new();
            for rule in &policy.origins {
                let origin = origin(&rule.origin)?;
                if rule.cidrs.is_empty() || rule.cidrs.len() > MAX_CIDRS {
                    return Err(AccessError::InvalidPolicy);
                }
                let mut unique = HashSet::new();
                let mut cidrs = Vec::with_capacity(rule.cidrs.len());
                for value in &rule.cidrs {
                    let cidr = Cidr::parse(value)?;
                    if !unique.insert(cidr) {
                        return Err(AccessError::InvalidPolicy);
                    }
                    cidrs.push(cidr);
                }
                if rules.insert(origin, cidrs).is_some() {
                    return Err(AccessError::InvalidPolicy);
                }
            }
            if !rules.contains_key(&primary_origin) {
                return Err(AccessError::InvalidPolicy);
            }
            Some(rules)
        } else {
            None
        };
        Ok(Self {
            primary_origin,
            rules,
            max_redirects: policy
                .and_then(|policy| policy.redirects.as_ref())
                .map_or(0, |redirects| redirects.max_hops),
        })
    }

    pub(crate) fn max_redirects(&self) -> u8 {
        self.max_redirects
    }

    pub fn enforcement(&self) -> Enforcement {
        if self.rules.is_some() {
            Enforcement::StrictCidrsV1
        } else {
            Enforcement::LegacyOriginOnly
        }
    }

    /// Parse and check the exact scheme/host/effective-port tuple before DNS.
    pub fn authorize_url(&self, value: &str) -> Result<Url> {
        let url = target_url(value)?;
        let origin = url.origin().ascii_serialization();
        let permitted = match &self.rules {
            Some(rules) => rules.contains_key(&origin),
            None => origin == self.primary_origin,
        };
        if !permitted {
            return Err(AccessError::OriginDenied);
        }
        Ok(url)
    }

    /// Validate the WHOLE resolver result. Never filter forbidden answers and
    /// silently retry another one, or fall back to a fresh unvalidated lookup.
    pub fn validate_addresses(
        &self,
        target: &str,
        addresses: &[SocketAddr],
    ) -> Result<Vec<SocketAddr>> {
        let url = self.authorize_url(target)?;
        if addresses.is_empty() {
            return Err(AccessError::EmptyDnsAnswer);
        }
        if addresses.len() > MAX_ADDRESSES {
            return Err(AccessError::DnsAnswerLimit);
        }
        let port = url.port_or_known_default().ok_or(AccessError::InvalidUrl)?;
        let cidrs = self
            .rules
            .as_ref()
            .and_then(|rules| rules.get(&url.origin().ascii_serialization()));
        let mut unique = HashSet::new();
        let mut validated = Vec::with_capacity(addresses.len());
        for address in addresses {
            let ip = normalized_ip(address.ip());
            if address.port() != port
                || matches!(address, SocketAddr::V6(address) if address.scope_id() != 0)
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip == IpAddr::V4(Ipv4Addr::BROADCAST)
            {
                return Err(AccessError::InvalidAddress);
            }
            if cidrs.is_some_and(|cidrs| !cidrs.iter().any(|cidr| cidr.contains(ip))) {
                return Err(AccessError::AddressDenied);
            }
            let normalized = SocketAddr::new(ip, port);
            if unique.insert(normalized) {
                validated.push(normalized);
            }
        }
        Ok(validated)
    }

    pub async fn client_for(&self, target: &str) -> Result<AuthorizedClient> {
        self.client_for_with_resolver(target, &SystemResolver).await
    }

    /// The resolver injection is for deterministic tests or an explicitly
    /// supplied deployment resolver, not a bypass of address validation.
    pub async fn client_for_with_resolver(
        &self,
        target: &str,
        resolver: &impl Resolver,
    ) -> Result<AuthorizedClient> {
        let url = self.authorize_url(target)?;
        let host = url.host_str().ok_or(AccessError::InvalidUrl)?;
        let port = url.port_or_known_default().ok_or(AccessError::InvalidUrl)?;
        let literal_host = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(host);
        let addresses = if let Ok(address) = literal_host.parse::<IpAddr>() {
            vec![SocketAddr::new(address, port)]
        } else {
            tokio::time::timeout(DNS_TIMEOUT, resolver.resolve(host, port))
                .await
                .map_err(|_| AccessError::DnsTimeout)?
                .map_err(|_| AccessError::DnsFailed)?
        };
        let addresses = self.validate_addresses(url.as_str(), &addresses)?;
        // Keep the original URL for HTTP Host and TLS SNI/certificate checks.
        // A fresh scoped client cannot reuse another policy's connection pool.
        // All fallback addresses belong to this one validated resolver answer.
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| AccessError::ClientUnavailable)?;
        let source_credentials_allowed = url.origin().ascii_serialization() == self.primary_origin;
        Ok(AuthorizedClient {
            client,
            url,
            addresses,
            source_credentials_allowed,
            enforcement: self.enforcement(),
        })
    }
}

pub type Resolution<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>;
pub trait Resolver: Sync {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> Resolution<'a>;
}
pub struct SystemResolver;
impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> Resolution<'a> {
        Box::pin(async move {
            // OS getaddrinfo may outlive a cancelled waiter. Keep its permit
            // inside the blocking owner, so timeouts cannot create unbounded
            // detached DNS work. The caller's deadline also covers admission.
            static LOOKUPS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
            let permit = LOOKUPS
                .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| std::io::Error::other("resolver_unavailable"))?;
            let host = host.to_owned();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let addresses = (host.as_str(), port).to_socket_addrs()?;
                // Take one extra so the caller rejects oversized answers.
                Ok(addresses.take(MAX_ADDRESSES + 1).collect())
            })
            .await
            .map_err(|_| std::io::Error::other("resolver_unavailable"))?
        })
    }
}

/// A client scoped to one checked URL and one resolver result. Do not log its
/// target URL: signed upstream query strings can contain credentials.
pub struct AuthorizedClient {
    client: Client,
    url: Url,
    addresses: Vec<SocketAddr>,
    source_credentials_allowed: bool,
    enforcement: Enforcement,
}
impl AuthorizedClient {
    pub fn request(&self, method: Method) -> RequestBuilder {
        self.client.request(method, self.url.clone())
    }

    pub fn source_credentials_allowed(&self) -> bool {
        self.source_credentials_allowed
    }

    pub fn enforcement(&self) -> Enforcement {
        self.enforcement
    }

    pub fn addresses(&self) -> &[SocketAddr] {
        &self.addresses
    }
}
