//! Stage A probes only the configured actual Worker. It never enables capture.
//! Unknown old-process drain remains unknown regardless of probe readiness.
use anyhow::{Result, ensure};
use persistence::static_hls_activation::{
    ChildRuntimeContract, PROBE_MAX_AGE, READER_VERSION, WorkerContract,
};
use serde::{
    Deserialize,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use std::{
    marker::PhantomData,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

static PROBES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Clone, Debug)]
pub struct Observation {
    pub worker: WorkerContract,
    /// Starts before the request; transport delay consumes freshness budget.
    pub checked_at: Instant,
    child_runtime: Option<ChildRuntimeContract>,
}

/// Fresh authenticated installed-runtime readiness for one exact Worker/DB.
/// Only the actual endpoint's closed response can construct this capability.
/// Media qualification, child custody and output evidence remain independent.
pub(crate) struct SupportedGate {
    contract: ChildRuntimeContract,
    checked_at: Instant,
}

impl SupportedGate {
    pub(crate) fn is_current(&self) -> bool {
        Instant::now()
            .checked_duration_since(self.checked_at)
            .is_some_and(|age| age <= PROBE_MAX_AGE)
    }
    pub(crate) fn require_input(
        &self,
        input: &media_core::static_hls::contracts::input::FrozenInput,
    ) -> Result<()> {
        let identity = input.identity_statement();
        ensure!(
            identity.worker_instance == self.contract.instance.to_string()
                && identity.database == self.contract.database.to_string(),
            "static_hls_child_runtime_mismatch"
        );
        ensure!(self.is_current(), "static_hls_child_runtime_stale");
        Ok(())
    }
}

pub(crate) async fn supported_child_gate(app: &super::App) -> Result<Option<SupportedGate>> {
    let cache = PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into()));
    let observed = probe(app, &cache).await?;
    Ok(observed.child_runtime.map(|contract| SupportedGate {
        contract,
        checked_at: observed.checked_at,
    }))
}

// Decode directly from authenticated plaintext so duplicate fields are never
// erased by serde_json::Value. Every nested declaration is an object, not the
// positional array alias ordinarily accepted by serde's struct representation.
struct MapOnly<T>(T);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for MapOnly<T> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = MapOnly<T>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a closed Worker contract object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(MapOnly)
            }
        }
        deserializer.deserialize_map(ObjectVisitor(PhantomData))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeResponse {
    purpose: String,
    contract: MapOnly<WorkerContract>,
    #[serde(default, deserialize_with = "present_child_runtime")]
    static_hls_child_runtime: Option<ChildRuntimeContract>,
}

fn present_child_runtime<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<ChildRuntimeContract>, D::Error> {
    // Absence is old/default-off. A present null, bool or malformed object is
    // unsupported evidence, never an alias for an omitted capability.
    MapOnly::<ChildRuntimeContract>::deserialize(deserializer).map(|MapOnly(value)| Some(value))
}

fn parse_response(plaintext: &[u8]) -> Result<ProbeResponse> {
    ensure!(
        !plaintext.is_empty() && plaintext.len() <= 4096,
        "static_hls_worker_contract_bounds"
    );
    let MapOnly(response) = serde_json::from_slice::<MapOnly<ProbeResponse>>(plaintext)?;
    ensure!(
        response.purpose == "rainsync-static-hls-contract-response-v1",
        "static_hls_worker_contract_purpose"
    );
    if let Some(child) = &response.static_hls_child_runtime {
        child.require_binding(&response.contract.0)?;
    }
    Ok(response)
}

fn open_response(app: &super::App, ciphertext: &str) -> Result<ProbeResponse> {
    use aes_gcm::aead::Aead;
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = STANDARD.decode(ciphertext)?;
    ensure!(bytes.len() >= 28, "static_hls_worker_contract_bounds");
    let plaintext = app
        .key
        .decrypt(bytes[..12].into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("static_hls_worker_contract_authentication"))?;
    parse_response(&plaintext)
}

fn verify_response(
    response: ProbeResponse,
    database: Uuid,
    challenge: Uuid,
    cache_identity: &str,
    checked_at: Instant,
    completed_at: Instant,
) -> Result<Observation> {
    let worker = response.contract.0;
    ensure!(
        worker.version == READER_VERSION
            && !worker.instance.is_nil()
            && !database.is_nil()
            && !challenge.is_nil()
            && worker.database == database
            && worker.challenge == challenge
            && worker.cache_identity == cache_identity,
        "static_hls_worker_contract_mismatch"
    );
    ensure!(
        completed_at
            .checked_duration_since(checked_at)
            .is_some_and(|age| age <= PROBE_MAX_AGE),
        "static_hls_worker_contract_stale"
    );
    Ok(Observation {
        worker,
        checked_at,
        child_runtime: response.static_hls_child_runtime,
    })
}

