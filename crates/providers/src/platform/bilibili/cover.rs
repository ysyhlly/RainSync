//! Opaque public cover targets; never accepted as an arbitrary browser URL.
use super::{Error, Future, Instant, Pin, Result, Url};

pub const MAX_COVER_BYTES: usize = 512 * 1024;

pub struct CoverUrl(Url);
impl CoverUrl {
    pub fn parse(value: &str) -> Result<Self> {
        if value.len() > 2048 || value.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(Error::InvalidResponse("cover_url"));
        }
        let mut url = Url::parse(value).map_err(|_| Error::InvalidResponse("cover_url"))?;
        if !matches!(url.scheme(), "http" | "https")
            || !matches!(
                url.host_str(),
                Some("i0.hdslb.com" | "i1.hdslb.com" | "i2.hdslb.com" | "i3.hdslb.com")
            )
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Restricted("cover_origin_denied"));
        }
        let path = url
            .path()
            .strip_prefix("/bfs/archive/")
            .ok_or(Error::Restricted("cover_path_denied"))?;
        let (stem, extension) = path
            .rsplit_once('.')
            .ok_or(Error::Restricted("cover_path_denied"))?;
        if !matches!(stem.len(), 32 | 40 | 64)
            || !stem.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !matches!(extension, "jpg" | "jpeg" | "png" | "webp")
        {
            return Err(Error::Restricted("cover_path_denied"));
        }
        // View still returns HTTP covers for old entries. Upgrade only this
        // fixed known public CDN target; transport always uses HTTPS/TLS.
        url.set_scheme("https")
            .map_err(|_| Error::InvalidResponse("cover_url"))?;
        Ok(Self(url))
    }
    pub(crate) fn url(&self) -> &Url {
        &self.0
    }
}

pub struct CoverResponse {
    pub content_type: String,
    pub body: Vec<u8>,
}

pub trait Transport: Send + Sync {
    fn get_cover<'a>(
        &'a self,
        url: &'a CoverUrl,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<CoverResponse>> + Send + 'a>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cover_targets_are_fixed_public_https_images_without_credentials_or_redirect_inputs() {
        let path = "/bfs/archive/0123456789abcdef0123456789abcdef01234567.jpg";
        assert_eq!(
            CoverUrl::parse(&format!("http://i0.hdslb.com{path}"))
                .unwrap()
                .url()
                .scheme(),
            "https"
        );
        for value in [
            format!("https://i0.hdslb.com.evil.invalid{path}"),
            format!("https://user:secret@i0.hdslb.com{path}"),
            format!("https://i0.hdslb.com:444{path}"),
            format!("https://i0.hdslb.com{path}?target=secret"),
            format!("https://i0.hdslb.com{path}#secret"),
            "https://127.0.0.1/cover.jpg".into(),
            "https://i0.hdslb.com/bfs/archive/file.svg".into(),
            "https://i0.hdslb.com/bfs/archive/../private/0123456789abcdef0123456789abcdef.jpg"
                .into(),
        ] {
            assert!(CoverUrl::parse(&value).is_err());
        }
    }
}
