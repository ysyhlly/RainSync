//! Parse HLS URI-bearing records before granting or rewriting any reference.
//! No network access or authorization decisions occur in this module.
use anyhow::{Result, bail, ensure};
use std::{collections::HashSet, ops::Range};

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_REFERENCES: usize = 20_000;
pub const MAX_DEPTH: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Playlist,
    Segment,
    Initialization,
    Key,
    Data,
}

#[derive(Debug)]
pub struct Reference<'a> {
    pub uri: &'a str,
    pub kind: Kind,
    span: Range<usize>,
}

pub struct Manifest<'a> {
    input: &'a str,
    references: Vec<Reference<'a>>,
}

struct Attribute<'a> {
    name: &'a str,
    value: &'a str,
    quoted: bool,
    span: Range<usize>,
}

fn attributes(input: &str, offset: usize) -> Result<Vec<Attribute<'_>>> {
    let mut output = Vec::new();
    let mut names = HashSet::new();
    let mut start = 0;
    while start < input.len() {
        let end = input[start..]
            .find('=')
            .map(|v| start + v)
            .ok_or_else(|| anyhow::anyhow!("invalid_manifest_attributes"))?;
        let name = &input[start..end];
        ensure!(
            !name.is_empty()
                && name
                    .bytes()
                    .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'-')
                && names.insert(name)
                && names.len() <= 128,
            "invalid_manifest_attributes"
        );
        let quoted = input.as_bytes().get(end + 1) == Some(&b'"');
        let value_start = end + 1 + usize::from(quoted);
        let value_end = if quoted {
            input[value_start..]
                .find('"')
                .map(|v| value_start + v)
                .ok_or_else(|| anyhow::anyhow!("invalid_manifest_attributes"))?
        } else {
            input[value_start..]
                .find(',')
                .map(|v| value_start + v)
                .unwrap_or(input.len())
        };
        let next = value_end + usize::from(quoted);
        ensure!(
            next == input.len() || input.as_bytes()[next] == b',',
            "invalid_manifest_attributes"
        );
        let value = &input[value_start..value_end];
        ensure!(
            !value.is_empty() && !value.bytes().any(|v| v.is_ascii_control()),
            "invalid_manifest_attributes"
        );
        ensure!(
            quoted || !value.contains('"'),
            "invalid_manifest_attributes"
        );
        output.push(Attribute {
            name,
            value,
            quoted,
            span: offset + value_start..offset + value_end,
        });
        if next == input.len() {
            break;
        }
        start = next + 1;
        ensure!(start < input.len(), "invalid_manifest_attributes");
    }
    Ok(output)
}

