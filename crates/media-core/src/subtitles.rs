//! Normalize a standalone WebVTT track into the playback plan's time coordinates.
use anyhow::{Context, Result, ensure};
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

fn timestamp(value: &str) -> Result<u64> {
    let fields: Vec<_> = value.split(':').collect();
    ensure!(matches!(fields.len(), 2 | 3), "invalid_subtitle_timestamp");
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (hours, minutes, seconds) = if fields.len() == 3 {
        ensure!(
            fields[0].len() >= 2 && digits(fields[0]),
            "invalid_subtitle_timestamp"
        );
        (fields[0].parse::<u64>()?, fields[1], fields[2])
    } else {
        (0, fields[0], fields[1])
    };
    let (seconds, millis) = seconds
        .split_once('.')
        .context("invalid_subtitle_timestamp")?;
    ensure!(
        minutes.len() == 2
            && seconds.len() == 2
            && millis.len() == 3
            && digits(minutes)
            && digits(seconds)
            && digits(millis),
        "invalid_subtitle_timestamp"
    );
    let minutes: u64 = minutes.parse()?;
    let seconds: u64 = seconds.parse()?;
    ensure!(minutes < 60 && seconds < 60, "invalid_subtitle_timestamp");
    hours
        .checked_mul(3_600_000)
        .and_then(|h| {
            h.checked_add(minutes * 60_000 + seconds * 1000 + millis.parse::<u64>().ok()?)
        })
        .context("subtitle_timestamp_overflow")
}
fn formatted(ms: u64) -> String {
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

fn cue_text(text: &str, origin: u64, start: u64, end: u64) -> Result<String> {
    let mut rest = text;
    let mut result = String::new();
    let mut previous = start;
    while let Some(open) = rest.find('<') {
        result.push_str(&rest[..open]);
        rest = &rest[open..];
        let Some(close) = rest.find('>') else {
            break;
        };
        let tag = &rest[1..close];
        if tag.as_bytes().first().is_some_and(u8::is_ascii_digit) {
            let time = timestamp(tag)?;
            ensure!(
                time > previous && time < end,
                "invalid_inline_subtitle_timestamp"
            );
            previous = time;
            // Earlier karaoke markers no longer belong to the clipped cue.
            if time > origin {
                result.push_str(&format!("<{}>", formatted(time - origin)));
            }
        } else {
            result.push_str(&rest[..=close]);
        }
        rest = &rest[close + 1..];
    }
    result.push_str(rest);
    Ok(result)
}

pub fn shift_webvtt(bytes: &[u8], origin_ms: f64) -> Result<Vec<u8>> {
    ensure!(bytes.len() <= MAX_BYTES, "subtitle_too_large");
    ensure!(
        origin_ms.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&origin_ms),
        "invalid_subtitle_origin"
    );
    let origin = origin_ms.round() as u64;
    let text = std::str::from_utf8(bytes)?
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    ensure!(!text.contains('\0'), "invalid_webvtt");
    let mut blocks = text.split("\n\n").filter(|b| !b.trim().is_empty());
    let header = blocks.next().context("invalid_webvtt")?;
    let signature = header.lines().next().context("invalid_webvtt")?;
    ensure!(
        signature == "WEBVTT"
            || signature.starts_with("WEBVTT ")
            || signature.starts_with("WEBVTT\t"),
        "invalid_webvtt"
    );
    // Segmented MPEG timestamps require a separate mapping, never silently
    // interpret them as standalone media-relative cues.
    ensure!(
        !header.contains("-->") && !header.contains("X-TIMESTAMP-MAP"),
        "unsupported_subtitle_mapping"
    );
    let mut output = format!("{header}\n\n");
    let mut previous_start = 0;
    for block in blocks {
        let block = block.trim_matches('\n');
        let lines: Vec<_> = block.lines().collect();
        let first = lines[0];
        if first == "NOTE"
            || first.starts_with("NOTE ")
            || first.starts_with("NOTE\t")
            || matches!(first, "STYLE" | "REGION")
        {
            output.push_str(block);
            output.push_str("\n\n");
            continue;
        }
        let timing = usize::from(!first.contains("-->"));
        let line = lines.get(timing).context("invalid_subtitle_cue")?;
        let (start, right) = line.split_once("-->").context("invalid_subtitle_cue")?;
        let start = timestamp(start.trim())?;
        let mut fields = right.split_whitespace();
        let end = timestamp(fields.next().context("invalid_subtitle_cue")?)?;
        ensure!(
            end > start && start >= previous_start,
            "invalid_subtitle_cue"
        );
        previous_start = start;
        let body = cue_text(&lines[timing + 1..].join("\n"), origin, start, end)?;
        if end <= origin {
            continue;
        }
        if timing == 1 {
            output.push_str(first);
            output.push('\n');
        }
        output.push_str(&format!(
            "{} --> {}",
            formatted(start.saturating_sub(origin)),
            formatted(end - origin)
        ));
        for setting in fields {
            output.push(' ');
            output.push_str(setting);
        }
        output.push('\n');
        output.push_str(&body);
        output.push_str("\n\n");
        ensure!(output.len() <= MAX_BYTES, "subtitle_too_large");
    }
    ensure!(output.len() <= MAX_BYTES, "subtitle_too_large");
    Ok(output.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clips_crossing_cues_drops_finished_and_keeps_chinese_settings() {
        let input = "\u{feff}WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\n已结束\r\n\r\nlong\r\n00:01.000 --> 00:05.000 align:start\r\n中文\r\n第二行\r\n\r\n00:05.000 --> 00:06.000\r\n下一句\r\n";
        let result = String::from_utf8(shift_webvtt(input.as_bytes(), 3000.0).unwrap()).unwrap();
        assert!(!result.contains("已结束"));
        assert!(result.contains("long\n00:00:00.000 --> 00:00:02.000 align:start\n中文\n第二行"));
        assert!(result.contains("00:00:02.000 --> 00:00:03.000"));
    }
    #[test]
    fn shifts_inline_markers_and_retains_annotations() {
        let input = b"WEBVTT\n\nNOTE hello\n\n00:01.000 --> 00:06.000\n<v speaker>old<00:02.000>now<00:04.000>next</v>\n";
        let result = String::from_utf8(shift_webvtt(input, 3000.0).unwrap()).unwrap();
        assert!(result.contains("NOTE hello"));
        assert!(result.contains("<v speaker>oldnow<00:00:01.000>next</v>"));
    }
    #[test]
    fn rejects_malformed_unmapped_and_oversized_inputs() {
        for input in [
            "WEBVTT\n\n00:61.000 --> 00:62.000\nx",
            "WEBVTT\n\n00:02.000 --> 00:01.000\nx",
            "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:90000\n\n",
            "WEBVTT\n\n-00:01.000 --> 00:02.000\nx",
            "WEBVTTbad",
        ] {
            assert!(shift_webvtt(input.as_bytes(), 0.0).is_err());
        }
        assert!(shift_webvtt(&[0xff], 0.0).is_err());
        assert!(shift_webvtt(&vec![b'a'; MAX_BYTES + 1], 0.0).is_err());
        for origin in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(shift_webvtt(b"WEBVTT\n\n", origin).is_err());
        }
    }
}
