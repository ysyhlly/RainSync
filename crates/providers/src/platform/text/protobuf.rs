//! Source-shaped DmSegMobileReply / DanmakuElem, implemented independently.
//! https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/grpc_api/bilibili/community/service/dm/v1/dm.proto
//! No schema-generated executable, remote styles, action, identity or script survives.
use super::*;
const MAX_FIELDS: usize = 250_000;
const SEGMENT_MS: u64 = 360_000;
struct Wire<'a> {
    rest: &'a [u8],
    fields: usize,
}
enum Value<'a> {
    Int(u64),
    Bytes(&'a [u8]),
    Fixed,
}
impl<'a> Wire<'a> {
    fn new(rest: &'a [u8]) -> Self {
        Self { rest, fields: 0 }
    }
    fn varint(&mut self) -> Result<u64> {
        let mut value = 0u64;
        for shift in (0..70).step_by(7) {
            let byte = *self.rest.first().ok_or_else(invalid)?;
            self.rest = &self.rest[1..];
            if shift == 63 && byte > 1 {
                return Err(invalid());
            }
            value |= u64::from(byte & 127) << shift;
            if byte & 128 == 0 {
                return Ok(value);
            }
        }
        Err(invalid())
    }
    fn next(&mut self) -> Result<Option<(u32, Value<'a>)>> {
        if self.rest.is_empty() {
            return Ok(None);
        }
        self.fields += 1;
        if self.fields > MAX_FIELDS {
            return Err(bilibili::Error::TooLarge);
        }
        let key = self.varint()?;
        let field = u32::try_from(key >> 3)
            .ok()
            .filter(|n| *n > 0 && *n < (1 << 29))
            .ok_or_else(invalid)?;
        let value = match key & 7 {
            0 => Value::Int(self.varint()?),
            1 | 5 => {
                let n = if key & 7 == 1 { 8 } else { 4 };
                self.rest = self.rest.get(n..).ok_or_else(invalid)?;
                Value::Fixed
            }
            2 => {
                let n = usize::try_from(self.varint()?).map_err(|_| invalid())?;
                let bytes = self.rest.get(..n).ok_or_else(invalid)?;
                self.rest = &self.rest[n..];
                Value::Bytes(bytes)
            }
            _ => return Err(invalid()), // groups and invalid wire types never recurse
        };
        Ok(Some((field, value)))
    }
}
fn element(bytes: &[u8], segment: u32) -> Result<Option<DanmakuCue>> {
    if bytes.len() > 32 * 1024 {
        return Err(bilibili::Error::TooLarge);
    }
    let mut wire = Wire::new(bytes);
    let (mut at, mut mode, mut content, mut size, mut color) = (0, 0, None, None, None);
    let mut seen = std::collections::HashSet::new();
    while let Some((field, value)) = wire.next()? {
        if matches!(field, 2 | 3 | 4 | 5 | 7) && !seen.insert(field) {
            return Err(invalid());
        }
        match (field, value) {
            (2, Value::Int(n)) => at = n,
            (3, Value::Int(n)) => mode = n,
            (4, Value::Int(n)) => size = Some(n),
            (5, Value::Int(n)) if n <= 0xffffff => color = Some(n as u32),
            (7, Value::Bytes(raw)) => {
                content = Some(std::str::from_utf8(raw).map_err(|_| invalid())?)
            }
            (2 | 3 | 4 | 5 | 7, _) => return Err(invalid()),
            _ => {}
        }
    }
    let start = u64::from(segment - 1) * SEGMENT_MS;
    if at < start || at > start + SEGMENT_MS || at > MAX_TIME_MS {
        return Err(invalid());
    }
    let raw = content.ok_or_else(invalid)?;
    let (mode, text, position, unsupported) = match mode {
        1..=3 | 6 => (DanmakuMode::Scroll, plain_text(raw, 160), None, false),
        4 => (DanmakuMode::Bottom, plain_text(raw, 160), None, false),
        5 => (DanmakuMode::Top, plain_text(raw, 160), None, false),
        7 => {
            let (text, position, unsupported) = positioned::parse(raw)?;
            (
                if position.is_some() {
                    DanmakuMode::Positioned
                } else {
                    DanmakuMode::Top
                },
                text,
                position,
                unsupported,
            )
        }
        8 | 9 => return Ok(None), // script/BAS never treated as text/program
        _ => return Err(invalid()),
    };
    Ok((!text.is_empty()).then_some(DanmakuCue {
        at_ms: at,
        text,
        mode,
        style: match (size, color) {
            (Some(size), Some(color)) => Some(DanmakuStyle {
                color_rgb: color,
                font_size_px: size.clamp(12, 48) as u8,
            }),
            _ => None,
        },
        position,
        advanced_unsupported: unsupported.then_some(true),
    }))
}
pub fn parse_bilibili_segment(bytes: &[u8], segment: u32) -> Result<Vec<DanmakuCue>> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    if !(1..=1680).contains(&segment) {
        return Err(invalid());
    }
    let mut wire = Wire::new(bytes);
    let mut cues = Vec::new();
    let mut state = None;
    let mut count = 0;
    while let Some((field, value)) = wire.next()? {
        match (field, value) {
            (1, Value::Bytes(raw)) => {
                count += 1;
                if count > MAX_CUES {
                    return Err(bilibili::Error::TooLarge);
                }
                if let Some(cue) = element(raw, segment)? {
                    cues.push(cue);
                }
            }
            (2, Value::Int(n)) if state.is_none() && n <= 1 => state = Some(n),
            (1 | 2, _) => return Err(invalid()),
            _ => {}
        }
    }
    if state == Some(1) {
        return Err(bilibili::Error::Restricted("danmaku_closed"));
    }
    Ok(bounded_danmaku(cues))
}
/// Version-1 renderers accept exactly the original three plain-cue fields.
pub fn legacy_danmaku(mut cues: Vec<DanmakuCue>) -> Vec<DanmakuCue> {
    for cue in &mut cues {
        if cue.mode == DanmakuMode::Positioned {
            cue.mode = DanmakuMode::Top;
        }
        cue.style = None;
        cue.position = None;
        cue.advanced_unsupported = None;
    }
    cues
}
pub fn bounded_danmaku(mut cues: Vec<DanmakuCue>) -> Vec<DanmakuCue> {
    cues.sort_by(|a, b| (a.at_ms, &a.text).cmp(&(b.at_ms, &b.text)));
    cues.dedup();
    let (mut second, mut count) = (None, 0);
    cues.retain(|cue| {
        let bucket = cue.at_ms / 1000;
        if second != Some(bucket) {
            second = Some(bucket);
            count = 0;
        }
        count += 1;
        count <= 6
    });
    cues.truncate(MAX_CUES);
    cues
}
#[cfg(test)]
mod tests {
    use super::*;
    fn var(mut n: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (n & 127) as u8;
            n >>= 7;
            out.push(b | if n > 0 { 128 } else { 0 });
            if n == 0 {
                return out;
            }
        }
    }
    fn int(f: u8, n: u64) -> Vec<u8> {
        [vec![f << 3], var(n)].concat()
    }
    fn blob(f: u8, b: &[u8]) -> Vec<u8> {
        [vec![(f << 3) | 2], var(b.len() as u64), b.to_vec()].concat()
    }
    fn cue(at: u64, mode: u64, text: &str) -> Vec<u8> {
        blob(
            1,
            &[
                int(2, at),
                int(3, mode),
                blob(7, text.as_bytes()),
                blob(10, b"ignored executable action"),
            ]
            .concat(),
        )
    }
    #[test]
    fn protobuf_cues_position_supported_advanced_and_drop_scripts() {
        let body = [
            cue(1000, 1, "<img src=x>"),
            cue(2000, 7, r#"[0,0,"1-1",4,"plain <script>"]"#),
            cue(3000, 8, "executable"),
            cue(3001, 9, "BAS"),
        ]
        .concat();
        let cues = parse_bilibili_segment(&body, 1).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[1].text, "plain <script>");
        assert_eq!(cues[1].mode, DanmakuMode::Positioned);
        assert_eq!(cues[1].position.as_ref().unwrap().duration_ms, 4000);
        assert!(parse_bilibili_segment(&body, 2).is_err());
    }
    #[test]
    fn legacy_renderers_keep_exact_three_field_plain_contract() {
        let body = cue(1000, 7, r#"[0.1,0.2,"1-1",4,"plain"]"#);
        let cues = legacy_danmaku(parse_bilibili_segment(&body, 1).unwrap());
        let value = serde_json::to_value(&cues[0]).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(value["mode"], "top");
        assert_eq!(value["text"], "plain");
    }
    #[test]
    fn malformed_framing_duplicate_wire_and_density_fail_closed() {
        for raw in [vec![0], vec![10, 100, 1], vec![11], vec![255; 12]] {
            assert!(parse_bilibili_segment(&raw, 1).is_err());
        }
        assert!(parse_bilibili_segment(&[int(2, 1), int(2, 0)].concat(), 1).is_err());
        assert!(parse_bilibili_segment(&int(2, 1), 1).is_err());
        assert!(parse_bilibili_segment(&cue(360001, 1, "x"), 1).is_err());
        let body = (0..20)
            .flat_map(|n| cue(1000 + n, 1, "x"))
            .collect::<Vec<_>>();
        assert_eq!(parse_bilibili_segment(&body, 1).unwrap().len(), 6);
    }
}
