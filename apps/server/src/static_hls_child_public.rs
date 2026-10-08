//! Private child orchestration for the existing authenticated playback route.
//!
//! The route supplies authentication/CSRF and membership checks. A supported
//! runtime gate is required before new work or any public plan. There is no
//! environment switch, alternate legacy reservation, or public proof DTO here.
//! The optional final sample remains part of the exact immutable intent hash;
//! it does not manufacture an observation/telemetry acceptance receipt.
use super::*;
use aes_gcm::aead::Aead;
use media_core::static_hls::contracts::{
    graph::RootGraphStatement, input::FrozenInput, operation::Action,
};
use persistence::{
    static_hls_child_claim::{self as claims, Claim, ExistingChild, PreparedChildInput},
    static_hls_pending::{self as pending, CatalogSnapshot},
};
use sqlx::Connection;
use static_hls_child_request::{ChildRequest, DecodeFailure, NewChild};
use static_hls_contract::SupportedGate;
use std::time::Duration;
use tokio::sync::oneshot;

/// Dispatch raw child intent before legacy serde can discard its closed lookup.
/// Absence leaves the existing legacy/parent parser and route unchanged.
pub(crate) fn parse_if_child(bytes: &[u8]) -> Result<Option<ChildRequest>> {
    let raw: Value = serde_json::from_slice(bytes)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_playback_request"))?;
    if raw.get("static_hls_fallback").is_some() {
        static_hls_child_request::parse(bytes).map(Some)
    } else {
        Ok(None)
    }
}

/// Called only after the existing route's auth(true), cookie-hash and member
/// checks. Its original executor, including claim COMMIT reconciliation, lives
/// independently of a disconnected HTTP waiter and participates in shutdown.
pub(crate) async fn start_authenticated(
    app: App,
    user: User,
    request: ChildRequest,
    login_hash: String,
    owner: preparation_owner::Owner,
) -> Result<Json<Value>> {
    let (send, wait) = oneshot::channel();
    tokio::spawn(async move {
        let mut send = Some(send);
        let result = owned(&app, user.id, &request, &login_hash, owner, &mut send).await;
        respond(&mut send, result);
    });
    wait.await
        .map_err(|_| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "static_hls_operation_receipt_unknown",
            )
        })?
        .map(Json)
}

fn respond(send: &mut Option<oneshot::Sender<Result<Value>>>, result: Result<Value>) {
    if let Some(send) = send.take() {
        let _ = send.send(result);
    }
}

struct RetainedChild {
    input: FrozenInput,
    parent_capture: Uuid,
    outcome: ExistingChild,
    response_encrypted: Option<String>,
}

