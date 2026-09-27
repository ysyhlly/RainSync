use crate::*;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{Semaphore, watch},
};

pub const INPUT_LIMIT: usize = 2 * 1024 * 1024;
pub const OUTPUT_LIMIT: usize = 256 * 1024;
const RGBA_SIZE: usize = 512 * 512 * 4;

#[derive(Clone)]
pub struct Settings {
    binary: String,
    timeout: Duration,
    slots: Arc<Semaphore>,
    pub writes_per_minute: i32,
}
impl Settings {
    pub fn configured() -> anyhow::Result<Self> {
        let concurrency = limits::configured("AVATAR_PROCESS_CONCURRENCY", 2)?;
        anyhow::ensure!(
            concurrency <= 8,
            "AVATAR_PROCESS_CONCURRENCY must be between 1 and 8"
        );
        let timeout = std::env::var("AVATAR_PROCESS_TIMEOUT_MS")
            .unwrap_or("5000".into())
            .parse::<u64>()?;
        anyhow::ensure!(
            (100..=30000).contains(&timeout),
            "AVATAR_PROCESS_TIMEOUT_MS must be between 100 and 30000"
        );
        Ok(Self {
            binary: std::env::var("AVATAR_FFMPEG_BIN").unwrap_or("ffmpeg".into()),
            timeout: Duration::from_millis(timeout),
            slots: Arc::new(Semaphore::new(concurrency as usize)),
            writes_per_minute: limits::configured("AVATAR_WRITES_PER_MINUTE", 10)? as i32,
        })
    }
}

fn invalid() -> Error {
    err(StatusCode::BAD_REQUEST, "avatar_invalid")
}
fn failed() -> Error {
    err(StatusCode::SERVICE_UNAVAILABLE, "avatar_processing_failed")
}

/// Cheap format/dimension/animation checks precede the actual decoder.
pub fn check_png(bytes: &[u8]) -> Result<()> {
    if bytes.len() > INPUT_LIMIT {
        return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "avatar_too_large"));
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(invalid());
    }
    let mut offset = 8usize;
    let mut header = false;
    let mut data = false;
    while offset.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|x| x.checked_add(length))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        let kind = &bytes[offset + 4..offset + 8];
        if !header && kind != b"IHDR" {
            return Err(invalid());
        }
        match kind {
            b"IHDR" => {
                if header
                    || length != 13
                    || u32::from_be_bytes(bytes[offset + 8..offset + 12].try_into().unwrap()) != 512
                    || u32::from_be_bytes(bytes[offset + 12..offset + 16].try_into().unwrap())
                        != 512
                {
                    return Err(invalid());
                }
                header = true;
            }
            b"acTL" | b"fcTL" | b"fdAT" => return Err(invalid()),
            b"IDAT" => data = true,
            b"IEND" => {
                return if length == 0 && data && end == bytes.len() {
                    Ok(())
                } else {
                    Err(invalid())
                };
            }
            _ => {}
        }
        offset = end;
    }
    Err(invalid())
}

