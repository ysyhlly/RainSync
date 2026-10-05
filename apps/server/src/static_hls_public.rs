//! Local, opt-in parent preparation through the existing authenticated route.
//! This slice does not advertise a child continuation or enable deployment.
#[cfg(all(test, target_os = "linux"))]
mod native_tests;
use super::*;
use media_core::static_hls::contracts::{
    input::FrozenInput,
    operation::{OperationResult, Reason},
};
use persistence::static_hls_pending::PreparedParentInput;

pub(crate) fn parse(bytes: &[u8]) -> Result<protocol::PlaybackRequest> {
    let raw: Value = serde_json::from_slice(bytes)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_playback_request"))?;
    // Child reports must never disappear into legacy serde's unknown fields.
    if raw.get("static_hls_fallback").is_some() {
        return Err(err(StatusCode::CONFLICT, "static_hls_child_not_available"));
    }
    let mut body: protocol::PlaybackRequest = serde_json::from_slice(bytes)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_playback_request"))?;
    validate(&body)?;
    playback_metrics::validate(&body)?;
    if body.static_hls_fallback_version.is_some() {
        let object = raw
            .as_object()
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_static_hls_negotiation"))?;
        const FIELDS: &[&str] = &[
            "static_hls_fallback_version",
            "upstream_profile_report",
            "http_file_fallback_version",
            "http_file_fallback",
            "viewer_id",
            "plan_generation",
            "idempotency_key",
            "room_id",
            "media_generation",
            "mode",
            "position_ms",
            "audio_index",
            "capabilities",
            "observation_version",
            "candidate_report",
            "playback_metrics_version",
            "playback_metrics",
            "playback_metrics_supported_versions",
        ];
        if object.keys().any(|key| !FIELDS.contains(&key.as_str())) {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "invalid_static_hls_negotiation",
            ));
        }
        for (name, id) in [
            ("room_id", Some(body.room_id)),
            ("viewer_id", body.viewer_id),
            ("idempotency_key", body.idempotency_key),
        ] {
            if id
                .is_none_or(|id| id.is_nil() || raw[name].as_str() != Some(id.to_string().as_str()))
            {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    "invalid_static_hls_negotiation",
                ));
            }
        }
        let capabilities = raw["capabilities"]
            .as_object()
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_static_hls_negotiation"))?;
        if capabilities.keys().any(|key| {
            !matches!(
                key.as_str(),
                "progressive_h264_aac" | "native_hls" | "mse_h264_aac" | "report"
            )
        }) {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "invalid_static_hls_negotiation",
            ));
        }
        if body.position_ms == 0.0 {
            body.position_ms = 0.0;
        }
    }
    Ok(body)
}

pub(crate) fn validate(body: &protocol::PlaybackRequest) -> Result<()> {
    if let Some(version) = body.static_hls_fallback_version
        && (version != 1
            || body.idempotency_key.is_none_or(|id| id.is_nil())
            || body.viewer_id.is_none_or(|id| id.is_nil())
            || body.room_id.is_nil()
            || body.plan_generation.is_none_or(|n| n == 0)
            || !body.position_ms.is_finite()
            || body.position_ms < 0.0
            || body.capabilities.is_none()
            || body
                .capabilities
                .as_ref()
                .is_some_and(|c| c.report.is_some())
            || body.http_file_fallback.is_some()
            || body.candidate_report.is_some()
            || body.upstream_profile_report.is_some())
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_static_hls_negotiation",
        ));
    }
    Ok(())
}

pub(crate) fn offered(body: &protocol::PlaybackRequest, enabled: bool) -> bool {
    enabled
        && body.static_hls_fallback_version == Some(1)
        && body
            .mode
            .as_deref()
            .is_none_or(|m| matches!(m, "auto" | "direct"))
        && body.capabilities.as_ref().is_some_and(|c| c.supports_hls())
}

