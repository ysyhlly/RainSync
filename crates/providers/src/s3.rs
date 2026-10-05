//! Read-only, source-scoped S3 access. This is deliberately separate from any
//! artifact store: no upload, deletion, account provisioning or presigned URLs.
//! Credential references are environment variable names, never secret values.
use crate::{Item, SourceConfig, media_request::MediaRequest};
use anyhow::{Result, anyhow, ensure};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use reqwest::{
    Method, Response, Url,
    header::{self, HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_CURSOR_BYTES: usize = 16 * 1024;
const MAX_LIST_PAGES: usize = 10_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct S3Config {
    pub region: String,
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub addressing_style: AddressingStyle,
    pub credential_ref: CredentialRef,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressingStyle {
    #[default]
    Path,
    /// The configured endpoint already includes the bucket in its hostname.
    /// We never infer a new credential-bearing origin from a bucket name.
    VirtualHosted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialRef {
    pub access_key_id_env: String,
    pub secret_access_key_env: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token_env: Option<String>,
}

impl CredentialRef {
    pub fn validate(&self) -> Result<()> {
        fn valid(name: &str) -> bool {
            name.len() > "RAINSYNC_S3_".len()
                && name.len() <= 128
                && name.starts_with("RAINSYNC_S3_")
                && name
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        }
        ensure!(
            valid(&self.access_key_id_env)
                && valid(&self.secret_access_key_env)
                && self.session_token_env.as_deref().is_none_or(valid),
            "invalid_s3_credential_reference"
        );
        ensure!(
            self.access_key_id_env != self.secret_access_key_env
                && self
                    .session_token_env
                    .as_ref()
                    .is_none_or(|name| name != &self.access_key_id_env
                        && name != &self.secret_access_key_env),
            "invalid_s3_credential_reference"
        );
        Ok(())
    }
    fn resolve(&self) -> Result<Credentials> {
        self.validate()?;
        let read =
            |name: &str| std::env::var(name).map_err(|_| anyhow!("s3_credentials_unavailable"));
        let credentials = Credentials {
            access_key_id: read(&self.access_key_id_env)?,
            secret_access_key: read(&self.secret_access_key_env)?,
            session_token: self.session_token_env.as_deref().map(read).transpose()?,
        };
        credentials.validate()?;
        Ok(credentials)
    }
}

// Deliberately not Debug/Serialize. Errors never include environment values.
pub(crate) struct Credentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}
impl Credentials {
    fn validate(&self) -> Result<()> {
        ensure!(
            !self.access_key_id.is_empty()
                && self.access_key_id.len() <= 128
                && self
                    .access_key_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')),
            "invalid_s3_credentials"
        );
        ensure!(
            !self.secret_access_key.is_empty()
                && self.secret_access_key.len() <= 1024
                && self.secret_access_key.bytes().all(|b| b.is_ascii_graphic()),
            "invalid_s3_credentials"
        );
        if let Some(token) = &self.session_token {
            ensure!(
                !token.is_empty()
                    && token.len() <= MAX_CURSOR_BYTES
                    && token.bytes().all(|b| b.is_ascii_graphic()),
                "invalid_s3_credentials"
            );
        }
        Ok(())
    }
}

/// Check the endpoint, bucket, prefix and reference syntax without resolving
/// credentials or contacting the source. Ref-to-owner binding belongs to the
/// administrator/source owner layer, not to the environment resolver.
pub fn validate_config(config: &SourceConfig) -> Result<()> {
    let s3 = config
        .s3
        .as_ref()
        .ok_or_else(|| anyhow!("missing_s3_config"))?;
    s3.credential_ref.validate()?;
    ensure!(
        !s3.region.is_empty()
            && s3.region.len() <= 64
            && s3
                .region
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "invalid_s3_region"
    );
    ensure!(
        (3..=63).contains(&s3.bucket.len())
            && s3
                .bucket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.'))
            && s3.bucket.as_bytes()[0].is_ascii_alphanumeric()
            && s3.bucket.as_bytes()[s3.bucket.len() - 1].is_ascii_alphanumeric()
            && !s3.bucket.contains("..")
            && s3.bucket.parse::<std::net::Ipv4Addr>().is_err(),
        "invalid_s3_bucket"
    );
    ensure!(
        s3.prefix.len() <= 1024 && !s3.prefix.chars().any(char::is_control),
        "invalid_s3_prefix"
    );
    ensure!(
        config.token.is_empty() && config.headers.is_empty(),
        "s3_embedded_credentials_or_headers"
    );
    let endpoint = crate::validate_url(&config.url).map_err(|_| anyhow!("invalid_s3_endpoint"))?;
    ensure!(
        endpoint.query().is_none()
            && endpoint.fragment().is_none()
            && !config.url.contains('#')
            && !config.url.contains('\\')
            && !config.url.bytes().any(|b| b.is_ascii_control())
            && config.url.trim() == config.url,
        "invalid_s3_endpoint"
    );
    ensure!(
        uri_encode(&percent_decode(endpoint.path())?, true) == endpoint.path(),
        "invalid_s3_endpoint_path"
    );
    crate::access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())?;
    if s3.addressing_style == AddressingStyle::VirtualHosted {
        ensure!(
            endpoint
                .host_str()
                .is_some_and(|host| host.starts_with(&format!("{}.", s3.bucket))),
            "invalid_s3_virtual_hosted_endpoint"
        );
    }
    Ok(())
}

fn uri_encode(value: &str, preserve_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    const HEX: &[u8] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~')
            || preserve_slash && byte == b'/'
        {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 15) as usize] as char);
        }
    }
    out
}

fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            ensure!(i + 2 < bytes.len(), "invalid_s3_encoding");
            let high = (bytes[i + 1] as char)
                .to_digit(16)
                .ok_or_else(|| anyhow!("invalid_s3_encoding"))?;
            let low = (bytes[i + 2] as char)
                .to_digit(16)
                .ok_or_else(|| anyhow!("invalid_s3_encoding"))?;
            decoded.push((high * 16 + low) as u8);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| anyhow!("invalid_s3_encoding"))
}

fn bucket_url(config: &SourceConfig) -> Result<Url> {
    validate_config(config)?;
    let s3 = config.s3.as_ref().unwrap();
    let mut url = crate::validate_url(&config.url)?;
    let path = match s3.addressing_style {
        AddressingStyle::Path => format!("{}/{}", url.path().trim_end_matches('/'), s3.bucket),
        AddressingStyle::VirtualHosted => format!("{}/", url.path().trim_end_matches('/')),
    };
    url.set_path(&path);
    Ok(url)
}

