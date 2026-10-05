//! Room-local native media identity. Global library rows are private placeholders.
use crate::*;
use providers::platform::bilibili::{self, Client, VideoId, course, pgc};
use providers::platform::{short_video, youtube};
use sqlx::postgres::PgRow;
use tokio::time::{Duration, Instant as Deadline};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRequest {
    pub(crate) provider: String,
    pub(crate) url: String,
    pub(crate) part: Option<u32>,
    pub(crate) credential_mode: Option<protocol::NativePlatformCredentialMode>,
    pub(crate) account_id: Option<Uuid>,
    pub(crate) live_version: Option<u32>,
    pub(crate) course_version: Option<u32>,
}

pub(crate) fn import_credential_mode(
    body: &ImportRequest,
) -> Result<protocol::NativePlatformCredentialMode> {
    let mode = body
        .credential_mode
        .unwrap_or(protocol::NativePlatformCredentialMode::Anonymous);
    let credential_provider_supported =
        matches!(body.provider.as_str(), "douyin" | "tiktok" | "youtube")
            || (body.provider == "bilibili"
                && (pgc::parse_resource(&body.url).is_ok()
                    || bilibili::live::parse_resource(&body.url).is_ok()
                    || course::parse_resource(&body.url).is_ok()));
    if (mode == protocol::NativePlatformCredentialMode::Anonymous && body.account_id.is_some())
        || (!credential_provider_supported
            && (mode != protocol::NativePlatformCredentialMode::Anonymous
                || body.account_id.is_some()))
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    Ok(mode)
}

/// Closed finite episode identities. PGC2 and course4 bind every resource axis.
#[derive(Clone, serde::Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum PgcIdentity {
    BilibiliPgc {
        ep_id: String,
        cid: String,
        season_id: String,
    },
    BilibiliCourse {
        ep_id: String,
        aid: String,
        cid: String,
        season_id: String,
    },
}
impl PgcIdentity {
    pub(crate) fn new(ep_id: String, cid: String, season_id: String) -> Self {
        Self::BilibiliPgc {
            ep_id,
            cid,
            season_id,
        }
    }
    pub(crate) fn new_course(ep_id: String, aid: String, cid: String, season_id: String) -> Self {
        Self::BilibiliCourse {
            ep_id,
            aid,
            cid,
            season_id,
        }
    }
    pub(crate) fn is_pgc(&self) -> bool {
        matches!(self, Self::BilibiliPgc { .. })
    }
    pub(crate) fn is_course(&self) -> bool {
        matches!(self, Self::BilibiliCourse { .. })
    }
    pub(crate) fn validate(&self) -> bool {
        let positive = |value: &str| {
            !value.starts_with('0')
                && value.bytes().all(|c| c.is_ascii_digit())
                && value.parse::<i64>().is_ok_and(|n| n > 0)
        };
        [self.ep_id(), self.cid(), self.season_id()]
            .into_iter()
            .all(positive)
            && self.aid().is_none_or(positive)
    }
    pub(crate) fn ep_id(&self) -> &str {
        match self {
            Self::BilibiliPgc { ep_id, .. } | Self::BilibiliCourse { ep_id, .. } => ep_id,
        }
    }
    pub(crate) fn cid(&self) -> &str {
        match self {
            Self::BilibiliPgc { cid, .. } | Self::BilibiliCourse { cid, .. } => cid,
        }
    }
    pub(crate) fn season_id(&self) -> &str {
        match self {
            Self::BilibiliPgc { season_id, .. } | Self::BilibiliCourse { season_id, .. } => {
                season_id
            }
        }
    }
    pub(crate) fn aid(&self) -> Option<&str> {
        match self {
            Self::BilibiliCourse { aid, .. } => Some(aid),
            _ => None,
        }
    }
}

pub(crate) struct Entry {
    pub media_id: Uuid,
    pub room_id: Uuid,
    pub provider: String,
    pub canonical_url: Option<String>,
    pub content_id: String,
    pub part: u32,
    pub cid: Option<i64>,
    pub revision: i64,
    pub pgc: Option<PgcIdentity>,
    pub course: Option<PgcIdentity>,
}
impl Entry {
    pub fn identity(&self) -> Option<PgcIdentity> {
        self.course.clone().or_else(|| self.pgc.clone())
    }
    pub fn resource_version(&self) -> u32 {
        if self.course.is_some() {
            4
        } else if self.pgc.is_some() {
            2
        } else {
            1
        }
    }
    pub fn resource(&self) -> String {
        if let Some(course) = &self.course {
            return course::EpisodeRef {
                ep_id: course.ep_id().into(),
            }
            .canonical();
        }
        if let Some(pgc) = &self.pgc {
            return pgc::EpisodeRef {
                ep_id: pgc.ep_id().into(),
            }
            .canonical();
        }
        if self.provider != "bilibili" {
            return self.canonical_url.clone().unwrap_or_default();
        }
        bilibili::VideoRef {
            id: VideoId::Bv(self.content_id.clone()),
            part: self.part,
        }
        .canonical()
    }
}