pub(crate) async fn begin(
    app: &App,
    user: Uuid,
    body: &protocol::PlaybackRequest,
    login: Option<&str>,
) -> Result<Option<Box<PreparedParentInput>>> {
    if !offered(
        body,
        std::env::var("STATIC_HLS_PARENT_PREPARE_ENABLED").is_ok_and(|v| v == "1"),
    ) {
        return Ok(None);
    }
    let login = login.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?;
    // Existing keys reach begin_authenticated's exact-login/hash replay checks
    // before probing a Worker or freezing a new operation/owner/viewer intent.
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2)",
    )
    .bind(user)
    .bind(body.idempotency_key)
    .fetch_one(&app.db)
    .await?;
    if exists {
        return Ok(None);
    }
    let http:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_snapshots snap JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid JOIN sources s ON s.id=m.source_id WHERE snap.room_id=$1 AND m.available AND s.kind='http')")
        .bind(body.room_id).fetch_one(&app.db).await?;
    if !http {
        return Ok(None);
    }
    // Bootstrap only the authenticated actual startup/DB/shared-cache binding.
    // The typed operation itself checks exact reader2/recipe1 before admission;
    // this Stage-A observation alone grants no capture or rollout authority.
    let cache =
        std::path::PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into()));
    let observed = static_hls_contract::probe(app, &cache).await.map_err(|_| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "static_hls_worker_unavailable",
        )
    })?;
    match playback_requests::static_hls_pending::build_and_freeze(
        app,
        user,
        body,
        login,
        observed.worker.instance,
    )
    .await?
    {
        playback_requests::static_hls_pending::Frozen::New(prepared) => Ok(Some(prepared)),
        playback_requests::static_hls_pending::Frozen::Existing(_) => Ok(None),
    }
}

pub(crate) fn reservation(
    body: &protocol::PlaybackRequest,
    prepared: &PreparedParentInput,
) -> Result<playback_requests::Reservation> {
    let i = prepared.input().identity_statement();
    Ok(playback_requests::Reservation {
        prepare_until: tokio::time::Instant::now() + std::time::Duration::from_secs(45),
        key: body
            .idempotency_key
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "idempotency_key_required"))?,
        session: Uuid::parse_str(&i.session_id).map_err(anyhow::Error::from)?,
        user: Uuid::parse_str(&i.user_id).map_err(anyhow::Error::from)?,
        room_id: body.room_id,
        lifecycle_epoch: i64::try_from(i.lifecycle_epoch).map_err(anyhow::Error::from)?,
        viewer_id: body.viewer_id,
        plan_generation: body.plan_generation,
        http_file: None,
        static_hls: Some(Box::new(prepared.input().clone())),
    })
}

pub(crate) fn native_allowed(result: &OperationResult) -> bool {
    matches!(
        result,
        OperationResult::Disposed { .. }
            | OperationResult::Refused {
                capture_id: None,
                reason: Reason::UnsupportedInput
            }
    )
}

pub(crate) async fn prepare(
    app: &App,
    user: &User,
    body: &protocol::PlaybackRequest,
    reservation: &playback_requests::Reservation,
    prepared: &PreparedParentInput,
    owner: &preparation_owner::Owner,
    login: Option<&str>,
) -> Result<Value> {
    match playback_requests::static_hls_pending::prepare_new_frozen(
        app,
        prepared,
        owner.cancelled(),
    )
    .await?
    {
        static_hls_operation_client::ParentPreparation::Published { plan } => {
            let plan: protocol::PlaybackPlan =
                serde_json::from_value(plan).map_err(anyhow::Error::from)?;
            let plan = static_hls_child_public::advertise_parent_fallback(app, plan).await?;
            serde_json::to_value(plan)
                .map_err(anyhow::Error::from)
                .map_err(Into::into)
        }
        static_hls_operation_client::ParentPreparation::QualificationEnded { observation } => {
            if !native_allowed(observation.result()) {
                return Err(err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "static_hls_qualification_refused",
                ));
            }
            let client = client(app)?;
            let until = client
                .remaining_preparation_deadline(prepared.input())
                .await
                .map_err(|_| err(StatusCode::CONFLICT, "playback_request_interrupted"))?;
            let mut ordinary = body.clone();
            ordinary.mode = Some("direct".into());
            tokio::time::timeout_at(
                until,
                media::prepare_playback(app, user, &ordinary, reservation, login),
            )
            .await
            .unwrap_or_else(|_| Err(err(StatusCode::CONFLICT, "playback_request_interrupted")))
        }
    }
}

fn client(app: &App) -> Result<static_hls_operation_client::Client> {
    static_hls_operation_client::Client::new(
        app.db.clone(),
        app.key.clone(),
        std::path::PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into())),
        &std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into()),
    )
    .map_err(Into::into)
}