fn validate_key(s3: &S3Config, key: &str) -> Result<()> {
    ensure!(
        !key.is_empty() && key.len() <= 1024 && !key.chars().any(char::is_control),
        "invalid_s3_key"
    );
    ensure!(key.starts_with(&s3.prefix), "s3_prefix_denied");
    // WHATWG URLs normalize dot segments, whereas S3 keys do not. Reject these
    // unrepresentable keys rather than silently reading a different object.
    ensure!(
        !key.split('/').any(|part| matches!(part, "." | "..")),
        "unsupported_s3_dot_segment_key"
    );
    Ok(())
}

/// Stable unsigned target for encrypted Worker grants; credentials are added
/// immediately before each GET/HEAD, never stored in this URL.
pub fn object_url(config: &SourceConfig, key: &str, version_id: Option<&str>) -> Result<Url> {
    let base = bucket_url(config)?;
    validate_key(config.s3.as_ref().unwrap(), key)?;
    let path = format!(
        "{}/{}",
        base.path().trim_end_matches('/'),
        uri_encode(key, true)
    );
    let mut url = Url::parse(&format!("{}{}", base.origin().ascii_serialization(), path))
        .map_err(|_| anyhow!("invalid_s3_key"))?;
    ensure!(url.path() == path, "unsupported_s3_dot_segment_key");
    if let Some(version) = version_id {
        ensure!(
            !version.is_empty() && version.len() <= 1024 && !version.chars().any(char::is_control),
            "invalid_s3_version"
        );
        url.set_query(Some(&format!("versionId={}", uri_encode(version, false))));
    }
    Ok(url)
}

pub async fn object_request(
    config: &SourceConfig,
    key: &str,
    version_id: Option<&str>,
    method: Method,
    range: Option<&str>,
    if_match: Option<&str>,
) -> Result<MediaRequest> {
    ensure!(
        matches!(method, Method::GET | Method::HEAD),
        "unsupported_s3_method"
    );
    let url = object_url(config, key, version_id)?;
    let mut request =
        crate::source_media_request(config, url.as_str(), method, &BTreeMap::new()).await?;
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    if let Some(etag) = if_match {
        validate_etag(etag)?;
        request = request.header(header::IF_MATCH, etag);
    }
    Ok(request.header(header::ACCEPT_ENCODING, "identity"))
}

