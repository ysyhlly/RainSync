//! Authenticated readiness for the exact original committed child receipt.
//! Retained statements grant neither physical custody nor a generic output read.
use super::{App, Error, Result, err, static_hls_child_plan, static_hls_input_cipher};
use aes_gcm::{Aes256Gcm, aead::Aead};
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement,
    input::{FrozenInput, OperationKind},
};
use sqlx::{Connection, Row, postgres::PgRow};
use std::{future::Future, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

const READ_BUDGET: Duration = Duration::from_millis(750);

enum Lookup {
    NotChild,
    Child(Option<PgRow>),
}

/// None means positively non-child. Once any retained child marker is found,
/// missing metadata or revoked authority is an error, never generic fallback.
pub(crate) async fn read_authenticated(
    app: &App,
    user: Uuid,
    login_hash: &str,
    session: Uuid,
    requested_generation: Option<u32>,
    relative_position_ms: Option<f64>,
) -> Result<Option<protocol::PlaybackReadiness>> {
    let row = match original_tuple(app, user, login_hash, session).await? {
        Lookup::NotChild => return Ok(None),
        Lookup::Child(None) => return Err(err(StatusCode::GONE, "invalid_playback_session")),
        Lookup::Child(Some(row)) => row,
    };
    let generation = u32::try_from(row.try_get::<i64, _>("plan_generation")?)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(unknown)?;
    if requested_generation.is_some_and(|value| value != generation) {
        return Err(err(StatusCode::CONFLICT, "stale_playback_plan"));
    }
    let status: String = row.try_get("job_status")?;
    match status.as_str() {
        "failed" => {
            let reason: Option<String> = row.try_get("job_error")?;
            let (status, code) = persistence::media_jobs::terminal_error(reason.as_deref());
            return Err(err(
                StatusCode::from_u16(status).expect("fixed terminal status"),
                code,
            ));
        }
        "cancelled" => return Err(err(StatusCode::GONE, "media_job_cancelled")),
        "queued" | "running" | "succeeded" => {}
        _ => return Err(unknown()),
    }
    let capture: Uuid = row.try_get("child_capture")?;
    let child_hash: String = row.try_get("child_hash")?;
    let parent_capture: Uuid = row.try_get("parent_capture")?;
    let parent_session: Uuid = row.try_get("parent_session")?;
    let parent_hash: String = row.try_get("parent_hash")?;
    let root_digest: String = row.try_get("root_digest")?;
    let inventory: String = row.try_get("inventory_encrypted")?;
    let reply: String = row.try_get("response_encrypted")?;
    let child = load_input(app, capture, session).await?;
    require_caller(&child, user, login_hash, session, generation).map_err(private_error)?;
    let parent = load_input(app, parent_capture, parent_session).await?;
    let root = open_root(&app.key, &inventory).map_err(private_error)?;
    require_tuple(
        &child,
        &parent,
        &root,
        ExpectedTuple {
            capture,
            session,
            child_hash: &child_hash,
            parent_capture,
            parent_session,
            parent_hash: &parent_hash,
            root_digest: &root_digest,
        },
    )
    .map_err(private_error)?;
    // The stopped, disposed parent is historical evidence. No fresh parent
    // grant is required or adopted. The adapter repeats current CHILD gates
    // after decryption, including full proof, disposal and the read predicate.
    let plan = static_hls_child_plan::from_committed_publication(
        &app.db, &app.key, &child, &parent, &root, &reply,
    )
    .await
    .map_err(private_error)?;
    if plan.session_id() != session || plan.plan_generation() != generation {
        return Err(unknown());
    }
    plan.into_readiness(relative_position_ms)
        .map(Some)
        .map_err(private_error)
}

fn require_caller(
    child: &FrozenInput,
    user: Uuid,
    login_hash: &str,
    session: Uuid,
    generation: u32,
) -> anyhow::Result<()> {
    let identity = child.identity_statement();
    anyhow::ensure!(
        child.kind() == OperationKind::Child
            && identity.session_id == session.to_string()
            && identity.user_id == user.to_string()
            && identity.auth_login_hash == login_hash
            && identity.plan_generation == u64::from(generation),
        "static_hls_child_readiness_caller_changed"
    );
    Ok(())
}

struct ExpectedTuple<'a> {
    capture: Uuid,
    session: Uuid,
    child_hash: &'a str,
    parent_capture: Uuid,
    parent_session: Uuid,
    parent_hash: &'a str,
    root_digest: &'a str,
}