struct ImportReference {
    provider: String,
    content_id: Option<String>,
    part: u32,
    canonical_url: String,
    bili: Option<bilibili::VideoRef>,
    pgc: Option<pgc::EpisodeRef>,
    course: Option<course::EpisodeRef>,
}
fn parse_import(body: &ImportRequest) -> Result<ImportReference> {
    if body.live_version.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    import_credential_mode(body)?;
    let is_course = body.provider == "bilibili" && course::parse_resource(&body.url).is_ok();
    if (is_course && body.course_version != Some(1))
        || (!is_course && body.course_version.is_some())
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_course_client_unsupported",
        ));
    }
    let invalid = || err(StatusCode::BAD_REQUEST, "native_platform_invalid");
    if is_course {
        if body.part.is_some_and(|part| part != 1) {
            return Err(invalid());
        }
        let episode = course::parse_resource(&body.url).map_err(|_| invalid())?;
        return Ok(ImportReference {
            provider: body.provider.clone(),
            content_id: Some(format!("course:ep{}", episode.ep_id)),
            part: 1,
            canonical_url: episode.canonical(),
            bili: None,
            pgc: None,
            course: Some(episode),
        });
    }
    if body.provider == "bilibili" && (body.url.starts_with("ep") || body.url.contains("/bangumi/"))
    {
        if body.part.is_some_and(|part| part != 1) {
            return Err(invalid());
        }
        let episode = pgc::parse_resource(&body.url).map_err(|_| invalid())?;
        return Ok(ImportReference {
            provider: body.provider.clone(),
            content_id: Some(format!("ep{}", episode.ep_id)),
            part: 1,
            canonical_url: episode.canonical(),
            bili: None,
            pgc: Some(episode),
            course: None,
        });
    }
    let (content_id, canonical_url, part, bili) = match body.provider.as_str() {
        "bilibili" => {
            let mut reference = bilibili::parse_resource(&body.url).map_err(|_| invalid())?;
            if let Some(part) = body.part {
                if !(1..=10_000).contains(&part) {
                    return Err(invalid());
                }
                reference.part = part;
            }
            let id = match &reference.id {
                VideoId::Bv(id) => Some(id.clone()),
                VideoId::Av(_) => None,
            };
            (id, reference.canonical(), reference.part, Some(reference))
        }
        "douyin" | "tiktok" => {
            if body.part.is_some_and(|p| p != 1) {
                return Err(invalid());
            }
            let platform = if body.provider == "douyin" {
                short_video::Platform::Douyin
            } else {
                short_video::Platform::TikTok
            };
            let reference =
                short_video::parse_resource(platform, &body.url).map_err(|_| invalid())?;
            (Some(reference.id().into()), reference.canonical(), 1, None)
        }
        "youtube" => {
            if body.part.is_some_and(|p| p != 1) {
                return Err(invalid());
            }
            let reference = youtube::parse_resource(&body.url).map_err(|_| invalid())?;
            (Some(reference.id.clone()), reference.canonical(), 1, None)
        }
        _ => return Err(invalid()),
    };
    Ok(ImportReference {
        provider: body.provider.clone(),
        content_id,
        canonical_url,
        part,
        bili,
        pgc: None,
        course: None,
    })
}
fn validate_entry(entry: &Entry) -> Result<()> {
    let invalid = || err(StatusCode::GONE, "invalid_playback_session");
    if entry.course.is_some() && entry.pgc.is_some() {
        return Err(invalid());
    }
    if let Some(identity) = &entry.course {
        if entry.provider != "bilibili"
            || !identity.is_course()
            || !identity.validate()
            || entry.part != 1
            || entry.content_id != format!("course:ep{}", identity.ep_id())
            || entry.cid != identity.cid().parse::<i64>().ok()
            || entry.canonical_url.as_deref() != Some(entry.resource().as_str())
        {
            return Err(invalid());
        }
    } else if let Some(identity) = &entry.pgc {
        if entry.provider != "bilibili"
            || !identity.is_pgc()
            || !identity.validate()
            || entry.part != 1
            || entry.content_id != format!("ep{}", identity.ep_id())
            || entry.cid != identity.cid().parse::<i64>().ok()
            || entry.canonical_url.as_deref() != Some(entry.resource().as_str())
        {
            return Err(invalid());
        }
    } else if entry.provider == "bilibili" {
        let reference = bilibili::parse_resource(&entry.resource()).map_err(|_| invalid())?;
        if !matches!(reference.id, VideoId::Bv(ref id) if *id == entry.content_id)
            || reference.part != entry.part
            || entry.canonical_url.is_some()
            || entry.cid.is_some_and(|v| v <= 0)
        {
            return Err(invalid());
        }
    } else {
        if entry.part != 1 || entry.cid.is_some() {
            return Err(invalid());
        }
        let canonical = entry.canonical_url.as_deref().ok_or_else(invalid)?;
        let reference = parse_import(&ImportRequest {
            provider: entry.provider.clone(),
            url: canonical.into(),
            part: None,
            credential_mode: None,
            account_id: None,
            live_version: None,
            course_version: None,
        })
        .map_err(|_| invalid())?;
        if reference.content_id.as_deref() != Some(&entry.content_id)
            || reference.canonical_url != canonical
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn plain_title(value: &str) -> String {
    let value: String = value
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}'))
        .take(200)
        .collect();
    let value = value.trim();
    if value.is_empty() {
        "平台影片".into()
    } else {
        value.into()
    }
}
fn import_title(metadata: &bilibili::VideoMetadata) -> String {
    let value = if metadata.part_count > 1 {
        format!(
            "{} · P{} {}",
            metadata.title, metadata.part, metadata.part_title
        )
    } else {
        metadata.title.clone()
    };
    plain_title(&value)
}
fn dto(row: &PgRow) -> Value {
    if row.get::<String, _>("resource_kind") == "other_live" {
        return crate::native_other_live::dto(row);
    }
    if row.get::<String, _>("resource_kind") == "live" {
        return crate::native_live::dto(row);
    }
    let title: String = row.get("title");
    let mut platform = json!({"version":1,"provider":row.get::<String,_>("provider"),"content_id":row.get::<String,_>("content_id"),"part":row.get::<i32,_>("part")});
    if row.get::<String, _>("resource_kind") == "pgc_episode" {
        platform["version"] = json!(2);
        platform["resource"] = json!(PgcIdentity::new(
            row.get::<i64, _>("ep_id").to_string(),
            row.get::<i64, _>("cid").to_string(),
            row.get::<i64, _>("season_id").to_string()
        ));
    }
    if row.get::<String, _>("resource_kind") == "course_episode" {
        platform["version"] = json!(4);
        platform["resource"] = json!(PgcIdentity::new_course(
            row.get::<i64, _>("ep_id").to_string(),
            row.get::<i64, _>("aid").to_string(),
            row.get::<i64, _>("cid").to_string(),
            row.get::<i64, _>("season_id").to_string()
        ));
    }
    json!({"id": row.get::<Uuid,_>("media_id"), "kind":"native_platform", "title":title,
        "original_title":title, "shared_title":null, "shared_title_revision":"0",
        "personal_title":null, "personal_title_revision":"0", "duration_ms":row.get::<Option<f64>,_>("duration_ms"),
        "cover":{"status":"missing","revision":null,"url":null,"retry_after_ms":null},
        "platform":platform})
}

pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(body): Json<ImportRequest>,
) -> Result<Response> {
    Ok(media_titles::private_json(
        import_one(&app, &h, room, body).await?,
    ))
}