pub async fn get_object(
    config: &SourceConfig,
    key: &str,
    version_id: Option<&str>,
    range: Option<&str>,
    if_match: Option<&str>,
) -> Result<Response> {
    let response = object_request(config, key, version_id, Method::GET, range, if_match)
        .await?
        .send()
        .await?;
    ensure_read_success(&response)?;
    Ok(response)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObjectMetadata {
    pub key: String,
    pub version_id: Option<String>,
    /// Opaque conditional validator; NOT an object checksum or a file MD5.
    pub etag: Option<String>,
    pub size: u64,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub checksum_algorithms: Vec<String>,
}
impl ObjectMetadata {
    /// Reliable version ID wins; otherwise bind the opaque validator, length
    /// and modification time without claiming ETag is a content hash.
    pub fn source_version(&self, bucket: &str) -> String {
        let identity = if self.version_id.as_deref().is_some_and(|v| v != "null") {
            json!([bucket, self.key, self.version_id])
        } else {
            json!([bucket, self.key, self.etag, self.size, self.last_modified])
        };
        format!(
            "s3:v1:{:x}",
            Sha256::digest(identity.to_string().as_bytes())
        )
    }
}

pub async fn head_object(
    config: &SourceConfig,
    key: &str,
    version_id: Option<&str>,
    if_match: Option<&str>,
) -> Result<ObjectMetadata> {
    let response = object_request(config, key, version_id, Method::HEAD, None, if_match)
        .await?
        .send()
        .await?;
    ensure_read_success(&response)?;
    metadata_from_head(key, response.headers())
}

fn validate_etag(etag: &str) -> Result<()> {
    ensure!(
        etag.len() >= 2
            && etag.len() <= 1024
            && etag.starts_with('"')
            && etag.ends_with('"')
            && etag[1..etag.len() - 1]
                .bytes()
                .all(|b| b >= 0x21 && b != b'"' && b != 0x7f),
        "invalid_s3_etag"
    );
    HeaderValue::from_str(etag).map_err(|_| anyhow!("invalid_s3_etag"))?;
    Ok(())
}
fn metadata_from_head(key: &str, headers: &HeaderMap) -> Result<ObjectMetadata> {
    let text = |name: &str| -> Result<Option<String>> {
        let values = headers.get_all(name);
        let mut values = values.iter();
        let Some(value) = values.next() else {
            return Ok(None);
        };
        ensure!(values.next().is_none(), "invalid_s3_metadata");
        let value = value.to_str().map_err(|_| anyhow!("invalid_s3_metadata"))?;
        ensure!(
            value.len() <= 1024 && !value.chars().any(char::is_control),
            "invalid_s3_metadata"
        );
        Ok(Some(value.to_owned()))
    };
    let etag = text("etag")?.ok_or_else(|| anyhow!("invalid_s3_metadata"))?;
    validate_etag(&etag)?;
    let size = text("content-length")?
        .ok_or_else(|| anyhow!("invalid_s3_metadata"))?
        .parse::<u64>()
        .map_err(|_| anyhow!("invalid_s3_metadata"))?;
    let version_id = text("x-amz-version-id")?;
    ensure!(
        version_id
            .as_ref()
            .is_none_or(|v| !v.is_empty() && !v.chars().any(char::is_control)),
        "invalid_s3_metadata"
    );
    Ok(ObjectMetadata {
        key: key.into(),
        version_id,
        etag: Some(etag),
        size,
        last_modified: text("last-modified")?,
        content_type: text("content-type")?,
        checksum_algorithms: vec![],
    })
}
fn ensure_read_success(response: &Response) -> Result<()> {
    ensure!(
        response.status().is_success(),
        "s3_read_failed_status_{}",
        response.status().as_u16()
    );
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListPage {
    pub objects: Vec<ObjectMetadata>,
    pub next_continuation_token: Option<String>,
}

fn list_url(
    config: &SourceConfig,
    continuation_token: Option<&str>,
    page_size: u16,
) -> Result<Url> {
    ensure!((1..=1000).contains(&page_size), "invalid_s3_page_size");
    let mut url = bucket_url(config)?;
    let mut query = vec![
        ("encoding-type", "url".to_owned()),
        ("list-type", "2".to_owned()),
        ("max-keys", page_size.to_string()),
        ("prefix", config.s3.as_ref().unwrap().prefix.clone()),
    ];
    if let Some(cursor) = continuation_token {
        ensure!(
            !cursor.is_empty()
                && cursor.len() <= MAX_CURSOR_BYTES
                && !cursor.chars().any(char::is_control),
            "invalid_s3_cursor"
        );
        query.push(("continuation-token", cursor.into()));
    }
    query.sort();
    url.set_query(Some(
        &query
            .into_iter()
            .map(|(name, value)| format!("{name}={}", uri_encode(&value, false)))
            .collect::<Vec<_>>()
            .join("&"),
    ));
    Ok(url)
}

/// A page is returned only after status, bounded XML and prefix validation.
/// Callers may persist its cursor after committing that page's upserts.
pub async fn list_page(
    config: &SourceConfig,
    continuation_token: Option<&str>,
    page_size: u16,
) -> Result<ListPage> {
    let url = list_url(config, continuation_token, page_size)?;
    let response = crate::source_media_request(config, url.as_str(), Method::GET, &BTreeMap::new())
        .await?
        .send()
        .await?;
    ensure_read_success(&response)?;
    let bytes = tokio::time::timeout(Duration::from_secs(30), bounded_list_body(response))
        .await
        .map_err(|_| anyhow!("s3_list_timeout"))??;
    parse_list_page(config, &bytes, continuation_token, page_size)
}
async fn bounded_list_body(response: Response) -> Result<Vec<u8>> {
    ensure!(
        response
            .content_length()
            .is_none_or(|n| n <= MAX_LIST_BYTES as u64),
        "s3_list_body_limit"
    );
    let mut body = vec![];
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| anyhow!("s3_list_body_failed"))?;
        ensure!(
            body.len().saturating_add(chunk.len()) <= MAX_LIST_BYTES,
            "s3_list_body_limit"
        );
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[derive(Deserialize)]
#[serde(rename = "ListBucketResult")]
struct XmlList {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Prefix")]
    prefix: String,
    #[serde(rename = "EncodingType")]
    encoding: String,
    #[serde(rename = "IsTruncated")]
    truncated: bool,
    #[serde(rename = "NextContinuationToken")]
    next: Option<String>,
    #[serde(rename = "Contents", default)]
    objects: Vec<XmlObject>,
}
#[derive(Deserialize)]
struct XmlObject {
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "Size")]
    size: u64,
    #[serde(rename = "ETag")]
    etag: Option<String>,
    #[serde(rename = "LastModified")]
    last_modified: Option<String>,
    #[serde(rename = "ChecksumAlgorithm", default)]
    checksum_algorithms: Vec<String>,
}
fn parse_list_page(
    config: &SourceConfig,
    body: &[u8],
    previous: Option<&str>,
    page_size: u16,
) -> Result<ListPage> {
    ensure!(body.len() <= MAX_LIST_BYTES, "s3_list_body_limit");
    // Never accept DTD/entity declarations or deep adversarial XML. The event
    // pass also requires the exact root and a single complete document.
    let mut reader = quick_xml::Reader::from_reader(body);
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        use quick_xml::events::Event;
        match reader
            .read_event()
            .map_err(|_| anyhow!("invalid_s3_list_xml"))?
        {
            Event::DocType(_) => return Err(anyhow!("invalid_s3_list_xml")),
            Event::Start(event) => {
                if depth == 0 {
                    ensure!(
                        event.name().as_ref() == b"ListBucketResult" && roots == 0,
                        "invalid_s3_list_xml"
                    );
                    roots += 1;
                }
                depth += 1;
                ensure!(depth <= 16, "invalid_s3_list_xml");
            }
            Event::End(_) => {
                ensure!(depth > 0, "invalid_s3_list_xml");
                depth -= 1;
            }
            Event::Eof => break,
            Event::Decl(_) if depth != 0 || roots != 0 => {
                return Err(anyhow!("invalid_s3_list_xml"));
            }
            Event::CData(_) | Event::GeneralRef(_) if depth == 0 => {
                return Err(anyhow!("invalid_s3_list_xml"));
            }
            Event::Empty(_) if depth == 0 => return Err(anyhow!("invalid_s3_list_xml")),
            Event::Text(event) if depth == 0 => ensure!(
                event.as_ref().iter().all(u8::is_ascii_whitespace),
                "invalid_s3_list_xml"
            ),
            _ => (),
        }
    }
    ensure!(roots == 1 && depth == 0, "invalid_s3_list_xml");
    let xml: XmlList =
        quick_xml::de::from_reader(body).map_err(|_| anyhow!("invalid_s3_list_xml"))?;
    let s3 = config
        .s3
        .as_ref()
        .ok_or_else(|| anyhow!("missing_s3_config"))?;
    ensure!(
        xml.name == s3.bucket
            && xml.encoding == "url"
            && percent_decode(&xml.prefix)? == s3.prefix
            && xml.objects.len() <= page_size as usize,
        "invalid_s3_list_scope"
    );
    let next = if xml.truncated {
        let cursor = xml.next.ok_or_else(|| anyhow!("invalid_s3_cursor"))?;
        ensure!(
            !cursor.is_empty()
                && cursor.len() <= MAX_CURSOR_BYTES
                && !cursor.chars().any(char::is_control)
                && previous != Some(cursor.as_str()),
            "invalid_s3_cursor"
        );
        Some(cursor)
    } else {
        ensure!(
            xml.next.as_deref().is_none_or(str::is_empty),
            "invalid_s3_cursor"
        );
        None
    };
    let mut seen = HashSet::new();
    let mut objects = vec![];
    for object in xml.objects {
        let key = percent_decode(&object.key)?;
        validate_key(s3, &key)?;
        ensure!(seen.insert(key.clone()), "duplicate_s3_list_key");
        validate_etag(
            object
                .etag
                .as_deref()
                .ok_or_else(|| anyhow!("invalid_s3_metadata"))?,
        )?;
        ensure!(
            object
                .last_modified
                .as_ref()
                .is_none_or(|v| v.len() <= 128 && !v.chars().any(char::is_control))
                && object.checksum_algorithms.len() <= 8
                && object
                    .checksum_algorithms
                    .iter()
                    .all(|v| v.len() <= 32
                        && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')),
            "invalid_s3_metadata"
        );
        objects.push(ObjectMetadata {
            key,
            version_id: None,
            etag: object.etag,
            size: object.size,
            last_modified: object.last_modified,
            content_type: None,
            checksum_algorithms: object.checksum_algorithms,
        });
    }
    Ok(ListPage {
        objects,
        next_continuation_token: next,
    })
}

