//! Scoped live DANMU_MSG packet boundary. WBI/SPI/getDanmuInfo requests are
//! normal first-party flows, never invented signatures, fake buvid or retries.
//! Provenance: https://github.com/streetartist/BiliKit/blob/main/Bilibili-Live-API-master/API.WebSocket.md
//! https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/live/danmaku.md
use super::*;
use futures_util::{SinkExt, StreamExt};
use std::io::{Cursor, Read};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_PACKETS: usize = 256;
#[derive(Clone)]
pub struct ClientId(String);
impl ClientId {
    pub(crate) fn expose_for_metadata(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for ClientId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClientId([REDACTED])")
    }
}
pub fn parse_client_id(bytes: &[u8]) -> Result<ClientId> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    #[derive(Deserialize)]
    struct IdEnvelope {
        code: i64,
        data: Option<IdData>,
    }
    #[derive(Deserialize)]
    struct IdData {
        b_3: String,
    }
    let data: IdEnvelope = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if data.code != 0 {
        return Err(bilibili::Error::Api(data.code));
    }
    let id = data.data.ok_or_else(invalid)?.b_3;
    if !(16..=128).contains(&id.len())
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(invalid());
    }
    Ok(ClientId(id))
}
pub struct Discovery {
    url: Url,
    token: String,
    room: u64,
    uid: u64,
}
impl fmt::Debug for Discovery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LiveDiscovery([REDACTED])")
    }
}
impl Discovery {
    pub fn url(&self) -> &Url {
        &self.url
    }
    pub fn auth_packet(&self, id: &ClientId) -> Result<Vec<u8>> {
        let body=serde_json::to_vec(&serde_json::json!({"uid":self.uid,"roomid":self.room,"protover":3,"buvid":id.0,"platform":"web","type":2,"key":self.token})).map_err(|_|invalid())?;
        Ok(packet(7, &body))
    }
}
pub fn validate_socket_url(raw: &str) -> Result<Url> {
    if raw.len() > 1024
        || !raw.is_ascii()
        || raw.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\')
        || raw.contains(['%', '?', '#', '@'])
    {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    let host = url.host_str().ok_or_else(invalid)?;
    if url.scheme() != "wss"
        || !host.ends_with(".chat.bilibili.com")
        || host.len() > 200
        || !host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/sub"
        || !matches!(url.port_or_known_default(), Some(443 | 2245))
    {
        return Err(bilibili::Error::Restricted("live_danmaku_origin_denied"));
    }
    Ok(url)
}
pub fn parse_discovery(bytes: &[u8], room: u64, uid: u64) -> Result<Discovery> {
    #[derive(Deserialize)]
    struct Envelope {
        code: i64,
        data: Option<Data>,
    }
    #[derive(Deserialize)]
    struct Data {
        token: String,
        host_list: Vec<Host>,
    }
    #[derive(Deserialize)]
    struct Host {
        host: String,
        wss_port: u16,
    }
    if room == 0 || bytes.len() > MAX_TEXT_BYTES {
        return Err(invalid());
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if envelope.code != 0 {
        return Err(bilibili::Error::Api(envelope.code));
    }
    let data = envelope.data.ok_or_else(invalid)?;
    if data.token.is_empty()
        || data.token.len() > 4096
        || data.token.bytes().any(|b| b <= b' ' || b == 127)
        || data.host_list.is_empty()
        || data.host_list.len() > 16
    {
        return Err(invalid());
    }
    let mut selected = None;
    for host in data.host_list {
        let url = validate_socket_url(&format!("wss://{}:{}/sub", host.host, host.wss_port))?;
        if selected.is_none() {
            selected = Some(url);
        }
    }
    Ok(Discovery {
        url: selected.ok_or_else(invalid)?,
        token: data.token,
        room,
        uid,
    })
}
fn packet(operation: u32, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(16 + body.len());
    bytes.extend_from_slice(&((16 + body.len()) as u32).to_be_bytes());
    bytes.extend_from_slice(&16u16.to_be_bytes());
    bytes.extend_from_slice(&1u16.to_be_bytes());
    bytes.extend_from_slice(&operation.to_be_bytes());
    bytes.extend_from_slice(&1u32.to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Accepted,
    Heartbeat,
    Text { epoch_ms: u64, text: String },
}
fn json_event(body: &[u8]) -> Result<Option<Event>> {
    if body.len() > 64 * 1024 {
        return Err(bilibili::Error::TooLarge);
    }
    #[derive(Deserialize)]
    struct Notification {
        cmd: String,
        #[serde(default)]
        info: Option<Vec<serde_json::Value>>,
    }
    let value: Notification = serde_json::from_slice(body).map_err(|_| invalid())?;
    if value.cmd.len() > 128 {
        return Err(invalid());
    }
    if value.cmd.split(':').next() != Some("DANMU_MSG") {
        return Ok(None);
    }
    let info = value
        .info
        .filter(|v| v.len() >= 2 && v.len() <= 32)
        .ok_or_else(invalid)?;
    let settings = info[0]
        .as_array()
        .filter(|v| v.len() >= 5 && v.len() <= 32)
        .ok_or_else(invalid)?;
    let timestamp = settings[4].as_u64().ok_or_else(invalid)?;
    let epoch_ms = if timestamp < 10_000_000_000 {
        timestamp.checked_mul(1000).ok_or_else(invalid)?
    } else {
        timestamp
    };
    if !(946_684_800_000..=4_102_444_800_000).contains(&epoch_ms) {
        return Err(invalid());
    }
    let text = plain_text(info[1].as_str().ok_or_else(invalid)?, 160);
    Ok((!text.is_empty()).then_some(Event::Text { epoch_ms, text }))
}
pub fn parse_packets(bytes: &[u8]) -> Result<Vec<Event>> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let mut budget = MAX_FRAME_BYTES;
    let mut packets = 0;
    let mut events = Vec::new();
    decode(bytes, 0, &mut budget, &mut packets, &mut events)?;
    Ok(events)
}
fn decode(
    mut bytes: &[u8],
    depth: usize,
    budget: &mut usize,
    count: &mut usize,
    events: &mut Vec<Event>,
) -> Result<()> {
    if depth > 3 {
        return Err(bilibili::Error::TooLarge);
    }
    while !bytes.is_empty() {
        if bytes.len() < 16 {
            return Err(invalid());
        }
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        let header = u16::from_be_bytes(bytes[4..6].try_into().unwrap()) as usize;
        let version = u16::from_be_bytes(bytes[6..8].try_into().unwrap());
        let op = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
        if header != 16 || length < 16 || length > bytes.len() {
            return Err(invalid());
        }
        *count += 1;
        if *count > MAX_PACKETS {
            return Err(bilibili::Error::TooLarge);
        }
        let body = &bytes[16..length];
        bytes = &bytes[length..];
        if matches!(version, 2 | 3) {
            if op != 5 {
                return Err(invalid());
            }
            let input = Cursor::new(body);
            let decoder: Box<dyn Read> = if version == 2 {
                Box::new(flate2::read::ZlibDecoder::new(input))
            } else {
                Box::new(brotli::Decompressor::new(input, 4096))
            };
            let mut expanded = Vec::new();
            decoder
                .take((*budget as u64) + 1)
                .read_to_end(&mut expanded)
                .map_err(|_| invalid())?;
            if expanded.len() > *budget {
                return Err(bilibili::Error::TooLarge);
            }
            *budget -= expanded.len();
            decode(&expanded, depth + 1, budget, count, events)?;
        } else if version <= 1 {
            match op {
                8 => {
                    #[derive(Deserialize)]
                    struct Ack {
                        code: i64,
                    }
                    let value: Ack = serde_json::from_slice(body).map_err(|_| invalid())?;
                    let code = value.code;
                    if code != 0 {
                        return Err(bilibili::Error::Restricted("live_danmaku_auth_denied"));
                    }
                    events.push(Event::Accepted);
                }
                3 => {
                    if body.len() != 4 {
                        return Err(invalid());
                    }
                    events.push(Event::Heartbeat);
                }
                5 => {
                    if let Some(event) = json_event(body)? {
                        events.push(event);
                    }
                }
                _ => {}
            }
        } else {
            return Err(bilibili::Error::Restricted(
                "live_danmaku_protocol_unsupported",
            ));
        }
    }
    Ok(())
}
pub struct Socket {
    inner: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    accepted: bool,
}
impl Socket {
    pub(crate) fn new(inner: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>) -> Self {
        Self {
            inner,
            accepted: false,
        }
    }
    pub async fn authenticate(
        &mut self,
        discovery: &Discovery,
        id: &ClientId,
        deadline: Instant,
    ) -> Result<()> {
        tokio::time::timeout_at(
            deadline,
            self.inner
                .send(Message::Binary(discovery.auth_packet(id)?.into())),
        )
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(|_| bilibili::Error::Transport)?;
        // Auth acknowledgement is mandatory; messages before it prove nothing.
        while !self.accepted {
            let events = self.next(deadline).await?;
            let mut acknowledged = false;
            for event in events {
                match event {
                    Event::Accepted => acknowledged = true,
                    Event::Text { .. } if !acknowledged => return Err(invalid()),
                    _ => {}
                }
            }
            self.accepted = acknowledged;
        }
        Ok(())
    }
    pub async fn heartbeat(&mut self, deadline: Instant) -> Result<()> {
        tokio::time::timeout_at(
            deadline,
            self.inner.send(Message::Binary(packet(2, b"").into())),
        )
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(|_| bilibili::Error::Transport)
    }
    pub async fn next(&mut self, deadline: Instant) -> Result<Vec<Event>> {
        loop {
            let message = tokio::time::timeout_at(deadline, self.inner.next())
                .await
                .map_err(|_| bilibili::Error::Deadline)?
                .ok_or(bilibili::Error::Restricted("live_danmaku_closed"))?
                .map_err(|_| bilibili::Error::Transport)?;
            match message {
                Message::Binary(body) => {
                    let events = parse_packets(&body)?;
                    if events.contains(&Event::Accepted) {
                        self.accepted = true;
                    }
                    return Ok(events);
                }
                Message::Ping(_) | Message::Pong(_) => {}
                Message::Close(_) => {
                    return Err(bilibili::Error::Restricted("live_danmaku_closed"));
                }
                _ => return Err(invalid()),
            }
        }
    }
}
#[derive(Deserialize)]
struct HistoryEnvelope {
    code: i64,
    data: Option<HistoryData>,
}
#[derive(Deserialize)]
struct HistoryData {
    room: Vec<History>,
    #[serde(default)]
    admin: Vec<History>,
}
#[derive(Deserialize)]
struct History {
    timeline: String,
    text: String,
    dm_type: u32,
}
pub fn parse_history(bytes: &[u8], started_at: u64, now_ms: u64) -> Result<Vec<DanmakuCue>> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let data: HistoryEnvelope = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if data.code != 0 {
        return Err(bilibili::Error::Api(data.code));
    }
    let data = data.data.ok_or_else(invalid)?;
    if data.room.len() > 100 || data.admin.len() > 100 {
        return Err(bilibili::Error::TooLarge);
    }
    let mut cues = Vec::new();
    for raw in data.room.into_iter().chain(data.admin) {
        if raw.dm_type != 0 {
            continue;
        }
        if raw.timeline.len() != 19
            || !raw.timeline.is_ascii()
            || raw.timeline.as_bytes()[10] != b' '
        {
            return Err(invalid());
        }
        let epoch = super::super::bilibili::live::playlist::parse_program_date_time(&format!(
            "{}T{}+08:00",
            &raw.timeline[..10],
            &raw.timeline[11..]
        ))
        .map_err(|_| invalid())?;
        let epoch = u64::try_from(epoch).map_err(|_| invalid())?;
        if epoch > now_ms + 5000 {
            return Err(invalid());
        }
        if epoch < started_at * 1000 || epoch + 120_000 < now_ms {
            continue;
        }
        let at_ms = epoch - started_at * 1000;
        if at_ms > MAX_TIME_MS {
            return Err(invalid());
        }
        let text = plain_text(&raw.text, 160);
        if !text.is_empty() {
            cues.push(DanmakuCue {
                at_ms,
                text,
                mode: DanmakuMode::Scroll,
                style: None,
                position: None,
                advanced_unsupported: None,
            });
        }
    }
    Ok(bounded_danmaku(cues))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn event() -> Vec<u8> {
        packet(5,br#"{"cmd":"DANMU_MSG:4:0:2:2:2:0","info":[[0,1,25,0,1700000000],"<img src=x>",[42,"private user"]]}"#)
    }
    fn compressed(version: u16, body: &[u8]) -> Vec<u8> {
        let mut p = packet(5, body);
        p[6..8].copy_from_slice(&version.to_be_bytes());
        p
    }
    #[test]
    fn packet_compression_plain_text_auth_and_bounds() {
        let raw = event();
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(&raw).unwrap();
        let z = compressed(2, &z.finish().unwrap());
        let mut b = Vec::new();
        {
            let mut encoder = brotli::CompressorWriter::new(&mut b, 4096, 4, 22);
            encoder.write_all(&raw).unwrap();
        }
        let b = compressed(3, &b);
        for body in [raw, z, b] {
            assert_eq!(
                parse_packets(&body).unwrap(),
                vec![Event::Text {
                    epoch_ms: 1700000000000,
                    text: "<img src=x>".into()
                }]
            );
        }
        assert_eq!(
            parse_packets(&packet(8, br#"{"code":0}"#)).unwrap(),
            vec![Event::Accepted]
        );
        assert!(parse_packets(&packet(8, br#"{"code":-101}"#)).is_err());
        assert!(parse_packets(&[0; 16]).is_err());
        assert!(parse_packets(&event()[..17]).is_err());
        assert!(parse_packets(&compressed(3, b"bad")).is_err());
        let bomb = vec![0; MAX_FRAME_BYTES + 1];
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        z.write_all(&bomb).unwrap();
        assert!(parse_packets(&compressed(2, &z.finish().unwrap())).is_err());
    }
    #[test]
    fn duplicate_auth_code_and_nested_decompression_budget_are_rejected() {
        assert!(parse_packets(&packet(8, br#"{"code":-101,"code":0}"#)).is_err());
        let mut raw = event();
        for _ in 0..5 {
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&raw).unwrap();
            raw = compressed(2, &encoder.finish().unwrap());
        }
        assert!(parse_packets(&raw).is_err());
        let many = (0..MAX_PACKETS + 1)
            .flat_map(|_| packet(3, &[0; 4]))
            .collect::<Vec<_>>();
        assert!(parse_packets(&many).is_err());
    }
    #[test]
    fn no_client_id_tokenless_or_external_host_fallback() {
        assert!(
            parse_client_id(br#"{"code":0,"data":{"b_3":"legitimately-issued-fixture-id"}}"#)
                .is_ok()
        );
        for url in [
            "wss://chat.bilibili.com.evil/sub",
            "ws://broadcastlv.chat.bilibili.com/sub",
            "wss://broadcastlv.chat.bilibili.com:80/sub",
            "wss://broadcastlv.chat.bilibili.com/sub?token=x",
        ] {
            assert!(validate_socket_url(url).is_err());
        }
        assert!(parse_discovery(br#"{"code":0,"data":{"token":"","host_list":[{"host":"broadcastlv.chat.bilibili.com","wss_port":443}]}}"#,1,0).is_err());
    }
}