async fn owned(
    app: &App,
    user: Uuid,
    request: &ChildRequest,
    login: &str,
    owner: preparation_owner::Owner,
    send: &mut Option<oneshot::Sender<Result<Value>>>,
) -> Result<Value> {
    // This precedes parent lookup, clocks, construction, claim and retirement.
    // A retired parent is expected on an exact-key retry, not a fresh intent.
    if let Some(retained) = retained(app, user, request, login).await? {
        return replay(app, request, retained).await;
    }
    // A generic reader probe, client report or stored row cannot grant this.
    // Resolve only after exact retained lookup so unavailable runtime metadata
    // cannot conceal a durable failed/in-progress result for the original key.
    let gate = supported_gate(app).await?;
    let client = client(app)?;
    let parent = tokio::time::timeout(
        Duration::from_millis(750),
        static_hls_child_parent::load_for_new_child(
            &app.db,
            static_hls_child_parent::ParentLookup {
                parent_session: request.parent_session_id(),
                user,
                login_hash: login,
                room: request.body().room_id,
                viewer: request.body().viewer_id.unwrap(),
            },
            |cipher| open_input(app, cipher),
            |cipher| open_root(app, cipher),
        ),
    )
    .await
    .map_err(|_| unknown())?
    .map_err(operation_error)?
    .ok_or_else(|| err(StatusCode::CONFLICT, "static_hls_child_parent_unavailable"))?;
    gate.require_input(&parent.input)
        .map_err(|_| unavailable())?;
    let (catalog, started) = catalog_and_clock(app, &parent.input).await?;
    let input = request.freeze_new(
        &parent.input,
        &parent.root,
        NewChild {
            user_id: user,
            auth_login_hash: login,
            request_owner_epoch: app.epoch,
            operation_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            preparation_started_at_ms: started,
        },
    )?;
    let prepared = PreparedChildInput::seal(
        input,
        parent.input.clone(),
        &parent.root,
        catalog,
        |plaintext| {
            let mut nonce = [0; 12];
            rand::rngs::OsRng.fill_bytes(&mut nonce);
            Ok(static_hls_input_cipher::seal_private_input_plaintext(
                &app.key, nonce, plaintext,
            )?)
        },
    )
    .map_err(operation_error)?;
    let reservation = reservation(request, prepared.input())?;
    let failure = match request.decoder_failure() {
        DecodeFailure::NativeDecode { code: 3 } => claims::DecoderFailure::NativeDecode,
        DecodeFailure::HlsMediaDecode {} => claims::DecoderFailure::FatalHlsMediaDecode,
        // The closed parser rejects every other decoder classification.
        DecodeFailure::NativeDecode { .. } => {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "invalid_static_hls_child_request",
            ));
        }
    };
    // All potentially delayed reads/crypto precede this final readiness check.
    // The claim still repeats actual parent/child authority under SQL locks.
    gate.require_input(&parent.input)
        .map_err(|_| unavailable())?;
    gate.require_input(prepared.input())
        .map_err(|_| unavailable())?;
    match claims::claim(
        &app.db,
        request.idempotency_key(),
        &prepared,
        failure,
        app.session_limit,
    )
    .await
    {
        Ok(Claim::Claimed(stop)) => {
            let original = parent.input.identity_statement();
            if stop.session.to_string() != original.session_id
                || stop.capture.to_string() != original.operation_id
                || stop.worker_instance.to_string() != original.worker_instance
            {
                // The claim is already durable: retain its preparation owner
                // while recording the positive Server preparation closure.
                acknowledge(app, reservation, owner);
                return Err(unknown());
            }
        }
        Ok(Claim::Existing(_)) => {
            let retained = retained(app, user, request, login)
                .await?
                .ok_or_else(unknown)?;
            return replay(app, request, retained).await;
        }
        Err(claim_error) => {
            // A lost COMMIT acknowledgement is not evidence of no claim. Wait
            // behind the original room/user locks before resolving absence.
            // If DB state is unknown, return unknown once but retain the exact
            // input/task/registry owner until resolution, including shutdown.
            let claim_error = operation_error(claim_error);
            loop {
                match reconcile(app, user, request, login).await {
                    Ok(Some(retained)) => {
                        if prepared
                            .input()
                            .require_same_frozen_input(&retained.input)
                            .is_ok()
                        {
                            if retained.outcome != ExistingChild::InProgress {
                                let result = replay(app, request, retained).await;
                                acknowledge(app, reservation, owner);
                                return result;
                            }
                            break;
                        }
                        // A same-key race has another original owner. Never
                        // reconstruct/adopt its preparation from retained SQL.
                        return replay(app, request, retained).await;
                    }
                    Ok(None) => return Err(claim_error),
                    Err(error)
                        if matches!(
                            error.1.as_str(),
                            "playback_request_conflict"
                                | "invalid_playback_session"
                                | "static_hls_child_parent_mismatch"
                                | "static_hls_contract_audio"
                        ) =>
                    {
                        // A positively read conflicting key/login is another
                        // intent, not an uncertain claim owned by this task.
                        return Err(error);
                    }
                    Err(_) => {
                        respond(send, Err(unknown()));
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }
    // Revocation in claim() is already atomic. This targets only the bound
    // original Worker operation; even a lost cancellation reply grants no
    // disposal evidence. Worker child creation independently requires original
    // parent custody and positive disposal before a fresh child can be admitted.
    let _ = client.call(&parent.input, Action::Cancel).await;
    let result = async {
        let queued = client
            .prepare_owned_child(
                prepared.input(),
                &parent.input,
                &parent.root,
                owner.cancelled(),
            )
            .await
            .map_err(operation_error)?;
        // Preparation can outlive the original six-second probe. A committed
        // reply stays immutable if a fresh read/runtime observation is missing.
        let gate = supported_gate(app).await?;
        gate.require_input(prepared.input())
            .map_err(|_| unavailable())?;
        let plan = queued.into_playback_plan().map_err(operation_error)?;
        serde_json::to_value(plan)
            .map_err(anyhow::Error::from)
            .map_err(Into::into)
    }
    .await;
    // Publication owns its original encrypted reply. Do not pass a child to
    // generic complete/fail or clear an already-committed success on a lost read.
    acknowledge(app, reservation, owner);
    result
}

fn acknowledge(
    app: &App,
    reservation: playback_requests::Reservation,
    owner: preparation_owner::Owner,
) {
    let app = app.clone();
    tokio::spawn(async move {
        owner.acknowledge(&app, &reservation).await;
    });
}

fn reservation(
    request: &ChildRequest,
    input: &FrozenInput,
) -> Result<playback_requests::Reservation> {
    let identity = input.identity_statement();
    Ok(playback_requests::Reservation {
        prepare_until: tokio::time::Instant::now() + std::time::Duration::from_secs(45),
        key: request.idempotency_key(),
        session: Uuid::parse_str(&identity.session_id).map_err(anyhow::Error::from)?,
        user: Uuid::parse_str(&identity.user_id).map_err(anyhow::Error::from)?,
        room_id: request.body().room_id,
        lifecycle_epoch: i64::try_from(identity.lifecycle_epoch).map_err(anyhow::Error::from)?,
        viewer_id: request.body().viewer_id,
        plan_generation: request.body().plan_generation,
        http_file: None,
        static_hls: Some(Box::new(input.clone())),
    })
}

async fn retained(
    app: &App,
    user: Uuid,
    request: &ChildRequest,
    login: &str,
) -> Result<Option<RetainedChild>> {
    let row = tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        fence(&mut tx).await?;
        let row = sqlx::query(RETAINED)
            .bind(user)
            .bind(request.idempotency_key())
            .fetch_optional(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(row)
    })
    .await
    .map_err(|_| unknown())??;
    match row {
        Some(row) => load_retained(app, user, request, login, row)
            .await
            .map(Some),
        None => Ok(None),
    }
}

// Same retained read, behind authority-prefix locks, only for resolving this
// original claim's uncertain COMMIT. This cannot reset/re-own a stored intent.
async fn reconcile(
    app: &App,
    user: Uuid,
    request: &ChildRequest,
    login: &str,
) -> Result<Option<RetainedChild>> {
    let row = tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        fence(&mut tx).await?;
        sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(request.body().room_id)
            .fetch_optional(&mut *tx)
            .await?;
        sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
        let row = sqlx::query(RETAINED_LOCKED)
            .bind(user)
            .bind(request.idempotency_key())
            .fetch_optional(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(row)
    })
    .await
    .map_err(|_| unknown())??;
    match row {
        Some(row) => load_retained(app, user, request, login, row)
            .await
            .map(Some),
        None => Ok(None),
    }
}

const RETAINED: &str = "SELECT r.*,r.response_encrypted IS NOT NULL AS response_present,(SELECT publication_phase FROM static_hls_captures WHERE session_id=r.session_id AND publication_phase<>'stage_a') AS capture_phase FROM playback_requests r WHERE r.user_id=$1 AND r.idempotency_key=$2";
const RETAINED_LOCKED: &str = "SELECT r.*,r.response_encrypted IS NOT NULL AS response_present,(SELECT publication_phase FROM static_hls_captures WHERE session_id=r.session_id AND publication_phase<>'stage_a') AS capture_phase FROM playback_requests r WHERE r.user_id=$1 AND r.idempotency_key=$2 FOR UPDATE OF r";

async fn fence(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> std::result::Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true)")
        .execute(&mut **tx).await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn load_retained(
    app: &App,
    user: Uuid,
    request: &ChildRequest,
    login: &str,
    row: sqlx::postgres::PgRow,
) -> Result<RetainedChild> {
    let request_hash: String = row.try_get("request_hash")?;
    let original_login: Option<String> = row.try_get("auth_login_hash")?;
    if original_login.as_deref() != Some(login) {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    if request_hash != request.request_sha256() {
        return Err(err(StatusCode::CONFLICT, "playback_request_conflict"));
    }
    let parent_capture = row
        .try_get::<Option<Uuid>, _>("static_hls_parent_capture_id")?
        .ok_or_else(|| err(StatusCode::CONFLICT, "playback_request_conflict"))?;
    let operation = row
        .try_get::<Option<Uuid>, _>("static_hls_operation_id")?
        .ok_or_else(unknown)?;
    let session: Uuid = row.try_get("session_id")?;
    let loaded = load_operation(app, operation, session).await?;
    request.require_frozen_replay(&loaded.input, user, login)?;
    let status: String = row.try_get("status")?;
    let code: Option<String> = row.try_get("error_code")?;
    let phase: Option<String> = row.try_get("capture_phase")?;
    let outcome = claims::retained_result(
        claims::RetainedChildStatement {
            input_version: row.try_get("static_hls_input_version")?,
            parent_capture: Some(parent_capture),
            request_hash: &request_hash,
            login: original_login.as_deref(),
            status: &status,
            error_status: row.try_get("error_status")?,
            error_code: code.as_deref(),
            response_present: row.try_get("response_present")?,
            capture_phase: phase.as_deref(),
        },
        request.request_sha256(),
        login,
        parent_capture,
    )
    .map_err(operation_error)?;
    // Match the private child linkage, not a caller-supplied capture UUID.
    let raw: Value =
        serde_json::from_slice(loaded.input.private_storage_plaintext()).map_err(|_| unknown())?;
    if raw["root"]["parent_capture_id"].as_str() != Some(parent_capture.to_string().as_str()) {
        return Err(unknown());
    }
    Ok(RetainedChild {
        input: loaded.input,
        parent_capture,
        outcome,
        response_encrypted: row.try_get("response_encrypted")?,
    })
}

async fn load_operation(
    app: &App,
    operation: Uuid,
    session: Uuid,
) -> Result<pending::LoadedOperation> {
    tokio::time::timeout(
        Duration::from_millis(750),
        pending::load_operation(&app.db, operation, session, |cipher| {
            open_input(app, cipher)
        }),
    )
    .await
    .map_err(|_| unknown())?
    .map_err(operation_error)?
    .ok_or_else(unknown)
}

async fn replay(app: &App, request: &ChildRequest, retained: RetainedChild) -> Result<Value> {
    match retained.outcome {
        ExistingChild::InProgress => Err(err(StatusCode::CONFLICT, "playback_request_in_progress")),
        ExistingChild::Failed { status, code } => Err(err(
            StatusCode::from_u16(status as u16).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &code,
        )),
        ExistingChild::PublishedChild => {
            let gate = supported_gate(app).await?;
            gate.require_input(&retained.input)
                .map_err(|_| unavailable())?;
            // Historical input/root only: the parent is deliberately stopped.
            // None of these reads can reconstruct custody or require a fresh
            // live parent grant. The plan adapter checks current CHILD gates.
            let parent =
                load_operation(app, retained.parent_capture, request.parent_session_id()).await?;
            let inventory: String = tokio::time::timeout(Duration::from_millis(750), async {
                let mut connection = app.db.acquire().await?;
                connection.close_on_drop();
                sqlx::query_scalar("SELECT inventory_encrypted FROM static_hls_captures WHERE id=$1 AND session_id=$2 AND publication_phase='published_parent' AND input_sha256=$3")
                    .bind(retained.parent_capture).bind(request.parent_session_id())
                    .bind(parent.input.input_sha256()).fetch_one(&mut *connection).await
            }).await.map_err(|_| unknown())??;
            let root = RootGraphStatement::parse_private_plaintext(
                &open_root(app, &inventory).map_err(operation_error)?,
            )
            .map_err(|_| unknown())?;
            root.require_parent_input(&parent.input)
                .map_err(|_| unknown())?;
            let response = retained.response_encrypted.as_deref().ok_or_else(unknown)?;
            let queued = static_hls_child_plan::from_committed_publication(
                &app.db,
                &app.key,
                &retained.input,
                &parent.input,
                &root,
                response,
            )
            .await
            .map_err(operation_error)?;
            let plan = queued.into_playback_plan().map_err(operation_error)?;
            gate.require_input(&retained.input)
                .map_err(|_| unavailable())?;
            serde_json::to_value(plan)
                .map_err(anyhow::Error::from)
                .map_err(Into::into)
        }
    }
}

async fn supported_gate(app: &App) -> Result<SupportedGate> {
    static_hls_contract::supported_child_gate(app)
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)
}

/// Optional parent negotiation uses actual installed readiness plus the exact
/// immutable original publication. Failure to observe optional capability
/// leaves the old parent response unchanged; it never grants child authority.
pub(crate) async fn advertise_parent_fallback(
    app: &App,
    mut plan: protocol::PlaybackPlan,
) -> anyhow::Result<protocol::PlaybackPlan> {
    plan.static_hls_fallback_version = None;
    let Ok(Some(gate)) = static_hls_contract::supported_child_gate(app).await else {
        return Ok(plan);
    };
    let input =
        static_hls_parent_plan::current_original_for_advertisement(&app.db, &app.key, &mut plan)
            .await?;
    gate.require_input(&input)?;
    plan.static_hls_fallback_version = Some(1);
    Ok(plan)
}

async fn catalog_and_clock(app: &App, parent: &FrozenInput) -> Result<(CatalogSnapshot, u64)> {
    let i = parent.identity_statement();
    let media = Uuid::parse_str(&i.media_id).map_err(anyhow::Error::from)?;
    let row = tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        sqlx::query("SELECT m.id AS media_id,m.source_id,m.resource,m.source_version,m.preview_generation,s.kind,s.config_encrypted,s.access_policy_revision,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS started_ms FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available AND s.kind='http' AND s.id=$2 AND s.access_policy_revision=$3 AND m.preview_generation=$4")
            .bind(media).bind(Uuid::parse_str(&i.source_id).map_err(|_| sqlx::Error::Protocol("static_hls_source_identity".into()))?)
            .bind(i64::try_from(i.source_policy_revision).map_err(|_| sqlx::Error::Protocol("static_hls_source_identity".into()))?)
            .bind(i64::try_from(i.media_source_generation).map_err(|_| sqlx::Error::Protocol("static_hls_source_identity".into()))?)
            .fetch_optional(&mut *connection).await
    }).await.map_err(|_| unknown())??
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_changed"))?;
    Ok((
        CatalogSnapshot::from_row(&row),
        u64::try_from(row.try_get::<i64, _>("started_ms")?).map_err(anyhow::Error::from)?,
    ))
}

