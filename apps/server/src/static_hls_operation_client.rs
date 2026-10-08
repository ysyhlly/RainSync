//! Actual private operation transport; public parent/child activation is separate.
#[path = "static_hls_operation_client/child_preparation.rs"]
mod child_preparation;
#[path = "static_hls_operation_client/preparation.rs"]
mod preparation;
pub(super) use preparation::ParentPreparation;

use aes_gcm::Aes256Gcm;
use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use media_core::static_hls::contracts::{
    input::FrozenInput,
    operation::{
        Action, CallAuthority, ChallengeObservation, ExpectedBinding,
        LivePendingAuthorityStatement, LivePublicationAuthorityStatement,
        MAX_RESPONSE_CIPHERTEXT_BYTES, OperationRequest, OperationResponse, RpcWindow,
    },
};
use persistence::static_hls_pending::{self as pending, LoadedOperation};
use reqwest::{Client as HttpClient, Url};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use uuid::Uuid;

static CALLS: LazyLock<Arc<Runtime>> = LazyLock::new(|| Arc::new(Runtime::default()));

struct Runtime {
    state: Mutex<(bool, usize)>,
    stop: watch::Sender<bool>,
    count: watch::Sender<usize>,
    serial: Arc<Semaphore>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            state: Mutex::new((false, 0)),
            stop: watch::channel(false).0,
            count: watch::channel(0).0,
            serial: Arc::new(Semaphore::new(1)),
        }
    }
}
struct Guard {
    runtime: Arc<Runtime>,
    _serial: OwnedSemaphorePermit,
}
impl Runtime {
    fn admit(self: &Arc<Self>) -> Result<Guard> {
        let serial = self
            .serial
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow::anyhow!("static_hls_operation_busy"))?;
        let mut state = self.state.lock().expect("operation call registry");
        ensure!(!state.0, "static_hls_operation_draining");
        state.1 += 1;
        self.count.send_replace(state.1);
        Ok(Guard {
            runtime: self.clone(),
            _serial: serial,
        })
    }
}
impl Guard {
    async fn cancelled(&self) {
        let mut stop = self.runtime.stop.subscribe();
        while !*stop.borrow_and_update() {
            if stop.changed().await.is_err() {
                return;
            }
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let mut state = self.runtime.state.lock().expect("operation call registry");
        state.1 -= 1;
        self.runtime.count.send_replace(state.1);
    }
}

pub(super) fn close() {
    let mut state = CALLS.state.lock().expect("operation call registry");
    state.0 = true;
    CALLS.stop.send_replace(true);
    CALLS.serial.close();
}
pub(super) async fn drain() {
    close();
    let mut count = CALLS.count.subscribe();
    while *count.borrow_and_update() != 0 {
        if count.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
#[allow(dead_code)] // Used by the cross-binary native transport fixture.
pub(super) fn active_calls() -> usize {
    CALLS.state.lock().expect("operation call registry").1
}

#[derive(Clone)]
pub(super) struct Client {
    db: PgPool,
    key: Arc<Aes256Gcm>,
    cache: PathBuf,
    endpoint: Url,
    http: HttpClient,
    #[cfg(test)]
    probe_gate: Option<Arc<ProbeGate>>,
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct ProbeGate {
    pub(super) entered: tokio::sync::Notify,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}
#[cfg(test)]
impl ProbeGate {
    #[allow(dead_code)] // Cross-binary native fixture control.
    pub(super) fn release(&self) {
        *self.released.lock().expect("owned probe gate") = true;
        self.wake.notify_all();
    }
    fn wait(&self) {
        self.entered.notify_one();
        let mut released = self.released.lock().expect("owned probe gate");
        while !*released {
            released = self.wake.wait(released).expect("owned probe gate");
        }
    }
}
impl Client {
    /// Native completion shares the original DB budget after qualification.
    // Worker tests include this Server client for shared operation fixtures;
    // only the Server's real public preparation path calls this method.
    #[cfg_attr(test, allow(dead_code))]
    pub(super) async fn remaining_preparation_deadline(
        &self,
        input: &FrozenInput,
    ) -> Result<tokio::time::Instant> {
        let began = tokio::time::Instant::now();
        let loaded = self.load(input).await?;
        ensure!(
            loaded.current_authority_live && loaded.publication_pending,
            "static_hls_preparation_expired"
        );
        preparation::preparation_deadline(began, &loaded, tokio::time::Instant::now())
    }
    #[cfg(all(test, target_os = "linux"))]
    fn record_failure(&self, action: Action, operation: &str, stage: &str, error: &anyhow::Error) {
        if std::env::var("RAINSYNC_OWNED_TEST_RUN_ID").is_ok_and(|id| Uuid::parse_str(&id).is_ok())
        {
            let purpose = match action {
                Action::Create => "create",
                Action::Publish => "publish",
                Action::PublishChild => "publish_child",
                Action::Query => "query",
                Action::Cancel => "cancel",
            };
            let _ = std::fs::write(
                self.cache
                    .join(format!("operation-client-failure-{}.json", Uuid::new_v4())),
                serde_json::to_vec_pretty(
                    &serde_json::json!({"purpose":purpose,"operation":operation,
                    "endpoint":self.endpoint.path(),"stage":stage,"error":format!("{error:#}")}),
                )
                .unwrap_or_default(),
            );
        }
    }
    pub(super) async fn published_plan(
        &self,
        input: &FrozenInput,
    ) -> Result<protocol::PlaybackPlan> {
        let response = self.call(input, Action::Query).await?;
        super::static_hls_parent_plan::from_original_receipt(&self.db, &self.key, input, &response)
            .await
    }

    pub(super) async fn replay_published(
        &self,
        operation: Uuid,
        session: Uuid,
    ) -> Result<protocol::PlaybackPlan> {
        let loaded = tokio::time::timeout(
            Duration::from_millis(750),
            pending::load_operation(&self.db, operation, session, |cipher| {
                Ok(
                    super::static_hls_input_cipher::open_private_input_plaintext(
                        &self.key,
                        cipher.as_bytes(),
                    )?,
                )
            }),
        )
        .await??
        .context("static_hls_original_operation_missing")?;
        ensure!(
            !loaded.publication_pending && loaded.publication_authority_live,
            "static_hls_parent_expired"
        );
        self.published_plan(&loaded.input).await
    }
    pub(super) fn new(
        db: PgPool,
        key: Arc<Aes256Gcm>,
        cache: PathBuf,
        worker: &str,
    ) -> Result<Self> {
        let base = Url::parse(worker)?;
        ensure!(
            matches!(base.scheme(), "http" | "https")
                && base.username().is_empty()
                && base.password().is_none()
                && base.query().is_none()
                && base.fragment().is_none(),
            "static_hls_worker_url_invalid"
        );
        let endpoint = Url::parse(&format!(
            "{}/media-delivery/static-hls-operation",
            worker.trim_end_matches('/')
        ))?;
        Ok(Self {
            db,
            key,
            cache,
            endpoint,
            http: HttpClient::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()?,
            #[cfg(test)]
            probe_gate: None,
        })
    }

    #[cfg(test)]
    #[allow(dead_code)] // Cross-binary native fixture control.
    pub(super) fn with_probe_gate(mut self, gate: Arc<ProbeGate>) -> Self {
        self.probe_gate = Some(gate);
        self
    }

    pub(super) async fn call(
        &self,
        input: &FrozenInput,
        action: Action,
    ) -> Result<OperationResponse> {
        let guard = CALLS.admit()?;
        #[cfg(all(test, target_os = "linux"))]
        let diagnostic_operation = input.identity_statement().operation_id;
        let client = self.clone();
        let input = input.clone();
        let challenge = Uuid::new_v4();
        let retained = Arc::new(Mutex::new(None::<media_core::static_hls_probe::OwnedProbe>));
        let (send, wait) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let scope = media_core::child_process::Scope::new();
            let result = scope.run(async { tokio::select! {
                result = tokio::time::timeout(Duration::from_secs(5), client.exchange(&input, action, challenge, retained.clone())) => {
                    result.unwrap_or_else(|_| Err(anyhow::anyhow!("static_hls_operation_receipt_unknown")))
                }
                _ = guard.cancelled() => Err(anyhow::anyhow!("static_hls_operation_receipt_unknown")),
            }}).await;
            #[cfg(all(test, target_os = "linux"))]
            if let Err(error) = &result {
                client.record_failure(
                    action,
                    &input.identity_statement().operation_id,
                    "exchange",
                    error,
                );
            }
            let mut result = Some(result);
            let mut send = Some(send);
            loop {
                // A cancelled exchange can leave a constructor/writer running
                // before it publishes the probe into its slot. Drain the exact
                // scope before interpreting an empty slot or removing files.
                if scope.shutdown().await.is_err() {
                    if let Some(send) = send.take() {
                        let _ = send.send(Err(anyhow::anyhow!(
                            "static_hls_operation_probe_cleanup_unknown"
                        )));
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                let probe = retained.clone();
                let file = media_core::child_process::blocking(move || {
                    let mut probe = probe.lock().expect("operation probe owner");
                    if let Some(owned) = probe.as_mut() {
                        owned.remove_owned()?;
                    }
                    probe.take();
                    Ok::<_, anyhow::Error>(())
                })
                .await;
                let database = tokio::time::timeout(Duration::from_millis(750), async {
                    let mut connection = client.db.acquire().await?;
                    connection.close_on_drop();
                    sqlx::query("UPDATE static_hls_database_binding SET probe_challenge=NULL,probe_sha256=NULL,probe_until=NULL WHERE singleton AND id=$1 AND probe_challenge=$2")
                        .bind(Uuid::parse_str(&input.identity_statement().database)?).bind(challenge)
                        .execute(&mut *connection).await?;
                    let clear: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM static_hls_database_binding WHERE singleton AND id=$1 AND probe_challenge IS DISTINCT FROM $2)")
                        .bind(Uuid::parse_str(&input.identity_statement().database)?).bind(challenge)
                        .fetch_one(&mut *connection).await?;
                    ensure!(clear, "static_hls_operation_probe_cleanup_unknown");
                    Ok::<_, anyhow::Error>(())
                }).await;
                if matches!(file, Ok(Ok(()))) && matches!(database, Ok(Ok(()))) {
                    let result = result.take();
                    // Release the exact cleanup lifetime and serial permit
                    // before waking a caller that may immediately query again.
                    drop(guard);
                    if let Some(send) = send.take() {
                        let _ = send.send(result.unwrap());
                    }
                    return;
                }
                if let Some(send) = send.take() {
                    let _ = send.send(Err(anyhow::anyhow!(
                        "static_hls_operation_probe_cleanup_unknown"
                    )));
                }
                // The original probe object and serial/lifetime guard survive
                // cancelled waiters and every uncertain cleanup attempt.
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        let result = tokio::time::timeout(Duration::from_secs(4), wait)
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_operation_receipt_unknown"))
            .and_then(|reply| {
                reply.map_err(|_| anyhow::anyhow!("static_hls_operation_receipt_unknown"))
            })
            .and_then(|reply| reply);
        #[cfg(all(test, target_os = "linux"))]
        if let Err(error) = &result {
            self.record_failure(action, &diagnostic_operation, "caller", error);
        }
        result
    }

    async fn load(&self, input: &FrozenInput) -> Result<LoadedOperation> {
        let identity = input.identity_statement();
        let loaded = tokio::time::timeout(
            Duration::from_millis(750),
            pending::load_operation(
                &self.db,
                Uuid::parse_str(&identity.operation_id)?,
                Uuid::parse_str(&identity.session_id)?,
                |cipher| {
                    Ok(
                        super::static_hls_input_cipher::open_private_input_plaintext(
                            &self.key,
                            cipher.as_bytes(),
                        )?,
                    )
                },
            ),
        )
        .await??
        .context("static_hls_original_operation_missing")?;
        ensure!(
            loaded.input.input_sha256() == input.input_sha256(),
            "static_hls_original_input_changed"
        );
        input.require_identity_statement(&loaded.current_identity)?;
        Ok(loaded)
    }

    async fn exchange(
        &self,
        input: &FrozenInput,
        action: Action,
        challenge: Uuid,
        retained: Arc<Mutex<Option<media_core::static_hls_probe::OwnedProbe>>>,
    ) -> Result<OperationResponse> {
        self.load(input).await?;
        let mut bytes = [0u8; 64];
        for chunk in bytes.chunks_mut(16) {
            chunk.copy_from_slice(Uuid::new_v4().as_bytes());
        }
        let digest = hex::encode(Sha256::digest(bytes));
        let cache = self.cache.clone();
        #[cfg(test)]
        let gate = self.probe_gate.clone();
        media_core::child_process::blocking(move || {
            let probe = media_core::static_hls_probe::OwnedProbe::create(
                &cache,
                &challenge.to_string(),
                bytes,
            )?;
            #[cfg(test)]
            if let Some(gate) = gate {
                gate.wait();
            }
            let mut retained = retained.lock().expect("operation probe owner");
            *retained = Some(probe);
            retained.as_mut().unwrap().write_nonce()
        })
        .await??;
        let database = Uuid::parse_str(&input.identity_statement().database)?;
        let until: i64 = tokio::time::timeout(Duration::from_millis(750), async {
            let mut connection = self.db.acquire().await?;
            connection.close_on_drop();
            sqlx::query_scalar("UPDATE static_hls_database_binding SET probe_challenge=$1,probe_sha256=$2,probe_until=clock_timestamp()+interval '6 seconds' WHERE singleton AND id=$3 AND (probe_challenge IS NULL OR probe_until<=clock_timestamp()) RETURNING floor(extract(epoch FROM probe_until)*1000)::bigint")
                .bind(challenge).bind(&digest).bind(database).fetch_one(&mut *connection).await
        }).await??;
        let loaded = self.load(input).await?;
        let issued = now_ms()?;
        let expected = ExpectedBinding::from_trusted_input(
            input,
            &loaded.current_identity,
            ChallengeObservation {
                challenge: challenge.to_string(),
                cache_challenge_sha256: digest,
                challenge_expires_at_ms: u64::try_from(until)?,
            },
            RpcWindow {
                issued_at_ms: issued,
                rpc_expires_at_ms: issued.checked_add(5000).context("RPC clock overflow")?,
            },
            now_ms()?,
        )?;
        let request = OperationRequest::for_expected(
            action,
            &expected,
            now_ms()?,
            authority(action, &loaded),
        )?;
        let random = Uuid::new_v4();
        let nonce = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|i| random.as_bytes()[i]);
        let wire = super::static_hls_operation_cipher::seal_request(
            &self.key,
            nonce,
            &request,
            action,
            &expected,
            now_ms()?,
            authority(action, &loaded),
        )?;
        let response = self
            .http
            .post(self.endpoint.clone())
            .body(wire)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_operation_receipt_unknown"))?;
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "static_hls_operation_receipt_unknown"
        );
        ensure!(
            response
                .headers()
                .get(reqwest::header::CACHE_CONTROL)
                .is_some_and(|v| v == "no-store"),
            "static_hls_operation_receipt_unknown"
        );
        if let Some(length) = response.content_length() {
            ensure!(
                length <= MAX_RESPONSE_CIPHERTEXT_BYTES as u64,
                "static_hls_operation_response_bounds"
            );
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| anyhow::anyhow!("static_hls_operation_receipt_unknown"))?;
            ensure!(
                chunk.len() <= MAX_RESPONSE_CIPHERTEXT_BYTES.saturating_sub(body.len()),
                "static_hls_operation_response_bounds"
            );
            body.extend_from_slice(&chunk);
        }
        // Authentication and echo comparisons use another real current DB
        // authority observation after network awaits, never a caller assertion.
        let current = self.load(input).await?;
        Ok(super::static_hls_operation_cipher::open_response(
            &self.key,
            &body,
            action,
            &expected,
            now_ms()?,
            authority(action, &current),
        )?)
    }
}

fn authority(action: Action, loaded: &LoadedOperation) -> CallAuthority<'_> {
    if matches!(action, Action::Publish | Action::PublishChild)
        || (action == Action::Query
            && loaded.input.kind()
                == media_core::static_hls::contracts::input::OperationKind::Child)
    {
        CallAuthority::LivePublication(LivePublicationAuthorityStatement {
            current_identity: &loaded.current_identity,
            current_authority_live: loaded.publication_authority_live,
            observed_at_ms: loaded.observed_at_ms,
            pending: loaded.publication_pending,
            pending_lease_expires_at_ms: loaded.pending_lease_expires_at_ms,
        })
    } else if action == Action::Create {
        CallAuthority::LivePending(LivePendingAuthorityStatement {
            current_identity: &loaded.current_identity,
            current_authority_live: loaded.current_authority_live,
            observed_at_ms: loaded.observed_at_ms,
            pending_lease_expires_at_ms: loaded.pending_lease_expires_at_ms,
        })
    } else {
        CallAuthority::ObservationOnly
    }
}
fn now_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