/// One bounded read-only Worker request, using the existing shared source key
/// for purpose-separated fresh AEAD authentication. Shared-cache evidence is a
/// fresh random file written here and read by the actual Worker, not a UUID file.
/// No secret key, source URL or cache path is transmitted.
pub async fn probe(app: &super::App, cache: &Path) -> Result<Observation> {
    let owner = app
        .preparations
        .admit()
        .ok_or_else(|| anyhow::anyhow!("static_hls_probe_draining"))?;
    let permit_slot = PROBES
        .try_acquire()
        .map_err(|_| anyhow::anyhow!("static_hls_probe_busy"))?;
    let challenge = Uuid::new_v4();
    let cache = cache.to_path_buf();
    // The cleanup owner is independent of a cancelled/late probe waiter.
    let app = app.clone();
    let slot = std::sync::Arc::new(std::sync::Mutex::new(
        None::<media_core::static_hls_probe::OwnedProbe>,
    ));
    let (send, wait) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _slot = permit_slot;
        let _owner = owner;
        let completed = slot.clone();
        let result = probe_owned(&app, &cache, challenge, completed).await;
        let mut send = Some(send);
        let mut result = Some(result);
        loop {
            let retained = slot.clone();
            let cleanup = media_core::child_process::blocking(move || {
                let mut retained = retained.lock().expect("probe owner slot");
                if let Some(owned) = retained.as_mut() {
                    owned.remove_owned()?;
                }
                retained.take();
                Ok::<_, anyhow::Error>(())
            })
            .await;
            let cleanup_database = tokio::time::timeout(Duration::from_millis(750), async {
                let mut connection=app.db.acquire().await?;
                connection.close_on_drop();
                sqlx::query("UPDATE static_hls_database_binding SET probe_challenge=NULL,probe_sha256=NULL,probe_until=NULL WHERE singleton AND probe_challenge=$1")
                    .bind(challenge).execute(&mut *connection).await?;
                Ok::<_,anyhow::Error>(())
            }).await;
            if matches!(cleanup, Ok(Ok(()))) && matches!(cleanup_database, Ok(Ok(()))) {
                if let Some(send) = send.take() {
                    let _ = send.send(result.take().unwrap());
                }
                break;
            }
            if let Some(send) = send.take() {
                let _ = send.send(Err(anyhow::anyhow!("static_hls_probe_cleanup_unknown")));
            }
            // Retain the original object, preparation lifetime and slot until
            // exact cleanup succeeds, independently of the diagnostic waiter.
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    // A stalled filesystem owner remains registered/counts against the single
    // slot, while the diagnostic waiter returns bounded unknown evidence.
    tokio::time::timeout(Duration::from_secs(4), wait)
        .await
        .map_err(|_| anyhow::anyhow!("static_hls_probe_owner_unknown"))?
        .map_err(|_| anyhow::anyhow!("static_hls_probe_owner_unknown"))?
}

async fn probe_owned(
    app: &super::App,
    cache: &Path,
    challenge: Uuid,
    completed: std::sync::Arc<std::sync::Mutex<Option<media_core::static_hls_probe::OwnedProbe>>>,
) -> Result<Observation> {
    use sha2::{Digest, Sha256};
    let checked_at = Instant::now();
    let database: Uuid = tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        let supported: bool = sqlx::query_scalar("SELECT static_hls_reader_supported()")
            .fetch_one(&mut *connection)
            .await?;
        ensure!(supported, "static_hls_reader_required");
        sqlx::query_scalar("SELECT id FROM static_hls_database_binding WHERE singleton")
            .fetch_one(&mut *connection)
            .await
            .map_err(anyhow::Error::from)
    })
    .await??;
    let mut bytes = [0u8; 64];
    for chunk in bytes.as_chunks_mut::<16>().0 {
        chunk.copy_from_slice(Uuid::new_v4().as_bytes());
    }
    let cache = cache.to_path_buf();
    media_core::child_process::blocking(move || {
        let owned = media_core::static_hls_probe::OwnedProbe::create(
            &cache,
            &challenge.to_string(),
            bytes,
        )?;
        let mut completed = completed.lock().expect("probe owner slot");
        *completed = Some(owned);
        completed.as_mut().unwrap().write_nonce()
    })
    .await??;
    let cache_identity = hex::encode(Sha256::digest(bytes));
    tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection=app.db.acquire().await?;
        connection.close_on_drop();
        let binding:Uuid=sqlx::query_scalar("UPDATE static_hls_database_binding SET probe_challenge=$1,probe_sha256=$2,probe_until=clock_timestamp()+interval '6 seconds' WHERE singleton AND (probe_challenge IS NULL OR probe_until<=clock_timestamp()) RETURNING id")
            .bind(challenge).bind(&cache_identity).fetch_one(&mut *connection).await?;
        ensure!(binding==database,"static_hls_probe_database_changed");
        Ok::<_,anyhow::Error>(())
    }).await??;
    let issued = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let request=app.encrypt(&serde_json::json!({"purpose":"rainsync-static-hls-contract-request-v1","challenge":challenge,"issued_at_ms":issued}))?;
    let base = std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let response = client
        .post(format!(
            "{}/media-delivery/static-hls-contract",
            base.trim_end_matches('/')
        ))
        .body(request)
        .send()
        .await?;
    ensure!(
        response.status() == reqwest::StatusCode::OK,
        "static_hls_worker_contract_unavailable"
    );
    // Bound streamed response even when a hostile endpoint omits its length.
    use futures_util::StreamExt;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        ensure!(
            body.len() + chunk.len() <= 4096,
            "static_hls_worker_contract_bounds"
        );
        body.extend_from_slice(&chunk);
    }
    let response = open_response(app, std::str::from_utf8(&body)?)?;
    verify_response(
        response,
        database,
        challenge,
        &cache_identity,
        checked_at,
        Instant::now(),
    )
}

