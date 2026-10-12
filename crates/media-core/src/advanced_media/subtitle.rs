use super::asset_contract::SubtitleKind;
use anyhow::{Result, ensure};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SubtitleSelection {
    pub index: u32,
    /// libass's `si` is a subtitle ordinal, unlike absolute FFmpeg `-map`.
    pub ordinal: u32,
    pub kind: SubtitleKind,
}

/// Require a complete, unique absolute catalog before deriving an ordinal.
pub fn select_subtitle(meta: &Value, wanted: u32) -> Result<SubtitleSelection> {
    let rows = super::recipe::indexed_streams(meta)?;
    let row = rows
        .iter()
        .find(|(index, _)| *index == wanted)
        .ok_or_else(|| anyhow::anyhow!("invalid_subtitle_track"))?
        .1;
    ensure!(row["codec_type"] == "subtitle", "invalid_subtitle_track");
    let kind = match row["codec_name"].as_str() {
        Some("ass") => SubtitleKind::Ass,
        Some("ssa") => SubtitleKind::Ssa,
        Some("hdmv_pgs_subtitle") => SubtitleKind::Pgs,
        _ => anyhow::bail!("subtitle_burn_in_codec_unsupported"),
    };
    let ordinal = rows
        .iter()
        .filter(|(index, row)| *index < wanted && row["codec_type"] == "subtitle")
        .count();
    // The subtitles filter consumes attachment bytes directly; filenames are
    // labels, never output paths. Reject oversized attachment sets before it
    // reads the container. We expose no fontsdir or force_style string.
    let mut font_bytes = 0u64;
    let mut attachments = 0;
    for (_, row) in &rows {
        if row["codec_type"] == "attachment" {
            attachments += 1;
            let bytes = row["extradata_size"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("subtitle_attachment_size_unavailable"))?;
            ensure!(bytes <= 16 * 1024 * 1024, "subtitle_attachment_too_large");
            font_bytes = font_bytes
                .checked_add(bytes)
                .ok_or_else(|| anyhow::anyhow!("subtitle_attachment_too_large"))?;
        }
    }
    ensure!(
        attachments <= 64 && font_bytes <= 64 * 1024 * 1024,
        "subtitle_attachment_too_large"
    );
    Ok(SubtitleSelection {
        index: wanted,
        ordinal: u32::try_from(ordinal)?,
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn absolute_selection_has_a_different_libass_ordinal() {
        let meta = json!({"streams":[{"index":7,"codec_type":"subtitle","codec_name":"ssa"},{"index":2,"codec_type":"subtitle","codec_name":"ass"},{"index":0,"codec_type":"video"}]});
        assert_eq!(
            select_subtitle(&meta, 7).unwrap(),
            SubtitleSelection {
                index: 7,
                ordinal: 1,
                kind: SubtitleKind::Ssa
            }
        );
        assert!(select_subtitle(&meta, 0).is_err());
        let duplicate = json!({"streams":[{"index":2,"codec_type":"subtitle","codec_name":"ass"},{"index":2,"codec_type":"audio"}]});
        assert!(select_subtitle(&duplicate, 2).is_err());
    }
}
