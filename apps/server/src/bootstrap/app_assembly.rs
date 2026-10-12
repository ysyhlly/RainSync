//! Complete App construction at its original startup boundary.
use crate::*;

pub(super) struct Context<'a> {
    pub db: &'a sqlx::PgPool,
    pub readiness: &'a Arc<health::Runtime>,
    pub control_cluster: &'a Option<control_cluster::Runtime>,
    pub public_origin: String,
    pub cipher: aes_gcm::Aes256Gcm,
    pub epoch: Uuid,
    pub start: Instant,
}

pub(super) fn assemble(context: Context<'_>) -> anyhow::Result<App> {
    let Context {
        db,
        readiness,
        control_cluster,
        public_origin,
        cipher,
        epoch,
        start,
    } = context;
    Ok(App {
        control_cluster: control_cluster.clone(),
        platform_http: providers::platform::http::PlatformHttp::new(),
        bilibili_signing_keys: Arc::new(Default::default()),
        native_delivery_owners: Arc::new(Default::default()),
        youtube: native_platform_config::configured_youtube()?,
        live_playback: native_live::LiveStore::default(),
        other_live_playback: native_other_live::LiveStore::default(),
        other_live_enabled: native_platform_config::configured_other_live()?,
        platform_oauth: Arc::new(
            providers::platform::oauth::Registry::from_env(&public_origin)
                .map_err(|_| anyhow::anyhow!("invalid platform OAuth configuration"))?,
        ),
        platform_oauth_exchanges: Arc::new(platform_accounts::exchanges::Registry::new()),
        native_transcode_delivery: Arc::new(Default::default()),
        presence_sequence: presence::Sequence::default(),
        account_security: account_security::Security::configured()?,
        avatar_settings: avatar_image::Settings::configured()?,
        session_limit: limits::configured("PLAYBACK_SESSION_LIMIT", limits::DEFAULT_SESSION_LIMIT)?,
        queue_limit: limits::configured("MEDIA_QUEUE_LIMIT", limits::DEFAULT_QUEUE_LIMIT)?,
        preview_settings: persistence::media_previews::Settings::configured()?,
        metrics: Default::default(),
        readiness: readiness.clone(),
        db: db.clone(),
        secure: public_origin.starts_with("https://"),
        origin: public_origin,
        key: Arc::new(cipher),
        epoch,
        start,
        rooms: Default::default(),
        agent_controls: Default::default(),
        upstream: Default::default(),
        upstream_policy: Default::default(),
        preparations: Default::default(),
    })
}