/// Convenience path for legacy all-at-once indexing. Durable scans should use
/// list_page instead. Failure never returns an apparently complete empty list.
pub async fn list_items(config: &SourceConfig) -> Result<Vec<Item>> {
    validate_config(config)?;
    let mut cursor = None;
    let mut cursors = HashSet::new();
    let mut keys = HashSet::new();
    let mut items = vec![];
    for _ in 0..MAX_LIST_PAGES {
        let page = list_page(config, cursor.as_deref(), 1000).await?;
        for object in page.objects {
            ensure!(keys.insert(object.key.clone()), "duplicate_s3_list_key");
            let file = object.key.rsplit('/').next().unwrap_or("");
            let Some((title, extension)) = file.rsplit_once('.') else {
                continue;
            };
            if !["mp4", "mkv", "webm", "mov", "m4v"]
                .contains(&extension.to_ascii_lowercase().as_str())
            {
                continue;
            }
            items.push(Item {title:title.into(),resource:object.key.clone(),duration_ms:None,
                metadata:json!({"s3":object,"source_version":object.source_version(&config.s3.as_ref().unwrap().bucket)})});
        }
        cursor = page.next_continuation_token;
        let Some(next) = &cursor else {
            return Ok(items);
        };
        ensure!(cursors.insert(next.clone()), "s3_cursor_loop");
    }
    Err(anyhow!("s3_scan_page_limit"))
}

/// Used only by the scoped media transport, after application-owned range and
/// conditional headers are finalized. No signature is carried across a hop.
pub(crate) struct RequestSigner {
    config: SourceConfig,
    #[cfg(test)]
    pub(crate) test_credentials: Option<Credentials>,
}
impl RequestSigner {
    pub(crate) fn new(config: &SourceConfig, target: &Url, method: &Method) -> Result<Self> {
        validate_config(config)?;
        let signer = Self {
            config: config.clone(),
            #[cfg(test)]
            test_credentials: None,
        };
        signer.validate_target(target, method)?;
        Ok(signer)
    }
    fn validate_target(&self, target: &Url, method: &Method) -> Result<()> {
        ensure!(
            matches!(*method, Method::GET | Method::HEAD),
            "unsupported_s3_method"
        );
        let bucket = bucket_url(&self.config)?;
        ensure!(
            bucket.origin() == target.origin() && target.fragment().is_none(),
            "s3_target_denied"
        );
        let query: BTreeMap<_, _> = target.query_pairs().into_owned().collect();
        ensure!(
            query.len() == target.query_pairs().count(),
            "s3_target_denied"
        );
        if target.path() == bucket.path() {
            ensure!(
                *method == Method::GET
                    && query.len() >= 4
                    && query.len() <= 5
                    && query.get("list-type").is_some_and(|v| v == "2")
                    && query.get("encoding-type").is_some_and(|v| v == "url")
                    && query.get("prefix") == Some(&self.config.s3.as_ref().unwrap().prefix)
                    && query
                        .get("max-keys")
                        .and_then(|v| v.parse::<u16>().ok())
                        .is_some_and(|v| (1..=1000).contains(&v))
                    && query.keys().all(|name| [
                        "list-type",
                        "encoding-type",
                        "prefix",
                        "max-keys",
                        "continuation-token"
                    ]
                    .contains(&name.as_str())),
                "s3_target_denied"
            );
            if let Some(cursor) = query.get("continuation-token") {
                ensure!(
                    !cursor.is_empty()
                        && cursor.len() <= MAX_CURSOR_BYTES
                        && !cursor.chars().any(char::is_control),
                    "s3_target_denied"
                );
            }
        } else {
            let prefix = format!("{}/", bucket.path().trim_end_matches('/'));
            let encoded = target
                .path()
                .strip_prefix(&prefix)
                .ok_or_else(|| anyhow!("s3_target_denied"))?;
            let key = percent_decode(encoded)?;
            ensure!(
                query.is_empty() || query.len() == 1 && query.contains_key("versionId"),
                "s3_target_denied"
            );
            let expected = object_url(
                &self.config,
                &key,
                query.get("versionId").map(String::as_str),
            )?;
            ensure!(expected == *target, "s3_target_denied");
        }
        Ok(())
    }
    pub(crate) fn sign(
        &self,
        target: &Url,
        method: &Method,
        headers: HeaderMap,
    ) -> Result<HeaderMap> {
        self.validate_target(target, method)?;
        if let Some(etag) = headers.get(header::IF_MATCH) {
            validate_etag(etag.to_str().map_err(|_| anyhow!("invalid_s3_etag"))?)?;
        }
        let date = amz_date(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| anyhow!("invalid_s3_clock"))?
                .as_secs(),
        )?;
        #[cfg(test)]
        if let Some(credentials) = &self.test_credentials {
            return sign_headers(
                target,
                method,
                headers,
                &self.config.s3.as_ref().unwrap().region,
                credentials,
                &date,
            );
        }
        let credentials = self.config.s3.as_ref().unwrap().credential_ref.resolve()?;
        sign_headers(
            target,
            method,
            headers,
            &self.config.s3.as_ref().unwrap().region,
            &credentials,
            &date,
        )
    }
    pub(crate) fn validate_response(
        &self,
        target: &Url,
        response: &Response,
        expected_if_match: Option<&HeaderValue>,
    ) -> Result<()> {
        if !response.status().is_success() {
            return Ok(());
        }
        if let Some((_, version)) = target.query_pairs().find(|(name, _)| name == "versionId") {
            ensure!(
                response
                    .headers()
                    .get_all("x-amz-version-id")
                    .iter()
                    .count()
                    == 1
                    && response
                        .headers()
                        .get("x-amz-version-id")
                        .and_then(|v| v.to_str().ok())
                        == Some(version.as_ref()),
                "s3_version_mismatch"
            );
        }
        if let Some(etag) = expected_if_match {
            ensure!(
                response.headers().get_all(header::ETAG).iter().count() == 1
                    && response.headers().get(header::ETAG) == Some(etag),
                "s3_etag_mismatch"
            );
        }
        Ok(())
    }
}