fn check_webp(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 20
        || bytes.len() > OUTPUT_LIMIT
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WEBP"
        || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 != bytes.len()
    {
        return Err(failed());
    }
    let mut offset = 12usize;
    let mut frames = 0;
    while offset + 8 <= bytes.len() {
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(8)
            .and_then(|n| n.checked_add(length))
            .filter(|n| *n <= bytes.len())
            .ok_or_else(failed)?;
        let data = &bytes[offset + 8..end];
        let dimensions = match &bytes[offset..offset + 4] {
            b"ANIM" | b"ANMF" | b"EXIF" | b"XMP " | b"ICCP" => return Err(failed()),
            b"VP8X" if length == 10 && data[0] & 2 == 0 => Some((
                1 + u32::from_le_bytes([data[4], data[5], data[6], 0]),
                1 + u32::from_le_bytes([data[7], data[8], data[9], 0]),
            )),
            b"VP8 " if length >= 10 && data[3..6] == [0x9d, 0x01, 0x2a] => {
                frames += 1;
                Some((
                    u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
                    u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
                ))
            }
            b"VP8L" if length >= 5 && data[0] == 0x2f => {
                frames += 1;
                let bits = u32::from_le_bytes(data[1..5].try_into().unwrap());
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"ALPH" => None,
            _ => return Err(failed()),
        };
        if dimensions.is_some_and(|d| d != (512, 512)) {
            return Err(failed());
        }
        offset = end + (length % 2);
    }
    if offset != bytes.len() || frames != 1 {
        return Err(failed());
    }
    Ok(())
}

fn decoder_input(input: Vec<u8>) -> Result<Vec<u8>> {
    check_png(&input)?;
    let mut output = input[..8].to_vec();
    let mut offset = 8;
    while offset < input.len() {
        let size = u32::from_be_bytes(input[offset..offset + 4].try_into().unwrap()) as usize;
        let end = offset + 12 + size;
        let kind = &input[offset + 4..offset + 8];
        // Canvas produces sRGB pixels. Do not inflate arbitrary embedded ICC,
        // compressed text or EXIF metadata in the decoder process.
        match kind {
            b"IHDR" | b"PLTE" | b"tRNS" | b"IDAT" | b"IEND" | b"sRGB" | b"gAMA" | b"cHRM"
            | b"sBIT" | b"tEXt" => output.extend_from_slice(&input[offset..end]),
            _ if kind[0] & 0x20 == 0 => return Err(invalid()),
            _ => {}
        }
        offset = end;
    }
    Ok(output)
}

struct Cancel(watch::Sender<bool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

async fn capture(
    settings: &Settings,
    args: &[&str],
    input: &[u8],
    max: usize,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> std::io::Result<Vec<u8>> {
    if *cancel.borrow() {
        return Err(std::io::Error::other("avatar cancelled"));
    }
    let mut command = Command::new(&settings.binary);
    command
        .args([
            "-hide_banner",
            "-max_alloc",
            "16777216",
            "-v",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-protocol_whitelist",
            "pipe",
        ])
        .args(args)
        .env_remove("FFREPORT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = media_core::child_process::spawn(command)?;
    let mut input_pipe = child.stdin.take().expect("piped input");
    let output_pipe = child.stdout.take().expect("piped output");
    let remaining = deadline.saturating_duration_since(Instant::now());
    let result = tokio::select! {
        _=cancel.changed()=>Err(std::io::Error::other("avatar cancelled")),
        value=tokio::time::timeout(remaining,async {
            let (_,bytes)=tokio::try_join!(async move {input_pipe.write_all(input).await?;drop(input_pipe);Ok::<(),std::io::Error>(())},async {
                let mut bytes=Vec::new();output_pipe.take((max+1) as u64).read_to_end(&mut bytes).await?;Ok::<_,std::io::Error>(bytes)
            })?;
            if bytes.len()>max { return Err(std::io::Error::new(std::io::ErrorKind::FileTooLarge,"avatar process output limit")); }
            if !child.wait().await?.success() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"avatar process failed")); }
            Ok(bytes)
        })=>value.unwrap_or_else(|_|Err(std::io::Error::new(std::io::ErrorKind::TimedOut,"avatar process timeout"))),
    };
    if result.is_err() {
        child.kill().await?;
    }
    result
}

/// Cancellation notifies an independent task. Its semaphore permit remains held
/// until the owned process tree has actually been killed and reaped.
pub async fn encode(settings: &Settings, input: Vec<u8>) -> Result<Vec<u8>> {
    let permit = settings
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| account_security::limited(1))?;
    let settings = settings.clone();
    let (sender, mut cancel) = watch::channel(false);
    let _cancel = Cancel(sender);
    tokio::spawn(async move {
        let _permit = permit;
        let input = decoder_input(input)?;
        let deadline = Instant::now() + settings.timeout;
        let raw = capture(
            &settings,
            &[
                "-err_detect",
                "crccheck+explode",
                "-xerror",
                "-f",
                "image2pipe",
                "-c:v",
                "png",
                "-i",
                "pipe:0",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ],
            &input,
            RGBA_SIZE,
            deadline,
            &mut cancel,
        )
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                err(StatusCode::GATEWAY_TIMEOUT, "avatar_processing_timeout")
            } else if error.kind() == std::io::ErrorKind::InvalidData {
                invalid()
            } else {
                failed()
            }
        })?;
        if raw.len() != RGBA_SIZE {
            return Err(invalid());
        }
        for quality in ["82", "60", "40"] {
            match capture(
                &settings,
                &[
                    "-f",
                    "rawvideo",
                    "-pixel_format",
                    "rgba",
                    "-video_size",
                    "512x512",
                    "-i",
                    "pipe:0",
                    "-frames:v",
                    "1",
                    "-map_metadata",
                    "-1",
                    "-c:v",
                    "libwebp",
                    "-quality",
                    quality,
                    "-compression_level",
                    "4",
                    "-threads",
                    "1",
                    "-f",
                    "webp",
                    "pipe:1",
                ],
                &raw,
                OUTPUT_LIMIT,
                deadline,
                &mut cancel,
            )
            .await
            {
                Ok(bytes) => {
                    check_webp(&bytes)?;
                    return Ok(bytes);
                }
                Err(error) if error.kind() == std::io::ErrorKind::FileTooLarge => continue,
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                    return Err(err(
                        StatusCode::GATEWAY_TIMEOUT,
                        "avatar_processing_timeout",
                    ));
                }
                Err(_) => return Err(failed()),
            }
        }
        Err(err(StatusCode::PAYLOAD_TOO_LARGE, "avatar_too_large"))
    })
    .await
    .map_err(|_| failed())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn saturated_process_slots_reject_without_launching_an_encoder() {
        let settings = Settings {
            binary: "must-not-be-launched".into(),
            timeout: Duration::from_secs(1),
            slots: Arc::new(Semaphore::new(1)),
            writes_per_minute: 10,
        };
        let _held = settings.slots.clone().acquire_owned().await.unwrap();
        let result = encode(&settings, Vec::new()).await;
        assert!(matches!(
            result,
            Err(Error(StatusCode::TOO_MANY_REQUESTS, _, Some(1)))
        ));
    }
    #[test]
    fn non_png_truncated_headers_and_declared_giant_chunks_are_rejected() {
        for bytes in [
            b"GIF89a".as_slice(),
            b"<svg/>".as_slice(),
            b"\x89PNG\r\n\x1a\n\xff\xff\xff\xffIHDRxxxx".as_slice(),
        ] {
            assert!(check_png(bytes).is_err());
        }
        assert!(check_webp(b"RIFF\0\0\0\0WEBP").is_err());
    }
}