/// Explicit current-admin diagnostic only. It accepts no caller-supplied URL,
/// does no startup or periodic work, and can never enable admission.
pub async fn endpoint(
    axum::extract::State(app): axum::extract::State<super::App>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> super::Result<impl axum::response::IntoResponse> {
    let before = super::auth(&app, &headers, true).await?;
    super::admin(&before)?;
    if !(body.is_empty() || body.as_ref() == b"{}") {
        return Err(super::err(
            axum::http::StatusCode::BAD_REQUEST,
            "static_hls_probe_no_arguments",
        ));
    }
    let cache = PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into()));
    let observed = probe(&app, &cache).await;
    // The original exact login and current admin/Origin/CSRF authority must
    // still hold after network/filesystem awaits, including on a late response.
    let after = super::auth(&app, &headers, true).await?;
    super::admin(&after)?;
    if after.id != before.id {
        return Err(super::err(
            axum::http::StatusCode::UNAUTHORIZED,
            "session_expired",
        ));
    }
    let compatible = observed.as_ref().is_ok_and(|value| {
        !value.worker.instance.is_nil() && value.checked_at.elapsed() <= Duration::from_secs(6)
    });
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({
            "compatible":compatible,"admission":"disabled","drain":"unknown"
        })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn worker() -> WorkerContract {
        WorkerContract {
            version: READER_VERSION,
            instance: Uuid::from_u128(9),
            database: Uuid::from_u128(10),
            cache_identity: "a".repeat(64),
            challenge: Uuid::from_u128(30),
        }
    }

    fn response(child: bool) -> Value {
        let worker = worker();
        let mut response =
            json!({"purpose":"rainsync-static-hls-contract-response-v1", "contract":worker});
        if child {
            response["static_hls_child_runtime"] = json!({
                "version":1, "reader_version":2, "recipe_version":1,
                "input_version":1, "graph_version":1, "output_version":1,
                "profile":"original_owner_static_hls_child_v1",
                "instance":worker.instance, "database":worker.database,
                "cache_identity":worker.cache_identity, "challenge":worker.challenge,
                "tasks":["child_encode","child_read"],
            });
        }
        response
    }

    fn observed(value: &Value, checked: Instant, completed: Instant) -> Result<Observation> {
        let expected = worker();
        verify_response(
            parse_response(&serde_json::to_vec(value)?)?,
            expected.database,
            expected.challenge,
            &expected.cache_identity,
            checked,
            completed,
        )
    }

    #[test]
    fn default_off_and_stage_a_reader_never_construct_child_readiness() {
        let now = Instant::now();
        let off = observed(&response(false), now, now).unwrap();
        assert!(off.child_runtime.is_none());
        let on = observed(&response(true), now, now).unwrap();
        let gate = SupportedGate {
            contract: on.child_runtime.unwrap(),
            checked_at: on.checked_at,
        };
        let parent =
            media_core::static_hls::contracts::input::FrozenInput::parse_private_plaintext(
                include_bytes!(
                    "../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json"
                ),
            )
            .unwrap();
        gate.require_input(&parent).unwrap();
        let mut changed: Value =
            serde_json::from_slice(parent.private_storage_plaintext()).unwrap();
        for field in ["worker_instance", "database"] {
            changed[field] = json!(Uuid::from_u128(40).to_string());
            let other =
                media_core::static_hls::contracts::input::FrozenInput::parse_private_plaintext(
                    &serde_json::to_vec(&changed).unwrap(),
                )
                .unwrap();
            assert!(gate.require_input(&other).is_err());
            changed[field] = json!(
                if field == "worker_instance" {
                    worker().instance
                } else {
                    worker().database
                }
                .to_string()
            );
        }
        let stale = SupportedGate {
            contract: gate.contract.clone(),
            checked_at: now - PROBE_MAX_AGE - Duration::from_millis(1),
        };
        assert!(stale.require_input(&parent).is_err());
        let future = SupportedGate {
            contract: gate.contract,
            checked_at: now + Duration::from_secs(60),
        };
        assert!(future.require_input(&parent).is_err());
    }

    #[test]
    fn authenticated_response_is_closed_at_every_object_boundary() {
        let value = response(true);
        let text = serde_json::to_string(&value).unwrap();
        assert!(parse_response(text.as_bytes()).is_ok());
        for object in ["contract", "static_hls_child_runtime"] {
            let mut unknown = value.clone();
            unknown[object]["future_capability"] = json!(true);
            assert!(parse_response(&serde_json::to_vec(&unknown).unwrap()).is_err());
            let mut array = value.clone();
            array[object] = json!(
                value[object]
                    .as_object()
                    .unwrap()
                    .values()
                    .cloned()
                    .collect::<Vec<_>>()
            );
            assert!(parse_response(&serde_json::to_vec(&array).unwrap()).is_err());
            for field in value[object].as_object().unwrap().keys() {
                let mut missing = value.clone();
                missing[object].as_object_mut().unwrap().remove(field);
                assert!(parse_response(&serde_json::to_vec(&missing).unwrap()).is_err());
            }
        }
        let mut unknown = value.clone();
        unknown["child_available"] = json!(true);
        assert!(parse_response(&serde_json::to_vec(&unknown).unwrap()).is_err());
        for replacement in [Value::Null, json!(true), json!(1), json!([])] {
            let mut malformed = value.clone();
            malformed["static_hls_child_runtime"] = replacement;
            assert!(parse_response(&serde_json::to_vec(&malformed).unwrap()).is_err());
        }
        for (target, replacement) in [
            ("\"version\":1", "\"version\":1,\"version\":1"),
            (
                "\"reader_version\":2",
                "\"reader_version\":2,\"reader_version\":2",
            ),
            (
                "\"purpose\":",
                "\"purpose\":\"rainsync-static-hls-contract-response-v1\",\"purpose\":",
            ),
        ] {
            assert!(parse_response(text.replacen(target, replacement, 1).as_bytes()).is_err());
        }
        assert!(parse_response(&serde_json::to_vec(&json!([value])).unwrap()).is_err());
    }

    #[test]
    fn unsupported_partial_and_foreign_child_runtime_fail_closed() {
        for (field, changed) in [
            ("version", json!(2)),
            ("reader_version", json!(1)),
            ("recipe_version", json!(2)),
            ("input_version", json!(2)),
            ("graph_version", json!(2)),
            ("output_version", json!(2)),
            ("version", json!(1.0)),
            ("profile", json!("generic_reader")),
            ("tasks", json!(["child_read", "child_encode"])),
            ("tasks", json!(["child_encode"])),
            ("tasks", json!(["child_encode", "parent_read"])),
            (
                "tasks",
                json!(["child_encode", "child_read", "parent_capture"]),
            ),
            ("instance", json!(Uuid::from_u128(31))),
            ("database", json!(Uuid::from_u128(31))),
            ("challenge", json!(Uuid::from_u128(31))),
            ("cache_identity", json!("b".repeat(64))),
            ("cache_identity", json!("A".repeat(64))),
            ("cache_identity", json!("a".repeat(63))),
            ("instance", json!(Uuid::nil())),
            ("database", json!(Uuid::nil())),
            ("challenge", json!(Uuid::nil())),
        ] {
            let mut value = response(true);
            value["static_hls_child_runtime"][field] = changed;
            assert!(
                parse_response(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn probe_cannot_replay_foreign_or_stale_startup_bindings() {
        let now = Instant::now();
        for field in ["database", "challenge", "cache_identity"] {
            let mut value = response(true);
            let changed = if field == "cache_identity" {
                json!("b".repeat(64))
            } else {
                json!(Uuid::from_u128(40))
            };
            value["contract"][field] = changed.clone();
            value["static_hls_child_runtime"][field] = changed;
            assert!(observed(&value, now, now).is_err());
        }
        for checked in [
            now - PROBE_MAX_AGE - Duration::from_millis(1),
            now + Duration::from_millis(1),
        ] {
            assert!(observed(&response(true), checked, now).is_err());
        }
        let mut old = response(false);
        old["contract"]["version"] = json!(0);
        assert!(observed(&old, now, now).is_err());
        let mut nil = response(false);
        nil["contract"]["instance"] = json!(Uuid::nil());
        assert!(observed(&nil, now, now).is_err());
    }
}
