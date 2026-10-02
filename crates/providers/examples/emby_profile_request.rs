//! Offline diagnostic helper: emit the existing Emby profile request builder's
//! exact JSON body. No network, credentials, route mutation or SID allocation.
use anyhow::{Result, ensure};
use providers::{PlaybackOptions, SourceConfig, emby, upstream_profiles};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};

const MAX_INPUT: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    user_id: String,
    item_id: String,
    item_metadata: Value,
    audio_index: Option<u32>,
    position_ms: f64,
}

fn request(input: Input) -> Result<Value> {
    ensure!(
        !input.user_id.is_empty()
            && input.user_id.len() <= 512
            && !input.user_id.chars().any(char::is_control),
        "invalid_user_id"
    );
    let metadata = upstream_profiles::normalize_metadata(
        &input.item_metadata,
        &input.item_id,
        input.audio_index,
    )?;
    // The body builder requires nonempty credentials but never uses this token
    // in the body. Real authorization/device headers remain harness-owned.
    let config: SourceConfig = serde_json::from_value(json!({
        "url":"http://127.0.0.1", "user_id":input.user_id,
        "token":"offline-diagnostic-placeholder"
    }))?;
    let options = PlaybackOptions {
        position_ms: input.position_ms,
        audio_index: metadata.audio.as_ref().map(|audio| audio.index),
        media_source_id: Some(metadata.media_source_id.clone()),
        progressive: false,
        hls: true,
        force_transcode: true,
    };
    emby::profile_playback_request(&config, &options, &metadata)
}

fn run() -> Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_INPUT, "input_too_large");
    let body = request(serde_json::from_slice(&bytes)?)?;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &body)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

fn main() {
    if run().is_err() {
        // Never echo raw metadata, source paths or parser context on failures.
        eprintln!("emby_profile_request_invalid");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Value {
        json!({"user_id":"fixture-user","item_id":"fixture-item","position_ms":0,
        "audio_index":1,"item_metadata":{"Id":"fixture-item","MediaSources":[{
            "Id":"fixture-source","RunTimeTicks":600_000_000,
            "SupportsTranscoding":true,"IsInfiniteStream":false,"RequiresOpening":false,
            "RequiresLooping":false,"DefaultAudioStreamIndex":1,"MediaStreams":[
                {"Type":"Video","Index":0,"Codec":"h264","Width":320,"Height":180,
                    "AverageFrameRate":60,"BitDepth":8,"VideoRange":"SDR"},
                {"Type":"Audio","Index":1,"Codec":"aac","Channels":1,"SampleRate":44100}
            ]
        }]}})
    }

    #[test]
    fn actual_builder_preserves_requested_recipe_for_incompatible_source_rates() {
        let body = request(serde_json::from_value(input()).unwrap()).unwrap();
        assert_eq!(body["UserId"], "fixture-user");
        assert_eq!(body["MediaSourceId"], "fixture-source");
        assert_eq!(body["AudioStreamIndex"], 1);
        assert_eq!(body["SubtitleStreamIndex"], -1);
        assert_eq!(body["EnableDirectPlay"], false);
        assert_eq!(body["EnableDirectStream"], false);
        assert_eq!(body["AllowVideoStreamCopy"], false);
        assert_eq!(body["AllowAudioStreamCopy"], false);
        let profiles = &body["DeviceProfile"]["CodecProfiles"];
        for (index, property, value) in
            [(0, "VideoFramerate", "30"), (1, "AudioSampleRate", "48000")]
        {
            assert!(
                profiles[index]["Conditions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|condition| condition["Property"] == property
                        && condition["Value"] == value
                        && condition["IsRequired"] == true)
            );
        }
        assert!(!body.to_string().contains("offline-diagnostic-placeholder"));
    }

    #[test]
    fn helper_rejects_unknown_options_or_mismatched_item() {
        let mut unknown = input();
        unknown["force_transcode"] = json!(false);
        assert!(serde_json::from_value::<Input>(unknown).is_err());
        let mut mismatch = input();
        mismatch["item_id"] = json!("different-item");
        assert!(request(serde_json::from_value(mismatch).unwrap()).is_err());
    }
}