fn attribute<'a>(attributes: &'a [Attribute<'a>], name: &str) -> Option<&'a str> {
    attributes.iter().find(|v| v.name == name).map(|v| v.value)
}

impl<'a> Manifest<'a> {
    pub fn parse(input: &'a str) -> Result<Self> {
        ensure!(input.len() <= MAX_BYTES, "manifest_limit");
        ensure!(
            input.lines().next() == Some("#EXTM3U"),
            "invalid_manifest_header"
        );
        let mut references = Vec::new();
        let mut offset = 0;
        let mut variant = false;
        for raw in input.split_inclusive('\n') {
            let line = raw.trim_end_matches(['\n', '\r']);
            let trimmed = line.trim();
            if trimmed.is_empty() {
                offset += raw.len();
                continue;
            }
            if !trimmed.starts_with('#') {
                ensure!(
                    !trimmed.bytes().any(|v| v.is_ascii_control()) && !trimmed.contains("{$"),
                    "invalid_manifest_uri"
                );
                let leading = line.len() - line.trim_start().len();
                references.push(Reference {
                    uri: trimmed,
                    kind: if variant {
                        Kind::Playlist
                    } else {
                        Kind::Segment
                    },
                    span: offset + leading..offset + leading + trimmed.len(),
                });
                variant = false;
            } else if trimmed.starts_with("#EXT-X-") {
                let (tag, value) = trimmed.split_once(':').unwrap_or((trimmed, ""));
                let kind = match tag {
                    "#EXT-X-MEDIA"
                    | "#EXT-X-I-FRAME-STREAM-INF"
                    | "#EXT-X-IMAGE-STREAM-INF"
                    | "#EXT-X-RENDITION-REPORT" => Some(Kind::Playlist),
                    "#EXT-X-MAP" => Some(Kind::Initialization),
                    "#EXT-X-KEY" | "#EXT-X-SESSION-KEY" => Some(Kind::Key),
                    "#EXT-X-PART" => Some(Kind::Segment),
                    "#EXT-X-PRELOAD-HINT" | "#EXT-X-SESSION-DATA" => Some(Kind::Data),
                    "#EXT-X-STREAM-INF" => {
                        variant = true;
                        None
                    }
                    "#EXT-X-DEFINE" => bail!("manifest_variables_unsupported"),
                    _ => None,
                };
                if kind.is_some() || tag == "#EXT-X-STREAM-INF" {
                    let leading = line.len() - line.trim_start().len();
                    let fields = attributes(value, offset + leading + tag.len() + 1)?;
                    if kind == Some(Kind::Key) {
                        let method = attribute(&fields, "METHOD");
                        ensure!(
                            matches!(method, Some("NONE" | "AES-128")),
                            "manifest_drm_unsupported"
                        );
                        ensure!(
                            attribute(&fields, "KEYFORMAT").is_none_or(|v| v == "identity"),
                            "manifest_drm_unsupported"
                        );
                        ensure!(
                            method == Some("NONE") || attribute(&fields, "URI").is_some(),
                            "invalid_manifest_key"
                        );
                        ensure!(
                            method != Some("NONE") || attribute(&fields, "URI").is_none(),
                            "invalid_manifest_key"
                        );
                    }
                    if let Some(uri) = fields.iter().find(|v| v.name == "URI") {
                        ensure!(
                            uri.quoted && !uri.value.contains("{$"),
                            "invalid_manifest_uri"
                        );
                        references.push(Reference {
                            uri: uri.value,
                            kind: kind.unwrap_or(Kind::Playlist),
                            span: uri.span.clone(),
                        });
                    } else {
                        ensure!(
                            !matches!(
                                tag,
                                "#EXT-X-MAP"
                                    | "#EXT-X-I-FRAME-STREAM-INF"
                                    | "#EXT-X-IMAGE-STREAM-INF"
                                    | "#EXT-X-PART"
                                    | "#EXT-X-PRELOAD-HINT"
                                    | "#EXT-X-RENDITION-REPORT"
                            ),
                            "invalid_manifest_uri"
                        );
                    }
                } else {
                    // Reject an unhandled URI-bearing extension rather than
                    // leaving a browser/FFmpeg request outside the grant path.
                    ensure!(!value.contains("URI="), "manifest_uri_tag_unsupported");
                }
            }
            ensure!(
                references.len() <= MAX_REFERENCES,
                "manifest_resource_limit"
            );
            offset += raw.len();
        }
        ensure!(!variant, "invalid_manifest_variant");
        Ok(Self { input, references })
    }

    pub fn references(&self) -> &[Reference<'a>] {
        &self.references
    }

    pub fn rewrite(
        &self,
        mut grant: impl FnMut(&Reference<'_>) -> Result<String>,
    ) -> Result<String> {
        let mut output = String::with_capacity(self.input.len());
        let mut offset = 0;
        for reference in &self.references {
            output.push_str(&self.input[offset..reference.span.start]);
            let target = grant(reference)?;
            ensure!(
                !target.is_empty() && !target.bytes().any(|v| v.is_ascii_control() || v == b'"'),
                "invalid_manifest_rewrite"
            );
            output.push_str(&target);
            offset = reference.span.end;
        }
        output.push_str(&self.input[offset..]);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_structure_and_rewrites_all_supported_reference_kinds() {
        let input = "#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English, Stereo\",URI=\"audio/list.m3u8\"\r\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"s\",NAME=\"中文\",URI=\"subs/list.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO=\"a\",SUBTITLES=\"s\"\nvideo/list.m3u8\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"secret.key\",IV=0x0001\n#EXT-X-BYTERANGE:10@100\nsegment.mp4\n#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,Title URI=\"untouched\"\nlast.ts\n";
        let parsed = Manifest::parse(input).unwrap();
        assert_eq!(
            parsed
                .references()
                .iter()
                .map(|v| v.kind)
                .collect::<Vec<_>>(),
            [
                Kind::Playlist,
                Kind::Playlist,
                Kind::Playlist,
                Kind::Initialization,
                Kind::Key,
                Kind::Segment,
                Kind::Segment
            ]
        );
        let output = parsed
            .rewrite(|v| Ok(format!("/granted/{}", v.uri)))
            .unwrap();
        assert!(output.contains("URI=\"/granted/subs/list.m3u8\""));
        assert!(output.contains("BYTERANGE=\"100@0\""));
        assert!(output.contains("#EXT-X-BYTERANGE:10@100\n/granted/segment.mp4"));
        assert!(output.contains("#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE"));
        assert!(output.contains("#EXTINF:4,Title URI=\"untouched\""));
        assert!(output.contains("#EXTM3U\r\n"));
    }

    #[test]
    fn rejects_malformed_or_unhandled_references_and_drm() {
        for input in [
            "garbage\nvideo.ts",
            "#EXTM3U\n#EXT-X-MAP:URI=\"unfinished",
            "#EXTM3U\n#EXT-X-MAP:URI=init.mp4",
            "#EXTM3U\n#EXT-X-MAP:URI=\"one\",URI=\"two\"",
            "#EXTM3U\n#EXT-X-MAP:URI=\"one\",",
            "#EXTM3U\n#EXT-X-MAP:BYTERANGE=\"2@0\"",
            "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,KEYFORMAT=\"drm\",URI=\"key\"",
            "#EXTM3U\n#EXT-X-KEY:METHOD=NONE,URI=\"key\"",
            "#EXTM3U\n#EXT-X-UNKNOWN:URI=\"escape\"",
            "#EXTM3U\n#EXT-X-DEFINE:NAME=\"host\",VALUE=\"evil\"",
            "#EXTM3U\n#EXT-X-MAP:URI=\"{$host}/init.mp4\"",
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1",
        ] {
            assert!(Manifest::parse(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn enforces_manifest_size_and_reference_budget() {
        assert!(Manifest::parse(&format!("#EXTM3U\n{}", "x".repeat(MAX_BYTES))).is_err());
        let at_limit = format!("#EXTM3U\n{}", "a.ts\n".repeat(MAX_REFERENCES));
        assert_eq!(
            Manifest::parse(&at_limit).unwrap().references().len(),
            MAX_REFERENCES
        );
        assert!(Manifest::parse(&(at_limit + "extra.ts\n")).is_err());
        let fields = (0..129)
            .map(|i| format!("X-{i}=1"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(
            Manifest::parse(&format!("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\",{fields}")).is_err()
        );
    }

    #[test]
    fn callback_rejections_and_unsafe_replacements_do_not_produce_a_manifest() {
        let input = Manifest::parse("#EXTM3U\na.ts\nb.ts\n").unwrap();
        assert!(
            input
                .rewrite(|v| {
                    ensure!(v.uri != "b.ts", "access_rejected");
                    Ok("/safe".into())
                })
                .is_err()
        );
        assert!(
            input
                .rewrite(|_| Ok("/safe\"\nhttp://evil/".into()))
                .is_err()
        );
    }
}