fn sign_headers(
    target: &Url,
    method: &Method,
    mut headers: HeaderMap,
    region: &str,
    credentials: &Credentials,
    date: &str,
) -> Result<HeaderMap> {
    credentials.validate()?;
    ensure!(
        matches!(*method, Method::GET | Method::HEAD)
            && date.len() == 16
            && date.ends_with('Z')
            && date.as_bytes()[8] == b'T'
            && date
                .bytes()
                .enumerate()
                .all(|(i, b)| matches!(i, 8 | 15) || b.is_ascii_digit()),
        "invalid_s3_signature_input"
    );
    ensure!(
        !headers.contains_key(header::HOST)
            && !headers.contains_key(header::AUTHORIZATION)
            && !headers
                .keys()
                .any(|name| name.as_str().starts_with("x-amz-")),
        "invalid_s3_signature_headers"
    );
    let host = match target.port() {
        Some(port) => format!(
            "{}:{port}",
            target
                .host_str()
                .ok_or_else(|| anyhow!("invalid_s3_endpoint"))?
        ),
        None => target.host_str().unwrap().to_owned(),
    };
    headers.insert(
        "x-amz-date",
        HeaderValue::from_str(date).map_err(|_| anyhow!("invalid_s3_signature_input"))?,
    );
    headers.insert(
        "x-amz-content-sha256",
        HeaderValue::from_static(EMPTY_SHA256),
    );
    if let Some(token) = &credentials.session_token {
        let mut token =
            HeaderValue::from_str(token).map_err(|_| anyhow!("invalid_s3_credentials"))?;
        token.set_sensitive(true);
        headers.insert("x-amz-security-token", token);
    }
    let mut canonical = BTreeMap::new();
    canonical.insert("host".to_owned(), host);
    for name in headers.keys() {
        let values = headers
            .get_all(name)
            .iter()
            .map(|value| {
                value
                    .to_str()
                    .map(|v| v.split_ascii_whitespace().collect::<Vec<_>>().join(" "))
                    .map_err(|_| anyhow!("invalid_s3_signature_headers"))
            })
            .collect::<Result<Vec<_>>>()?;
        canonical.insert(name.as_str().to_owned(), values.join(","));
    }
    let signed_headers = canonical
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = canonical
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect::<String>();
    let mut query = target
        .query_pairs()
        .map(|(name, value)| (uri_encode(&name, false), uri_encode(&value, false)))
        .collect::<Vec<_>>();
    query.sort();
    let query = query
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        target.path(),
        query,
        canonical_headers,
        signed_headers,
        EMPTY_SHA256
    );
    let scope = format!("{}/{region}/s3/aws4_request", &date[..8]);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{date}\n{scope}\n{:x}",
        Sha256::digest(canonical_request.as_bytes())
    );
    let hmac = |key: &[u8], body: &[u8]| -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
        mac.update(body);
        mac.finalize().into_bytes().to_vec()
    };
    let key = hmac(
        format!("AWS4{}", credentials.secret_access_key).as_bytes(),
        &date.as_bytes()[..8],
    );
    let key = hmac(&key, region.as_bytes());
    let key = hmac(&key, b"s3");
    let key = hmac(&key, b"aws4_request");
    let signature = hmac(&key, to_sign.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope},SignedHeaders={signed_headers},Signature={signature}",
        credentials.access_key_id
    );
    let mut authorization =
        HeaderValue::from_str(&authorization).map_err(|_| anyhow!("invalid_s3_credentials"))?;
    authorization.set_sensitive(true);
    headers.insert(header::AUTHORIZATION, authorization);
    Ok(headers)
}

