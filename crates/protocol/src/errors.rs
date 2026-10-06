use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Public codes are an allowlist. Raw framework, database and upstream errors
/// must never be copied into the wire response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    AccountInactive,
    AccountOwnershipRequired,
    AccountLastAdmin,
    DistributedPlaybackIntentRequired,
    InvalidDistributedPlaybackIntent,
    DedicatedDistributedEndpointRequired,
    DistributedOutputNotQualified,
    DistributedAudioSelectionChanged,
    ComputeAudioTrackUnavailable,
    ComputeVerificationInterrupted,
    ComputeQualificationRejected,
    ComputeQualificationBindingChanged,
    ComputeServerOutputRejected,
    ComputeOutputReportMismatch,
    ComputeVerificationAlreadyOwned,
    InvalidComputeDrainReceipt,
    ComputeDrainReceiptNotOwned,
    NasComputeDisabled,
    InvalidComputePolicy,
    InvalidComputeCapability,
    ComputeNotAuthorized,
    InvalidComputeSource,
    ComputeSourceChanged,
    InvalidComputeRecipe,
    ComputeRoomQueueFull,
    ComputeSourceNotReady,
    ComputeNodeUnhealthy,
    ComputeLeaseLost,
    ComputeFenceRequired,
    InvalidComputeArtifact,
    ComputeArtifactHashMismatch,
    ComputeArtifactImmutable,
    ComputeOutputBudgetExceeded,
    ComputeGlobalBudgetExceeded,
    InvalidComputeManifest,
    IncompleteComputeArtifact,
    UnreferencedComputeArtifact,
    ComputeArtifactChanged,
    ComputeOutputNotFound,
    ComputeJobNotFound,
    ComputeOutputNotReady,
    P2pDisabled,
    P2pConsentRequired,
    P2pScopeChanged,
    P2pPeerExpired,
    InvalidP2pSignal,
    P2pSignalBudgetExceeded,
    P2pTargetUnavailable,
    P2pRoomPeerBudgetExceeded,
    PrivateLibrariesDisabled,
    LibraryInvalid,
    LibraryNotFound,
    LibraryLimit,
    LibrarySourceLimit,
    LibraryConflict,
    LibraryOwnerRequired,
    SourceAlreadyAttached,
    S3SourceRequired,
    S3ScanFailed,
    SourceScanBusy,
    SourceNotFound,
    UserNotFound,
    ChatMuted,
    ChatRateLimited,
    ChatModeratorRequired,
    ChatModerationInvalid,
    ChatTargetProtected,
    ChatMessageNotFound,
    TimelineMediaUnavailable,
    TimelineClockStale,
    TimelineCursorInvalid,
    TimelineActivityNotFound,
    TimelineCursorExpired,
    TimelineCommentInvalid,
    TimelineMessageConflict,
    TimelineActivityUnavailable,
    TimelineActivityStale,
    TimelinePositionInvalid,
    ReactionInvalid,
    ReactionConflict,
    ReactionRateLimited,
    PluginRevisionInvalid,
    PluginManifestOrPermissionsInvalid,
    PluginRevisionConflict,
    PluginNotFound,
    PluginNoRollback,
    PluginRollbackInvalid,
    PluginMediaChanged,
    PlatformCollectionRestricted,
    PlatformCollectionProviderUnavailable,
    PlatformCollectionCleanupFailed,
    PlatformCollectionItemsUnavailable,
    PlatformImportUnavailable,
    PlatformImportPlatformRestricted,
    PlatformImportInvalid,
    PlatformImportCancelled,
    PlatformCollectionChanged,
    PlatformCollectionInvalid,
    PlatformCollectionUnsupported,
    PlatformCollectionSingleRequired,
    PlatformImportLimit,
    PlatformImportDeadline,
    NativePlatformTextInvalid,
    NativePlatformTextUnavailable,
    NativePlatformTextTimeout,
    NativePlatformTextUnsupported,
    NativePlatformSubtitleLoginRequired,
    NativePlatformSubtitleUnavailable,
    NativePlatformDanmakuUnsupported,
    NativePlatformDanmakuTimeInvalid,
    NativePlatformCaptionMetadataUnavailable,
    NativePlatformCaptionFormatUnsupported,
    NativePlatformCaptionOriginUnsupported,
    NativePlatformCaptionSigningRequired,
    NativeLiveDanmakuClientIdConsentRequired,
    NativeLiveDanmakuLoginRequired,
    NativeLiveDanmakuAuthDenied,
    NativeLiveDanmakuProtocolUnsupported,
    NativeLiveDanmakuHeartbeatTimeout,
    NativeLiveDanmakuOutputLimit,
    NativeLiveDanmakuClosed,
    NativeLiveClientUnsupported,
    NativeLiveBroadcastChanged,
    NativeLiveNotBroadcasting,
    NativeLiveRateLimited,
    NativeLiveCapacity,
    NativeLivePlaylistChanged,
    NativeLiveWindowExpired,
    NativeLiveSeekUnsupported,
    NativeLiveRateUnsupported,
    NativeLiveEndUnsupported,
    NativeLiveStateChanged,
    NativePlatformInvalid,
    NativePlatformInvalidResponse,
    NativePlatformEntryChanged,
    NativePlatformIntentRequired,
    NativePlatformInvalidIntent,
    NativePlatformAccessDenied,
    NativePlatformProviderUnavailable,
    NativePlatformAnonymousUnsupported,
    NativePlatformDeviceUnsupported,
    NativePlatformResolveFailed,
    NativePlatformResolveTimeout,
    NativePlatformUrlExpired,
    NativePlatformCodecUnsupported,
    NativePlatformCompatibilitySourceUnsupported,
    NativePlatformProgressiveUnsupported,
    NativePlatformDeliveryInvalid,
    NativePlatformRangeInvalid,
    PlatformAccountChanged,
    PlatformCredentialInvalid,
    PlatformLoginChanged,
    PlatformLoginExpired,
    PlatformLoginInProgress,
    PlatformLoginRequestConflict,
    PlatformLoginRequestInvalid,
    PlatformLoginRequestNotFound,
    PlatformLoginUpstreamFailed,
    PlatformStorageConsentRequired,
    PlatformPlanRefreshRequired,
    DedicatedPlatformEndpointRequired,
    InvalidRequest,
    UnsupportedPlaybackMetricsVersion,
    InvalidPlaybackMetrics,
    PlaybackMetricsNotNegotiated,
    StalePlaybackMetrics,
    PlaybackMetricsSequenceStale,
    PlaybackMetricsConflict,
    PlaybackMetricsClosed,
    PlaybackMetricsTimeInvalid,
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
    SourceInUse,
    SourceManagedElsewhere,
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
    InvalidPlanGeneration,
    PlaybackViewerLimitExceeded,
    PlaybackViewerOriginRequired,
    StalePlaybackPlan,
    InvalidPosition,
    InvalidRate,
    NoMedia,
    InvalidMode,
    UnsupportedVideoOrHdr,
    HdrUnsupported,
    DrmUnsupported,
    UnsupportedTimeline,
    UpstreamPlaybackFailed,
    UpstreamPolicyDenied,
    UpstreamPolicyChanged,
    UpstreamPolicyUnavailable,
    NoMediaSource,
    InvalidUpstreamBase,
    UpstreamNoCompatibleStream,
    SourceProbeFailed,
    SourceChanged,
    SourceVersionRequired,
    SourceSeekUnsupported,
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
    MediaInputInvalid,
    MediaInputDenied,
    MediaDecoderUnavailable,
    MediaEncoderUnavailable,
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
            "idempotency_key_conflict" => Self::InvalidRequest,
            "wrong_room" => Self::RoomMismatch,
            "try_later" => Self::RateLimited,
            "legacy_stream_mapping_unsupported" => Self::UnsupportedVideoOrHdr,
            "advanced_local_source_required"
            | "local_hls_ladder_source_required"
            | "local_hls_ladder_source_unsupported"
            | "local_hls_ladder_duration_required" => Self::UnsupportedVideoOrHdr,
            "local_hls_ladder_advanced_incompatible"
            | "dedicated_local_hls_ladder_endpoint_required" => Self::InvalidRequest,
            "dedicated_advanced_endpoint_required" => Self::InvalidRequest,
            "invalid_subtitle_track" => Self::InvalidSubtitle,
            _ => serde_json::from_value(serde_json::Value::String(reason.to_ascii_uppercase()))
                .unwrap_or_else(|_| Self::from_status(status)),
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::ComputeRoomQueueFull
                | Self::ComputeOutputNotReady
                | Self::P2pSignalBudgetExceeded
                | Self::P2pRoomPeerBudgetExceeded
                | Self::S3ScanFailed
                | Self::SourceScanBusy
                | Self::ChatRateLimited
                | Self::ReactionRateLimited
                | Self::PlatformImportDeadline
                | Self::PlatformImportUnavailable
                | Self::PlatformCollectionProviderUnavailable
                | Self::NativeLiveRateLimited
                | Self::NativeLiveCapacity
                | Self::PlaybackRequestInProgress
                | Self::PlatformLoginInProgress
                | Self::PlatformLoginUpstreamFailed
                | Self::NativePlatformResolveFailed
                | Self::NativePlatformResolveTimeout
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
                | Self::UpstreamPolicyUnavailable
                | Self::MediaUnavailable
                | Self::AgentOffline
                | Self::AgentTimeout
        )
    }

    fn message(self) -> &'static str {
        match self {
            Self::InvalidComputeDrainReceipt => "计算资源释放回执无效",
            Self::ComputeDrainReceiptNotOwned => "不能确认不属于此节点的计算尝试",

            Self::NasComputeDisabled => "服务器尚未启用 NAS 本地计算",
            Self::InvalidComputePolicy => "计算授权参数无效",
            Self::InvalidComputeCapability => "节点计算能力报告无效",
            Self::ComputeNotAuthorized => "此设备尚未获得计算授权",
            Self::InvalidComputeSource => "计算片源身份无效",
            Self::ComputeSourceChanged => "片源已变化，请重新索引",
            Self::InvalidComputeRecipe => "计算配方不受支持",
            Self::ComputeRoomQueueFull => "房间计算队列已满，请稍后重试",
            Self::ComputeSourceNotReady => "NAS 片源尚未完成内容校验",
            Self::ComputeNodeUnhealthy => "节点计算心跳已失效",
            Self::ComputeLeaseLost => "计算任务所有权已失效",
            Self::ComputeFenceRequired => "计算任务授权信息不完整",
            Self::InvalidComputeArtifact => "计算产物无效",
            Self::ComputeArtifactHashMismatch => "计算产物完整性校验失败",
            Self::ComputeArtifactImmutable => "已发布的分片不能覆盖",
            Self::ComputeOutputBudgetExceeded => "计算产物超过节点配额",
            Self::ComputeGlobalBudgetExceeded => "计算产物存储空间不足",
            Self::InvalidComputeManifest => "HLS 产物清单无效",
            Self::IncompleteComputeArtifact => "计算产物尚未完整",
            Self::UnreferencedComputeArtifact => "计算产物与清单不一致",
            Self::ComputeArtifactChanged => "计算产物已变化，请重新生成",
            Self::ComputeOutputNotFound => "计算产物不可用",
            Self::ComputeJobNotFound => "计算任务不可用",
            Self::DistributedPlaybackIntentRequired => "请显式选择合格的 NAS 主播放产物",
            Self::InvalidDistributedPlaybackIntent => "NAS 主播放请求不受支持，请重新选择产物",
            Self::DedicatedDistributedEndpointRequired => "NAS 主播放需要专用接口，请更新客户端",
            Self::DistributedOutputNotQualified => {
                "NAS 产物未通过资格校验、已过期或授权已变化，请重新生成"
            }
            Self::DistributedAudioSelectionChanged => {
                "当前原片音轨与产物不同，请按当前音轨重新生成"
            }
            Self::ComputeAudioTrackUnavailable => "所选原片音轨不可用，请刷新片源信息",
            Self::ComputeVerificationInterrupted => "NAS 产物校验已中断，请查看任务状态",
            Self::ComputeQualificationRejected => "原片时间轴、音轨或编码不能安全用于 NAS 主播放",
            Self::ComputeQualificationBindingChanged => "NAS 原片版本、音轨或计算代次已变化",
            Self::ComputeServerOutputRejected => "服务器未通过 NAS 产物独立解码与时间轴校验",
            Self::ComputeOutputReportMismatch => "NAS 输出报告与服务器独立测量不一致",
            Self::ComputeVerificationAlreadyOwned => "此计算代次已开始服务器校验，请等待原任务结果",
            Self::ComputeOutputNotReady => "计算产物尚未就绪，请查看任务进度",
            Self::P2pDisabled => "服务器尚未启用 P2P 实验",
            Self::P2pConsentRequired => "启用前请确认上传和网络地址披露",
            Self::P2pScopeChanged => "房间或产物授权已变化",
            Self::P2pPeerExpired => "P2P 参与授权已到期",
            Self::InvalidP2pSignal => "P2P 连接消息无效",
            Self::P2pSignalBudgetExceeded => "P2P 连接消息过于频繁，请稍后重试",
            Self::P2pTargetUnavailable => "P2P 参与者不可用",
            Self::P2pRoomPeerBudgetExceeded => "房间 P2P 参与者已达上限",

            Self::PrivateLibrariesDisabled => "私人库创建与分享未开启，请联系管理员",
            Self::LibraryInvalid => "媒体库字段或期限无效，请检查后重试",
            Self::LibraryNotFound => "媒体库不存在或当前账号无权访问",
            Self::LibraryLimit => "本人的私人库数量已达上限",
            Self::LibrarySourceLimit => "当前媒体库的片源数量已达上限",
            Self::LibraryConflict => "媒体库权限或资料已变化，请核对最新版本后再提交",
            Self::LibraryOwnerRequired => "此操作仅限媒体库所有者",
            Self::SourceAlreadyAttached => "此片源已属于当前媒体库",
            Self::S3SourceRequired => "此片源类型不支持私人库索引入口",
            Self::S3ScanFailed => "S3 本页读取失败，已保存扫描进度，可以继续",
            Self::SourceScanBusy => "索引扫描正忙，请稍后重试",
            Self::SourceNotFound => "片源不存在或当前账号无权访问",
            Self::UserNotFound => "目标用户不存在",

            Self::ChatMuted => "你在此房间的禁言尚未结束",
            Self::ChatRateLimited => "聊天发送过快，请稍后重试",
            Self::ChatModeratorRequired => "此操作需要房主、管理员或获授权的聊天管理员",
            Self::ChatModerationInvalid => "聊天管理操作或原因不完整，请检查后重试",
            Self::ChatTargetProtected => "此成员是受保护的所有者、控制者或管理员，无法执行此操作",
            Self::ChatMessageNotFound => "此聊天消息已不存在",
            Self::TimelineMediaUnavailable => "此评论场次的媒体已不可用，请重新选择影片",
            Self::TimelineClockStale => "房间时钟尚未完成恢复，请同步状态后再评论",
            Self::TimelineCursorInvalid => "时间轴评论分页游标无效",
            Self::TimelineActivityNotFound => "此观影场次不存在或不属于当前房间",
            Self::TimelineCursorExpired => "历史评论分页已过期，请重新刷新",
            Self::TimelineCommentInvalid => "评论正文或时间锚点无效，请检查后重试",
            Self::TimelineMessageConflict => "此发送编号已绑定不同内容，请放弃旧请求后重新发送",
            Self::TimelineActivityUnavailable => "当前没有可评论的点播场次",
            Self::TimelineActivityStale => "共同观影场次已变化，请重新选择评论位置",
            Self::TimelinePositionInvalid => "评论位置超出当前影片范围",
            Self::ReactionInvalid => "此表情不在当前允许的固定表情集中",
            Self::ReactionConflict => "此表情编号已用于不同请求",
            Self::ReactionRateLimited => "表情发送过快，每秒最多2次，请稍后重试",
            Self::PluginRevisionInvalid => "插件配置修订号无效，请重新读取状态",
            Self::PluginManifestOrPermissionsInvalid => "插件版本、配置或权限不在当前受控目录中",
            Self::PluginRevisionConflict => "插件配置已被更新，请刷新后确认修改",
            Self::PluginNotFound => "此插件不在当前受控目录或尚未安装",
            Self::PluginNoRollback => "此插件没有可回退的配置",
            Self::PluginRollbackInvalid => "上一次插件配置无法通过当前目录校验，已停止回退",
            Self::PluginMediaChanged => "影片信息或访问权限已变化，请重新读取元数据",

            Self::PlatformCollectionRestricted => "平台拒绝展开此合集，请检查自己的平台访问权限",
            Self::PlatformCollectionProviderUnavailable => "此平台的合集解析器未启用或暂不可用",
            Self::PlatformCollectionCleanupFailed => "合集解析器未能确认停止，当前操作已停止",
            Self::PlatformCollectionItemsUnavailable => {
                "合集未提供可核对的视频条目，请使用单独视频链接"
            }
            Self::PlatformImportUnavailable => "平台导入暂不可用，请稍后重新预览",
            Self::PlatformImportPlatformRestricted => "平台拒绝访问部分待导入条目",
            Self::PlatformImportInvalid => "平台导入条目无法安全解析",
            Self::PlatformImportCancelled => "本次平台导入已取消",
            Self::PlatformCollectionChanged => {
                "合集或账号、登录快照已变化或过期，请重新预览；不要重放旧分页令牌"
            }
            Self::PlatformCollectionInvalid => "合集或播放列表链接无效，请使用受支持的完整链接",
            Self::PlatformCollectionUnsupported => "此类合集或播放列表暂不支持，请粘贴单独视频链接",
            Self::PlatformCollectionSingleRequired => "一次只能展开一个合集或播放列表",
            Self::PlatformImportLimit => "本次合集预览或导入数量超出安全上限",
            Self::PlatformImportDeadline => "合集预览或导入超时，请重新预览后重试未导入条目",
            Self::NativePlatformTextInvalid => "平台字幕或弹幕数据无法安全解析",
            Self::NativePlatformTextUnavailable => "平台字幕或弹幕当前不可用",
            Self::NativePlatformTextTimeout => "平台字幕或弹幕请求超时",
            Self::NativePlatformTextUnsupported => "此媒体没有已核对的平台字幕或弹幕接口",
            Self::NativePlatformSubtitleLoginRequired => "平台字幕需要自己的有效平台账号",
            Self::NativePlatformSubtitleUnavailable => "所选平台字幕已不可用，请重新加载字幕列表",
            Self::NativePlatformDanmakuUnsupported => "此平台暂未提供已核对的原站弹幕接口",
            Self::NativePlatformDanmakuTimeInvalid => "原站弹幕时间超出当前影片范围",
            Self::NativePlatformCaptionMetadataUnavailable => {
                "平台未提供可核对的字幕元数据，未假定此影片没有字幕"
            }
            Self::NativePlatformCaptionFormatUnsupported => "平台提供的字幕格式暂不支持",
            Self::NativePlatformCaptionOriginUnsupported => "平台字幕地址超出已核对的安全范围",
            Self::NativePlatformCaptionSigningRequired => {
                "平台字幕需要额外签名或验证，当前请求已停止"
            }
            Self::NativeLiveDanmakuClientIdConsentRequired => {
                "开启实时弹幕前需要同意获取本次播放的临时客户端标识"
            }
            Self::NativeLiveDanmakuLoginRequired => "实时弹幕需要自己的有效平台账号",
            Self::NativeLiveDanmakuAuthDenied => "平台拒绝实时弹幕连接，未切换账号或重试验证",
            Self::NativeLiveDanmakuProtocolUnsupported => "平台实时弹幕协议超出当前已核对范围",
            Self::NativeLiveDanmakuHeartbeatTimeout => "实时弹幕连接未回应心跳，连接已停止",
            Self::NativeLiveDanmakuOutputLimit => "实时弹幕输出达到本次播放的安全上限",
            Self::NativeLiveDanmakuClosed => "实时弹幕连接已结束，可重新选择开启",
            Self::NativeLiveClientUnsupported => "当前客户端未启用直播边缘与控制同步，请更新客户端",
            Self::NativeLiveBroadcastChanged => "直播场次已变化，请重新预览并导入此直播间",
            Self::NativeLiveNotBroadcasting => "此直播场次已结束或尚未开播，请选择其他媒体",
            Self::NativeLiveRateLimited => "直播平台请求过于频繁，请稍后重试",
            Self::NativeLiveCapacity => "直播播放服务正忙，请稍后重试",
            Self::NativeLiveWindowExpired => "直播滚动窗口已过期，请重新加载当前场次",
            Self::NativeLivePlaylistChanged => "直播播放列表已变化，请重新加载当前场次",
            Self::NativeLiveSeekUnsupported => "直播不支持房间进度跳转",
            Self::NativeLiveRateUnsupported => "直播仅支持 1 倍速",
            Self::NativeLiveEndUnsupported => "直播不会自动结束或切换下一项，请手动选择媒体",
            Self::NativeLiveStateChanged => "直播身份已变化，请重新加载当前媒体",
            Self::NativePlatformInvalid
            | Self::NativePlatformIntentRequired
            | Self::NativePlatformInvalidIntent
            | Self::DedicatedPlatformEndpointRequired => {
                "请通过平台影片入口添加并播放受支持的完整视频链接"
            }
            Self::NativePlatformProviderUnavailable => {
                "此平台解析器尚未启用或必要运行组件不可用，请联系服务管理员"
            }
            Self::NativePlatformAnonymousUnsupported => {
                "此视频无法通过当前匿名接入解析，可能需要平台登录或尚未支持的签名方式"
            }
            Self::NativePlatformEntryChanged => "平台影片信息已变化，请重新确认片源",
            Self::NativePlatformAccessDenied => {
                "平台未授权访问此视频，请检查平台登录状态和视频权限"
            }
            Self::NativePlatformDeviceUnsupported | Self::NativePlatformCodecUnsupported => {
                "当前设备或媒体编码不支持此平台播放方式"
            }
            Self::NativePlatformCompatibilitySourceUnsupported => {
                "此平台片源无法安全核对完整媒体身份，暂不支持兼容转码；平台权限和有效期仍适用"
            }
            Self::NativePlatformProgressiveUnsupported => {
                "该视频未提供本版本支持的 AVC/AAC DASH 流"
            }
            Self::NativePlatformResolveFailed
            | Self::NativePlatformInvalidResponse
            | Self::PlatformLoginUpstreamFailed => "平台服务暂时不可用，请稍后重试",
            Self::NativePlatformResolveTimeout => "等待平台解析超时，请稍后重试",
            Self::NativePlatformUrlExpired | Self::PlatformPlanRefreshRequired => {
                "平台播放地址已到期，请重新加载以取得新的播放方案"
            }
            Self::NativePlatformDeliveryInvalid => "平台媒体响应不符合播放要求，请重新加载",
            Self::NativePlatformRangeInvalid => "平台媒体只支持有效的单一字节范围请求",
            Self::PlatformAccountChanged => "平台账号状态已变化，请重新加载影片",
            Self::PlatformCredentialInvalid => "平台登录信息不可用，请解除绑定后重新登录平台",
            Self::PlatformLoginChanged
            | Self::PlatformLoginExpired
            | Self::PlatformLoginRequestNotFound => {
                "本次平台扫码登录已失效，请重新开始；RainSync 登录不受影响"
            }
            Self::PlatformLoginInProgress => "平台登录操作正在处理中，请稍候",
            Self::PlatformLoginRequestConflict | Self::PlatformLoginRequestInvalid => {
                "平台登录请求已变化或无效，请重新开始"
            }
            Self::PlatformStorageConsentRequired => {
                "请先确认将平台登录信息保存在当前 RainSync 服务端"
            }
            Self::HdrUnsupported => {
                "此片源含 HDR 视频，当前不支持 HDR 播放或 HDR 转 SDR；请使用 SDR 版本"
            }
            Self::DrmUnsupported => "此片源含加密或受保护的媒体轨道，当前不支持此类播放",
            Self::UnsupportedPlaybackMetricsVersion => "播放指标协议版本不受支持",
            Self::InvalidPlaybackMetrics => "播放指标格式或范围无效",
            Self::PlaybackMetricsNotNegotiated => "此播放会话未启用独立指标采集",
            Self::StalePlaybackMetrics => "此播放指标已被新的会话或意图替代",
            Self::PlaybackMetricsSequenceStale => "播放指标采样序号已过期",
            Self::PlaybackMetricsConflict => "播放指标与已接收的累计采样冲突",
            Self::PlaybackMetricsClosed => "此播放指标采集已结束",
            Self::PlaybackMetricsTimeInvalid => "无法确认播放指标的时间范围",
            Self::UpstreamPolicyChanged => "上游账户授权已变化，请重新准备播放",
            Self::UpstreamPolicyDenied => "片源绑定的上游账户已禁止播放，请联系片源管理员",
            Self::UpstreamPolicyUnavailable => {
                "无法确认上游账户播放权限，已暂停授权；请检查片源账户权限和连接"
            }
            Self::InvalidPlanGeneration => "播放方案代次格式无效，请更新客户端",
            Self::StalePlaybackPlan => "此播放方案已被新的操作替代，请重新加载当前播放",
            Self::PlaybackViewerOriginRequired => "此旧播放器身份缺少登录归属，请重新进入播放器",
            Self::PlaybackViewerLimitExceeded => {
                "此账号在该房间的播放器身份已达上限，现有播放器可继续使用；新播放器需使用新房间"
            }
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
                "片源缺少可靠版本信息；HTTP 片源需提供稳定校验器，NAS 片源请升级 Agent 并重新扫描，然后重新发起播放"
            }
            Self::SourceSeekUnsupported => {
                "HTTP 片源不支持所需的字节范围读取，无法定位或探测此媒体"
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
            Self::AccountInactive => "该账号已注销，无法再接收授权或更新资源",
            Self::AccountOwnershipRequired => "请先转移全部房间与私人媒体库的所有权，再注销账号",
            Self::AccountLastAdmin => "请先设置另一名管理员，再注销当前管理员账号",
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
            Self::UnsupportedTimeline => "此媒体时间轴无法安全映射；暂不支持不连续或滑动窗口播放",
            Self::DeviceHasNoCompatiblePlaybackTransport
            | Self::UpstreamNoCompatibleStream
            | Self::UpstreamDeviceProfileRequired => "设备没有兼容的播放方式",
            Self::InvalidAudioTrack => "所选音轨不可用",
            Self::NoMedia => "请先选择影片",
            Self::SourceInUse => "此片源正在播放或准备播放，请先停止相关播放后再删除",
            Self::SourceManagedElsewhere => "此片源由 NAS 设备或所属媒体库管理，请到对应页面操作",
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
            Self::MediaInputInvalid => "媒体输入无法解析，请检查文件格式或重新扫描片源",
            Self::MediaInputDenied => "媒体源拒绝访问，请检查片源账户或设备权限",
            Self::MediaDecoderUnavailable => "当前媒体处理程序缺少所需解码器，请联系管理员",
            Self::MediaEncoderUnavailable => "当前媒体处理程序缺少所需编码器，请联系管理员",
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
    fn optional_text_and_collection_refusals_have_safe_terminal_codes() {
        for (reason, code) in [
            (
                "platform_collection_changed",
                ErrorCode::PlatformCollectionChanged,
            ),
            (
                "native_platform_caption_metadata_unavailable",
                ErrorCode::NativePlatformCaptionMetadataUnavailable,
            ),
            (
                "native_platform_caption_origin_unsupported",
                ErrorCode::NativePlatformCaptionOriginUnsupported,
            ),
            (
                "native_live_danmaku_auth_denied",
                ErrorCode::NativeLiveDanmakuAuthDenied,
            ),
        ] {
            assert_eq!(ErrorCode::from_reason(reason, 422), code);
            assert!(!code.retryable());
            assert!(!ApiError::new(code, Uuid::nil()).message.is_empty());
        }
    }
    #[test]
    fn legacy_mapping_refusal_reuses_the_existing_terminal_video_code() {
        assert_eq!(
            ErrorCode::from_reason("legacy_stream_mapping_unsupported", 422),
            ErrorCode::UnsupportedVideoOrHdr
        );
        assert!(!ErrorCode::UnsupportedVideoOrHdr.retryable());
        assert_eq!(
            ErrorCode::from_reason("unsupported_video_or_hdr", 422),
            ErrorCode::UnsupportedVideoOrHdr
        );
        assert_eq!(
            ErrorCode::from_reason("hdr_unsupported", 422),
            ErrorCode::HdrUnsupported
        );
        assert_eq!(
            ErrorCode::from_reason("drm_unsupported", 422),
            ErrorCode::DrmUnsupported
        );
    }
    #[test]
    fn new_library_compute_and_p2p_reasons_are_specific() {
        for (reason, status, expected) in [
            (
                "private_libraries_disabled",
                503,
                ErrorCode::PrivateLibrariesDisabled,
            ),
            ("library_conflict", 409, ErrorCode::LibraryConflict),
            ("s3_scan_failed", 502, ErrorCode::S3ScanFailed),
            ("nas_compute_disabled", 503, ErrorCode::NasComputeDisabled),
            ("compute_lease_lost", 409, ErrorCode::ComputeLeaseLost),
            ("p2p_consent_required", 400, ErrorCode::P2pConsentRequired),
            ("invalid_p2p_signal", 400, ErrorCode::InvalidP2pSignal),
        ] {
            assert_eq!(ErrorCode::from_reason(reason, status), expected);
        }
    }
    #[test]
    fn timeline_plugin_and_chat_reasons_have_specific_safe_codes() {
        for (reason, status, expected) in [
            ("chat_muted", 403, ErrorCode::ChatMuted),
            (
                "timeline_activity_stale",
                409,
                ErrorCode::TimelineActivityStale,
            ),
            (
                "timeline_cursor_expired",
                409,
                ErrorCode::TimelineCursorExpired,
            ),
            (
                "timeline_message_conflict",
                409,
                ErrorCode::TimelineMessageConflict,
            ),
            (
                "plugin_manifest_or_permissions_invalid",
                400,
                ErrorCode::PluginManifestOrPermissionsInvalid,
            ),
            (
                "plugin_revision_conflict",
                409,
                ErrorCode::PluginRevisionConflict,
            ),
            ("plugin_media_changed", 409, ErrorCode::PluginMediaChanged),
            ("reaction_rate_limited", 429, ErrorCode::ReactionRateLimited),
        ] {
            let code = ErrorCode::from_reason(reason, status);
            assert_eq!(code, expected);
            let error = ApiError::new(code, Uuid::nil());
            assert!(!error.message.is_empty());
            assert!(!error.message.contains(reason));
            assert_eq!(error.retryable, code == ErrorCode::ReactionRateLimited);
        }
    }
    #[test]
    fn unsupported_timeline_is_explicit_and_not_retried_as_transient() {
        let code = ErrorCode::from_reason("unsupported_timeline", 422);
        assert_eq!(code, ErrorCode::UnsupportedTimeline);
        let error = ApiError::new(code, Uuid::nil());
        assert!(!error.retryable);
        assert!(error.message.contains("时间轴"));
    }
    #[test]
    fn stale_plan_is_explicit_and_not_blindly_retried() {
        assert_eq!(
            ErrorCode::from_reason("stale_playback_plan", 409),
            ErrorCode::StalePlaybackPlan
        );
        assert_eq!(
            ErrorCode::from_reason("invalid_plan_generation", 400),
            ErrorCode::InvalidPlanGeneration
        );
        assert!(!ErrorCode::StalePlaybackPlan.retryable());
        assert!(!ErrorCode::InvalidPlanGeneration.retryable());
        assert_eq!(
            ErrorCode::from_reason("playback_viewer_limit_exceeded", 429),
            ErrorCode::PlaybackViewerLimitExceeded
        );
        assert!(!ErrorCode::PlaybackViewerLimitExceeded.retryable());
    }

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
    fn terminal_media_categories_are_actionable_without_retry_or_credentials() {
        for (reason, status, expected) in [
            ("media_input_invalid", 422, ErrorCode::MediaInputInvalid),
            ("media_input_denied", 502, ErrorCode::MediaInputDenied),
            (
                "media_decoder_unavailable",
                422,
                ErrorCode::MediaDecoderUnavailable,
            ),
            (
                "media_encoder_unavailable",
                503,
                ErrorCode::MediaEncoderUnavailable,
            ),
        ] {
            let error = ApiError::new(ErrorCode::from_reason(reason, status), Uuid::nil());
            assert_eq!(error.code, expected);
            assert!(!error.retryable);
            assert!(error.retry_after_ms.is_none());
            assert!(!error.message.is_empty());
            assert!(!error.message.contains(reason));
            assert_ne!(error.code, ErrorCode::LoginRequired);
            assert_ne!(error.code, ErrorCode::Forbidden);
        }
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
    #[test]
    fn explicit_hdr_and_protection_boundaries_are_safe_terminal_errors() {
        for (reason, expected) in [
            ("hdr_unsupported", ErrorCode::HdrUnsupported),
            ("drm_unsupported", ErrorCode::DrmUnsupported),
        ] {
            let code = ErrorCode::from_reason(reason, 422);
            assert_eq!(code, expected);
            assert!(!code.retryable());
            assert!(!ApiError::new(code, Uuid::nil()).message.is_empty());
        }
    }
    #[test]
    fn platform_login_expiry_never_masquerades_as_rainsync_logout() {
        for (reason, status, expected) in [
            (
                "platform_login_expired",
                410,
                ErrorCode::PlatformLoginExpired,
            ),
            (
                "platform_login_changed",
                409,
                ErrorCode::PlatformLoginChanged,
            ),
            (
                "platform_account_changed",
                409,
                ErrorCode::PlatformAccountChanged,
            ),
            (
                "native_platform_url_expired",
                410,
                ErrorCode::NativePlatformUrlExpired,
            ),
        ] {
            let code = ErrorCode::from_reason(reason, status);
            assert_eq!(code, expected);
            assert_ne!(code, ErrorCode::SessionExpired);
            assert_ne!(code, ErrorCode::LoginRequired);
            assert!(!code.retryable());
        }
    }
}
