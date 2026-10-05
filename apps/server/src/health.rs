//! Readiness policy. The service owner must supply fresh, positively observed
//! checks; this module deliberately does not infer readiness from liveness.
//! Server probes are wired to its actual lock-owning connection and database.
//! Worker policy is reusable, but Worker runtime probes remain unwired.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Server,
    #[allow(dead_code)] // Worker runtime probe wiring is a separate contract.
    Worker,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Check {
    Database,
    InstanceOwnership,
    AcceptingWork,
    WritableCache,
    Ffmpeg,
    ClaimLoop,
}

impl Check {
    pub fn name(self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::InstanceOwnership => "instance_ownership",
            Self::AcceptingWork => "accepting_work",
            Self::WritableCache => "writable_cache",
            Self::Ffmpeg => "ffmpeg",
            Self::ClaimLoop => "claim_loop",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Ready,
    Failed,
    Unknown,
    Stale,
}

#[derive(Clone, Copy, Debug)]
pub struct Observation {
    pub outcome: Outcome,
    pub checked_at: Instant,
}

#[derive(Debug)]
pub struct Readiness {
    pub ready: bool,
    pub checks: Vec<(Check, Outcome)>,
}

impl Readiness {
    pub fn http_status(&self) -> u16 {
        if self.ready { 200 } else { 503 }
    }
}

/// Evaluate the same snapshot at one monotonic instant. An idle claim loop is
/// healthy when its last successful database poll is fresh; completing a media
/// job is not required. `InstanceOwnership` must come from the lock owner, never
/// from a separate `SELECT 1`. Probe details/paths/credentials are not exposed.
pub fn evaluate(
    role: Role,
    observations: &BTreeMap<Check, Observation>,
    now: Instant,
    max_age: Duration,
) -> Readiness {
    let required: &[Check] = match role {
        Role::Server => &[
            Check::Database,
            Check::InstanceOwnership,
            Check::AcceptingWork,
        ],
        Role::Worker => &[
            Check::Database,
            Check::InstanceOwnership,
            Check::AcceptingWork,
            Check::WritableCache,
            Check::Ffmpeg,
            Check::ClaimLoop,
        ],
    };
    let checks: Vec<_> = required
        .iter()
        .map(|check| {
            let outcome = match observations.get(check) {
                None => Outcome::Unknown,
                Some(observed) => match now.checked_duration_since(observed.checked_at) {
                    // A zero freshness budget and future samples fail closed.
                    Some(age) if !max_age.is_zero() && age <= max_age => observed.outcome,
                    _ => Outcome::Stale,
                },
            };
            (*check, outcome)
        })
        .collect();
    Readiness {
        ready: checks.iter().all(|(_, outcome)| *outcome == Outcome::Ready),
        checks,
    }
}

/// The HTTP path only reads bounded in-memory evidence; it never waits on SQL.
#[derive(Default)]
pub struct Runtime {
    observations: std::sync::Mutex<BTreeMap<Check, Observation>>,
    accepting: std::sync::atomic::AtomicBool,
}
impl Runtime {
    pub fn observe(&self, check: Check, outcome: Outcome) {
        if let Ok(mut observed) = self.observations.lock() {
            observed.insert(
                check,
                Observation {
                    outcome,
                    checked_at: Instant::now(),
                },
            );
        }
    }
    pub fn accepting(&self, value: bool) {
        self.accepting
            .store(value, std::sync::atomic::Ordering::Release);
    }
    pub fn snapshot(&self) -> Readiness {
        let now = Instant::now();
        let mut observed = self
            .observations
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default();
        observed.insert(
            Check::AcceptingWork,
            Observation {
                outcome: if self.accepting.load(std::sync::atomic::Ordering::Acquire) {
                    Outcome::Ready
                } else {
                    Outcome::Failed
                },
                checked_at: now,
            },
        );
        evaluate(Role::Server, &observed, now, Duration::from_secs(6))
    }
}

pub async fn endpoint(
    axum::extract::State(app): axum::extract::State<super::App>,
) -> impl axum::response::IntoResponse {
    let snapshot = app.readiness.snapshot();
    let checks: BTreeMap<_, _> = snapshot
        .checks
        .iter()
        .map(|(check, outcome)| {
            (
                check.name(),
                match outcome {
                    Outcome::Ready => "ready",
                    Outcome::Failed => "failed",
                    Outcome::Unknown => "unknown",
                    Outcome::Stale => "stale",
                },
            )
        })
        .collect();
    (
        axum::http::StatusCode::from_u16(snapshot.http_status()).expect("fixed readiness status"),
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Extension(http_api::PreserveReadinessBody),
        axum::Json(serde_json::json!({"ready":snapshot.ready,"checks":checks})),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed(now: Instant) -> BTreeMap<Check, Observation> {
        [
            Check::Database,
            Check::InstanceOwnership,
            Check::AcceptingWork,
            Check::WritableCache,
            Check::Ffmpeg,
            Check::ClaimLoop,
        ]
        .into_iter()
        .map(|check| {
            (
                check,
                Observation {
                    outcome: Outcome::Ready,
                    checked_at: now,
                },
            )
        })
        .collect()
    }

    #[test]
    fn an_empty_snapshot_never_claims_ready() {
        let now = Instant::now();
        let result = evaluate(Role::Server, &BTreeMap::new(), now, Duration::from_secs(10));
        assert_eq!(result.http_status(), 503);
        assert!(
            result
                .checks
                .iter()
                .all(|(_, value)| *value == Outcome::Unknown)
        );
    }

    #[test]
    fn database_success_cannot_hide_lost_ownership_or_draining() {
        let now = Instant::now();
        for check in [Check::InstanceOwnership, Check::AcceptingWork] {
            let mut observations = observed(now);
            observations.get_mut(&check).unwrap().outcome = Outcome::Failed;
            assert!(!evaluate(Role::Server, &observations, now, Duration::from_secs(10)).ready);
        }
    }

    #[test]
    fn server_does_not_require_worker_only_dependencies() {
        let now = Instant::now();
        let mut observations = observed(now);
        observations.remove(&Check::ClaimLoop);
        observations.get_mut(&Check::Ffmpeg).unwrap().outcome = Outcome::Failed;
        assert!(evaluate(Role::Server, &observations, now, Duration::from_secs(10)).ready);
        assert!(!evaluate(Role::Worker, &observations, now, Duration::from_secs(10)).ready);
    }

    #[test]
    fn stale_or_future_positive_evidence_cannot_keep_service_ready() {
        let now = Instant::now();
        let observations = observed(now);
        let stale = evaluate(
            Role::Worker,
            &observations,
            now + Duration::from_secs(11),
            Duration::from_secs(10),
        );
        assert!(!stale.ready);
        assert!(
            stale
                .checks
                .iter()
                .all(|(_, value)| *value == Outcome::Stale)
        );
        assert!(
            !evaluate(
                Role::Worker,
                &observations,
                now - Duration::from_secs(1),
                Duration::from_secs(10)
            )
            .ready
        );
        assert!(!evaluate(Role::Worker, &observations, now, Duration::ZERO).ready);
    }

    #[test]
    fn a_fresh_idle_worker_poll_is_ready_but_failed_disk_is_not() {
        let now = Instant::now();
        let mut observations = observed(now);
        assert_eq!(
            evaluate(Role::Worker, &observations, now, Duration::from_secs(10)).http_status(),
            200
        );
        observations.get_mut(&Check::WritableCache).unwrap().outcome = Outcome::Failed;
        assert_eq!(
            evaluate(Role::Worker, &observations, now, Duration::from_secs(10)).http_status(),
            503
        );
    }
}