fn amz_date(seconds: u64) -> Result<String> {
    ensure!(seconds <= 253402300799, "invalid_s3_clock");
    let mut days = seconds / 86400;
    let clock = seconds % 86400;
    let mut year = 1970u64;
    let leap = |year: u64| {
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
    };
    loop {
        let len = if leap(year) { 366 } else { 365 };
        if days < len {
            break;
        }
        days -= len;
        year += 1;
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0;
    while days >= months[month] {
        days -= months[month];
        month += 1;
    }
    Ok(format!(
        "{year:04}{:02}{:02}T{:02}{:02}{:02}Z",
        month + 1,
        days + 1,
        clock / 3600,
        clock / 60 % 60,
        clock % 60
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access_policy::{AccessError, Resolution, Resolver};
    use crate::media_request::MediaRequestError;
    use std::{
        net::SocketAddr,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn config(endpoint: &str) -> SourceConfig {
        serde_json::from_value(json!({"url":endpoint,"s3":{
            "region":"us-east-1","bucket":"media-bucket","prefix":"media/",
            "credential_ref":{"access_key_id_env":"RAINSYNC_S3_TEST_ACCESS_KEY_ID",
                "secret_access_key_env":"RAINSYNC_S3_TEST_SECRET_ACCESS_KEY"}}}))
        .unwrap()
    }
    fn synthetic() -> Credentials {
        Credentials {
            access_key_id: "synthetic-access".into(),
            secret_access_key: "synthetic-secret".into(),
            session_token: Some("synthetic-session-token".into()),
        }
    }
    fn xml(keys: &[&str], truncated: bool, cursor: Option<&str>) -> String {
        format!("<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>media-bucket</Name><Prefix>media%2F</Prefix><EncodingType>url</EncodingType><IsTruncated>{truncated}</IsTruncated>{}{}{}</ListBucketResult>",
            cursor.map(|cursor|format!("<NextContinuationToken>{cursor}</NextContinuationToken>")).unwrap_or_default(),
            keys.iter().map(|key|format!("<Contents><Key>{}</Key><Size>123</Size><ETag>&quot;multipart-2&quot;</ETag><LastModified>2026-10-05T00:00:00Z</LastModified><ChecksumAlgorithm>SHA256</ChecksumAlgorithm></Contents>",uri_encode(key,false))).collect::<String>(),"")
    }

    #[test]
    fn published_aws_sigv4_get_and_list_vectors() {
        // Public AWS documentation test credentials, not a real account.
        // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
        let credentials = Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-9"));
        let signed = sign_headers(
            &Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap(),
            &Method::GET,
            headers,
            "us-east-1",
            &credentials,
            "20130524T000000Z",
        )
        .unwrap();
        assert_eq!(
            signed[header::AUTHORIZATION],
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
        let signed = sign_headers(
            &Url::parse("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2").unwrap(),
            &Method::GET,
            HeaderMap::new(),
            "us-east-1",
            &credentials,
            "20130524T000000Z",
        )
        .unwrap();
        assert!(signed[header::AUTHORIZATION].to_str().unwrap().ends_with(
            "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        ));
        assert!(signed[header::AUTHORIZATION].is_sensitive());
    }

    #[test]
    fn unsigned_targets_preserve_keys_versions_and_prefix_scope() {
        let config = config("https://storage.example/s3/");
        let key = "media/nested/雪 +%?#.mp4";
        let url = object_url(&config, key, Some("version+/= &?")).unwrap();
        assert_eq!(
            url.path(),
            "/s3/media-bucket/media/nested/%E9%9B%AA%20%2B%25%3F%23.mp4"
        );
        assert_eq!(url.query(), Some("versionId=version%2B%2F%3D%20%26%3F"));
        assert!(RequestSigner::new(&config, &url, &Method::GET).is_ok());
        assert!(!url.as_str().contains("secret") && !url.as_str().contains("X-Amz"));
        for key in [
            "elsewhere/movie.mp4",
            "media/../movie.mp4",
            "media/./movie.mp4",
            "",
        ] {
            assert!(object_url(&config, key, None).is_err(), "{key}");
        }
        for target in [
            "https://storage.example/s3/other-bucket/media/movie.mp4",
            "https://other.example/s3/media-bucket/media/movie.mp4",
            "https://storage.example/s3/media-bucket/media/movie.mp4?uploadId=write",
            "https://storage.example/s3/media-bucket/media/movie.mp4?versionId=1&versionId=2",
            "https://storage.example/s3/media-bucket?list-type=2&encoding-type=url&max-keys=1000&prefix=",
        ] {
            assert!(
                RequestSigner::new(&config, &Url::parse(target).unwrap(), &Method::GET).is_err(),
                "{target}"
            );
        }
        for method in [Method::PUT, Method::POST, Method::DELETE, Method::PATCH] {
            assert!(RequestSigner::new(&config, &url, &method).is_err());
        }
        let mut virtual_hosted = config.clone();
        virtual_hosted.s3.as_mut().unwrap().addressing_style = AddressingStyle::VirtualHosted;
        assert!(validate_config(&virtual_hosted).is_err());
        virtual_hosted.url = "https://media-bucket.s3.us-east-1.amazonaws.com".into();
        assert_eq!(
            object_url(&virtual_hosted, "media/film.mp4", None)
                .unwrap()
                .path(),
            "/media/film.mp4"
        );
    }

    #[test]
    fn configuration_has_closed_environment_only_credential_references() {
        let config = config("https://storage.example");
        assert!(validate_config(&config).is_ok());
        for name in [
            "DATABASE_URL",
            "RAINSYNC_S3_",
            "RAINSYNC_S3_lower",
            "RAINSYNC_S3_SECRET\n",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            let mut changed = config.clone();
            changed
                .s3
                .as_mut()
                .unwrap()
                .credential_ref
                .secret_access_key_env = name.into();
            assert!(validate_config(&changed).is_err(), "{name}");
        }
        for url in [
            "https://user:pass@storage.example",
            "https://storage.example?key=secret",
            "https://storage.example#fragment",
            "https://storage.example/s3$proxy",
        ] {
            let mut changed = config.clone();
            changed.url = url.into();
            assert!(validate_config(&changed).is_err(), "{url}");
        }
        let mut changed = config.clone();
        changed.token = "embedded-secret".into();
        assert!(validate_config(&changed).is_err());
        changed = config.clone();
        changed
            .headers
            .insert("Authorization".into(), "embedded".into());
        assert!(validate_config(&changed).is_err());
        let mut raw = serde_json::to_value(&config).unwrap();
        raw["s3"]["secret_access_key"] = json!("embedded");
        assert!(serde_json::from_value::<SourceConfig>(raw).is_err());
        let resource = json!({"source_url":config.url,"s3":config.s3});
        let round_trip = crate::resource_config(&resource).unwrap();
        assert!(round_trip.s3.is_some());
    }

    #[test]
    fn list_xml_validates_pagination_encoding_scope_and_opaque_etags() {
        let config = config("https://storage.example");
        let body = xml(&["media/雪 +%?.mp4"], true, Some("opaque+/= &amp;token"));
        let page = parse_list_page(&config, body.as_bytes(), None, 1000).unwrap();
        assert_eq!(page.objects[0].key, "media/雪 +%?.mp4");
        assert_eq!(page.objects[0].etag.as_deref(), Some("\"multipart-2\""));
        assert_eq!(
            page.next_continuation_token.as_deref(),
            Some("opaque+/= &token")
        );
        assert_eq!(page.objects[0].checksum_algorithms, vec!["SHA256"]);
        assert!(parse_list_page(&config, body.as_bytes(), Some("opaque+/= &token"), 1000).is_err());
        for bad in [
            xml(&["private/outside.mp4"], false, None),
            xml(&["media/a.mp4", "media/a.mp4"], false, None),
            xml(&[], true, None),
            xml(&[], false, Some("unexpected")),
            body.replace("media-bucket", "other-bucket"),
            body.replace("<Prefix>media%2F</Prefix>", "<Prefix>private%2F</Prefix>"),
            body.replace(
                "<EncodingType>url</EncodingType>",
                "<EncodingType>other</EncodingType>",
            ),
            body.replace("<Key>", "<Key>%XX"),
            body.replace("<IsTruncated>true</IsTruncated>", ""),
            body.replace("<Size>123</Size>", "<Size>-1</Size>"),
            body.replace("&quot;multipart-2&quot;", "W/&quot;weak&quot;"),
            format!("<!DOCTYPE data [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]>{body}"),
            format!("{body}{body}"),
            format!("{body}<![CDATA[trailing]]>"),
            format!("{body}<?xml version=\"1.0\"?>"),
            body.replace("</Contents>", "</Wrong>"),
            body.replace("<ListBucketResult ", "<WrongRoot ")
                .replace("</ListBucketResult>", "</WrongRoot>"),
        ] {
            assert!(
                parse_list_page(&config, bad.as_bytes(), None, 1000).is_err(),
                "accepted malformed listing"
            );
        }
        assert!(
            parse_list_page(
                &config,
                xml(&["media/a.mp4", "media/b.mp4"], false, None).as_bytes(),
                None,
                1
            )
            .is_err()
        );
        assert!(parse_list_page(&config, &vec![b'x'; MAX_LIST_BYTES + 1], None, 1000).is_err());
        let url = list_url(&config, Some("opaque+/= &token"), 1000).unwrap();
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "continuation-token")
                .unwrap()
                .1,
            "opaque+/= &token"
        );
        assert!(RequestSigner::new(&config, &url, &Method::GET).is_ok());
    }

    #[test]
    fn head_metadata_and_version_identity_do_not_treat_etag_as_md5() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("1234"));
        headers.insert(
            header::ETAG,
            HeaderValue::from_static("\"opaque-multipart-7\""),
        );
        headers.insert("x-amz-version-id", HeaderValue::from_static("version-1"));
        headers.insert(
            header::LAST_MODIFIED,
            HeaderValue::from_static("Mon, 05 Oct 2026 00:00:00 GMT"),
        );
        let object = metadata_from_head("media/movie.mp4", &headers).unwrap();
        assert_eq!(object.version_id.as_deref(), Some("version-1"));
        assert_eq!(object.size, 1234);
        let mut changed = object.clone();
        changed.etag = Some("\"different\"".into());
        assert_eq!(
            object.source_version("bucket"),
            changed.source_version("bucket")
        );
        changed.version_id = Some("version-2".into());
        assert_ne!(
            object.source_version("bucket"),
            changed.source_version("bucket")
        );
        let mut unversioned = object.clone();
        unversioned.version_id = None;
        changed = unversioned.clone();
        changed.etag = Some("\"different\"".into());
        assert_ne!(
            unversioned.source_version("bucket"),
            changed.source_version("bucket")
        );
        headers.insert(header::ETAG, HeaderValue::from_static("W/\"weak\""));
        assert!(metadata_from_head("media/movie.mp4", &headers).is_err());
        headers.insert(header::ETAG, HeaderValue::from_static("\"strong\""));
        headers.append(header::ETAG, HeaderValue::from_static("\"other\""));
        assert!(metadata_from_head("media/movie.mp4", &headers).is_err());
    }

    #[test]
    fn utc_signature_dates_handle_leap_years_and_bounds() {
        assert_eq!(amz_date(0).unwrap(), "19700101T000000Z");
        assert_eq!(amz_date(951782400).unwrap(), "20000229T000000Z");
        assert_eq!(amz_date(1369353600).unwrap(), "20130524T000000Z");
        assert_eq!(amz_date(253402300799).unwrap(), "99991231T235959Z");
        assert!(amz_date(u64::MAX).is_err());
    }

    struct LocalResolver {
        calls: AtomicUsize,
    }
    impl Resolver for LocalResolver {
        fn resolve<'a>(&'a self, _host: &'a str, port: u16) -> Resolution<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(vec![SocketAddr::from(([127, 0, 0, 1], port))]) })
        }
    }
    struct Fixture {
        port: u16,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Fixture {
        async fn new(reply: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(vec![]));
            let seen = requests.clone();
            let task = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut bytes = vec![];
                    loop {
                        let mut buf = [0; 1024];
                        let n = stream.read(&mut buf).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if bytes.ends_with(b"\r\n\r\n") {
                            break;
                        }
                        assert!(bytes.len() < 65536);
                    }
                    let request = String::from_utf8(bytes).unwrap();
                    seen.lock().unwrap().push(request.clone());
                    let _ = stream.write_all(reply(&request).as_bytes()).await;
                }
            });
            Self {
                port,
                requests,
                task,
            }
        }
        fn config(&self) -> SourceConfig {
            let mut config = config(&format!("http://storage.invalid:{}", self.port));
            config.access_policy = Some(
                serde_json::from_value(json!({"schema_version":1,"origins":[
                {"origin":config.url,"cidrs":["127.0.0.1/32"]}],"redirects":{"max_hops":5}}))
                .unwrap(),
            );
            config
        }
    }
    fn response(status: u16, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} Fixture\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }
    fn resolver() -> LocalResolver {
        LocalResolver {
            calls: AtomicUsize::new(0),
        }
    }

    #[tokio::test]
    async fn scoped_transport_signs_actual_range_conditions_head_and_session_token() {
        let fixture = Fixture::new(|request| {
            if request.starts_with("HEAD ") {
                response(
                    200,
                    "ETag: \"opaque-2\"\r\nx-amz-version-id: version+/=1\r\n",
                    "",
                )
            } else {
                response(
                    206,
                    "ETag: \"opaque-2\"\r\nx-amz-version-id: version+/=1\r\nContent-Range: bytes 0-3/10\r\n",
                    "abcd",
                )
            }
        })
        .await;
        let config = fixture.config();
        let resolver = resolver();
        let response = object_request(
            &config,
            "media/movie.mp4",
            Some("version+/=1"),
            Method::GET,
            Some("bytes=0-3"),
            Some("\"opaque-2\""),
        )
        .await
        .unwrap()
        .with_s3_test_credentials(synthetic())
        .send_with_resolver(&resolver)
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.text().await.unwrap(), "abcd");
        let target = object_url(&config, "media/movie.mp4", Some("version+/=1")).unwrap();
        let digest = format!("{:x}", Sha256::digest(target.as_str().as_bytes()));
        let response = object_request(
            &config,
            "media/movie.mp4",
            Some("version+/=1"),
            Method::HEAD,
            None,
            None,
        )
        .await
        .unwrap()
        .conditional_identity(&digest, "\"opaque-2\"")
        .with_s3_test_credentials(synthetic())
        .send_with_resolver(&resolver)
        .await
        .unwrap();
        let metadata = metadata_from_head("media/movie.mp4", response.headers()).unwrap();
        assert_eq!(metadata.version_id.as_deref(), Some("version+/=1"));
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            let request = request.to_ascii_lowercase();
            assert!(request.contains("versionid=version%2b%2f%3d1"));
            assert!(request.contains("if-match: \"opaque-2\""));
            assert!(request.contains("x-amz-security-token: synthetic-session-token"));
            assert!(
                request.contains("authorization: aws4-hmac-sha256 credential=synthetic-access/")
            );
            assert!(!request.contains("synthetic-secret"));
            assert!(request.contains("signedheaders=accept-encoding;host;if-match;"));
        }
        assert!(requests[0].contains("range: bytes=0-3"));
        assert!(requests[0].contains(";range;x-amz-content-sha256;"));
        assert!(!requests[1].contains(";range;"));
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn s3_redirect_and_dns_policy_failure_never_replay_credentials() {
        let fixture =
            Fixture::new(|_| response(307, "Location: /media-bucket/media/final.mp4\r\n", ""))
                .await;
        let config = fixture.config();
        let resolver = resolver();
        let result = object_request(&config, "media/movie.mp4", None, Method::GET, None, None)
            .await
            .unwrap()
            .with_s3_test_credentials(synthetic())
            .send_with_resolver(&resolver)
            .await;
        assert!(matches!(result, Err(MediaRequestError::RedirectDisabled)));
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
        let mut denied = config.clone();
        denied.access_policy.as_mut().unwrap().origins[0].cidrs = vec!["192.0.2.0/24".into()];
        let result = object_request(&denied, "media/movie.mp4", None, Method::GET, None, None)
            .await
            .unwrap()
            .with_s3_test_credentials(synthetic())
            .send_with_resolver(&resolver)
            .await;
        assert!(matches!(
            result,
            Err(MediaRequestError::Access(AccessError::AddressDenied))
        ));
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn ignored_version_or_conditional_etag_cannot_return_successful_object_bytes() {
        let fixture = Fixture::new(|request| {
            let version = if request.contains("missing-version.mp4") {
                ""
            } else if request.contains("wrong-version.mp4") {
                "x-amz-version-id: other-version\r\n"
            } else {
                "x-amz-version-id: selected-version\r\n"
            };
            let etag = if request.contains("wrong-etag.mp4") {
                "ETag: \"other-etag\"\r\n"
            } else {
                "ETag: \"selected-etag\"\r\n"
            };
            response(200, &format!("{version}{etag}"), "object-bytes")
        })
        .await;
        let config = fixture.config();
        for key in [
            "media/missing-version.mp4",
            "media/wrong-version.mp4",
            "media/wrong-etag.mp4",
        ] {
            let result = object_request(
                &config,
                key,
                Some("selected-version"),
                Method::GET,
                None,
                Some("\"selected-etag\""),
            )
            .await
            .unwrap()
            .with_s3_test_credentials(synthetic())
            .send_with_resolver(&resolver())
            .await;
            assert!(
                matches!(result, Err(MediaRequestError::S3RepresentationChanged)),
                "{key}"
            );
        }
        let result =
            crate::source_request(&config, &config.url, Method::DELETE, &BTreeMap::new()).await;
        assert_eq!(
            result.err().unwrap().to_string(),
            "s3_requires_read_transport"
        );
        assert_eq!(fixture.requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn mock_two_page_list_resumes_cursor_and_failure_is_not_empty_success() {
        let first = xml(&["media/a.mp4"], true, Some("opaque+/= &amp;token"));
        let last = xml(&["media/b.mp4"], false, None);
        let fixture = Fixture::new(move |request| {
            if request.contains("continuation-token=") {
                response(200, "Content-Type: application/xml\r\n", &last)
            } else {
                response(200, "Content-Type: application/xml\r\n", &first)
            }
        })
        .await;
        let config = fixture.config();
        let resolver = resolver();
        let mut cursor = None;
        let mut keys = vec![];
        loop {
            let target = list_url(&config, cursor.as_deref(), 1000).unwrap();
            let response = crate::source_media_request(
                &config,
                target.as_str(),
                Method::GET,
                &BTreeMap::new(),
            )
            .await
            .unwrap()
            .with_s3_test_credentials(synthetic())
            .send_with_resolver(&resolver)
            .await
            .unwrap();
            ensure_read_success(&response).unwrap();
            let body = bounded_list_body(response).await.unwrap();
            let page = parse_list_page(&config, &body, cursor.as_deref(), 1000).unwrap();
            keys.extend(page.objects.into_iter().map(|v| v.key));
            cursor = page.next_continuation_token;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(keys, vec!["media/a.mp4", "media/b.mp4"]);
        {
            let requests = fixture.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert!(requests[1].contains("continuation-token=opaque%2B%2F%3D%20%26token"));
        }
        let failed = Fixture::new(|_| {
            response(
                403,
                "Content-Type: application/xml\r\n",
                "<Error><Code>AccessDenied</Code></Error>",
            )
        })
        .await;
        let config = failed.config();
        let target = list_url(&config, None, 1000).unwrap();
        let response =
            crate::source_media_request(&config, target.as_str(), Method::GET, &BTreeMap::new())
                .await
                .unwrap()
                .with_s3_test_credentials(synthetic())
                .send_with_resolver(&resolver)
                .await
                .unwrap();
        assert_eq!(
            ensure_read_success(&response).unwrap_err().to_string(),
            "s3_read_failed_status_403"
        );
    }

    #[test]
    fn real_environment_resolver_and_production_apis_run_in_owned_subprocess() {
        // Environment changes are confined to a fresh process, not global
        // unsafe mutations in a concurrent Rust test runtime.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "s3::tests::production_api_environment_fixture",
            ])
            .env_clear()
            .env("RAINSYNC_S3_TEST_ACCESS_KEY_ID", "synthetic-access")
            .env("RAINSYNC_S3_TEST_SECRET_ACCESS_KEY", "synthetic-secret")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-secret"));
    }

    #[tokio::test]
    #[ignore = "owned subprocess helper with synthetic environment credentials"]
    async fn production_api_environment_fixture() {
        let failed_once = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let failed = failed_once.clone();
        let fixture = Fixture::new(move |request| {
            if request.contains("list-type=2") {
                let page = request.lines().next().unwrap().split_ascii_whitespace().nth(1).unwrap()
                    .split("continuation-token=page-").nth(1)
                    .and_then(|value| value.split('&').next()).and_then(|v|v.parse::<usize>().ok()).unwrap_or(0);
                if page == 5 && !failed.swap(true, Ordering::SeqCst) {
                    return response(503, "", "<Error><Code>SlowDown</Code></Error>");
                }
                let keys = (page*1000..page*1000+1000).map(|i|format!("media/{i:05}.mp4")).collect::<Vec<_>>();
                let next = (page < 9).then(||format!("page-{}",page+1));
                response(200,"Content-Type: application/xml\r\n",&xml(&keys.iter().map(String::as_str).collect::<Vec<_>>(),page<9,next.as_deref()))
            } else if request.starts_with("HEAD ") {
                "HTTP/1.1 200 Fixture\r\nContent-Length: 10\r\nETag: \"multipart-2\"\r\nx-amz-version-id: version-1\r\nContent-Type: video/mp4\r\nConnection: close\r\n\r\n".into()
            } else {
                response(206,"ETag: \"multipart-2\"\r\nx-amz-version-id: version-1\r\nContent-Range: bytes 0-3/10\r\n","abcd")
            }
        }).await;
        let config = config(&format!("http://127.0.0.1:{}", fixture.port));
        let credentials = config
            .s3
            .as_ref()
            .unwrap()
            .credential_ref
            .resolve()
            .unwrap();
        assert_eq!(credentials.access_key_id, "synthetic-access");
        assert_eq!(credentials.secret_access_key, "synthetic-secret");
        let mut cursor = None;
        let mut keys = HashSet::new();
        let mut failure_seen = false;
        loop {
            let page = match list_page(&config, cursor.as_deref(), 1000).await {
                Ok(page) => page,
                Err(error) => {
                    assert_eq!(error.to_string(), "s3_read_failed_status_503");
                    assert!(!failure_seen);
                    failure_seen = true;
                    // Resume the same previously committed continuation token.
                    list_page(&config, cursor.as_deref(), 1000).await.unwrap()
                }
            };
            for object in page.objects {
                assert!(keys.insert(object.key));
            }
            cursor = page.next_continuation_token;
            if cursor.is_none() {
                break;
            }
        }
        assert!(failure_seen);
        assert_eq!(keys.len(), 10_000);
        let metadata = head_object(
            &config,
            "media/00001.mp4",
            Some("version-1"),
            Some("\"multipart-2\""),
        )
        .await
        .unwrap();
        assert_eq!(metadata.size, 10);
        assert_eq!(metadata.version_id.as_deref(), Some("version-1"));
        let response = get_object(
            &config,
            "media/00001.mp4",
            Some("version-1"),
            Some("bytes=0-3"),
            Some("\"multipart-2\""),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.text().await.unwrap(), "abcd");
        assert_eq!(list_items(&config).await.unwrap().len(), 10_000);
        assert!(fixture.requests.lock().unwrap().iter().all(|request| {
            request.contains("authorization: AWS4-HMAC-SHA256")
                && !request.contains("synthetic-secret")
        }));
    }
}
