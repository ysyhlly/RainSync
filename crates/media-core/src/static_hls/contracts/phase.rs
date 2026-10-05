//! Pure transition/predicate checks over supplied statements. A successful check
//! is not SQL proof, a CapturePermit, DisposalProof, grant, or live authority.
use super::graph::RootGraphStatement;
use super::input::{FrozenInput, IdentityStatement, OperationKind};
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestPhase {
    Pending,
    CompletedMarkedParent,
    CompletedUnmarkedNative,
    CompletedChild,
    Failed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublicationPhase {
    PendingParent,
    PublishedParent,
    PendingChild,
    PublishedChild,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureState {
    Capturing,
    Verified,
    Cancelled,
    Unknown,
    Disposed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessDispositionStatement {
    NeverStarted,
    Reaped,
}

/// Assertions only: anyone can construct this. It cannot acknowledge a real
/// owner's disposal, release a slot/reservation, or convert to DisposalProof.
pub struct DisposalStatement {
    pub operation_id: String,
    pub owner_id: String,
    pub streams_closed: bool,
    pub process_drained: bool,
    pub files_removed: bool,
    pub process_disposition: ProcessDispositionStatement,
}
impl DisposalStatement {
    fn require_matches(&self, state: &PhaseStatement) -> Result<()> {
        require(
            self.operation_id == state.input.identity_statement().operation_id
                && self.owner_id == state.owner_id
                && self.streams_closed
                && self.process_drained
                && self.files_removed,
            ContractError::Facts,
        )
    }
}

/// Candidate ledger data. No mutable whole-input access and no real authority.
pub struct PhaseStatement {
    input: FrozenInput,
    owner_id: String,
    pub request: RequestPhase,
    pub publication: PublicationPhase,
    pub capture: CaptureState,
    pub root_digest: Option<String>,
    pub response_sha256: Option<String>,
}
impl PhaseStatement {
    pub fn new(
        input: FrozenInput,
        owner_id: String,
        request: RequestPhase,
        publication: PublicationPhase,
        capture: CaptureState,
        root_digest: Option<String>,
        response_sha256: Option<String>,
    ) -> Result<Self> {
        let state = Self {
            input,
            owner_id,
            request,
            publication,
            capture,
            root_digest,
            response_sha256,
        };
        state.validate_shape()?;
        Ok(state)
    }
    pub fn input(&self) -> &FrozenInput {
        &self.input
    }
    fn validate_shape(&self) -> Result<()> {
        require(
            uuid(&self.owner_id)
                && self.root_digest.as_ref().is_none_or(|s| hash(s))
                && self.response_sha256.as_ref().is_none_or(|s| hash(s)),
            ContractError::Identity,
        )?;
        let parent = self.input.kind() == OperationKind::Parent;
        require(
            if parent {
                matches!(
                    self.publication,
                    PublicationPhase::PendingParent | PublicationPhase::PublishedParent
                )
            } else {
                matches!(
                    self.publication,
                    PublicationPhase::PendingChild | PublicationPhase::PublishedChild
                )
            },
            ContractError::Transition,
        )?;
        require(
            self.capture != CaptureState::Verified || self.root_digest.is_some(),
            ContractError::Facts,
        )?;
        require(
            self.capture != CaptureState::Capturing || self.root_digest.is_none(),
            ContractError::Facts,
        )?;
        match self.request {
            RequestPhase::Pending => require(
                self.response_sha256.is_none()
                    && matches!(
                        self.publication,
                        PublicationPhase::PendingParent | PublicationPhase::PendingChild
                    ),
                ContractError::Transition,
            ),
            RequestPhase::CompletedMarkedParent => require(
                parent
                    && self.publication == PublicationPhase::PublishedParent
                    && self.capture != CaptureState::Capturing
                    && self.root_digest.is_some()
                    && self.response_sha256.is_some(),
                ContractError::Transition,
            ),
            RequestPhase::CompletedUnmarkedNative => require(
                parent
                    && self.publication == PublicationPhase::PendingParent
                    && self.capture == CaptureState::Disposed
                    && self.response_sha256.is_some(),
                ContractError::Transition,
            ),
            RequestPhase::CompletedChild => require(
                !parent
                    && self.publication == PublicationPhase::PublishedChild
                    && self.capture != CaptureState::Capturing
                    && self.input.child_root().is_some_and(|root| {
                        Some(root.root_digest.as_str()) == self.root_digest.as_deref()
                    })
                    && self.root_digest.is_some()
                    && self.response_sha256.is_some(),
                ContractError::Transition,
            ),
            RequestPhase::Failed => {
                require(self.response_sha256.is_none(), ContractError::Transition)
            }
        }
    }
}

/// Facts that a future authority layer must obtain under its own exact locks,
/// actual Worker ownership, scanner and positive-disposal boundaries.
pub struct TransitionStatements<'a> {
    pub identity: &'a IdentityStatement,
    pub now_ms: u64,
    pub pending_lease_expires_at_ms: u64,
    pub current_authority_live: bool,
    pub complete_scan: Option<&'a RootGraphStatement>,
    pub same_worker_local_snapshot: bool,
    pub publication_session_and_response_atomic: bool,
    pub explained_native_result: bool,
    pub disposal: Option<&'a DisposalStatement>,
}

pub fn validate_transition(
    before: &PhaseStatement,
    after: &PhaseStatement,
    facts: &TransitionStatements<'_>,
) -> Result<()> {
    before.validate_shape()?;
    after.validate_shape()?;
    before.input.require_same_frozen_input(&after.input)?;
    before.input.require_identity_statement(facts.identity)?;
    require(before.owner_id == after.owner_id, ContractError::Identity)?;
    if let Some(scan) = facts.complete_scan {
        require(
            after.root_digest.as_deref() == Some(scan.root_digest()),
            ContractError::Facts,
        )?;
        validate_scan_binding(&before.input, scan)?;
    }
    if let Some(root) = &before.root_digest {
        require(
            after.root_digest.as_ref() == Some(root),
            ContractError::Immutable,
        )?;
    } else if let Some(root) = &after.root_digest {
        let scan = facts.complete_scan.ok_or(ContractError::Facts)?;
        require(
            before.request == RequestPhase::Pending && root == scan.root_digest(),
            ContractError::Facts,
        )?;
    }
    let capture_ok = match before.capture {
        CaptureState::Capturing => true,
        CaptureState::Verified => after.capture != CaptureState::Capturing,
        CaptureState::Cancelled => matches!(
            after.capture,
            CaptureState::Cancelled | CaptureState::Unknown | CaptureState::Disposed
        ),
        CaptureState::Unknown => matches!(
            after.capture,
            CaptureState::Unknown | CaptureState::Disposed
        ),
        CaptureState::Disposed => after.capture == CaptureState::Disposed,
    };
    require(capture_ok, ContractError::Transition)?;
    if before.capture != CaptureState::Verified && after.capture == CaptureState::Verified {
        require(
            before.request == RequestPhase::Pending
                && facts.complete_scan.is_some()
                && facts.same_worker_local_snapshot,
            ContractError::Facts,
        )?;
        validate_pending_fences(&before.input, facts)?;
    }
    if before.capture != CaptureState::Disposed && after.capture == CaptureState::Disposed {
        facts
            .disposal
            .ok_or(ContractError::Facts)?
            .require_matches(before)?;
    }
    match (before.request, after.request) {
        (
            RequestPhase::Pending,
            RequestPhase::CompletedMarkedParent | RequestPhase::CompletedChild,
        ) => {
            validate_pending_fences(&before.input, facts)?;
            require(
                after.capture == CaptureState::Verified
                    && facts.same_worker_local_snapshot
                    && facts.complete_scan.is_some_and(|scan| {
                        Some(scan.root_digest()) == after.root_digest.as_deref()
                    })
                    && facts.publication_session_and_response_atomic,
                ContractError::Facts,
            )?;
            require(
                matches!(
                    (before.publication, after.publication),
                    (
                        PublicationPhase::PendingParent,
                        PublicationPhase::PublishedParent
                    ) | (
                        PublicationPhase::PendingChild,
                        PublicationPhase::PublishedChild
                    )
                ),
                ContractError::Transition,
            )?;
        }
        (RequestPhase::Pending, RequestPhase::CompletedUnmarkedNative) => {
            validate_pending_fences(&before.input, facts)?;
            facts
                .disposal
                .ok_or(ContractError::Facts)?
                .require_matches(before)?;
            require(
                facts.explained_native_result
                    && after.capture == CaptureState::Disposed
                    && before.publication == after.publication,
                ContractError::Facts,
            )?;
        }
        (RequestPhase::Pending, RequestPhase::Failed)
        | (
            RequestPhase::CompletedMarkedParent
            | RequestPhase::CompletedUnmarkedNative
            | RequestPhase::CompletedChild,
            RequestPhase::Failed,
        ) => {
            require(
                before.publication == after.publication,
                ContractError::Immutable,
            )?;
        }
        (left, right) if left == right => {
            require(
                before.publication == after.publication
                    && before.response_sha256 == after.response_sha256,
                ContractError::Immutable,
            )?;
        }
        _ => return Err(ContractError::Transition),
    }
    Ok(())
}

fn validate_scan_binding(input: &FrozenInput, scan: &RootGraphStatement) -> Result<()> {
    match input.kind() {
        OperationKind::Parent => scan.require_parent_input(input),
        OperationKind::Child => scan.require_child_scan_binding(input),
    }
}

fn validate_pending_fences(input: &FrozenInput, facts: &TransitionStatements<'_>) -> Result<()> {
    require(
        facts.current_authority_live
            && facts.now_ms < input.preparation_deadline_ms()
            && facts.now_ms < input.root_deadline_ms()
            && facts.now_ms < facts.pending_lease_expires_at_ms,
        ContractError::Deadline,
    )
}

/// Pure monotonically shortening local deadline calculations. Caller supplies
/// DB remaining lifetimes and monotonic ticks; this type performs no queries.
pub struct DeadlineFenceStatements {
    root_until_tick_ms: u64,
    phase_until_tick_ms: Option<u64>,
    last_observed_tick_ms: u64,
    valid: bool,
}
impl DeadlineFenceStatements {
    pub fn from_input(input: &FrozenInput, db_now_ms: u64, local_tick_ms: u64) -> Result<Self> {
        let root = input
            .root_deadline_ms()
            .checked_sub(db_now_ms)
            .filter(|v| *v > 0)
            .ok_or(ContractError::Deadline)?;
        let phase = input
            .preparation_deadline_ms()
            .checked_sub(db_now_ms)
            .filter(|v| *v > 0)
            .ok_or(ContractError::Deadline)?;
        Ok(Self {
            root_until_tick_ms: local_tick_ms
                .checked_add(root)
                .ok_or(ContractError::Deadline)?,
            phase_until_tick_ms: Some(
                local_tick_ms
                    .checked_add(phase)
                    .ok_or(ContractError::Deadline)?,
            ),
            last_observed_tick_ms: local_tick_ms,
            valid: true,
        })
    }
    /// Charge positive evidence from query START, including the full round trip.
    /// A missing still-applicable phase, query error, overflow or missed fence
    /// fails closed. Rechecks can only shorten, never restart either interval.
    pub fn observe(
        &mut self,
        query_start_tick_ms: u64,
        query_end_tick_ms: u64,
        db_remaining_root_ms: u64,
        db_remaining_phase_ms: Option<u64>,
    ) -> Result<()> {
        let result = self.observe_inner(
            query_start_tick_ms,
            query_end_tick_ms,
            db_remaining_root_ms,
            db_remaining_phase_ms,
        );
        if result.is_err() {
            self.valid = false;
        }
        result
    }
    fn observe_inner(
        &mut self,
        query_start_tick_ms: u64,
        query_end_tick_ms: u64,
        db_remaining_root_ms: u64,
        db_remaining_phase_ms: Option<u64>,
    ) -> Result<()> {
        require(
            self.valid
                && query_start_tick_ms >= self.last_observed_tick_ms
                && query_end_tick_ms >= query_start_tick_ms,
            ContractError::Deadline,
        )?;
        let root = query_start_tick_ms
            .checked_add(db_remaining_root_ms)
            .ok_or(ContractError::Deadline)?;
        self.root_until_tick_ms = self.root_until_tick_ms.min(root);
        if let Some(old) = self.phase_until_tick_ms {
            let remaining = db_remaining_phase_ms.ok_or(ContractError::Deadline)?;
            self.phase_until_tick_ms = Some(
                old.min(
                    query_start_tick_ms
                        .checked_add(remaining)
                        .ok_or(ContractError::Deadline)?,
                ),
            );
        }
        self.last_observed_tick_ms = query_end_tick_ms;
        self.require_live(query_end_tick_ms)
    }
    pub fn complete_preparation(&mut self, local_tick_ms: u64) -> Result<()> {
        self.require_live(local_tick_ms)?;
        self.phase_until_tick_ms = None;
        Ok(())
    }
    pub fn require_live(&mut self, local_tick_ms: u64) -> Result<()> {
        let result = require(
            self.valid
                && local_tick_ms >= self.last_observed_tick_ms
                && local_tick_ms < self.root_until_tick_ms
                && self
                    .phase_until_tick_ms
                    .is_none_or(|until| local_tick_ms < until),
            ContractError::Deadline,
        );
        self.last_observed_tick_ms = self.last_observed_tick_ms.max(local_tick_ms);
        if result.is_err() {
            self.valid = false;
        }
        result
    }
}

pub struct DeliveryStatements<'a> {
    pub identity: &'a IdentityStatement,
    pub now_ms: u64,
    pub current_authority_live: bool,
    pub grant_live: bool,
    pub input_sha256: &'a str,
    pub root_digest: &'a str,
    pub reader_version: u8,
    pub recipe_version: u8,
    pub same_worker_local_snapshot: bool,
    pub verified_job_attempt_output_binding: bool,
}
fn validate_delivery_common(state: &PhaseStatement, facts: &DeliveryStatements<'_>) -> Result<()> {
    state.validate_shape()?;
    state.input.require_identity_statement(facts.identity)?;
    require(
        facts.current_authority_live
            && facts.grant_live
            && facts.now_ms < state.input.root_deadline_ms(),
        ContractError::Deadline,
    )?;
    require(
        facts.input_sha256 == state.input.input_sha256()
            && state.root_digest.as_deref() == Some(facts.root_digest),
        ContractError::Identity,
    )?;
    require(
        facts.reader_version == READER_VERSION && facts.recipe_version == RECIPE_VERSION,
        ContractError::Version,
    )
}
pub fn validate_parent_read_statement(
    state: &PhaseStatement,
    facts: &DeliveryStatements<'_>,
) -> Result<()> {
    validate_delivery_common(state, facts)?;
    require(
        state.request == RequestPhase::CompletedMarkedParent
            && state.publication == PublicationPhase::PublishedParent
            && state.capture == CaptureState::Verified
            && facts.same_worker_local_snapshot,
        ContractError::Facts,
    )
}
/// Published verified output outlives positive child INPUT disposal. Parent
/// liveness and child input ownership are intentionally absent from this check.
/// Actual output/read/file owners retain independent disposal obligations.
pub fn validate_child_output_statement(
    state: &PhaseStatement,
    facts: &DeliveryStatements<'_>,
) -> Result<()> {
    validate_delivery_common(state, facts)?;
    require(
        state.request == RequestPhase::CompletedChild
            && state.publication == PublicationPhase::PublishedChild
            && facts.verified_job_attempt_output_binding,
        ContractError::Facts,
    )
}