fn require_tuple(
    child: &FrozenInput,
    parent: &FrozenInput,
    root: &RootGraphStatement,
    expected: ExpectedTuple<'_>,
) -> anyhow::Result<()> {
    let identity = child.identity_statement();
    let original = parent.identity_statement();
    anyhow::ensure!(
        identity.operation_id == expected.capture.to_string()
            && identity.session_id == expected.session.to_string()
            && child.input_sha256() == expected.child_hash
            && original.operation_id == expected.parent_capture.to_string()
            && original.session_id == expected.parent_session.to_string()
            && parent.input_sha256() == expected.parent_hash
            && root.root_digest() == expected.root_digest,
        "static_hls_child_readiness_tuple_changed"
    );
    root.require_parent_input(parent)?;
    child.require_child_of(parent, root.root_digest(), root.selected_audio_statement())?;
    Ok(())
}

async fn original_tuple(app: &App, user: Uuid, login: &str, session: Uuid) -> Result<Lookup> {
    bounded_read(async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        sqlx::query("SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true),set_config('rainsync.static_hls_child_reader','original_published_child_v1',true)")
            .execute(&mut *tx).await?;
        sqlx::query("SET LOCAL statement_timeout='750ms'")
            .execute(&mut *tx).await?;
        let child: bool = sqlx::query_scalar(CLASSIFY_CHILD)
            .bind(session).fetch_one(&mut *tx).await?;
        let result = if child {
            Lookup::Child(sqlx::query(ORIGINAL_TUPLE)
                .bind(session).bind(user).bind(login).fetch_optional(&mut *tx).await?)
        } else {
            Lookup::NotChild
        };
        tx.commit().await?;
        Ok::<_, sqlx::Error>(result)
    }).await
}

async fn load_input(app: &App, operation: Uuid, session: Uuid) -> Result<FrozenInput> {
    let loaded = bounded_read(persistence::static_hls_pending::load_operation(
        &app.db,
        operation,
        session,
        |cipher| {
            Ok(static_hls_input_cipher::open_private_input_plaintext(
                &app.key,
                cipher.as_bytes(),
            )?)
        },
    ))
    .await?
    .ok_or_else(unknown)?;
    Ok(loaded.input)
}

/// Acquisition, SQL, COMMIT and synchronous decoding share one absolute budget
/// starting when the read is called. timeout_at can poll an already-ready but
/// late future first, so the final monotonic check rejects that result too.
fn bounded_read<T, E>(
    future: impl Future<Output = std::result::Result<T, E>>,
) -> impl Future<Output = Result<T>>
where
    E: Into<anyhow::Error>,
{
    // Capture synchronously at invocation, not when the returned future is
    // first polled. Scheduling delay must consume the same fixed budget.
    let until = Instant::now().checked_add(READ_BUDGET);
    async move {
        let until = until.ok_or_else(unknown)?;
        let result = tokio::time::timeout_at(until, future)
            .await
            .map_err(|_| unknown())?;
        accept_before_deadline(result, until, Instant::now())?
            .map_err(|error| private_error(error.into()))
    }
}

fn accept_before_deadline<T>(value: T, until: Instant, now: Instant) -> Result<T> {
    if now >= until {
        return Err(unknown());
    }
    Ok(value)
}

fn open_root(key: &Aes256Gcm, encrypted: &str) -> anyhow::Result<RootGraphStatement> {
    anyhow::ensure!(
        !encrypted.is_empty() && encrypted.len() <= 262_144,
        "static_hls_parent_inventory_bounds"
    );
    let bytes = STANDARD
        .decode(encrypted)
        .map_err(|_| anyhow::anyhow!("static_hls_parent_inventory_shape"))?;
    anyhow::ensure!(bytes.len() >= 28, "static_hls_parent_inventory_bounds");
    let plaintext = key
        .decrypt(bytes[..12].into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("static_hls_parent_inventory_authentication"))?;
    anyhow::ensure!(
        !plaintext.is_empty() && plaintext.len() <= 262_144,
        "static_hls_parent_inventory_bounds"
    );
    RootGraphStatement::parse_private_plaintext(&plaintext).map_err(Into::into)
}

fn unknown() -> Error {
    err(
        StatusCode::SERVICE_UNAVAILABLE,
        "static_hls_operation_receipt_unknown",
    )
}

fn private_error(error: anyhow::Error) -> Error {
    match error.to_string().as_str() {
        "invalid_position" => err(StatusCode::BAD_REQUEST, "invalid_position"),
        "static_hls_child_expired" | "static_hls_contract_deadline" => {
            err(StatusCode::GONE, "playback_request_expired")
        }
        "static_hls_child_authority_required" | "static_hls_child_authority_revoked" => {
            err(StatusCode::GONE, "invalid_playback_session")
        }
        _ => unknown(),
    }
}

