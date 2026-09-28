//! Bounded sequential decode. Every decoded frame is inspected in order.
use anyhow::{Result, ensure};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};
const FRAME: usize = 1280 * 360 * 3;
pub const MAX_IMAGE: usize = 262144;

pub fn is_black(rgb: &[u8]) -> bool {
    let black = rgb
        .as_chunks::<3>()
        .0
        .iter()
        .filter(|p| (u32::from(p[0]) * 299 + u32::from(p[1]) * 587 + u32::from(p[2]) * 114) < 24000)
        .count();
    !rgb.is_empty() && black * 1000 >= (rgb.len() / 3) * 995
}
pub fn check_webp(bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() >= 20
            && bytes.len() <= MAX_IMAGE
            && &bytes[..4] == b"RIFF"
            && &bytes[8..12] == b"WEBP",
        "invalid_preview"
    );
    ensure!(
        u32::from_le_bytes(bytes[4..8].try_into()?) as usize + 8 == bytes.len(),
        "invalid_riff"
    );
    let (mut offset, mut frames) = (12, 0);
    while offset + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into()?) as usize;
        let end = offset
            .checked_add(8 + size)
            .filter(|v| *v <= bytes.len())
            .ok_or_else(|| anyhow::anyhow!("invalid_chunk"))?;
        let data = &bytes[offset + 8..end];
        let dims = match &bytes[offset..offset + 4] {
            b"VP8 " if size >= 10 && data[3..6] == [0x9d, 0x01, 0x2a] => {
                frames += 1;
                Some((
                    u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
                    u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
                ))
            }
            b"VP8L" if size >= 5 && data[0] == 0x2f => {
                frames += 1;
                let bits = u32::from_le_bytes(data[1..5].try_into()?);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"VP8X" if size == 10 && data[0] & 2 == 0 => Some((
                1 + u32::from_le_bytes([data[4], data[5], data[6], 0]),
                1 + u32::from_le_bytes([data[7], data[8], data[9], 0]),
            )),
            b"ALPH" => None,
            _ => anyhow::bail!("invalid_static_preview"),
        };
        ensure!(dims.is_none_or(|v| v == (640, 360)), "invalid_dimensions");
        offset = end + size % 2;
    }
    ensure!(offset == bytes.len() && frames == 1, "invalid_frame_count");
    Ok(())
}
fn command() -> Command {
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-v",
        "error",
        "-nostdin",
        "-max_alloc",
        "67108864",
        "-threads",
        "1",
        "-filter_threads",
        "1",
    ])
    .env_remove("FFREPORT")
    .stderr(Stdio::null())
    .stdout(Stdio::piped());
    cmd
}
pub async fn generate(
    url: &str,
    poster: bool,
    timeout: Duration,
    mut cancel: watch::Receiver<bool>,
) -> Result<Vec<u8>> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut cmd = command();
    // Only the task-owned proxy is given to FFmpeg; never an upstream credential.
    cmd.args([
        "-protocol_whitelist",
        "http,tcp,crypto",
        "-i",
        url,
        "-an",
        "-sn",
        "-vf",
        // Crop in display space before resizing, including non-square pixels.
        // FFmpeg 5.1 supports exact crop; no unbounded intermediate scale or
        // newer reset_sar option is needed. Unspecified SAR falls back to 1.
        "split[a][b];[a]scale=640:360,setsar=1[a];[b]crop=w='min(iw,ih*16/9/if(gt(sar,0),sar,1))':h='min(ih,iw*if(gt(sar,0),sar,1)*9/16)':exact=1,scale=640:360,setsar=1[b];[a][b]hstack",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
    ])
    .stdin(Stdio::null());
    let mut child = crate::child_process::spawn(cmd)?;
    let mut out = child.stdout.take().unwrap();
    let decoded = tokio::select! {
        _=cancel.changed()=>Err(anyhow::anyhow!("preview_cancelled")),
        result=tokio::time::timeout_at(deadline,async {
            let mut frame=vec![0;FRAME];
            loop {
                out.read_exact(&mut frame).await?;
                // Inspect the complete frame before center cropping; the left
                // half is analysis-only, the right half preserves output aspect.
                let sample: Vec<u8> = frame.as_chunks::<{1280*3}>().0.iter().flat_map(|row|row[..640*3].iter().copied()).collect();
                if poster || !is_black(&sample) {
                    let result: Vec<u8> = frame.as_chunks::<{1280*3}>().0.iter().flat_map(|row|row[640*3..].iter().copied()).collect();
                    return Ok::<_,anyhow::Error>(result)
                }
            }
        })=>result.unwrap_or_else(|_|Err(anyhow::anyhow!("preview_timeout"))),
    };
    child.kill().await?;
    let frame = decoded?;
    for quality in ["75", "50", "30"] {
        if *cancel.borrow() {
            anyhow::bail!("preview_cancelled")
        }
        let mut cmd = command();
        cmd.args([
            "-protocol_whitelist",
            "pipe",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            "640x360",
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
            "image2pipe",
            "pipe:1",
        ])
        .stdin(Stdio::piped());
        let mut child = crate::child_process::spawn(cmd)?;
        let mut input = child.stdin.take().unwrap();
        let out = child.stdout.take().unwrap();
        let encoded = tokio::select! {
            _=cancel.changed()=>Err(anyhow::anyhow!("preview_cancelled")),
            result=tokio::time::timeout_at(deadline,async {
                let (_,bytes)=tokio::try_join!(async {input.write_all(&frame).await?;drop(input);Ok::<_,std::io::Error>(())},async {let mut bytes=Vec::new();out.take((MAX_IMAGE+1) as u64).read_to_end(&mut bytes).await?;Ok::<_,std::io::Error>(bytes)})?;
                if bytes.len()>MAX_IMAGE {return Ok(bytes)}
                ensure!(child.wait().await?.success(),"preview_encode_failed");Ok::<_,anyhow::Error>(bytes)
            })=>result.unwrap_or_else(|_|Err(anyhow::anyhow!("preview_timeout"))),
        };
        child.kill().await?;
        let bytes = encoded?;
        if bytes.len() > MAX_IMAGE {
            continue;
        }
        check_webp(&bytes)?;
        return Ok(bytes);
    }
    anyhow::bail!("preview_too_large")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dark_picture_is_valid_but_995_per_mille_black_is_not() {
        assert!(is_black(&vec![0; 3000]));
        assert!(!is_black(&vec![24; 3000]));
        let mut frame = vec![0; 3000];
        frame[..15].fill(100);
        assert!(is_black(&frame));
        frame[..18].fill(100);
        assert!(!is_black(&frame));
        assert!(!is_black(&[]));
        assert!(check_webp(b"RIFFbrokenWEBP").is_err());
    }
}