/// Batch and single imports share all controller, session and frozen-account
/// fences. The existing room/provider/content/part uniqueness is the retry key.
pub(crate) async fn import_one(
    app: &App,
    h: &HeaderMap,
    room: Uuid,
    body: ImportRequest,
) -> Result<Value> {
    import_one_with_frozen(app, h, room, body, None).await
}
pub(crate) async fn import_one_with_frozen(
    app: &App,
    h: &HeaderMap,
    room: Uuid,
    mut body: ImportRequest,
    frozen: Option<&platform_accounts::FrozenAccount>,
) -> Result<Value> {
    import_credential_mode(&body)?;
    let user = auth(app, h, true).await?;
    // Even anonymous redirect discovery must wait for room authority. Recheck
    // authority after discovery before any account can be consulted.
    rooms::controller(app, h, room).await?.rollback().await?;
    let candidates = providers::platform::imports::candidates(&body.url)
        .map_err(crate::platform_media::provider_error)?;
    if candidates.len() != 1 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_import_single_required",
        ));
    }
    let provider = providers::platform::imports::Provider::parse(&body.provider)
        .map_err(crate::platform_media::provider_error)?;
    let input = providers::platform::imports::parse_input(&candidates[0], Some(provider))
        .map_err(crate::platform_media::provider_error)?;
    let normalized = providers::platform::imports::resolve(
        &app.platform_http,
        input,
        Deadline::now() + Duration::from_secs(20),
    )
    .await
    .map_err(crate::platform_media::provider_error)?;
    body.url = normalized.url;
    if body.provider == "bilibili" && bilibili::live::parse_resource(&body.url).is_ok() {
        return crate::native_live::import_one(app, h, room, &body, frozen).await;
    }
    if let Ok(p) = providers::platform::other_live::Provider::parse(&body.provider)
        && providers::platform::other_live::parse_resource(p, &body.url).is_ok()
    {
        return crate::native_other_live::import_one(app, h, room, &body, frozen).await;
    }
    if body.live_version.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    let reference = parse_import(&body)?;
    let credential_mode = import_credential_mode(&body)?;
    if frozen.is_some() && credential_mode != protocol::NativePlatformCredentialMode::OwnOrAnonymous
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    let login = media_authorization::login_hash(h)?;
    // Initial authority must precede even a public provider lookup. No locks
    // survive the lookup, and the controller is independently rechecked after it.
    let mut tx = rooms::controller(app, h, room).await?;
    if let Some(frozen) = frozen {
        platform_accounts::guard_for_publish(&mut tx, user.id, frozen).await?;
    }
    if credential_mode == protocol::NativePlatformCredentialMode::Anonymous
        && let Some(content_id) = &reference.content_id
        && let Some(row)=sqlx::query("SELECT media_id,provider,content_id,part,title,duration_ms,resource_kind,ep_id,aid,cid,season_id,live_room_id,live_uid,live_broadcast_id,live_started_at,live_resource,canonical_url FROM room_platform_media WHERE room_id=$1 AND provider=$2 AND content_id=$3 AND part=$4")
            .bind(room).bind(&reference.provider).bind(content_id).bind(reference.part as i32).fetch_optional(&mut *tx).await? {
            let result=dto(&row);
            rooms::commit_controller(tx,h).await?;
            return Ok(result);
    }
    tx.rollback().await?;
    // Consent is explicit for short-provider imports; legacy requests stay
    // anonymous. Only the importing principal's provider vault is consulted.
    let loaded;
    let account = if let Some(frozen) = frozen {
        frozen
    } else {
        loaded = match credential_mode {
            protocol::NativePlatformCredentialMode::OwnOrAnonymous => {
                platform_accounts::load_for_provider_playback(app, user.id, &reference.provider)
                    .await?
            }
            protocol::NativePlatformCredentialMode::Anonymous => {
                platform_accounts::FrozenAccount::anonymous_for_provider(
                    user.id,
                    &reference.provider,
                )?
            }
        };
        &loaded
    };
    if body.account_id.is_some() && body.account_id != account.account_id() {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    // Loading is an await. Recheck controller/login and the exact frozen
    // account before credentialed upstream work, then release every lock.
    let mut before_resolve = rooms::controller(app, h, room).await?;
    platform_accounts::guard_for_publish(&mut before_resolve, user.id, account).await?;
    let live: bool = sqlx::query_scalar("SELECT playback_login_allowed($1,$2)")
        .bind(user.id)
        .bind(&login)
        .fetch_one(&mut *before_resolve)
        .await?;
    if !live {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    // Reusing an existing identity is still an account-scoped result. In own
    // mode validate the exact supplied account and its fresh frozen guard first;
    // otherwise a single-item retry could silently ignore stale account intent.
    if credential_mode == protocol::NativePlatformCredentialMode::OwnOrAnonymous
        && let Some(content_id) = &reference.content_id
        && let Some(row)=sqlx::query("SELECT media_id,provider,content_id,part,title,duration_ms,resource_kind,ep_id,aid,cid,season_id,live_room_id,live_uid,live_broadcast_id,live_started_at,live_resource,canonical_url FROM room_platform_media WHERE room_id=$1 AND provider=$2 AND content_id=$3 AND part=$4")
            .bind(room).bind(&reference.provider).bind(content_id).bind(reference.part as i32).fetch_optional(&mut *before_resolve).await? {
        let result=dto(&row);
        platform_accounts::guard_for_publish(&mut before_resolve,user.id,account).await?;
        rooms::commit_controller(before_resolve,h).await?;
        return Ok(result);
    }
    before_resolve.rollback().await?;
    let (content_id, part, cid, canonical_url, title, duration_seconds, pgc_identity) =
        if let Some(episode) = &reference.course {
            let resolved = course::Client::new(app.platform_http, account.cookie().cloned())
                .resolve(
                    &episode.canonical(),
                    Some(1080),
                    Deadline::now() + Duration::from_secs(35),
                )
                .await
                .map_err(crate::platform_media::provider_error)?;
            if !resolved.whole_entitlement().is_whole() || resolved.metadata.ep_id != episode.ep_id
            {
                return Err(err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "native_platform_access_denied",
                ));
            }
            let m = resolved.metadata;
            let identity = PgcIdentity::new_course(
                m.ep_id.clone(),
                m.aid.clone(),
                m.cid.clone(),
                m.season_id.clone(),
            );
            if !identity.validate() {
                return Err(err(
                    StatusCode::BAD_GATEWAY,
                    "native_platform_invalid_response",
                ));
            }
            (
                format!("course:ep{}", m.ep_id),
                1,
                identity.cid().parse::<i64>().ok(),
                Some(episode.canonical()),
                plain_title(&format!("{} · {}", m.title, m.episode_title)),
                m.duration_ms as f64 / 1000.0,
                Some(identity),
            )
        } else if let Some(episode) = &reference.pgc {
            let resolved = pgc::Client::new(app.platform_http, account.cookie().cloned())
                .resolve(
                    &episode.canonical(),
                    Some(1080),
                    Deadline::now() + Duration::from_secs(35),
                )
                .await
                .map_err(crate::platform_media::provider_error)?;
            if !resolved.whole_entitlement().is_whole() || resolved.metadata.ep_id != episode.ep_id
            {
                return Err(err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "native_platform_access_denied",
                ));
            }
            let metadata = resolved.metadata;
            let identity = PgcIdentity::new(
                metadata.ep_id.clone(),
                metadata.cid.clone(),
                metadata.season_id.clone(),
            );
            if !identity.validate() {
                return Err(err(
                    StatusCode::BAD_GATEWAY,
                    "native_platform_invalid_response",
                ));
            }
            let title = plain_title(&format!("{} · {}", metadata.title, metadata.episode_title));
            let duration = metadata.duration_ms as f64 / 1000.0;
            (
                format!("ep{}", metadata.ep_id),
                1,
                identity.cid().parse::<i64>().ok(),
                Some(episode.canonical()),
                title,
                duration,
                Some(identity),
            )
        } else if let Some(bili) = &reference.bili {
            let metadata = Client::new(app.platform_http, None)
                .view(bili, Deadline::now() + Duration::from_secs(20))
                .await
                .map_err(crate::platform_media::provider_error)?;
            let cid = metadata
                .cid
                .parse::<i64>()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| err(StatusCode::BAD_GATEWAY, "native_platform_invalid_response"))?;
            let title = import_title(&metadata);
            (
                metadata.bvid,
                metadata.part,
                Some(cid),
                None,
                title,
                metadata.duration_seconds as f64,
                None,
            )
        } else if reference.provider == "youtube" {
            // Exact importing-viewer credentials are optional and never fall
            // back after a credentialed failure. Signed addresses are discarded.
            let resolved = crate::platform_media::resolve_youtube_with_account(
                app,
                &reference.canonical_url,
                youtube::SelectionMode::PreferAdaptive,
                youtube::QualityLimit::Auto,
                account.youtube_cookie(),
                Deadline::now() + Duration::from_secs(35),
            )
            .await?;
            if reference.content_id.as_deref() != Some(&resolved.content_id)
                || reference.canonical_url != resolved.canonical_url
                || !resolved.duration_seconds.is_finite()
                || !(0.001..=604800.0).contains(&resolved.duration_seconds)
            {
                return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
            }
            (
                resolved.content_id,
                1,
                None,
                Some(resolved.canonical_url),
                plain_title(&resolved.title),
                resolved.duration_seconds,
                None,
            )
        } else {
            // Metadata may use the importing caller's account. Discard every
            // signed address; each viewer prepares a separate account-bound grant.
            let deadline = Deadline::now() + Duration::from_secs(35);
            let resolved = match account.short_cookie() {
                Some(credential) => {
                    crate::platform_media::resolve_progressive(
                        app,
                        &reference.provider,
                        &reference.canonical_url,
                        Some(credential),
                        deadline,
                    )
                    .await?
                }
                None => {
                    crate::platform_media::resolve_public_progressive(
                        app,
                        &reference.provider,
                        &reference.canonical_url,
                        deadline,
                    )
                    .await?
                }
            };
            if reference.content_id.as_deref() != Some(&resolved.content_id) {
                return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
            }
            (
                resolved.content_id,
                1,
                None,
                Some(resolved.canonical_url),
                plain_title(&resolved.title),
                resolved.duration_seconds,
                None,
            )
        };
    let mut tx = rooms::controller(app, h, room).await?;
    platform_accounts::guard_for_publish(&mut tx, user.id, account).await?;
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT media_id FROM room_platform_media WHERE room_id=$1 AND provider=$2 AND content_id=$3 AND part=$4")
        .bind(room).bind(&reference.provider).bind(&content_id).bind(part as i32).fetch_optional(&mut *tx).await?;
    let media = if let Some(media) = existing {
        media
    } else {
        let media = Uuid::new_v4();
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata,available) VALUES($1,NULL,'平台影片',$2,NULL,'{}',true)")
            .bind(media).bind(format!("platform:{media}")).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,cid,title,duration_ms,created_by,canonical_url,resource_kind,ep_id,season_id,aid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)")
            .bind(media).bind(room).bind(&reference.provider).bind(&content_id).bind(part as i32).bind(cid).bind(title)
            .bind(Some(duration_seconds * 1000.0)).bind(user.id).bind(canonical_url)
            .bind(if pgc_identity.as_ref().is_some_and(PgcIdentity::is_course) { "course_episode" } else if pgc_identity.is_some() { "pgc_episode" } else { "video" })
            .bind(pgc_identity.as_ref().and_then(|id| id.ep_id().parse::<i64>().ok()))
            .bind(pgc_identity.as_ref().and_then(|id| id.season_id().parse::<i64>().ok()))
            .bind(pgc_identity.as_ref().and_then(|id| id.aid().and_then(|id| id.parse::<i64>().ok()))).execute(&mut *tx).await?;
        media
    };
    let row = sqlx::query("SELECT media_id,provider,content_id,part,title,duration_ms,resource_kind,ep_id,aid,cid,season_id,live_room_id,live_uid,live_broadcast_id,live_started_at,live_resource,canonical_url FROM room_platform_media WHERE room_id=$1 AND media_id=$2")
        .bind(room).bind(media).fetch_one(&mut *tx).await?;
    let result = dto(&row);
    platform_accounts::guard_for_publish(&mut tx, user.id, account).await?;
    rooms::commit_controller(tx, h).await?;
    Ok(result)
}

