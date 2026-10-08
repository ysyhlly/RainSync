//! Stored source identity, independent of a selected playback transport.
//!
//! Parse only at string boundaries. This is deliberately not a wire enum:
//! existing DTOs/configuration retain their exact strings and error mappings.
//! Native platform identities are a separate namespace, not source kinds.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Local,
    Http,
    Jellyfin,
    Emby,
    Agent,
    S3,
}

impl SourceKind {
    /// Unknown spellings are left to each legacy boundary's existing error or
    /// fallthrough. In particular, this neither trims nor case-folds input.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local" => Some(Self::Local),
            "http" => Some(Self::Http),
            "jellyfin" => Some(Self::Jellyfin),
            "emby" => Some(Self::Emby),
            "agent" => Some(Self::Agent),
            "s3" => Some(Self::S3),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Http => "http",
            Self::Jellyfin => "jellyfin",
            Self::Emby => "emby",
            Self::Agent => "agent",
            Self::S3 => "s3",
        }
    }

    pub const fn upstream(self) -> Option<UpstreamKind> {
        match self {
            Self::Jellyfin => Some(UpstreamKind::Jellyfin),
            Self::Emby => Some(UpstreamKind::Emby),
            _ => None,
        }
    }
}

/// Only adapters implementing upstream metadata/PlaybackInfo capabilities.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UpstreamKind {
    Jellyfin,
    Emby,
}

impl UpstreamKind {
    pub fn parse(value: &str) -> Option<Self> {
        SourceKind::parse(value)?.upstream()
    }

    pub const fn source_kind(self) -> SourceKind {
        match self {
            Self::Jellyfin => SourceKind::Jellyfin,
            Self::Emby => SourceKind::Emby,
        }
    }

    pub const fn as_str(self) -> &'static str {
        self.source_kind().as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_identity_keeps_exact_legacy_spellings_and_s3_distinct_from_http() {
        for kind in [
            SourceKind::Local,
            SourceKind::Http,
            SourceKind::Jellyfin,
            SourceKind::Emby,
            SourceKind::Agent,
            SourceKind::S3,
        ] {
            assert_eq!(SourceKind::parse(kind.as_str()), Some(kind));
        }
        assert_ne!(SourceKind::S3, SourceKind::Http);
        for value in [
            "",
            "HTTP",
            "http ",
            " local",
            "bilibili",
            "native_platform",
            "other",
        ] {
            assert_eq!(SourceKind::parse(value), None);
        }
        assert_eq!(
            UpstreamKind::parse("jellyfin"),
            Some(UpstreamKind::Jellyfin)
        );
        assert_eq!(UpstreamKind::parse("emby"), Some(UpstreamKind::Emby));
        for value in ["local", "http", "agent", "s3", "unknown"] {
            assert_eq!(UpstreamKind::parse(value), None);
        }
    }
}
