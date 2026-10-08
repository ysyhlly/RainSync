//! Bounded authenticated read-only compatibility probe. It does not activate
//! capture, assert old-process drain, or expose the source key/cache path.
use axum::{
    body::Bytes,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use persistence::static_hls_activation::{ChildRuntimeContract, READER_VERSION, WorkerContract};
use serde_json::json;
use sqlx::Row;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const REQUEST_BYTES: usize = 4096;
const CHALLENGE_AGE_MS: u64 = 6000;
pub(super) static INSTANCE: std::sync::LazyLock<Uuid> = std::sync::LazyLock::new(Uuid::new_v4);
static PROBES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    purpose: String,
    challenge: Uuid,
    issued_at_ms: u64,
}

pub async fn endpoint(State(app): State<super::App>, body: Bytes) -> impl IntoResponse {
    let refused = || {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CACHE_CONTROL, "no-store")],
            String::new(),
        )
    };
    if body.len() > REQUEST_BYTES {
        return refused();
    }
    let Ok(ciphertext) = std::str::from_utf8(&body) else {
        return refused();
    };
    let Ok(request) = super::decrypt(&app, ciphertext) else {
        return refused();
    };
    let Ok(request): std::result::Result<Request, _> = serde_json::from_value(request) else {
        return refused();
    };
    let challenge = request.challenge;
    let issued = request.issued_at_ms;
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return refused();
    };
    let now = now.as_millis().min(u128::from(u64::MAX)) as u64;
    if request.purpose != "rainsync-static-hls-contract-request-v1"
        || challenge.is_nil()
        || issued > now
        || now - issued > CHALLENGE_AGE_MS
    {
        return refused();
    }
    let Ok(_slot) = PROBES.try_acquire() else {
        return refused();
    };
    let observed = tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        let row = sqlx::query("SELECT id,probe_sha256,static_hls_reader_supported() AS supported FROM static_hls_database_binding WHERE singleton AND probe_challenge=$1 AND probe_until>clock_timestamp()")
            .bind(challenge).fetch_one(&mut *connection).await?;
        anyhow::ensure!(row.get::<bool,_>("supported"), "static_hls_reader_required");
        Ok::<_,anyhow::Error>((row.get::<Uuid,_>("id"),row.get::<String,_>("probe_sha256")))
    }).await;
    let Ok(Ok((database, expected_digest))) = observed else {
        return refused();
    };
    // The challenge name is generated internally from a validated UUID. The
    // actual configured cache must contain the Server's fresh random bytes.
    // A stored UUID/cache path or /ready is not shared-cache evidence.
    let root = app.cache.clone();
    let cache = tokio::time::timeout(
        Duration::from_millis(250),
        media_core::child_process::blocking(move || {
            let bytes = media_core::static_hls_probe::read(&root, &challenge.to_string())?;
            use sha2::{Digest, Sha256};
            Ok::<_, anyhow::Error>(hex::encode(Sha256::digest(bytes)))
        }),
    )
    .await;
    let Ok(Ok(Ok(cache_identity))) = cache else {
        return refused();
    };
    if cache_identity != expected_digest {
        return refused();
    }
    let contract = WorkerContract {
        version: READER_VERSION,
        instance: *INSTANCE,
        database,
        cache_identity,
        challenge,
    };
    // Generic Stage A remains byte-shape compatible while the independent
    // actual installed encoder/read registry may add its exact closed profile.
    // The same authenticated cache/DB challenge binds both declarations. This
    // does not qualify any source, capture, recipe, attempt or output.
    let Ok(child_runtime) = app
        .static_hls_child_dispatch
        .child_contract(&app, &contract)
    else {
        return refused();
    };
    let Ok(response) = response_payload(&contract, child_runtime) else {
        return refused();
    };
    let Ok(response) = seal(&app, &response) else {
        return refused();
    };
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        response,
    )
}

fn response_payload(
    contract: &WorkerContract,
    child_runtime: Option<ChildRuntimeContract>,
) -> anyhow::Result<serde_json::Value> {
    let mut response = json!({
        "purpose":"rainsync-static-hls-contract-response-v1", "contract":contract,
    });
    if let Some(child_runtime) = child_runtime {
        child_runtime.require_binding(contract)?;
        response["static_hls_child_runtime"] = serde_json::to_value(child_runtime)?;
    }
    Ok(response)
}

fn seal(app: &super::App, value: &serde_json::Value) -> anyhow::Result<String> {
    use aes_gcm::aead::Aead;
    use base64::{Engine, engine::general_purpose::STANDARD};
    // UUID v4 supplies random bytes; 96-bit AES-GCM nonce is never retained.
    let random = Uuid::new_v4();
    // Exclude UUID's fixed version/variant octets to retain 96 random bits.
    let bytes = random.as_bytes();
    let nonce: [u8; 12] = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|index| bytes[index]);
    let encrypted = app
        .key
        .encrypt((&nonce).into(), serde_json::to_vec(value)?.as_slice())
        .map_err(|_| anyhow::anyhow!("contract_probe_unavailable"))?;
    Ok(STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::static_hls_activation::{CHILD_RUNTIME_PROFILE, CHILD_RUNTIME_VERSION};

    fn worker() -> WorkerContract {
        WorkerContract {
            version: READER_VERSION,
            instance: Uuid::new_v4(),
            database: Uuid::new_v4(),
            cache_identity: "a".repeat(64),
            challenge: Uuid::new_v4(),
        }
    }

    fn child(worker: &WorkerContract) -> ChildRuntimeContract {
        ChildRuntimeContract {
            version: CHILD_RUNTIME_VERSION,
            reader_version: 2,
            recipe_version: 1,
            input_version: 1,
            graph_version: 1,
            output_version: 1,
            profile: CHILD_RUNTIME_PROFILE.into(),
            instance: worker.instance,
            database: worker.database,
            challenge: worker.challenge,
            cache_identity: worker.cache_identity.clone(),
            tasks: ["child_encode".into(), "child_read".into()],
        }
    }

    #[test]
    fn disabled_response_preserves_generic_contract_without_child_field() {
        let worker = worker();
        let payload = response_payload(&worker, None).unwrap();
        assert!(payload.get("static_hls_child_runtime").is_none());
        assert_eq!(payload.as_object().unwrap().len(), 2);
        assert_eq!(payload["contract"]["version"], READER_VERSION);
    }

    #[test]
    fn child_response_is_exact_closed_profile_and_same_probe_binding() {
        let worker = worker();
        let payload = response_payload(&worker, Some(child(&worker))).unwrap();
        assert_eq!(payload.as_object().unwrap().len(), 3);
        assert_eq!(payload["static_hls_child_runtime"]["reader_version"], 2);
        for field in 0..8 {
            let mut changed = child(&worker);
            match field {
                0 => changed.version += 1,
                1 => changed.reader_version += 1,
                2 => changed.output_version += 1,
                3 => changed.instance = Uuid::new_v4(),
                4 => changed.database = Uuid::new_v4(),
                5 => changed.challenge = Uuid::new_v4(),
                6 => changed.cache_identity = "b".repeat(64),
                _ => changed.tasks[0] = "generic_encode".into(),
            }
            assert!(response_payload(&worker, Some(changed)).is_err());
        }
    }
}
