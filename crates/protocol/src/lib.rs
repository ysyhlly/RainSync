use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
pub struct RoomState {
    pub room_id: Uuid,
    pub revision: u32,
    pub media_id: Option<Uuid>,
    pub media_generation: u32,
    pub playback_status: PlaybackStatus,
    pub anchor_position_ms: f64,
    pub anchor_server_time_ms: f64,
    pub playback_rate: f64,
    pub controller_user_id: Uuid,
    pub duration_ms: Option<f64>,
    pub clock_epoch: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", content = "payload", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Action {
    Play,
    Pause,
    Seek { position_ms: f64 },
    SetRate { rate: f64 },
    ChangeMedia { media_id: Uuid },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct Command {
    pub protocol_version: u8,
    pub room_id: Uuid,
    pub command_id: Uuid,
    pub expected_revision: u32,
    pub media_generation: u32,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackPlan {
    pub session_id: Uuid,
    pub media_id: Uuid,
    pub media_generation: u32,
    pub delivery_mode: String,
    pub transport: String,
    pub playback_url: String,
    pub timeline_origin_ms: f64,
    pub duration_ms: Option<f64>,
    pub expires_in_seconds: u32,
    pub rebuild_on_seek: bool,
    pub audio_tracks: Vec<MediaTrack>,
    pub subtitle_tracks: Vec<MediaTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MediaTrack {
    pub index: u32,
    pub label: String,
    pub language: String,
    pub url: Option<String>,
}

/// Independently detected transports; MSE support does not imply progressive support.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCapabilities {
    pub progressive_h264_aac: bool,
    pub native_hls: bool,
    pub mse_h264_aac: bool,
}

impl PlaybackCapabilities {
    pub fn supports_hls(&self) -> bool {
        self.native_hls || self.mse_h264_aac
    }
    pub fn negotiate<'a>(&self, mode: &'a str, transport: &'a str) -> Option<(&'a str, &'a str)> {
        if transport == "hls" || mode != "direct" {
            return self.supports_hls().then_some((mode, "hls"));
        }
        if self.progressive_h264_aac {
            Some((mode, transport))
        } else {
            self.supports_hls().then_some(("remux", "hls"))
        }
    }
}

#[cfg(test)]
mod capability_tests {
    use super::*;
    #[test]
    fn refuses_unplayable_output_and_distinguishes_transports() {
        let mut caps = PlaybackCapabilities {
            progressive_h264_aac: true,
            native_hls: false,
            mse_h264_aac: false,
        };
        assert_eq!(
            caps.negotiate("direct", "progressive"),
            Some(("direct", "progressive"))
        );
        assert_eq!(caps.negotiate("transcode", "hls"), None);
        caps.progressive_h264_aac = false;
        assert_eq!(caps.negotiate("direct", "progressive"), None);
        caps.native_hls = true;
        assert_eq!(
            caps.negotiate("direct", "progressive"),
            Some(("remux", "hls"))
        );
    }
}