pub(crate) fn original_target(input: &FrozenInput) -> Result<String> {
    let value: Value =
        serde_json::from_slice(input.private_storage_plaintext()).map_err(anyhow::Error::from)?;
    value["source"]["canonical_target"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_changed"))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value {
        json!({"room_id":Uuid::new_v4(),"idempotency_key":Uuid::new_v4(),"viewer_id":Uuid::new_v4(),"plan_generation":1,"media_generation":0,"position_ms":0,"static_hls_fallback_version":1,"capabilities":{"progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":false}})
    }
    fn decode(value: &Value) -> Result<protocol::PlaybackRequest> {
        parse(&serde_json::to_vec(value).unwrap())
    }
    #[test]
    fn legacy_offer_absence_preserves_serialized_contract() {
        let body=parse(br#"{"room_id":"11111111-1111-4111-8111-111111111111","media_generation":0,"future_legacy_offer":true}"#).unwrap();
        assert!(!offered(&body, true));
        assert!(
            serde_json::to_value(body)
                .unwrap()
                .get("static_hls_fallback_version")
                .is_none()
        );
    }
    #[test]
    fn capability_and_local_gate_are_both_required() {
        let mut body = decode(&request()).unwrap();
        assert!(offered(&body, true));
        assert!(!offered(&body, false));
        body.capabilities.as_mut().unwrap().native_hls = false;
        assert!(!offered(&body, true));
        body.capabilities.as_mut().unwrap().mse_h264_aac = true;
        assert!(offered(&body, true));
        body.mode = Some("transcode".into());
        assert!(!offered(&body, true));
    }
    #[test]
    fn negotiated_unknown_fields_cannot_be_ignored() {
        for (key, value) in [
            ("fallback_recipe", json!("unsafe")),
            ("source_url", json!("http://127.0.0.1/")),
        ] {
            let mut v = request();
            v[key] = value;
            assert!(decode(&v).is_err());
        }
        let mut v = request();
        v["capabilities"]["future_decoding_flag"] = json!(true);
        assert!(decode(&v).is_err());
    }
    #[test]
    fn child_lookup_never_falls_through_legacy_parsing() {
        let mut v = request();
        v.as_object_mut()
            .unwrap()
            .remove("static_hls_fallback_version");
        v["static_hls_fallback"] = json!({"parent_session_id":Uuid::new_v4()});
        assert!(decode(&v).is_err());
    }
    #[test]
    fn negotiated_identity_requires_complete_canonical_ordering() {
        for (key, value) in [
            ("static_hls_fallback_version", json!(2)),
            ("plan_generation", json!(0)),
            ("viewer_id", Value::Null),
            ("idempotency_key", json!(Uuid::nil())),
            ("position_ms", json!(-1)),
            ("capabilities", Value::Null),
            ("candidate_report", json!({})),
        ] {
            let mut v = request();
            v[key] = value;
            assert!(decode(&v).is_err(), "{key}");
        }
        let mut v = request();
        v["room_id"] = json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
        assert!(decode(&v).is_err());
    }
    #[test]
    fn signed_zero_retries_share_the_same_canonical_hash() {
        let mut v = request();
        let positive = decode(&v).unwrap();
        v["position_ms"] = json!(-0.0);
        let negative = decode(&v).unwrap();
        assert_eq!(
            serde_json::to_vec(&positive).unwrap(),
            serde_json::to_vec(&negative).unwrap()
        );
    }
    #[test]
    fn unknown_or_capacity_refusal_cannot_authorize_ordinary_playback() {
        let id = Uuid::new_v4().to_string();
        assert!(native_allowed(&OperationResult::Disposed {
            capture_id: id.clone(),
            disposed_at_ms: 1
        }));
        assert!(native_allowed(&OperationResult::Refused {
            capture_id: None,
            reason: Reason::UnsupportedInput
        }));
        assert!(!native_allowed(&OperationResult::Unknown {
            capture_id: Some(id.clone()),
            reason: Reason::UnsupportedInput
        }));
        assert!(!native_allowed(&OperationResult::Refused {
            capture_id: Some(id.clone()),
            reason: Reason::UnsupportedInput
        }));
        assert!(!native_allowed(&OperationResult::CancelRequested {
            capture_id: id
        }));
    }
}