// Classification is not authorization. Even a broken child tuple must never
// reach the generic reader and inherit numerical v3/v4 compatibility.
const CLASSIFY_CHILD: &str = r#"
SELECT EXISTS(SELECT 1 FROM playback_requests r
    WHERE r.session_id=$1 AND r.static_hls_parent_capture_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM static_hls_captures c
    WHERE c.session_id=$1 AND c.publication_phase IN ('pending_child','published_child'))
 OR EXISTS(SELECT 1 FROM media_jobs j
    WHERE j.session_id=$1 AND j.spec->>'kind'='static_hls_child')
 OR EXISTS(SELECT 1 FROM static_hls_child_output_publications proof
    JOIN media_jobs j ON j.id=proof.job_id WHERE j.session_id=$1)
"#;

// Selectors only. Current authority and full proof remain in the dedicated
// persistence adapter, rather than a second copy of its large SQL statement.
const ORIGINAL_TUPLE: &str = r#"
SELECT r.static_hls_operation_id AS child_capture,
 r.static_hls_input_sha256 AS child_hash,r.plan_generation,r.response_encrypted,
 parent.id AS parent_capture,parent.session_id AS parent_session,
 parent.input_sha256 AS parent_hash,parent.root_digest,parent.inventory_encrypted,
 j.status AS job_status,j.error AS job_error
FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id
 JOIN static_hls_captures c ON c.id=r.static_hls_operation_id AND c.session_id=r.session_id
 JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
 JOIN playback_requests original ON original.session_id=parent.session_id
 JOIN media_jobs j ON j.id=r.session_id AND j.session_id=r.session_id
