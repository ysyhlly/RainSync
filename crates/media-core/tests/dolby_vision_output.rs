//! Explicit public-developer-fixture qualification. No fixture is downloaded
//! by a test, and no production media, account, or display is used.
use media_core::advanced_media::{
    EncoderSelection, Input, Inventory, OwnedLocalInput, Recipe, Request,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

async fn probe(path: &Path, frames: bool) -> Value {
    let mut command = tokio::process::Command::new("ffprobe");
    command.args(["-v", "error", "-of", "json"]);
    if frames {
        command.args([
            "-select_streams",
            "v:0",
            "-show_frames",
            "-read_intervals",
            "%+#2",
            "-show_entries",
            "frame=side_data_list",
        ]);
    } else {
        command.args(["-show_streams", "-show_format", "-show_data"]);
    }
    command.arg(path);
    let (status, bytes) =
        media_core::child_process::capture(command, Duration::from_secs(30), 8 * 1024 * 1024)
            .await
            .unwrap();
    assert!(status.success(), "fixture probe failed");
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
#[ignore = "requires RAINSYNC_DOLBY_FIXTURE_ROOT and a qualified FFmpeg/libplacebo/Vulkan runtime"]
async fn real_rpu_native_candidates_and_sdr_output() {
    let root = std::path::PathBuf::from(
        std::env::var("RAINSYNC_DOLBY_FIXTURE_ROOT").expect("owned fixture root"),
    );
    let inventory = Inventory::inspect().await.unwrap();
    let mut reports = Vec::new();
    for name in ["dv84.mp4", "dv5.mp4", "dv81.mp4"] {
        let source = root.join(name);
        if !source.is_file() {
            assert_ne!(
                name, "dv84.mp4",
                "at least the FFmpeg FATE fixture is required"
            );
            continue;
        }
        let before = Sha256::digest(std::fs::read(&source).unwrap());
        let meta = probe(&source, false).await;
        let native =
            media_core::capabilities::analyze_legacy_mapped_source(&meta, None, 0.0).unwrap();
        assert_eq!(native.candidates.len(), 1);
        assert_eq!(native.candidates[0].id, "direct");
        assert!(native.candidates[0].video.dolby_vision.is_some());
        assert!(
            native
                .route_decisions
                .iter()
                .filter(|d| d.candidate_id != "direct")
                .all(|d| !d.offered)
        );
        // Native eligibility must not weaken the ordinary SDR Worker guard.
        assert!(media_core::capabilities::validate_motion_source(&meta).is_err());
        let input_frames = probe(&source, true).await;
        assert!(
            input_frames["frames"]
                .as_array()
                .unwrap()
                .iter()
                .all(|frame| frame["side_data_list"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|side| side["side_data_type"] == "Dolby Vision RPU Data"))
        );
        let version =
            media_core::file_version::snapshot_file(&std::fs::File::open(&source).unwrap())
                .unwrap()
                .version;
        let input = OwnedLocalInput::open(&root, name, &version).unwrap();
        input.verify_dolby_vision_rpu(&meta).await.unwrap();
        for start in [0.0, 1.0] {
            let directory =
                std::env::temp_dir().join(format!("rainsync-dovi-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let output = directory.join("index.m3u8");
            let request = Request {
                tone_map_hdr: true,
                ..Default::default()
            };
            let recipe = Recipe::from_probe(
                &meta,
                None,
                start,
                &request,
                EncoderSelection::software_recipe(),
            )
            .unwrap();
            let args = recipe
                .ffmpeg_args(Input::OwnedLocal(&input), &output, &inventory, false)
                .unwrap();
            let mut command = tokio::process::Command::new("ffmpeg");
            command.args(args).env("LP_NUM_THREADS", "2");
            input.install(&mut command).unwrap();
            command
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::inherit());
            let (status, _) =
                media_core::child_process::capture(command, Duration::from_secs(90), 1024 * 1024)
                    .await
                    .unwrap();
            assert!(status.success(), "Dolby fixture conversion failed");
            let actual = probe(&output, false).await;
            recipe.validate_output_probe(&actual).unwrap();
            let video = actual["streams"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["codec_type"] == "video")
                .unwrap();
            assert_eq!(video["codec_name"], "h264");
            assert_eq!(video["pix_fmt"], "yuv420p");
            for key in ["color_transfer", "color_primaries", "color_space"] {
                assert_eq!(video[key], "bt709");
            }
            let output_frames = probe(&output, true).await;
            assert!(
                output_frames["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(
                        |frame| frame["side_data_list"].as_array().is_none_or(|rows| rows
                            .iter()
                            .all(|row| !row["side_data_type"]
                                .as_str()
                                .unwrap_or("")
                                .contains("Dolby Vision")))
                    )
            );
            reports.push(json!({"fixture":name,"start_seconds":start,"source_sha256":format!("{before:x}"),
                "native_candidate":native.candidates[0],"decoded_rpu_frames":input_frames["frames"].as_array().unwrap().len(),
                "actual_sdr_video":video,"result":"passed","display_acceptance":"not performed"}));
            std::fs::remove_dir_all(directory).unwrap();
        }
        assert_eq!(before, Sha256::digest(std::fs::read(&source).unwrap()));
        input.verify().unwrap();
    }
    if let Ok(path) = std::env::var("RAINSYNC_DOLBY_OUTPUT_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
    }
}