/// Caller must have authenticated the viewer. Both native and ordinary media
/// details are gated by this room's current membership, never the global cache.
pub(crate) async fn scoped_read(app: &App, viewer: Uuid, room: Uuid, media: Uuid) -> Result<Value> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)",
    )
    .bind(room)
    .bind(viewer)
    .fetch_one(&app.db)
    .await?;
    if !allowed {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    let row = sqlx::query("SELECT x.media_id,x.provider,x.content_id,x.part,x.title,x.duration_ms,x.resource_kind,x.ep_id,x.aid,x.cid,x.season_id,x.live_room_id,x.live_uid,x.live_broadcast_id,x.live_started_at,x.live_resource,x.canonical_url FROM room_platform_media x JOIN media_items m ON m.id=x.media_id JOIN room_members rm ON rm.room_id=x.room_id AND rm.user_id=$1 WHERE x.room_id=$2 AND x.media_id=$3 AND m.available")
        .bind(viewer).bind(room).bind(media).fetch_optional(&app.db).await?;
    if let Some(row) = row {
        return Ok(dto(&row));
    }
    // Ordinary reads join sources and consequently cannot reveal native
    // placeholders belonging to another room.
    let row=sqlx::query(&format!("{} WHERE {} AND m.id=$2 AND EXISTS(SELECT 1 FROM room_members WHERE room_id=$3 AND user_id=$1)",media_titles::SELECT,media_titles::VISIBLE))
        .bind(viewer).bind(media).bind(room).fetch_optional(&app.db).await?
        .ok_or_else(||err(StatusCode::NOT_FOUND,"media_not_found"))?;
    Ok(media_titles::media(&row))
}
pub async fn scoped_detail(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, media)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(media_titles::private_json(
        scoped_read(&app, user.id, room, media).await?,
    ))
}

