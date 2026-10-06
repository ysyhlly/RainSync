//! Explicit source/program and command whitelists. Never serialize upstream
//! author hashes, arbitrary target URLs, images, credentials or API actions.
use super::*;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DanmakuProgram {
    pub language: String,
    pub source: String,
}
impl DanmakuProgram {
    pub(super) fn new(mode: u64, source: &str) -> Option<Self> {
        if source.trim().is_empty() || source.len() > 32768 || source.contains('\0') {
            return None;
        }
        Some(Self {
            language: if mode == 8 { "script" } else { "bas" }.into(),
            source: source.into(),
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DanmakuInteraction {
    pub kind: String,
    pub duration_ms: u32,
    pub video: String,
    pub options: Vec<String>,
}
pub(super) fn interaction(command: &str, raw: &str, video: &str) -> Option<DanmakuInteraction> {
    let extra: serde_json::Value = serde_json::from_str(raw).ok()?;
    let kind = match command {
        "#LINK#" => "video",
        "#ATTENTION#" => "follow",
        "#VOTE#" => "vote",
        "#UP#" => "up",
        _ => return None,
    };
    let target = if kind == "video" {
        extra
            .get("bvid")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| {
                extra
                    .get("aid")
                    .and_then(|v| v.as_u64())
                    .filter(|n| *n > 0)
                    .map(|n| format!("av{n}"))
            })?
    } else {
        video.to_owned()
    };
    if !bilibili::parse_resource(&target)
        .is_ok_and(|r| matches!(r.id, bilibili::VideoId::Bv(_) | bilibili::VideoId::Av(_)))
    {
        return None;
    }
    let duration_ms = extra
        .get("duration")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000)
        .clamp(1000, 30000) as u32;
    let options = if kind == "vote" {
        extra
            .get("options")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .take(8)
            .filter_map(|v| {
                v.get("desc")
                    .or_else(|| v.get("text"))
                    .and_then(|v| v.as_str())
            })
            .map(|s| plain_text(s, 80))
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        Vec::new()
    };
    Some(DanmakuInteraction {
        kind: kind.into(),
        duration_ms,
        video: target,
        options,
    })
}
