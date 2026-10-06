//! Source-shaped DmSegMobileReply / DanmakuElem, implemented independently.
//! https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/grpc_api/bilibili/community/service/dm/v1/dm.proto
//! Only bounded program sources and typed interactions survive normalization.
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
fn element(bytes: &[u8], segment: Option<u32>) -> Result<Option<DanmakuCue>> {
    if bytes.len() > 64 * 1024 {
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
    let start = segment.map(|n| u64::from(n - 1) * SEGMENT_MS);
    if start.is_some_and(|start| at < start || at > start + SEGMENT_MS) || at > MAX_TIME_MS {
        return Err(invalid());
    }
    let raw = content.ok_or_else(invalid)?;
    if matches!(mode, 8 | 9) {
        return Ok(DanmakuProgram::new(mode, raw).map(|program| DanmakuCue {
            at_ms: at,
            text: if mode == 8 {
                "Script 弹幕"
            } else {
                "BAS 弹幕"
            }
            .into(),
            mode: DanmakuMode::Top,
            style: None,
            position: None,
            advanced_unsupported: None,
            program: Some(program),
            interaction: None,
        }));
    }
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
        program: None,
        interaction: None,
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
                if let Some(cue) = element(raw, Some(segment))? {
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
    cues.retain(|cue| cue.program.is_none() && cue.interaction.is_none());
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
    let (mut second, mut count, mut advanced_count, mut advanced_bytes) = (None, 0, 0, 0);
    cues.retain(|cue| {
        if cue.program.is_some() || cue.interaction.is_some() {
            advanced_count += 1;
            advanced_bytes += cue.program.as_ref().map_or(0, |p| p.source.len());
            return advanced_count <= 32 && advanced_bytes <= 256 * 1024;
        }
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
/// Special packages span the film; retain only the requested window (including
/// the maximum supported 120s animation lifetime at its leading edge).
pub fn parse_bilibili_special(bytes: &[u8], from_ms: u64, to_ms: u64) -> Result<Vec<DanmakuCue>> {
    if bytes.len() > MAX_TEXT_BYTES || from_ms > to_ms || to_ms > MAX_TIME_MS {
        return Err(invalid());
    }
    let mut wire = Wire::new(bytes);
    let mut cues = Vec::new();
    let mut count = 0;
    while let Some((field, value)) = wire.next()? {
        if let (1, Value::Bytes(raw)) = (field, value) {
            count += 1;
            if count > MAX_CUES {
                return Err(bilibili::Error::TooLarge);
            }
            if let Some(cue) = element(raw, None)?
                && cue.program.is_some()
                && cue.at_ms >= from_ms
                && cue.at_ms <= to_ms
            {
                cues.push(cue);
            }
        }
    }
    Ok(bounded_danmaku(cues))
}
pub struct DanmakuView {
    pub special_requests: Vec<TextRequest>,
    pub cues: Vec<DanmakuCue>,
}
pub fn parse_bilibili_view(
    bytes: &[u8],
    cid: u64,
    video: &str,
    from_ms: u64,
    to_ms: u64,
) -> Result<DanmakuView> {
    if bytes.len() > MAX_TEXT_BYTES || cid == 0 || from_ms > to_ms || to_ms > MAX_TIME_MS {
        return Err(invalid());
    }
    let mut wire = Wire::new(bytes);
    let mut special_requests = Vec::new();
    let mut cues = Vec::new();
    let mut commands = 0;
    while let Some((field, value)) = wire.next()? {
        match (field, value) {
            (1, Value::Int(1)) => return Err(bilibili::Error::Restricted("danmaku_closed")),
            (6, Value::Bytes(raw)) => {
                if special_requests.len() >= 4 {
                    return Err(bilibili::Error::TooLarge);
                }
                let raw = std::str::from_utf8(raw).map_err(|_| invalid())?;
                special_requests.push(TextRequest::bilibili_danmaku_special(raw)?);
            }
            (9, Value::Bytes(raw)) => {
                commands += 1;
                if commands > 1024 || raw.len() > 32768 {
                    return Err(bilibili::Error::TooLarge);
                }
                if let Some(cue) = command(raw, cid, video)?
                    && cue.at_ms >= from_ms
                    && cue.at_ms <= to_ms
                {
                    cues.push(cue);
                }
            }
            (6 | 9, _) => return Err(invalid()),
            _ => {}
        }
    }
    Ok(DanmakuView {
        special_requests,
        cues: bounded_danmaku(cues),
    })
}
fn command(raw: &[u8], cid: u64, video: &str) -> Result<Option<DanmakuCue>> {
    let mut wire = Wire::new(raw);
    let (mut oid, mut at, mut kind, mut content, mut extra) = (None, 0, None, None, None);
    let mut seen = std::collections::HashSet::new();
    while let Some((field, value)) = wire.next()? {
        if matches!(field, 2 | 4 | 5 | 6 | 9) && !seen.insert(field) {
            return Err(invalid());
        }
        match (field, value) {
            (2, Value::Int(n)) => oid = Some(n),
            (6, Value::Int(n)) if n <= MAX_TIME_MS => at = n,
            (4 | 5 | 9, Value::Bytes(raw)) => {
                let text = std::str::from_utf8(raw).map_err(|_| invalid())?;
                match field {
                    4 => kind = Some(text),
                    5 => content = Some(text),
                    _ => extra = Some(text),
                }
            }
            (2 | 4 | 5 | 6 | 9, _) => return Err(invalid()),
            _ => {}
        }
    }
    if oid != Some(cid) {
        return Err(invalid());
    }
    let Some(interaction) = kind
        .zip(extra)
        .and_then(|(kind, extra)| advanced::interaction(kind, extra, video))
    else {
        return Ok(None);
    };
    let label = match interaction.kind.as_str() {
        "video" => "关联视频",
        "follow" => "到原站关注",
        "vote" => "到原站投票",
        _ => "UP 主弹幕",
    };
    let text = content
        .map(|s| plain_text(s, 160))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| label.into());
    Ok(Some(DanmakuCue {
        at_ms: at,
        text,
        mode: DanmakuMode::Top,
        style: None,
        position: None,
        advanced_unsupported: None,
        program: None,
        interaction: Some(interaction),
    }))
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
    fn protobuf_cues_preserve_bounded_programs_and_positioned_text() {
        let body = [
            cue(1000, 1, "<img src=x>"),
            cue(2000, 7, r#"[0,0,"1-1",4,"plain <script>"]"#),
            cue(3000, 8, "executable"),
            cue(3001, 9, "BAS"),
        ]
        .concat();
        let cues = parse_bilibili_segment(&body, 1).unwrap();
        assert_eq!(cues.len(), 4);
        assert_eq!(cues[1].text, "plain <script>");
        assert_eq!(cues[1].mode, DanmakuMode::Positioned);
        assert_eq!(cues[1].position.as_ref().unwrap().duration_ms, 4000);
        assert!(parse_bilibili_segment(&body, 2).is_err());
    }
    #[test]
    fn special_packages_span_segments_but_keep_only_the_requested_window() {
        let body = [
            cue(1000, 9, "def text t {content=\"early\"}"),
            cue(370000, 9, "def text t {content=\"BAS\"}"),
            cue(380000, 8, "$.createComment(\"Script\");"),
            cue(400000, 1, "ordinary"),
        ]
        .concat();
        let cues = parse_bilibili_special(&body, 360000, 720000).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].program.as_ref().unwrap().language, "bas");
        assert_eq!(cues[1].program.as_ref().unwrap().language, "script");
        assert!(legacy_danmaku(cues).is_empty());
        assert!(
            parse_bilibili_segment(&cue(1, 8, &"a".repeat(32769)), 1)
                .unwrap()
                .is_empty()
        );
    }
    fn command_fixture(cid: u64, at: u64, kind: &str, extra: &str) -> Vec<u8> {
        blob(
            9,
            &[
                int(2, cid),
                blob(3, b"private-author"),
                blob(4, kind.as_bytes()),
                blob(5, "互动测试".as_bytes()),
                int(6, at),
                blob(9, extra.as_bytes()),
            ]
            .concat(),
        )
    }
    #[test]
    fn metadata_is_identity_bound_and_commands_never_serialize_remote_payloads() {
        let body = [blob(6,b"https://i0.hdslb.com/bfs/dm/abc123.bin"),
            command_fixture(123,1000,"#LINK#",r#"{"bvid":"BV1dGhd68Epd","duration":8000,"image":"https://evil.test","url":"javascript:evil"}"#),
            command_fixture(123,2000,"#VOTE#",r#"{"options":[{"desc":"选项一"},{"desc":"选项二"}]}"#),
            command_fixture(123,3000,"#ATTENTION#","{}"),
            command_fixture(123,4000,"#UP#","{}")].concat();
        let view = parse_bilibili_view(&body, 123, "BV1dGhd68Epd", 0, 360000).unwrap();
        assert_eq!(view.special_requests.len(), 1);
        assert!(view.special_requests[0].cookie().is_none());
        assert_eq!(view.cues.len(), 4);
        assert_eq!(
            view.cues[1].interaction.as_ref().unwrap().options,
            ["选项一", "选项二"]
        );
        let json = serde_json::to_string(&view.cues).unwrap();
        for forbidden in ["evil", "private-author", "hdslb"] {
            assert!(!json.contains(forbidden));
        }
        assert!(parse_bilibili_view(&body, 124, "BV1dGhd68Epd", 0, 360000).is_err());
        assert!(parse_bilibili_view(&int(1, 1), 123, "BV1dGhd68Epd", 0, 360000).is_err());
        for url in [
            "https://evil.hdslb.com/bfs/dm/a.bin",
            "https://i0.hdslb.com/bfs/dm/../a.bin",
            "https://i0.hdslb.com/bfs/dm/a.bin?secret=x",
            "https://i0.hdslb.com:443/bfs/dm/a.bin",
        ] {
            assert!(
                parse_bilibili_view(&blob(6, url.as_bytes()), 123, "BV1dGhd68Epd", 0, 360000)
                    .is_err()
            );
        }
    }
    #[test]
    fn advanced_budget_does_not_consume_plain_density_and_old_renderers_drop_programs() {
        let body = [
            cue(0, 8, "$.createComment(\"x\");"),
            (1..=6).flat_map(|at| cue(at, 1, "plain")).collect(),
        ]
        .concat();
        let cues = parse_bilibili_segment(&body, 1).unwrap();
        assert_eq!(cues.len(), 7);
        assert_eq!(legacy_danmaku(cues).len(), 6);
        let body = (0..40)
            .flat_map(|at| cue(at, 9, "def text t {content=\"x\"}"))
            .collect::<Vec<_>>();
        assert_eq!(parse_bilibili_segment(&body, 1).unwrap().len(), 32);
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