pub(crate) async fn capture(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    room: Uuid,
    generation: u32,
) -> Result<Entry> {
    let state: Value = sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1")
        .bind(room)
        .fetch_one(&mut **tx)
        .await?;
    if state["media_generation"].as_u64() != Some(u64::from(generation)) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    let media = state["media_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no_media"))?;
    let row = sqlx::query("SELECT x.provider,x.canonical_url,x.content_id,x.part,x.cid,x.revision,x.resource_kind,x.ep_id,x.season_id,x.aid FROM room_platform_media x JOIN media_items m ON m.id=x.media_id WHERE x.room_id=$1 AND x.media_id=$2 AND m.available FOR SHARE OF x,m")
        .bind(room).bind(media).fetch_optional(&mut **tx).await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND,"media_not_found"))?;
    let entry = Entry {
        media_id: media,
        room_id: room,
        provider: row.get("provider"),
        canonical_url: row.get("canonical_url"),
        content_id: row.get("content_id"),
        part: row.get::<i32, _>("part") as u32,
        cid: row.get("cid"),
        revision: row.get("revision"),
        pgc: match row.get::<String, _>("resource_kind").as_str() {
            "pgc_episode" => Some(PgcIdentity::new(
                row.get::<Option<i64>, _>("ep_id")
                    .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?
                    .to_string(),
                row.get::<Option<i64>, _>("cid")
                    .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?
                    .to_string(),
                row.get::<Option<i64>, _>("season_id")
                    .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?
                    .to_string(),
            )),
            "course_episode" => None,
            "video"
                if row.get::<Option<i64>, _>("ep_id").is_none()
                    && row.get::<Option<i64>, _>("season_id").is_none() =>
            {
                None
            }
            _ => return Err(err(StatusCode::GONE, "invalid_playback_session")),
        },
        course: if row.get::<String, _>("resource_kind") == "course_episode" {
            let axis = |name: &str| {
                row.get::<Option<i64>, _>(name)
                    .filter(|v| *v > 0)
                    .map(|v| v.to_string())
                    .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))
            };
            Some(PgcIdentity::new_course(
                axis("ep_id")?,
                axis("aid")?,
                axis("cid")?,
                axis("season_id")?,
            ))
        } else {
            None
        },
    };
    validate_entry(&entry)?;
    Ok(entry)
}
pub(crate) async fn guard(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    entry: &Entry,
    generation: u32,
) -> Result<()> {
    let current = capture(tx, entry.room_id, generation).await?;
    if current.media_id != entry.media_id
        || current.provider != entry.provider
        || current.canonical_url != entry.canonical_url
        || current.content_id != entry.content_id
        || current.part != entry.part
        || current.cid != entry.cid
        || current.revision != entry.revision
        || current.pgc != entry.pgc
        || current.course != entry.course
    {
        return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn course_import_and_identity_require_explicit_closed_course_route() {
        let body: ImportRequest=serde_json::from_value(json!({"provider":"bilibili","url":"https://www.bilibili.com/cheese/play/ep7","course_version":1,"credential_mode":"own_or_anonymous","account_id":Uuid::from_u128(3)})).unwrap();
        let reference = parse_import(&body).unwrap();
        assert!(reference.bili.is_none() && reference.pgc.is_none());
        assert_eq!(reference.course.unwrap().ep_id, "7");
        assert_eq!(reference.content_id.as_deref(), Some("course:ep7"));
        for version in [None, Some(0), Some(2)] {
            assert!(
                parse_import(&ImportRequest {
                    course_version: version,
                    ..body.clone()
                })
                .is_err()
            );
        }
        for url in [
            "BV1xx411c7mD",
            "ep7",
            "https://www.bilibili.com/bangumi/play/ep7",
            "https://www.bilibili.com/cheese/play/ss7",
            "https://www.bilibili.com/cheese/play/ep7?p=2",
        ] {
            assert!(
                parse_import(&ImportRequest {
                    url: url.into(),
                    ..body.clone()
                })
                .is_err()
            );
        }
        let identity = PgcIdentity::new_course("7".into(), "10".into(), "8".into(), "9".into());
        let mut entry = Entry {
            media_id: Uuid::from_u128(1),
            room_id: Uuid::from_u128(2),
            provider: "bilibili".into(),
            canonical_url: Some(body.url),
            content_id: "course:ep7".into(),
            part: 1,
            cid: Some(8),
            revision: 1,
            pgc: None,
            course: Some(identity.clone()),
        };
        assert!(validate_entry(&entry).is_ok());
        assert_eq!(entry.resource_version(), 4);
        let value = serde_json::to_value(&identity).unwrap();
        assert_eq!(
            value,
            json!({"kind":"bilibili_course","ep_id":"7","aid":"10","cid":"8","season_id":"9"})
        );
        for axis in ["ep_id", "aid", "cid", "season_id"] {
            let mut wrong = value.clone();
            wrong[axis] = json!("0");
            assert!(
                !serde_json::from_value::<PgcIdentity>(wrong)
                    .unwrap()
                    .validate()
            );
        }
        for field in ["bvid", "cookie", "has_paid", "account_id", "can_view"] {
            let mut wrong = value.clone();
            wrong[field] = json!("private");
            assert!(serde_json::from_value::<PgcIdentity>(wrong).is_err());
        }
        entry.pgc = Some(PgcIdentity::new("7".into(), "8".into(), "9".into()));
        assert!(validate_entry(&entry).is_err());
        entry.pgc = None;
        entry.course = Some(PgcIdentity::new("7".into(), "8".into(), "9".into()));
        assert!(validate_entry(&entry).is_err());
        entry.course = Some(identity);
        entry.content_id = "ep7".into();
        assert!(validate_entry(&entry).is_err());
    }
    #[test]
    fn short_import_credentials_require_explicit_mode_and_never_owner_authority() {
        for provider in ["douyin", "tiktok", "youtube", "bilibili"] {
            let mut body: ImportRequest = serde_json::from_value(json!({
                "provider": provider,
                "url": if provider=="youtube" {"dQw4w9WgXcQ"} else if provider=="bilibili" {"ep7"} else {"1234567890123456789"},
            }))
            .unwrap();
            assert_eq!(
                import_credential_mode(&body).unwrap(),
                protocol::NativePlatformCredentialMode::Anonymous
            );
            body.account_id = Some(Uuid::from_u128(9));
            assert!(parse_import(&body).is_err());
            body.credential_mode = Some(protocol::NativePlatformCredentialMode::OwnOrAnonymous);
            assert!(parse_import(&body).is_ok());
            body.credential_mode = Some(protocol::NativePlatformCredentialMode::Anonymous);
            assert!(parse_import(&body).is_err());
            body.account_id = None;
            assert!(parse_import(&body).is_ok());
        }
        let public = json!({"provider":"douyin","url":"123","credential_mode":"own_or_anonymous"});
        for field in [
            "cookie",
            "headers",
            "owner_id",
            "shared_account",
            "account_revision",
        ] {
            let mut invalid = public.clone();
            invalid[field] = json!("synthetic-private-data");
            assert!(serde_json::from_value::<ImportRequest>(invalid).is_err());
        }
        let mut invalid = public;
        invalid["credential_mode"] = json!("owner_account");
        assert!(serde_json::from_value::<ImportRequest>(invalid).is_err());
    }

    #[test]
    fn import_is_bounded_and_does_not_accept_foreign_urls() {
        for url in [
            "https://evil.example/video/BV1xx411c7mD",
            "http://www.bilibili.com/video/BV1xx411c7mD",
            "https://b23.tv/example",
            "BV1xx411c7mD?cookie=secret",
        ] {
            assert!(
                parse_import(&ImportRequest {
                    provider: "bilibili".into(),
                    url: url.into(),
                    part: None,
                    credential_mode: None,
                    account_id: None,
                    live_version: None,
                    course_version: None,
                })
                .is_err()
            );
        }
        let parsed = parse_import(&ImportRequest {
            provider: "bilibili".into(),
            url: "BV1xx411c7mD".into(),
            part: Some(2),
            credential_mode: None,
            account_id: None,
            live_version: None,
            course_version: None,
        })
        .unwrap();
        assert_eq!(parsed.part, 2);
        assert!(
            parse_import(&ImportRequest {
                provider: "bilibili".into(),
                url: "BV1xx411c7mD".into(),
                part: Some(0),
                credential_mode: None,
                account_id: None,
                live_version: None,
                course_version: None,
            })
            .is_err()
        );
    }
    #[test]
    fn ordinary_vod_identity_is_provider_bound_and_part_one_only() {
        for (provider, url, content_id, canonical) in [
            (
                "douyin",
                "1234567890123456789",
                "1234567890123456789",
                "https://www.douyin.com/video/1234567890123456789",
            ),
            (
                "tiktok",
                "https://www.tiktok.com/@creator.name/video/1234567890123456789",
                "1234567890123456789",
                "https://www.tiktok.com/@creator.name/video/1234567890123456789",
            ),
            (
                "youtube",
                "https://youtu.be/dQw4w9WgXcQ",
                "dQw4w9WgXcQ",
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            ),
        ] {
            let parsed = parse_import(&ImportRequest {
                provider: provider.into(),
                url: url.into(),
                part: None,
                credential_mode: None,
                account_id: None,
                live_version: None,
                course_version: None,
            })
            .unwrap();
            assert_eq!(parsed.content_id.as_deref(), Some(content_id));
            assert_eq!(parsed.canonical_url, canonical);
            assert_eq!(parsed.part, 1);
            assert!(
                parse_import(&ImportRequest {
                    provider: provider.into(),
                    url: url.into(),
                    part: Some(2),
                    credential_mode: None,
                    account_id: None,
                    live_version: None,
                    course_version: None,
                })
                .is_err()
            );
            let mut entry = Entry {
                media_id: Uuid::from_u128(1),
                room_id: Uuid::from_u128(2),
                provider: provider.into(),
                canonical_url: Some(canonical.into()),
                content_id: content_id.into(),
                part: 1,
                cid: None,
                revision: 1,
                pgc: None,
                course: None,
            };
            assert!(validate_entry(&entry).is_ok());
            entry.content_id.push('0');
            assert!(validate_entry(&entry).is_err());
            entry.content_id = content_id.into();
            entry.cid = Some(1);
            assert!(validate_entry(&entry).is_err());
        }
        for (provider, url) in [
            ("douyin", "https://www.tiktok.com/@creator/video/123"),
            ("tiktok", "https://www.douyin.com/video/123"),
            (
                "youtube",
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=private",
            ),
            ("youtube", "https://evil.example/watch?v=dQw4w9WgXcQ"),
            ("douyin", "https://www.douyin.com/note/123"),
        ] {
            assert!(
                parse_import(&ImportRequest {
                    provider: provider.into(),
                    url: url.into(),
                    part: None,
                    credential_mode: None,
                    account_id: None,
                    live_version: None,
                    course_version: None,
                })
                .is_err()
            );
        }
    }
    #[test]
    fn pgc_import_and_entry_are_explicit_and_mutually_exclusive_with_ugc() {
        let body = ImportRequest {
            provider: "bilibili".into(),
            url: "https://www.bilibili.com/bangumi/play/ep7".into(),
            part: None,
            credential_mode: Some(protocol::NativePlatformCredentialMode::OwnOrAnonymous),
            account_id: Some(Uuid::from_u128(3)),
            live_version: None,
            course_version: None,
        };
        let reference = parse_import(&body).unwrap();
        assert!(reference.bili.is_none());
        assert_eq!(reference.pgc.unwrap().ep_id, "7");
        let mut entry = Entry {
            media_id: Uuid::from_u128(1),
            room_id: Uuid::from_u128(2),
            provider: "bilibili".into(),
            canonical_url: Some(body.url.clone()),
            content_id: "ep7".into(),
            part: 1,
            cid: Some(8),
            revision: 1,
            pgc: Some(PgcIdentity::new("7".into(), "8".into(), "9".into())),
            course: None,
        };
        assert!(validate_entry(&entry).is_ok());
        entry.pgc = None;
        assert!(validate_entry(&entry).is_err());
        entry.pgc = Some(PgcIdentity::new("7".into(), "8".into(), "9".into()));
        entry.content_id = "BV1xx411c7mD".into();
        assert!(validate_entry(&entry).is_err());
        entry.content_id = "ep7".into();
        entry.provider = "youtube".into();
        assert!(validate_entry(&entry).is_err());
        entry.provider = "bilibili".into();
        entry.cid = Some(80);
        assert!(validate_entry(&entry).is_err());
        for url in [
            "https://www.bilibili.com/bangumi/play/ss7",
            "https://www.bilibili.com/bangumi/play/ep7?p=2",
        ] {
            assert!(
                parse_import(&ImportRequest {
                    url: url.into(),
                    credential_mode: None,
                    account_id: None,
                    live_version: None,
                    course_version: None,
                    ..body.clone()
                })
                .is_err()
            );
        }
        assert!(
            parse_import(&ImportRequest {
                url: "BV1xx411c7mD".into(),
                ..body
            })
            .is_err()
        );
    }
    #[test]
    fn title_is_room_local_bounded_plain_text() {
        let metadata = bilibili::VideoMetadata {
            bvid: "BV1xx411c7mD".into(),
            aid: "1".into(),
            cid: "2".into(),
            part: 2,
            part_count: 3,
            title: "a".repeat(300),
            part_title: "\nunsafe".into(),
            duration_seconds: 1,
        };
        assert_eq!(import_title(&metadata).chars().count(), 200);
        let metadata = bilibili::VideoMetadata {
            title: "\n\t".into(),
            part_count: 1,
            ..metadata
        };
        assert_eq!(import_title(&metadata), "平台影片");
    }
}
