//! Owned, synthetic FFmpeg fixtures. Run explicitly with --ignored; no network,
//! Server, accounts, browser or Agent is used by this suite.
use media_core::capabilities::{candidates, negotiated_hls_args};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("rainsync-capability-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn path(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().to_owned()
    }
    fn record(&self, input: &str, source: &Value, mode: &str, output: &Value) {
        let Ok(root) = std::env::var("RAINSYNC_CAPABILITY_OUTPUT_REPORT_DIR") else {
            return;
        };
        let directory = Path::new(&root).join(self.0.file_name().unwrap());
        std::fs::create_dir_all(&directory).unwrap();
        let facts = |probe: &Value| {
            probe["streams"]
                .as_array()
                .unwrap()
                .iter()
                .map(|stream| {
                    let mut facts = serde_json::Map::new();
                    for key in [
                        "index",
                        "codec_type",
                        "codec_name",
                        "codec_tag_string",
                        "profile",
                        "level",
                        "pix_fmt",
                        "width",
                        "height",
                        "sample_aspect_ratio",
                        "r_frame_rate",
                        "avg_frame_rate",
                        "channels",
                        "sample_rate",
                        "color_transfer",
                        "color_primaries",
                        "color_space",
                        "side_data_list",
                    ] {
                        if let Some(value) = stream.get(key) {
                            facts.insert(key.into(), value.clone());
                        }
                    }
                    Value::Object(facts)
                })
                .collect::<Vec<_>>()
        };
        let snapshot =
            media_core::file_version::snapshot_file(&std::fs::File::open(input).unwrap()).unwrap();
        let report = json!({"schema_version":1, "fixture":"owned synthetic FFmpeg media", "source_sha256":format!("{:x}", Sha256::digest(std::fs::read(input).unwrap())),
            "source_stat_version":snapshot.version, "source_bytes":snapshot.len,
            "source_facts":facts(source), "offered_candidates":candidates(source,None,0.0).unwrap(),
            "actual_output_mode":mode, "observed_output_probe":facts(output),
            "evidence_boundary":"Synthetic local decoder/encoder/header and geometry evidence, not browser/device playback or presentation proof"});
        std::fs::write(
            directory.join(format!("{mode}.json")),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
async fn command(binary: &str, args: &[&str]) -> Vec<u8> {
    let mut command = tokio::process::Command::new(binary);
    command.args(args);
    let (status, bytes) = media_core::child_process::capture(
        command,
        std::time::Duration::from_secs(30),
        4 * 1024 * 1024,
    )
    .await
    .unwrap();
    assert!(status.success(), "{binary} failed");
    bytes
}
async fn source(f: &Fixture, name: &str, filter: &str, extra: &[&str]) -> String {
    let path = f.path(name);
    let mut args = vec!["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", filter];
    args.extend_from_slice(extra);
    args.extend(["-threads", "1", "-movflags", "+faststart", &path]);
    command("ffmpeg", &args).await;
    path
}
async fn encode(f: &Fixture, input: &str, mode: &str, audio: Option<u32>) -> Value {
    let path = f.path(&format!("{mode}/index.m3u8"));
    std::fs::create_dir(Path::new(&path).parent().unwrap()).unwrap();
    let mut args = negotiated_hls_args(input, &path, 0.0, mode, audio);
    // Bound synthetic encoding threads without changing the production recipe.
    args.splice(
        0..0,
        [
            "-threads".into(),
            "1".into(),
            "-filter_threads".into(),
            "1".into(),
        ],
    );
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    command("ffmpeg", &refs).await;
    serde_json::from_slice(
        &command(
            "ffprobe",
            &[
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-show_data",
                "-of",
                "json",
                &path,
            ],
        )
        .await,
    )
    .unwrap()
}
fn video(probe: &Value) -> &Value {
    probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["codec_type"] == "video")
        .unwrap()
}
fn verify_recipe(probe: &Value) {
    let v = video(probe);
    assert_eq!(
        (v["width"].as_u64(), v["height"].as_u64()),
        (Some(1280), Some(720))
    );
    assert_eq!(v["profile"], "High");
    assert_eq!(v["codec_tag_string"], "avc1");
    assert_eq!(v["level"], 31);
    assert_eq!(v["pix_fmt"], "yuv420p");
    assert_eq!(v["r_frame_rate"], "30/1");
    assert_eq!(v["sample_aspect_ratio"], "1:1");
}
async fn visible_width(f: &Fixture) -> usize {
    let path = f.path("transcode/index.m3u8");
    let bytes = command(
        "ffmpeg",
        &[
            "-v",
            "error",
            "-i",
            &path,
            "-frames:v",
            "1",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ],
    )
    .await;
    assert_eq!(bytes.len(), 1280 * 720);
    let middle = &bytes[360 * 1280..361 * 1280];
    middle.iter().filter(|luma| **luma > 40).count()
}

#[tokio::test]
#[ignore = "requires local FFmpeg with libx264/libx265; synthetic CPU fixtures"]
async fn anamorphic_and_rotated_inputs_preserve_display_geometry() {
    for (sar, rotate, width) in [("16/15", false, 960), ("1", true, 576)] {
        let f = Fixture::new();
        let filter = format!("color=red:s=720x576:r=25:d=0.4,setsar={sar}");
        let path = source(
            &f,
            "source.mp4",
            &filter,
            &["-c:v", "libx264", "-pix_fmt", "yuv420p"],
        )
        .await;
        let input = if rotate {
            let rotated = f.path("rotated.mp4");
            command(
                "ffmpeg",
                &[
                    "-v",
                    "error",
                    "-y",
                    "-display_rotation",
                    "90",
                    "-i",
                    &path,
                    "-c",
                    "copy",
                    "-metadata:s:v:0",
                    "rotate=90",
                    &rotated,
                ],
            )
            .await;
            rotated
        } else {
            path
        };
        let measured = media_core::probe(&input).await.unwrap();
        assert_eq!(candidates(&measured, None, 0.0).unwrap().len(), 1);
        let output = encode(&f, &input, "transcode", None).await;
        verify_recipe(&output);
        f.record(&input, &measured, "transcode", &output);
        assert!(
            !output["streams"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["codec_type"] == "audio")
        );
        assert!(
            visible_width(&f).await.abs_diff(width) <= 2,
            "display aspect was stretched"
        );
    }
}

#[tokio::test]
#[ignore = "requires local FFmpeg with libx264/libx265; synthetic CPU fixtures"]
async fn actual_hevc_main_and_main10_sdr_headers_and_output_agree() {
    for (depth, profile) in [("yuv420p", ".1."), ("yuv420p10le", ".2.")] {
        let f = Fixture::new();
        let input = source(
            &f,
            "hevc.mp4",
            "color=red:s=128x72:r=25:d=0.4",
            &[
                "-c:v",
                "libx265",
                "-x265-params",
                "pools=none:frame-threads=1:log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709",
                "-pix_fmt",
                depth,
                "-tag:v",
                "hvc1",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-colorspace",
                "bt709",
            ],
        )
        .await;
        let probe = media_core::probe(&input).await.unwrap();
        let routes = candidates(&probe, None, 0.0).unwrap();
        assert_eq!(
            routes.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["direct", "transcode_720p"]
        );
        assert!(
            routes[0]
                .video
                .content_type
                .contains(&format!("hvc1{profile}"))
        );
        assert_eq!(routes[0].video.width, 128);
        assert_eq!(routes[0].video.framerate, 25.0);
        assert!(routes[0].audio.is_none());
        let output = encode(&f, &input, "transcode", None).await;
        verify_recipe(&output);
        f.record(&input, &probe, "transcode", &output);
        assert_eq!(video(&output)["color_transfer"], "bt709");
        assert_eq!(video(&output)["color_primaries"], "bt709");
    }
}

#[tokio::test]
#[ignore = "requires local FFmpeg with libx264; synthetic CPU fixture"]
async fn vfr_input_has_a_real_cfr_output() {
    let f = Fixture::new();
    let input = source(
        &f,
        "vfr.mp4",
        "color=red:s=320x180:r=30:d=1,select='not(eq(mod(n,3),1))'",
        &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-fps_mode", "vfr"],
    )
    .await;
    let probe = media_core::probe(&input).await.unwrap();
    assert!(media_core::hls_needs_video_transform(&probe));
    assert_eq!(candidates(&probe, None, 0.0).unwrap().len(), 1);
    let output = encode(&f, &input, "transcode", None).await;
    verify_recipe(&output);
    f.record(&input, &probe, "transcode", &output);
    let path = f.path("transcode/index.m3u8");
    let bytes = command(
        "ffprobe",
        &[
            "-v",
            "error",
            "-select_streams",
            "v",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            &path,
        ],
    )
    .await;
    let frames: Value = serde_json::from_slice(&bytes).unwrap();
    let times: Vec<f64> = frames["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            v["best_effort_timestamp_time"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    assert!(times.len() > 20);
    assert!(
        times
            .windows(2)
            .all(|pair| ((pair[1] - pair[0]) - 1.0 / 30.0).abs() < 0.00001)
    );
}

#[tokio::test]
#[ignore = "requires local FFmpeg with libx264/AAC; synthetic CPU fixture"]
async fn zero_origin_copy_and_audio_only_routes_keep_exact_track_configurations() {
    let f = Fixture::new();
    let input = source(
        &f,
        "multichannel.mp4",
        "color=red:s=320x180:r=25:d=0.4",
        &[
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=5.1:sample_rate=48000:d=0.4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
        ],
    )
    .await;
    let probe = media_core::probe(&input).await.unwrap();
    let routes = candidates(&probe, None, 0.0).unwrap();
    assert_eq!(
        routes.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        vec!["direct", "remux", "audio_transcode", "transcode_720p"]
    );
    assert_eq!(routes[0].audio.as_ref().unwrap().channels, "6");
    assert_eq!(routes[2].audio.as_ref().unwrap().channels, "2");
    for (mode, channels) in [("remux", 6), ("audio_transcode", 2)] {
        let output = encode(&f, &input, mode, Some(1)).await;
        f.record(&input, &probe, mode, &output);
        assert_eq!(video(&output)["width"], 320);
        assert_eq!(video(&output)["r_frame_rate"], "25/1");
        let audio = output["streams"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["codec_type"] == "audio")
            .unwrap();
        assert_eq!(audio["channels"], channels);
        assert_eq!(audio["sample_rate"], "48000");
        assert_eq!(audio["profile"], "LC");
    }
}

#[tokio::test]
#[ignore = "requires local FFmpeg with libx264; synthetic sample-entry fixtures"]
async fn avc3_requires_encoding_while_mkv_copy_has_a_proved_avc1_mux() {
    let f = Fixture::new();
    let original = source(
        &f,
        "source.mp4",
        "color=red:s=320x180:r=25:d=0.4",
        &["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    )
    .await;
    let avc3 = f.path("avc3.mp4");
    command(
        "ffmpeg",
        &[
            "-v", "error", "-y", "-i", &original, "-c", "copy", "-tag:v", "avc3", &avc3,
        ],
    )
    .await;
    let probe = media_core::probe(&avc3).await.unwrap();
    assert_eq!(video(&probe)["codec_tag_string"], "avc3");
    let routes = candidates(&probe, None, 0.0).unwrap();
    assert_eq!(
        routes
            .iter()
            .map(|route| route.id.as_str())
            .collect::<Vec<_>>(),
        vec!["transcode_720p"]
    );
    let output = encode(&f, &avc3, "transcode", None).await;
    verify_recipe(&output);
    f.record(&avc3, &probe, "transcode", &output);
    let mkv = f.path("source.mkv");
    command(
        "ffmpeg",
        &["-v", "error", "-y", "-i", &original, "-c", "copy", &mkv],
    )
    .await;
    let probe = media_core::probe(&mkv).await.unwrap();
    assert_eq!(candidates(&probe, None, 0.0).unwrap()[0].id, "remux");
    let output = encode(&f, &mkv, "remux", None).await;
    assert_eq!(video(&output)["codec_tag_string"], "avc1");
    assert_eq!(video(&output)["width"], 320);
    f.record(&mkv, &probe, "remux", &output);
    let mov = Fixture::new();
    let input = source(
        &mov,
        "source.mov",
        "color=red:s=320x180:r=25:d=0.4",
        &["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    )
    .await;
    let probe = media_core::probe(&input).await.unwrap();
    assert_eq!(probe["format"]["tags"]["major_brand"], "qt  ");
    assert_eq!(candidates(&probe, None, 0.0).unwrap()[0].id, "remux");
    let output = encode(&mov, &input, "remux", None).await;
    assert_eq!(video(&output)["codec_tag_string"], "avc1");
    assert_eq!(video(&output)["width"], 320);
    mov.record(&input, &probe, "remux", &output);
}
