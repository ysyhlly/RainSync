//! Stop admission first and positively drain in-flight token rotation.
//! Shutdown never drops a provider exchange future or retries an ambiguous one.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
pub(super) async fn phase<T, E: Into<Error>>(
    future: impl std::future::Future<Output = std::result::Result<T, E>>,
) -> Result<T> {
    budget(Duration::from_secs(5), future).await
}
async fn budget<T, E: Into<Error>>(
    duration: Duration,
    future: impl std::future::Future<Output = std::result::Result<T, E>>,
) -> Result<T> {
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "platform_renewal_database_phase_unknown",
            )
        })?
        .map_err(Into::into)
}
pub(super) async fn commit(tx: Transaction<'_, Postgres>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), tx.commit())
        .await
        .map_err(|_| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "platform_renewal_commit_unknown",
            )
        })?
        .map_err(Into::into)
}
pub(super) fn authority_expired(error: &Error) -> bool {
    error.0 == StatusCode::UNAUTHORIZED && error.1 == "session_expired"
}
pub(super) async fn begin(app: &App) -> Result<Transaction<'_, Postgres>> {
    let mut tx = tokio::time::timeout(Duration::from_secs(5), app.db.begin())
        .await
        .map_err(|_| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "platform_renewal_database_unavailable",
            )
        })??;
    phase(sqlx::query("SET LOCAL statement_timeout='5s'").execute(&mut *tx)).await?;
    phase(sqlx::query("SET LOCAL lock_timeout='5s'").execute(&mut *tx)).await?;
    Ok(tx)
}
pub struct Maintenance {
    closing: Arc<AtomicBool>,
    wake: tokio::sync::watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<Result<()>>>,
    healthy: Arc<AtomicBool>,
    drain_failed: bool,
}
impl Maintenance {
    pub fn start(app: App) -> Self {
        let closing = Arc::new(AtomicBool::new(false));
        let (wake, mut stop) = tokio::sync::watch::channel(false);
        let fence = closing.clone();
        let healthy = Arc::new(AtomicBool::new(true));
        let health = healthy.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut durability_unconfirmed = false;
            loop {
                tokio::select! {biased; result=stop.changed()=>{if result.is_err()||*stop.borrow(){break;}}, _=interval.tick()=>{}}
                if fence.load(Ordering::Acquire) {
                    break;
                }
                // No select/cancellation surrounds a rotating operation. Both
                // passes stop admitting further accounts after close().
                let bili = renewal::refresh_due_inner(&app, &fence).await;
                if bili.is_err() {
                    tracing::warn!(
                        event = "platform_renewal_pass_failed",
                        provider = "bilibili"
                    );
                }
                durability_unconfirmed |= bili
                    .as_ref()
                    .err()
                    .is_some_and(|e| e.1 == "platform_renewal_durability_unconfirmed");
                if fence.load(Ordering::Acquire) {
                    break;
                }
                let oauth = oauth::refresh_due_inner(&app, &fence).await;
                if oauth.is_err() {
                    tracing::warn!(event = "platform_renewal_pass_failed", provider = "oauth");
                }
                durability_unconfirmed |= oauth
                    .as_ref()
                    .err()
                    .is_some_and(|e| e.1 == "platform_renewal_durability_unconfirmed");
                health.store(
                    bili.is_ok() && oauth.is_ok() && !durability_unconfirmed,
                    Ordering::Release,
                );
            }
            // Establish the durable recovery state before acknowledging drain.
            // Expired claims are conservative unknown states, never retries.
            let mut tx = begin(&app).await?;
            phase(sqlx::query("UPDATE platform_account_renewals SET state='uncertain',operation_nonce=NULL,operation_expires_at=NULL WHERE state='running' AND operation_expires_at<=clock_timestamp()").execute(&mut *tx)).await?;
            phase(sqlx::query("UPDATE platform_oauth_accounts SET renewal_state='uncertain',operation_nonce=NULL,operation_expires_at=NULL WHERE renewal_state='running' AND operation_expires_at<=clock_timestamp()").execute(&mut *tx)).await?;
            commit(tx).await?;
            if durability_unconfirmed {
                return Err(err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "platform_renewal_durability_unconfirmed",
                ));
            }
            Ok(())
        });
        Self {
            closing,
            wake,
            task: Some(task),
            healthy,
            drain_failed: false,
        }
    }
    pub fn healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }
    pub fn close(&self) {
        self.closing.store(true, Ordering::Release);
        let _ = self.wake.send(true);
    }
    /// Await positive completion; do not abort/drop the task on a caller timeout.
    /// The caller must keep the runtime alive until this barrier succeeds.
    pub async fn drain(&mut self) -> Result<()> {
        self.close();
        if !self.healthy() {
            tracing::warn!(event = "platform_renewal_unhealthy_at_shutdown");
        }
        if self.drain_failed {
            return Err(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "platform_renewal_drain_failed",
            ));
        }
        if let Some(task) = self.task.take() {
            match task.await {
                Ok(Ok(())) => {}
                _ => {
                    self.drain_failed = true;
                    return Err(err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "platform_renewal_drain_failed",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_session_expiry_is_authority_loss() {
        assert!(authority_expired(&err(
            StatusCode::UNAUTHORIZED,
            "session_expired"
        )));
        for e in [
            err(StatusCode::INTERNAL_SERVER_ERROR, "database_error"),
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "platform_renewal_database_phase_unknown",
            ),
            err(StatusCode::FORBIDDEN, "csrf_failed"),
        ] {
            assert!(!authority_expired(&e));
        }
    }
    #[tokio::test]
    async fn database_phase_budget_bounds_transport_stall_without_platform_io() {
        let failure = budget(
            Duration::from_millis(5),
            std::future::pending::<Result<()>>(),
        )
        .await
        .unwrap_err();
        assert_eq!(failure.1, "platform_renewal_database_phase_unknown");
        assert_eq!(
            budget(Duration::from_millis(5), async { Ok::<_, Error>(7) })
                .await
                .unwrap(),
            7
        );
    }
}
