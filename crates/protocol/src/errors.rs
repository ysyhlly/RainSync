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
    UsernameTaken,
    AlreadyAuthenticated,
    AvatarInvalid,
    AvatarTooLarge,
    AvatarVersionConflict,
    AvatarOperationConflict,
    AvatarProcessingFailed,
    AvatarProcessingTimeout,
    RegistrationInviteInvalid,
    RegistrationInviteAlreadyUsed,
    RegistrationBatchConflict,
    RegistrationBatchAlreadyCreated,
    InvalidInvite,
    RoomFull,
    RoomNotActive,
    RoomLifecycleConflict,
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
    UnsupportedObservationVersion,
    ObservationVersionRequired,
    InvalidObservation,
    InvalidObservationSequence,
    ObservationSequenceStale,
    ObservationConflict,
    InvalidObservationPosition,
    InvalidObservationRate,
    ObservationNotComplete,
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
    StaleCapabilityReport,
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
    MediaTitleInvalid,
    MediaTitleConflict,
    MediaPreviewStale,
    MediaPreviewQueueFull,
    MediaPreviewUnavailable,
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
                | Self::AvatarProcessingFailed
                | Self::AvatarProcessingTimeout
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
            Self::UnsupportedObservationVersion => "播放观测协议版本不受支持，请更新客户端",
            Self::ObservationVersionRequired => "此会话未启用播放观测，请重新准备播放",
            Self::InvalidObservation => "播放观测格式无效，请检查客户端",
            Self::InvalidObservationSequence => "播放观测序号无效，请检查客户端",
            Self::ObservationSequenceStale => "播放观测已过时，请发送新的实际播放样本",
            Self::ObservationConflict => "此观测序号已用于其他播放样本，请使用新序号",
            Self::InvalidObservationPosition => "播放观测超出此会话授权的时间范围",
            Self::InvalidObservationRate => "实际播放倍速超出支持范围",
            Self::ObservationNotComplete => "媒体尚未完整生成，不能报告自然播放结束",
            Self::MediaTitleInvalid => "名称需为 1—200 个字符，不能包含换行或控制字符",
            Self::MediaTitleConflict => "名称已被其他操作修改，请核对最新名称后再次保存",
            Self::MediaPreviewStale => "预览版本已更新，请刷新媒体资料",
            Self::MediaPreviewQueueFull => "预览队列已满，请稍后重试",
            Self::MediaPreviewUnavailable => "暂无法生成预览",
            Self::SourceChanged => "源文件已变化，请重新扫描片源后重新发起播放",
            Self::StaleCapabilityReport => "播放能力报告已过期或片源已改变，请重新检测后加载",
            Self::RoomNotActive => "房间已关闭或正在清理，请刷新房间状态",
            Self::RoomLifecycleConflict => "房间生命周期已改变，请刷新后重试",
            Self::SourceVersionRequired => {
                "NAS 索引缺少文件版本，请管理员升级 NAS Agent 并重新连接或扫描片源，完成后重新发起播放"
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
            Self::UsernameTaken => "登录账号已被使用，请选择其他账号",
            Self::AlreadyAuthenticated => "当前已有登录账号，请先确认当前身份",
            Self::AvatarInvalid => "头像必须为有效的 512×512 静态 PNG 图片",
            Self::AvatarTooLarge => "头像文件超过允许大小，请重新裁剪后保存",
            Self::AvatarVersionConflict => "头像已在其他操作中更新，请刷新资料后再保存",
            Self::AvatarOperationConflict => "此头像操作编号已用于不同内容，请重新确认操作",
            Self::AvatarProcessingFailed => "头像处理暂时不可用，原头像未更改",
            Self::AvatarProcessingTimeout => "头像处理超时，原头像未更改",
            Self::RegistrationInviteInvalid => "邀请码无效或已失效，请检查后重试或联系管理员",
            Self::RegistrationInviteAlreadyUsed => "邀请码已用于注册，不能撤销",
            Self::RegistrationBatchConflict => "批次编号已用于其他请求，请核对生成记录",
            Self::RegistrationBatchAlreadyCreated => {
                "此批次已生成，请查询记录；完整邀请码无法重新显示"
            }
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
    fn observation_rejections_have_specific_public_codes_and_require_new_action() {
        for (reason, status, expected) in [
            (
                "unsupported_observation_version",
                400,
                ErrorCode::UnsupportedObservationVersion,
            ),
            (
                "observation_version_required",
                400,
                ErrorCode::ObservationVersionRequired,
            ),
            ("invalid_observation", 400, ErrorCode::InvalidObservation),
            (
                "invalid_observation_sequence",
                400,
                ErrorCode::InvalidObservationSequence,
            ),
            (
                "observation_sequence_stale",
                409,
                ErrorCode::ObservationSequenceStale,
            ),
            ("observation_conflict", 409, ErrorCode::ObservationConflict),
            (
                "invalid_observation_position",
                400,
                ErrorCode::InvalidObservationPosition,
            ),
            (
                "invalid_observation_rate",
                400,
                ErrorCode::InvalidObservationRate,
            ),
            (
                "observation_not_complete",
                400,
                ErrorCode::ObservationNotComplete,
            ),
        ] {
            let response = ErrorResponse {
                error: ApiError::new(ErrorCode::from_reason(reason, status), Uuid::nil()),
            };
            assert_eq!(response.error.code, expected);
            assert!(!response.error.retryable);
            assert!(!response.error.message.is_empty());
            assert!(!response.error.message.contains(reason));
            assert!(response.error.retry_after_ms.is_none());
            let wire = serde_json::to_value(&response).unwrap();
            assert_eq!(wire["error"]["code"], reason.to_ascii_uppercase());
        }
    }
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
            ErrorCode::SourceChanged,
            ErrorCode::SourceVersionRequired,
        ] {
            assert!(!ApiError::new(code, Uuid::nil()).retryable);
        }
        assert!(ApiError::new(ErrorCode::AgentTimeout, Uuid::nil()).retryable);
    }
}
