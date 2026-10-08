//! Bounded ByteDance caption data conversion, never browser cue/style execution.
use super::*;
use serde::Deserialize;
#[derive(Deserialize)]
struct CaptionJson {
    utterances: Vec<Utterance>,
}
#[derive(Deserialize)]
struct Utterance {
    start_time: u64,
    end_time: u64,
    text: String,
}
fn timestamp(value: &str, srt: bool) -> Result<u64> {
    let normalized = if srt {
        value.replace(',', ".")
    } else {
        value.to_owned()
    };
    let parts = normalized.split(':').collect::<Vec<_>>();
    if !(2..=3).contains(&parts.len()) {
        return Err(invalid());
    }
    let (seconds, millis) = parts[parts.len() - 1].split_once('.').ok_or_else(invalid)?;
    let number = |s: &str| -> Result<u64> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        s.parse().map_err(|_| invalid())
    };
    let minute = number(parts[parts.len() - 2])?;
    let second = number(seconds)?;
    if minute > 59 || second > 59 || millis.len() != 3 {
        return Err(invalid());
    }
    let hour = if parts.len() == 3 {
        number(parts[0])?
    } else {
        0
    };
    hour.checked_mul(3600000)
        .and_then(|n| n.checked_add(minute * 60000 + second * 1000 + number(millis).ok()?))
        .filter(|n| *n <= MAX_TIME_MS)
        .ok_or_else(invalid)
}
pub fn parse_timed_text(format: SubtitleFormat, bytes: &[u8]) -> Result<Vec<SubtitleCue>> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let mut cues = Vec::new();
    if format == SubtitleFormat::ByteDanceJson {
        let json: CaptionJson = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if json.utterances.len() > MAX_CUES {
            return Err(bilibili::Error::TooLarge);
        }
        for cue in json.utterances {
            cues.push(SubtitleCue {
                from_ms: cue.start_time,
                to_ms: cue.end_time,
                text: plain_text(&cue.text, MAX_CUE_TEXT),
            });
        }
    } else {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| invalid())?
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n");
        if text.contains('\r') || text.contains('\0') {
            return Err(invalid());
        }
        let srt = format == SubtitleFormat::ByteDanceSrt;
        if !srt
            && !text
                .lines()
                .next()
                .is_some_and(|line| line == "WEBVTT" || line.starts_with("WEBVTT "))
        {
            return Err(invalid());
        }
        let mut blocks = text.split("\n\n");
        if !srt {
            blocks.next();
        }
        for block in blocks {
            let block = block.trim();
            if block.is_empty() {
                continue;
            }
            if !srt
                && ["NOTE", "STYLE", "REGION"].iter().any(|tag| {
                    block == *tag
                        || block.starts_with(&format!("{tag}\n"))
                        || block.starts_with(&format!("{tag} "))
                })
            {
                continue;
            }
            let mut lines = block.lines();
            let mut line = lines.next().ok_or_else(invalid)?;
            if !line.contains(" --> ") {
                line = lines.next().ok_or_else(invalid)?;
            }
            let (from, to) = line.split_once(" --> ").ok_or_else(invalid)?;
            let end = to.split_ascii_whitespace().next().ok_or_else(invalid)?;
            let content = lines.collect::<Vec<_>>().join(" ");
            cues.push(SubtitleCue {
                from_ms: timestamp(from, srt)?,
                to_ms: timestamp(end, srt)?,
                text: plain_text(&content, MAX_CUE_TEXT),
            });
            if cues.len() > MAX_CUES {
                return Err(bilibili::Error::TooLarge);
            }
        }
    }
    if cues
        .iter()
        .any(|c| c.to_ms <= c.from_ms || c.to_ms > MAX_TIME_MS)
    {
        return Err(invalid());
    }
    cues.retain(|c| !c.text.is_empty());
    cues.sort_by_key(|c| c.from_ms);
    Ok(cues)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn data_formats_cannot_execute_markup_styles_or_scripts() {
        let vtt=b"WEBVTT\n\nSTYLE\n::cue{color:red}\n\nid\n00:01.000 --> 00:02.000 line:3%\n<img src=x>\n\n";
        let cues = parse_timed_text(SubtitleFormat::ByteDanceVtt, vtt).unwrap();
        assert_eq!(cues.len(), 1);
        assert!(render_vtt(&cues).unwrap().contains("&lt;img"));
        assert_eq!(
            parse_timed_text(
                SubtitleFormat::ByteDanceSrt,
                b"1\n00:00:01,000 --> 00:00:02,000\nhello\n"
            )
            .unwrap()[0]
                .from_ms,
            1000
        );
        assert!(
            parse_timed_text(
                SubtitleFormat::ByteDanceJson,
                br#"{"utterances":[{"start_time":0,"end_time":0,"text":"x"}]}"#
            )
            .is_err()
        );
        assert!(parse_timed_text(SubtitleFormat::ByteDanceVtt, b"<script>html</script>").is_err());
    }
}