WHERE r.session_id=$1 AND r.user_id=$2 AND r.auth_login_hash=$3
 AND p.user_id=$2 AND p.auth_login_hash=$3
 AND r.status='completed' AND r.static_hls_input_version=1
 AND r.response_encrypted IS NOT NULL
 AND c.publication_phase='published_child' AND parent.publication_phase='published_parent'
 AND original.static_hls_operation_id=parent.id AND original.static_hls_input_sha256=parent.input_sha256
 AND j.logical_queue='static_hls_v1' AND static_hls_child_job_matches(j,r,c)
 AND static_hls_child_grant_authority_allowed(r.session_id)
 AND playback_caller_allowed(p.resource,$2,$3)
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::KeyInit;
    use serde_json::{Value, json};

    const PARENT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json");
    const ROOT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_root_v1.json");

    fn statements() -> (FrozenInput, FrozenInput, RootGraphStatement) {
        let parent = FrozenInput::parse_private_plaintext(PARENT).unwrap();
        let root = RootGraphStatement::parse_private_plaintext(ROOT).unwrap();
        let mut value: Value = serde_json::from_slice(PARENT).unwrap();
        value["kind"] = json!("child");
        value["operation_id"] = json!(Uuid::from_u128(13));
        value["session_id"] = json!(Uuid::from_u128(14));
        value["request_owner_epoch"] = json!(Uuid::from_u128(15));
        value["request_sha256"] = json!("2".repeat(64));
        value["plan_generation"] = json!(2);
        value["prepare_started_at_ms"] = json!(2000);
        value["prepare_expires_at_ms"] = json!(47000);
        value["position_ms"] = json!(13.125);
        value["root"] = json!({
            "parent_session_id": parent.identity_statement().session_id,
            "parent_capture_id": parent.identity_statement().operation_id,
            "parent_input_sha256": parent.input_sha256(),
            "root_digest": root.root_digest(),
            "root_admitted_at_ms": 1000,
            "root_hard_expires_at_ms": 1801000,
            "selected_audio": {"kind":"single", "stream_index":1},
        });
        let child =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        (parent, child, root)
    }

    fn expected<'a>(
        child: &'a FrozenInput,
        parent: &'a FrozenInput,
        root: &'a RootGraphStatement,
    ) -> ExpectedTuple<'a> {
        ExpectedTuple {
            capture: Uuid::parse_str(&child.identity_statement().operation_id).unwrap(),
            session: Uuid::parse_str(&child.identity_statement().session_id).unwrap(),
            child_hash: child.input_sha256(),
            parent_capture: Uuid::parse_str(&parent.identity_statement().operation_id).unwrap(),
            parent_session: Uuid::parse_str(&parent.identity_statement().session_id).unwrap(),
            parent_hash: parent.input_sha256(),
            root_digest: root.root_digest(),
        }
    }

    #[test]
    fn authenticated_caller_binding_rejects_same_user_other_login_session_and_generation() {
        let (parent, child, _) = statements();
        let user = Uuid::from_u128(4);
        let session = Uuid::from_u128(14);
        let login = "a".repeat(64);
        assert!(require_caller(&child, user, &login, session, 2).is_ok());
        for (input, user, login, session, generation) in [
            (&parent, user, login.clone(), session, 2),
            (&child, Uuid::from_u128(99), login.clone(), session, 2),
            (&child, user, "b".repeat(64), session, 2),
            (&child, user, login.clone(), Uuid::from_u128(99), 2),
            (&child, user, login.clone(), session, 1),
            (&child, user, login.clone(), session, 0),
        ] {
            assert_eq!(
                require_caller(input, user, &login, session, generation)
                    .unwrap_err()
                    .to_string(),
                "static_hls_child_readiness_caller_changed"
            );
        }
    }

    #[test]
    fn immutable_tuple_requires_exact_child_parent_and_root_selectors() {
        let (parent, child, root) = statements();
        assert!(require_tuple(&child, &parent, &root, expected(&child, &parent, &root)).is_ok());
        for field in 0..7 {
            let mut lookup = expected(&child, &parent, &root);
            match field {
                0 => lookup.capture = Uuid::from_u128(99),
                1 => lookup.session = Uuid::from_u128(99),
                2 => lookup.child_hash = "foreign-child-input",
                3 => lookup.parent_capture = Uuid::from_u128(99),
                4 => lookup.parent_session = Uuid::from_u128(99),
                5 => lookup.parent_hash = "foreign-parent-input",
                6 => lookup.root_digest = "foreign-root",
                _ => unreachable!(),
            }
            assert_eq!(
                require_tuple(&child, &parent, &root, lookup)
                    .unwrap_err()
                    .to_string(),
                "static_hls_child_readiness_tuple_changed"
            );
        }
    }

    #[test]
    fn retained_root_inventory_is_authenticated_bounded_and_not_an_owner() {
        let key = Aes256Gcm::new_from_slice(&[17; 32]).unwrap();
        let nonce = [19; 12];
        let ciphertext = key.encrypt((&nonce).into(), ROOT).unwrap();
        let encrypted = STANDARD.encode([nonce.as_slice(), ciphertext.as_slice()].concat());
        let root = open_root(&key, &encrypted).unwrap();
        assert_eq!(root.root_digest(), statements().2.root_digest());
        let wrong = Aes256Gcm::new_from_slice(&[18; 32]).unwrap();
        assert!(open_root(&wrong, &encrypted).is_err());
        for value in [String::new(), "x".repeat(262_145), STANDARD.encode([0; 27])] {
            assert!(open_root(&key, &value).is_err());
        }
    }

    #[test]
    fn absolute_deadline_rejects_ready_at_or_after_the_invocation_budget() {
        let began = Instant::now();
        let until = began + READ_BUDGET;
        assert_eq!(
            accept_before_deadline(7, until, until - Duration::from_nanos(1)).unwrap(),
            7
        );
        for now in [until, until + Duration::from_nanos(1)] {
            let error = accept_before_deadline(7, until, now).unwrap_err();
            assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error.1, "static_hls_operation_receipt_unknown");
        }
    }

    #[tokio::test]
    async fn deferred_ready_read_cannot_restart_its_budget_when_first_polled() {
        let deferred = bounded_read(std::future::ready(Ok::<_, anyhow::Error>(7)));
        tokio::time::sleep(READ_BUDGET + Duration::from_millis(5)).await;
        let error = deferred.await.unwrap_err();
        assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.1, "static_hls_operation_receipt_unknown");
    }

    #[test]
    fn child_dispatch_precedes_generic_job_facts_and_never_uses_numeric_compatibility() {
        let media = include_str!("media.rs");
        let route = media.split("pub async fn readiness(").nth(1).unwrap();
        let child = route
            .find("static_hls_child_readiness::read_authenticated")
            .unwrap();
        let generic = route
            .find("playback_plan::AUTHORIZED_SNAPSHOT_SQL")
            .unwrap();
        assert!(child < generic);
        assert!(route.contains("AND NOT static_hls_is_child_session(p.id)"));
        for marker in [
            "static_hls_parent_capture_id",
            "pending_child",
            "published_child",
            "static_hls_child_output_publications",
        ] {
            assert!(CLASSIFY_CHILD.contains(marker));
        }
        for gate in [
            "r.user_id=$2",
            "r.auth_login_hash=$3",
            "p.auth_login_hash=$3",
            "static_hls_child_job_matches",
            "static_hls_child_grant_authority_allowed",
            "playback_caller_allowed",
        ] {
            assert!(ORIGINAL_TUPLE.contains(gate));
        }
        assert!(!ORIGINAL_TUPLE.contains("validation_version"));
        assert!(!ORIGINAL_TUPLE.contains("static_hls_published_parent_authority_allowed"));
    }

    #[test]
    fn private_errors_do_not_project_ciphertexts_paths_or_stored_diagnostics() {
        for message in [
            "https://private.invalid/?credential=secret",
            "/cache/another-owner",
            "static_hls_child_readiness_tuple_changed",
            "static_hls_child_complete_evidence_required",
        ] {
            let error = private_error(anyhow::anyhow!(message.to_owned()));
            assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error.1, "static_hls_operation_receipt_unknown");
        }
        let error = private_error(anyhow::anyhow!("invalid_position"));
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(error.1, "invalid_position");
    }
}
