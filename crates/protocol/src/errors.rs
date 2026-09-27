use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Public codes are an allowlist. Raw framework, database and upstream errors
/// must never be copied into the wire response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidRequest,
    LoginRequired,
    SessionExpired,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    PayloadTooLarge,
    UnsupportedMediaType,
    RangeNotSatisfiable,
    RateLimited,
    InternalError,
    UpstreamFailed,
    ServiceUnavailable,
    RequestTimeout,
    InvalidCredentials,
    OriginRejected,
    CsrfRejected,
    NotAMember,
    AdminRequired,
    ControllerRequired,
    InvalidName,
    UsernameOrPasswordInvalid,
    InvalidInvite,
    RoomFull,
    PairCodeInvalid,
    AgentTokenRequired,
    InvalidAgent,
    InvalidSource,
    MediaRootUnavailable,
    SourceRootUnavailable,
    OutsideMediaRoot,
    InvalidSourceUrl,
    SourceScanFailed,
    TooManyPlaybackSessions,
    MediaQueueFull,
    PlaybackRequestConflict,
    PlaybackRequestInProgress,
    PlaybackRequestInterrupted,
    PlaybackRequestExpired,
    PlaybackRequestRetryExhausted,
    PlaybackRequestCancelled,
    StaleMedia,
    InvalidPosition,
    InvalidRate,
    NoMedia,
    InvalidMode,
    UnsupportedVideoOrHdr,
    UpstreamPlaybackFailed,
    NoMediaSource,
    InvalidUpstreamBase,
    UpstreamNoCompatibleStream,
    SourceProbeFailed,
    SourceChanged,
    SourceVersionRequired,
    InvalidAudioTrack,
    DeviceHasNoCompatiblePlaybackTransport,
    UpstreamDeviceProfileRequired,
    ProtocolVersion,
    RoomMismatch,
    RevisionConflict,
    CommandOwnedByAnotherUser,
    CommandPayloadConflict,
    CommandReplayUnverifiable,
    ControlEpochRequired,
    ControlEpochExpired,
    DatabaseError,
    CommitFailed,
    RoomBusy,
    MediaNotFound,
    MediaUnavailable,
    InvalidPlaybackSession,
    ProbeBusy,
    InvalidSubtitle,
    CrossOriginSubtitle,
    InvalidResource,
    MediaJobFailed,
    CacheCapacityExceeded,
    CacheReadOnly,
    CachePermissionDenied,
    MediaJobCancelled,
    MediaJobRetryExhausted,
    InvalidResourceSignature,
    WrongResourceSession,
    CrossOriginMediaRejected,
    UpstreamMediaError,
    ManifestTooLarge,
    AgentOffline,
    AgentTimeout,
    InvalidTransfer,
    TransferExpired,
}

impl ErrorCode {
    pub fn from_status(status: u16) -> Self {
        match status {
            401 => Self::LoginRequired,
            403 => Self::Forbidden,
            404 => Self::NotFound,
            405 => Self::MethodNotAllowed,
            408 | 504 => Self::RequestTimeout,
            409 => Self::RevisionConflict,
            410 => Self::SessionExpired,
            413 => Self::PayloadTooLarge,
            415 => Self::UnsupportedMediaType,
            416 => Self::RangeNotSatisfiable,
            429 => Self::RateLimited,
            502 => Self::UpstreamFailed,
            503 => Self::ServiceUnavailable,
            400..=499 => Self::InvalidRequest,
            _ => Self::InternalError,
        }
    }

    pub fn from_reason(reason: &str, status: u16) -> Self {
        match reason {
            "wrong_room" => Self::RoomMismatch,
            "try_later" => Self::RateLimited,
            _ => serde_json::from_value(serde_json::Value::String(reason.to_ascii_uppercase()))
                .unwrap_or_else(|_| Self::from_status(status)),
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::PlaybackRequestInProgress
                | Self::MediaQueueFull
                | Self::PlaybackRequestInterrupted
                | Self::RateLimited
                | Self::RoomBusy
                | Self::ProbeBusy
                | Self::ServiceUnavailable
                | Self::RequestTimeout
                | Self::UpstreamFailed
                | Self::SourceScanFailed
                | Self::SourceProbeFailed
                | Self::UpstreamPlaybackFailed
                | Self::MediaUnavailable
                | Self::AgentOffline
                | Self::AgentTimeout
        )
    }

