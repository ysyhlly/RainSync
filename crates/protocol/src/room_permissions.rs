use serde::{Deserialize, Serialize};

/// Room authority never grants access to a source or private media library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomPermission {
    Invite,
    Kick,
    Close,
    Play,
    Pause,
    Seek,
    SetRate,
    ChangeMedia,
    Queue,
}
impl RoomPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invite => "invite",
            Self::Kick => "kick",
            Self::Close => "close",
            Self::Play => "play",
            Self::Pause => "pause",
            Self::Seek => "seek",
            Self::SetRate => "set_rate",
            Self::ChangeMedia => "change_media",
            Self::Queue => "queue",
        }
    }
    pub fn for_action(action: &crate::Action) -> Self {
        match action {
            crate::Action::Play => Self::Play,
            crate::Action::Pause => Self::Pause,
            crate::Action::Seek { .. } => Self::Seek,
            crate::Action::SetRate { .. } => Self::SetRate,
            crate::Action::ChangeMedia { .. } | crate::Action::EndMedia { .. } => Self::ChangeMedia,
        }
    }
}
