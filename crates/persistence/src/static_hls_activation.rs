//! Stage A evaluates compatibility evidence only. There is deliberately no
//! production activation operation; a positive candidate still cannot admit.
//! Process drain comes from positive shutdown obligations supplied by the owner,
//! never from UUID files, empty SQL results, expired leases or readiness.
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const READER_VERSION: u32 = 1;
pub const PROBE_MAX_AGE: Duration = Duration::from_secs(6);
pub const CHILD_RUNTIME_VERSION: u32 = 1;
pub const CHILD_RUNTIME_PROFILE: &str = "original_owner_static_hls_child_v1";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerContract {
    pub version: u32,
    pub instance: Uuid,
    pub database: Uuid,
    pub cache_identity: String,
    pub challenge: Uuid,
}

/// Private installed-execution declaration, emitted only by the actual
/// same-startup child runtime. This authenticates readiness, not any media
/// input, live owner, encoded output or durable execution attempt.
///
/// This optional sibling of the Stage A contract is omitted when no dedicated
/// child runtime is installed. Generic reader compatibility cannot mint it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChildRuntimeContract {
    pub version: u32,
    pub reader_version: u32,
    pub recipe_version: u32,
    pub input_version: u32,
    pub graph_version: u32,
    pub output_version: u32,
    pub profile: String,
    pub instance: Uuid,
    pub database: Uuid,
    pub challenge: Uuid,
    pub cache_identity: String,
    pub tasks: [String; 2],
}

impl ChildRuntimeContract {
    /// Shape and exact authenticated probe binding only. Callers must verify
    /// the response's purpose, fresh challenge, actual endpoint and elapsed
    /// time before using this declaration as installed-runtime readiness.
    pub fn require_binding(&self, worker: &WorkerContract) -> anyhow::Result<()> {
        anyhow::ensure!(
            worker.version == READER_VERSION
                && self.version == CHILD_RUNTIME_VERSION
                && self.reader_version == 2
                && self.recipe_version == 1
                && self.input_version == 1
                && self.graph_version == 1
                && self.output_version == 1
                && self.profile == CHILD_RUNTIME_PROFILE
                && self.tasks == ["child_encode", "child_read"]
                && self.instance == worker.instance
                && self.database == worker.database
                && self.challenge == worker.challenge
                && self.cache_identity == worker.cache_identity
                && !self.instance.is_nil()
                && !self.database.is_nil()
                && !self.challenge.is_nil()
                && self.cache_identity.len() == 64
                && self
                    .cache_identity
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "static_hls_child_runtime_mismatch"
        );
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub enum Drain {
    #[default]
    Unknown,
    /// A successful bounded owner shutdown and all positive resource receipts.
    Confirmed,
}

#[derive(Clone, Debug)]
pub struct ExpectedWorker {
    pub instance: Uuid,
    pub database: Uuid,
    pub cache_identity: String,
    pub challenge: Uuid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    DrainUnknown,
    WorkerUnknown,
    WorkerOld,
    WorkerMismatch,
    ProbeStale,
    AdmissionDisabled,
}

/// Evidence must be collected from the configured actual WORKER_URL endpoint.
/// Nearby binaries, --version output and /ready cannot satisfy this contract.
/// Keeping this pure lets frozen-old and late-response fixtures exercise it
/// without introducing an activation endpoint or a new deployment setting.
pub fn admission(
    drain: Drain,
    expected: &ExpectedWorker,
    observed: Option<(&WorkerContract, Instant)>,
    now: Instant,
) -> Result<(), Refusal> {
    if !matches!(drain, Drain::Confirmed) {
        return Err(Refusal::DrainUnknown);
    }
    let Some((observed, checked_at)) = observed else {
        return Err(Refusal::WorkerUnknown);
    };
    if observed.version != READER_VERSION {
        return Err(Refusal::WorkerOld);
    }
    if observed.instance != expected.instance
        || observed.database != expected.database
        || observed.cache_identity != expected.cache_identity
        || observed.challenge != expected.challenge
        || observed.instance.is_nil()
        || observed.database.is_nil()
        || observed.challenge.is_nil()
        || observed.cache_identity.is_empty()
        || observed.cache_identity.len() > 128
    {
        return Err(Refusal::WorkerMismatch);
    }
    if !now
        .checked_duration_since(checked_at)
        .is_some_and(|age| age <= PROBE_MAX_AGE)
    {
        return Err(Refusal::ProbeStale);
    }
    // Stage A has no public activation path. Even all-positive compatibility
    // evidence is not a complete fallback authorization or a rollout decision.
    Err(Refusal::AdmissionDisabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn expected() -> ExpectedWorker {
        ExpectedWorker {
            instance: Uuid::new_v4(),
            database: Uuid::new_v4(),
            cache_identity: "owned-cache-identity".into(),
            challenge: Uuid::new_v4(),
        }
    }
    fn contract(expected: &ExpectedWorker) -> WorkerContract {
        WorkerContract {
            version: READER_VERSION,
            instance: expected.instance,
            database: expected.database,
            cache_identity: expected.cache_identity.clone(),
            challenge: expected.challenge,
        }
    }
    #[test]
    fn no_process_absence_or_readiness_inference_can_replace_drain() {
        let now = Instant::now();
        let expected = expected();
        let observed = contract(&expected);
        assert_eq!(
            admission(Drain::Unknown, &expected, Some((&observed, now)), now),
            Err(Refusal::DrainUnknown)
        );
        assert_eq!(
            admission(Drain::Confirmed, &expected, None, now),
            Err(Refusal::WorkerUnknown)
        );
    }
    #[test]
    fn actual_old_worker_and_each_mismatched_binding_refuse() {
        let now = Instant::now();
        let expected = expected();
        let mut observed = contract(&expected);
        observed.version = 0;
        assert_eq!(
            admission(Drain::Confirmed, &expected, Some((&observed, now)), now),
            Err(Refusal::WorkerOld)
        );
        for field in 0..4 {
            let mut observed = contract(&expected);
            match field {
                0 => observed.instance = Uuid::new_v4(),
                1 => observed.database = Uuid::new_v4(),
                2 => observed.cache_identity = "other-cache".into(),
                _ => observed.challenge = Uuid::new_v4(),
            }
            assert_eq!(
                admission(Drain::Confirmed, &expected, Some((&observed, now)), now),
                Err(Refusal::WorkerMismatch)
            );
        }
    }
    #[test]
    fn delayed_or_future_probe_refuses_and_positive_evidence_stays_off() {
        let now = Instant::now();
        let expected = expected();
        let observed = contract(&expected);
        for checked in [
            now - PROBE_MAX_AGE - Duration::from_millis(1),
            now + Duration::from_millis(1),
        ] {
            assert_eq!(
                admission(Drain::Confirmed, &expected, Some((&observed, checked)), now),
                Err(Refusal::ProbeStale)
            );
        }
        assert_eq!(
            admission(Drain::Confirmed, &expected, Some((&observed, now)), now),
            Err(Refusal::AdmissionDisabled)
        );
    }
}