    fn message(self) -> &'static str {
        match self {
            Self::SourceChanged => "源文件已变化，请重新连接 NAS Agent 更新索引后重新播放",
            Self::SourceVersionRequired => {
                "NAS Agent 缺少文件版本信息，请升级 Agent 并重新连接以更新索引"
            }
            Self::MediaQueueFull => "媒体处理队列已满，请稍后使用相同请求编号重试",
            Self::CacheCapacityExceeded => "媒体缓存空间不足，请联系管理员清理后重新发起播放",
            Self::CacheReadOnly => "媒体缓存为只读，请联系管理员调整挂载后重新发起播放",
            Self::CachePermissionDenied => {
                "媒体缓存没有写入权限，请联系管理员修复权限后重新发起播放"
            }
            Self::MediaJobCancelled => "媒体处理已取消，请重新加载当前播放",
            Self::MediaJobRetryExhausted => "媒体处理重试次数已用尽，请检查服务后重新发起播放",
            Self::PlaybackRequestConflict => "播放请求编号已用于不同参数，请为新的操作使用新编号",
            Self::PlaybackRequestInProgress => "播放方案正在准备，请使用相同请求编号稍后查询",
            Self::PlaybackRequestInterrupted => "播放准备已中断，可使用相同请求编号重试",
            Self::PlaybackRequestRetryExhausted => "播放准备重试次数已用尽，请检查片源后重新操作",
            Self::PlaybackRequestCancelled => "此播放请求已取消，请重新发起播放操作",
            Self::PlaybackRequestExpired => "原播放请求或会话已结束，请重新发起播放操作",
            Self::LoginRequired | Self::SessionExpired | Self::InvalidPlaybackSession => {
                "会话已失效，请重新登录或重新加载播放"
            }
            Self::InvalidName => "房间名不能为空，且不能超过 120 个字符",
            Self::InvalidCredentials => "用户名或密码不正确",
            Self::Forbidden
            | Self::NotAMember
            | Self::AdminRequired
            | Self::ControllerRequired
            | Self::OriginRejected
            | Self::CsrfRejected
            | Self::CommandOwnedByAnotherUser => "没有执行此操作的权限",
            Self::RevisionConflict | Self::StaleMedia | Self::RoomMismatch => {
                "房间状态已改变，请同步最新状态后重试"
            }
            Self::CommandPayloadConflict => "命令编号已用于其他请求，请同步状态后重新操作",
            Self::CommandReplayUnverifiable => "旧命令无法验证，请同步状态后重新操作",
            Self::ControlEpochRequired | Self::ControlEpochExpired => {
                "控制凭据需要更新，请同步房间后重新操作；旧命令不会自动重试"
            }
            Self::RoomBusy | Self::ProbeBusy | Self::ServiceUnavailable => {
                "服务资源正忙，请稍后重试"
            }
            Self::RateLimited | Self::TooManyPlaybackSessions => "请求或播放会话过多，请稍后重试",
            Self::UnsupportedVideoOrHdr => "此视频或 HDR 格式暂不支持",
            Self::DeviceHasNoCompatiblePlaybackTransport
            | Self::UpstreamNoCompatibleStream
            | Self::UpstreamDeviceProfileRequired => "设备没有兼容的播放方式",
            Self::InvalidAudioTrack => "所选音轨不可用",
            Self::NoMedia => "请先选择影片",
            Self::NotFound | Self::MediaNotFound | Self::NoMediaSource => {
                "请求的资源不存在或不可用"
            }
            Self::RangeNotSatisfiable => "请求的字节范围超出资源长度",
            Self::AgentOffline => "NAS Agent 当前离线",
            Self::AgentTimeout | Self::RequestTimeout => "等待服务响应超时，请稍后重试",
            Self::UpstreamFailed
            | Self::UpstreamMediaError
            | Self::SourceScanFailed
            | Self::SourceProbeFailed
            | Self::UpstreamPlaybackFailed
            | Self::MediaUnavailable => "媒体源暂时不可用，请稍后重试",
            Self::MediaJobFailed => "媒体处理失败，请重新加载或联系管理员",
            Self::InternalError | Self::DatabaseError | Self::CommitFailed => {
                "操作未能完成，请保留诊断编号并联系管理员"
            }
            Self::ProtocolVersion => "客户端协议版本不受支持，请刷新客户端",
            Self::PayloadTooLarge => "请求内容过大",
            Self::MethodNotAllowed => "此接口不支持该操作",
            Self::UnsupportedMediaType => "请求内容类型不受支持",
            _ => "请求参数或资源授权无效，请检查后重试",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub retry_after_ms: Option<u32>,
    pub request_id: Uuid,
}

impl ApiError {
    pub fn new(code: ErrorCode, request_id: Uuid) -> Self {
        Self {
            code,
            message: code.message().into(),
            retryable: code.retryable(),
            retry_after_ms: None,
            request_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ErrorResponse {
    pub error: ApiError,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_exposes_arbitrary_internal_text_or_invents_retry_delays() {
        let secret = "https://private.invalid/?token=secret /home/private/media.mkv";
        let response = ErrorResponse {
            error: ApiError::new(ErrorCode::from_reason(secret, 500), Uuid::nil()),
        };
        let wire = serde_json::to_string(&response).unwrap();
        assert!(!wire.contains("secret"));
        assert!(!wire.contains("retry_after_ms"));
        assert!(!response.error.retryable);
        assert_eq!(response.error.code, ErrorCode::InternalError);
    }
    #[test]
    fn authorization_and_conflict_require_action_not_blind_retry() {
        for code in [
            ErrorCode::SessionExpired,
            ErrorCode::Forbidden,
            ErrorCode::StaleMedia,
            ErrorCode::RevisionConflict,
            ErrorCode::CommandPayloadConflict,
            ErrorCode::CommitFailed,
        ] {
            assert!(!ApiError::new(code, Uuid::nil()).retryable);
        }
        assert!(ApiError::new(ErrorCode::AgentTimeout, Uuid::nil()).retryable);
    }
}