fn open_input(app: &App, cipher: &str) -> anyhow::Result<Vec<u8>> {
    Ok(static_hls_input_cipher::open_private_input_plaintext(
        &app.key,
        cipher.as_bytes(),
    )?)
}
fn open_root(app: &App, cipher: &str) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        !cipher.is_empty() && cipher.len() <= 262_144,
        "static_hls_parent_inventory_bounds"
    );
    let bytes = STANDARD
        .decode(cipher)
        .map_err(|_| anyhow::anyhow!("static_hls_parent_inventory_shape"))?;
    anyhow::ensure!(bytes.len() >= 28, "static_hls_parent_inventory_bounds");
    let plain = app
        .key
        .decrypt(bytes[..12].into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("static_hls_parent_inventory_authentication"))?;
    anyhow::ensure!(
        !plain.is_empty() && plain.len() <= 262_144,
        "static_hls_parent_inventory_bounds"
    );
    Ok(plain)
}
fn client(app: &App) -> Result<static_hls_operation_client::Client> {
    static_hls_operation_client::Client::new(
        app.db.clone(),
        app.key.clone(),
        std::path::PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into())),
        &std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into()),
    )
    .map_err(operation_error)
}
fn unavailable() -> Error {
    err(StatusCode::CONFLICT, "static_hls_child_not_available")
}
fn unknown() -> Error {
    err(
        StatusCode::SERVICE_UNAVAILABLE,
        "static_hls_operation_receipt_unknown",
    )
}
fn operation_error(error: anyhow::Error) -> Error {
    match error.to_string().as_str() {
        "playback_request_conflict" => err(StatusCode::CONFLICT, "playback_request_conflict"),
        "static_hls_exact_login_required" => err(StatusCode::GONE, "invalid_playback_session"),
        "too_many_playback_sessions" => {
            err(StatusCode::TOO_MANY_REQUESTS, "too_many_playback_sessions")
        }
        "static_hls_source_changed" => err(StatusCode::CONFLICT, "source_changed"),
        "static_hls_child_parent_required" | "static_hls_child_parent_unavailable" => {
            err(StatusCode::CONFLICT, "static_hls_child_parent_unavailable")
        }
        "static_hls_child_authority_required" | "static_hls_child_authority_revoked" => {
            err(StatusCode::GONE, "invalid_playback_session")
        }
        "static_hls_contract_deadline" | "static_hls_child_expired" => {
            err(StatusCode::GONE, "playback_request_expired")
        }
        "static_hls_child_output_not_ready" => {
            err(StatusCode::CONFLICT, "static_hls_child_output_not_ready")
        }
        "static_hls_child_preparation_cancelled" => {
            err(StatusCode::GONE, "playback_request_cancelled")
        }
        _ => unknown(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Value {
        json!({
            "static_hls_fallback_version":1,
            "static_hls_fallback":{
                "parent_session_id":Uuid::from_u128(2),
                "failure":{"kind":"native_decode","code":3},
                "final_observation":null,
            },
            "idempotency_key":Uuid::from_u128(12),
            "room_id":Uuid::from_u128(5),"media_generation":0,
            "viewer_id":Uuid::from_u128(8),"plan_generation":2,
            "mode":"transcode","position_ms":13.125,
            "capabilities":{
                "progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":false,
            },
        })
    }

    #[test]
    fn raw_dispatch_never_hides_a_child_lookup_in_legacy_serde() {
        assert!(
            parse_if_child(br#"{"future_legacy_offer":true}"#)
                .unwrap()
                .is_none()
        );
        assert!(
            parse_if_child(&serde_json::to_vec(&request()).unwrap())
                .unwrap()
                .is_some()
        );
        let mut null = request();
        null["static_hls_fallback"] = Value::Null;
        assert!(parse_if_child(&serde_json::to_vec(&null).unwrap()).is_err());
        let encoded = serde_json::to_string(&request()).unwrap();
        let duplicate = encoded.replacen(
            "\"mode\":\"transcode\"",
            "\"mode\":\"transcode\",\"mode\":\"transcode\"",
            1,
        );
        assert!(parse_if_child(duplicate.as_bytes()).is_err());
    }

    #[test]
    fn child_reservation_retains_original_complete_hash_and_root_budget() {
        let request =
            static_hls_child_request::parse(&serde_json::to_vec(&request()).unwrap()).unwrap();
        let parent = FrozenInput::parse_private_plaintext(include_bytes!(
            "../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json"
        ))
        .unwrap();
        let root = RootGraphStatement::parse_private_plaintext(include_bytes!(
            "../../../crates/media-core/src/static_hls/contracts/golden_root_v1.json"
        ))
        .unwrap();
        let input = request.freeze_new(&parent, &root, NewChild {
            user_id: Uuid::from_u128(4),
            auth_login_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            request_owner_epoch: Uuid::from_u128(3),
            operation_id: Uuid::from_u128(101),
            session_id: Uuid::from_u128(102),
            preparation_started_at_ms: 100_000,
        }).unwrap();
        let reservation = reservation(&request, &input).unwrap();
        assert_eq!(reservation.key, request.idempotency_key());
        assert_eq!(reservation.session, Uuid::from_u128(102));
        assert!(reservation.http_file.is_none());
        let retained = reservation.static_hls.as_ref().unwrap();
        retained.require_same_frozen_input(&input).unwrap();
        assert_eq!(
            retained.identity_statement().request_sha256,
            request.request_sha256()
        );
        assert_eq!(retained.root_deadline_ms(), parent.root_deadline_ms());
        assert_eq!(retained.preparation_deadline_ms(), 145_000);
    }

    #[test]
    fn safe_error_mapping_does_not_expose_private_transport_details() {
        let unknown = operation_error(anyhow::anyhow!(
            "https://private.invalid/?credential=secret"
        ));
        assert_eq!(unknown.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(unknown.1, "static_hls_operation_receipt_unknown");
        let conflict = operation_error(anyhow::anyhow!("playback_request_conflict"));
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert_eq!(conflict.1, "playback_request_conflict");
        let missing_gate = unavailable();
        assert_eq!(missing_gate.0, StatusCode::CONFLICT);
        assert_eq!(missing_gate.1, "static_hls_child_not_available");
    }
}
