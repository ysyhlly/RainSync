//! Bounded, offline diagnostics for committed room transitions.
//!
//! These facts explain a manual window; they are not credentials or proof of
//! provider work. Version 2 records the resolved media inputs and deterministic
//! lifecycle/clock transitions. Version 1 checkpoints retain their old meaning;
//! state replay never certifies or repeats external resource disposal.

use protocol::{Action, Command, PlaybackStatus, RoomState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const FORMAT_VERSION: u8 = 2;
pub const REDUCER_VERSION: &str = "room-diagnostics/2";
pub const LEGACY_FORMAT_VERSION: u8 = 1;
pub const LEGACY_REDUCER_VERSION: &str = "room-diagnostics/1";

fn supported_version(version: u8, reducer: &str) -> bool {
    matches!(
        (version, reducer),
        (1, LEGACY_REDUCER_VERSION) | (2, REDUCER_VERSION)
    )
}

#[path = "diagnostics_transitions.rs"]
mod transitions;
pub use transitions::{LifecycleTransition, ResolvedMedia};
pub const MAX_EVENTS: usize = 256;
pub const MAX_BUNDLE_BYTES: usize = 512 * 1024;
pub const MAX_STATE_BYTES: usize = 4096;
pub const MAX_ENVELOPE_BYTES: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum LifecycleState {
    Active,
    Closing,
    Closed,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lifecycle {
    pub state: LifecycleState,
    pub epoch: i64,
}

/// An explicit allowlist: neither a room credential nor its control epoch can
/// enter a diagnostic envelope, including an external-media checkpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeCommand {
    pub protocol_version: u8,
    pub command_id: Uuid,
    pub expected_revision: u32,
    pub media_generation: u32,
    pub action: SafeAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_version: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum SafeAction {
    Play,
    Pause,
    Seek { position_ms: f64 },
    SetRate { rate: f64 },
    ChangeMedia { media_id: Uuid },
    EndMedia { position_ms: f64 },
}

impl SafeCommand {
    pub fn from_command(command: &Command) -> Self {
        Self {
            protocol_version: command.protocol_version,
            command_id: command.command_id,
            expected_revision: command.expected_revision,
            media_generation: command.media_generation,
            live_version: command.live_version,
            action: match command.action {
                Action::Play => SafeAction::Play,
                Action::Pause => SafeAction::Pause,
                Action::Seek { position_ms } => SafeAction::Seek { position_ms },
                Action::SetRate { rate } => SafeAction::SetRate { rate },
                Action::ChangeMedia { media_id } => SafeAction::ChangeMedia { media_id },
                Action::EndMedia { position_ms } => SafeAction::EndMedia { position_ms },
            },
        }
    }

    pub fn to_command(&self, room_id: Uuid) -> Command {
        Command {
            protocol_version: self.protocol_version,
            room_id,
            command_id: self.command_id,
            live_version: self.live_version,
            control_epoch: None,
            expected_revision: self.expected_revision,
            media_generation: self.media_generation,
            action: match self.action {
                SafeAction::Play => Action::Play,
                SafeAction::Pause => Action::Pause,
                SafeAction::Seek { position_ms } => Action::Seek { position_ms },
                SafeAction::SetRate { rate } => Action::SetRate { rate },
                SafeAction::ChangeMedia { media_id } => Action::ChangeMedia { media_id },
                SafeAction::EndMedia { position_ms } => Action::EndMedia { position_ms },
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub schema_version: u8,
    pub reducer_version: String,
    pub event_id: Uuid,
    pub actor_id: Option<Uuid>,
    pub actor_is_admin: bool,
    pub before: RoomState,
    pub lifecycle_before: Lifecycle,
    pub lifecycle_after: Lifecycle,
    pub operation: Operation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Control {
        command: SafeCommand,
        server_time_ms: f64,
    },
    Ownership {
        expected_revision: u32,
        controller_user_id: Uuid,
    },
    MediaControl {
        command: SafeCommand,
        server_time_ms: f64,
        resolved_media: ResolvedMedia,
    },
    Lifecycle {
        transition: LifecycleTransition,
        expected_revision: u32,
        server_time_ms: Option<f64>,
    },
    ServerRestart {
        clock_epoch: Uuid,
    },
    ControlOwnerTakeover {
        clock_epoch: Uuid,
        server_time_ms: f64,
        recovered_position_ms: f64,
        checkpoint_matched: bool,
    },
    Checkpoint {
        reason: CheckpointReason,
        command: Option<SafeCommand>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckpointReason {
    MediaChanged,
    MediaAdvanced,
    Closing,
    Closed,
    Reopened,
    Archived,
    ServerRestart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum UnavailableReason {
    Legacy,
    UnsupportedVersion,
    MalformedEnvelope,
    InvalidState,
    OversizedRow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub revision: u32,
    pub recorded_at_ms: i64,
    pub after: Option<RoomState>,
    pub envelope: Option<Envelope>,
    pub unavailable: Option<UnavailableReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub format_version: u8,
    pub reducer_version: String,
    pub room_id: Uuid,
    pub captured_at_ms: i64,
    pub after_revision: u32,
    pub retained_from_revision: Option<u32>,
    pub snapshot: RoomState,
    pub lifecycle: Lifecycle,
    pub events: Vec<Event>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum IssueCode {
    UnsupportedVersion,
    OversizedWindow,
    OversizedRow,
    InvalidMetadata,
    InvalidState,
    InvalidLifecycle,
    Legacy,
    MalformedEnvelope,
    MissingAfterState,
    WrongRoom,
    RevisionGap,
    BeforeStateMismatch,
    LifecycleMismatch,
    ActorRequired,
    ControllerRequired,
    InvalidCommand,
    CheckpointRequired,
    InvalidEventTime,
    ReducerRejected,
    CommittedStateMismatch,
    InvalidCheckpoint,
    SnapshotMismatch,
    TruncatedWindow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Issue {
    pub index: Option<usize>,
    pub revision: Option<u32>,
    pub code: IssueCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub room_id: Uuid,
    pub verified_steps: usize,
    pub checkpoint_steps: usize,
    pub unverifiable_steps: usize,
    pub continuous: bool,
    pub reaches_snapshot: bool,
    pub all_transitions_verified: bool,
    pub final_state_digest: Option<String>,
    pub issues: Vec<Issue>,
}

const STATE_FIELDS: [&str; 11] = [
    "room_id",
    "revision",
    "media_id",
    "media_generation",
    "playback_status",
    "anchor_position_ms",
    "anchor_server_time_ms",
    "playback_rate",
    "controller_user_id",
    "duration_ms",
    "clock_epoch",
];

/// RoomState itself accepts unknown and absent optional fields. Check its full
/// allowlist before decoding the original bytes into the diagnostic DTOs.
fn strict_state_fields(value: &serde_json::Value) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("malformed_state")?;
    if object.len() != STATE_FIELDS.len() + usize::from(object.contains_key("live"))
        || object
            .keys()
            .any(|field| field != "live" && !STATE_FIELDS.contains(&field.as_str()))
        || STATE_FIELDS
            .iter()
            .any(|field| !object.contains_key(*field))
    {
        return Err("malformed_state");
    }
    Ok(())
}

fn strict_envelope_fields(value: &serde_json::Value) -> Result<(), &'static str> {
    strict_state_fields(value.get("before").ok_or("malformed_envelope")?)?;
    if value["operation"]["kind"] == "media_control" {
        let resolved = value["operation"]["resolved_media"]
            .as_object()
            .ok_or("malformed_envelope")?;
        if resolved.len() != 2 + usize::from(resolved.contains_key("live"))
            || resolved
                .keys()
                .any(|field| !["media_id", "duration_ms", "live"].contains(&field.as_str()))
            || !resolved.contains_key("media_id")
            || !resolved.contains_key("duration_ms")
        {
            return Err("malformed_envelope");
        }
    }
    if value["operation"]["kind"] == "lifecycle"
        && !value["operation"]
            .as_object()
            .is_some_and(|operation| operation.contains_key("server_time_ms"))
    {
        return Err("malformed_envelope");
    }
    Ok(())
}

pub fn decode_envelope(bytes: &[u8]) -> Result<Envelope, &'static str> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err("oversized_envelope");
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "malformed_envelope")?;
    strict_envelope_fields(&value)?;
    // Decode the original bytes too: this rejects duplicate typed fields rather
    // than trusting the last key retained by serde_json::Value.
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "malformed_envelope")?;
    validate_envelope(&envelope)?;
    Ok(envelope)
}

pub fn decode_window(bytes: &[u8]) -> Result<Window, &'static str> {
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err("oversized_window");
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "malformed_window")?;
    strict_state_fields(value.get("snapshot").ok_or("malformed_window")?)?;
    let events = value
        .get("events")
        .and_then(serde_json::Value::as_array)
        .ok_or("malformed_window")?;
    if events.len() > MAX_EVENTS {
        return Err("too_many_events");
    }
    for event in events {
        if let Some(after) = event.get("after").filter(|value| !value.is_null()) {
            strict_state_fields(after)?;
        }
        if let Some(envelope) = event.get("envelope").filter(|value| !value.is_null()) {
            strict_envelope_fields(envelope)?;
        }
    }
    let window: Window = serde_json::from_slice(bytes).map_err(|_| "malformed_window")?;
    if !supported_version(window.format_version, &window.reducer_version) {
        return Err("unsupported_window_version");
    }
    if window.captured_at_ms < 0 || window.events.iter().any(|event| event.recorded_at_ms < 0) {
        return Err("invalid_metadata");
    }
    validate_state(&window.snapshot)?;
    validate_lifecycle(window.lifecycle)?;
    for event in &window.events {
        if let Some(after) = &event.after {
            validate_state(after)?;
        }
        if let Some(envelope) = &event.envelope {
            validate_envelope(envelope)?;
        }
    }
    Ok(window)
}

pub fn validate_state(state: &RoomState) -> Result<(), &'static str> {
    let valid_nonnegative = |number: f64| number.is_finite() && number >= 0.0;
    if state.live.as_ref().is_some_and(|live| {
        !live.valid()
            || state.media_id.is_none()
            || state.duration_ms.is_some()
            || state.anchor_position_ms != 0.0
            || state.playback_rate != 1.0
            || state.playback_status == PlaybackStatus::Ended
    }) {
        return Err("invalid_state");
    }
    if !valid_nonnegative(state.anchor_position_ms)
        || !valid_nonnegative(state.anchor_server_time_ms)
        || !state.playback_rate.is_finite()
        || !(0.25..=2.0).contains(&state.playback_rate)
        || state
            .duration_ms
            .is_some_and(|duration| !valid_nonnegative(duration))
        || state.anchor_position_ms
            > state
                .duration_ms
                .unwrap_or(protocol::UNKNOWN_DURATION_LIMIT_MS)
    {
        return Err("invalid_state");
    }
    if serde_json::to_vec(state)
        .map_err(|_| "invalid_state")?
        .len()
        > MAX_STATE_BYTES
    {
        return Err("oversized_state");
    }
    Ok(())
}

pub fn state_digest(state: &RoomState) -> Result<String, &'static str> {
    validate_state(state)?;
    let bytes = serde_json::to_vec(state).map_err(|_| "invalid_state")?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn validate_lifecycle(lifecycle: Lifecycle) -> Result<(), &'static str> {
    if lifecycle.epoch < 0 {
        return Err("invalid_lifecycle");
    }
    Ok(())
}

fn validate_command(command: &SafeCommand) -> Result<(), &'static str> {
    if command.protocol_version != protocol::VERSION {
        return Err("unsupported_command_version");
    }
    match command.action {
        SafeAction::Seek { position_ms } if !position_ms.is_finite() || position_ms < 0.0 => {
            Err("invalid_command")
        }
        SafeAction::EndMedia { position_ms } if !position_ms.is_finite() || position_ms <= 0.0 => {
            Err("invalid_command")
        }
        SafeAction::SetRate { rate } if !rate.is_finite() || !(0.25..=2.0).contains(&rate) => {
            Err("invalid_command")
        }
        _ => Ok(()),
    }
}

fn validate_envelope(envelope: &Envelope) -> Result<(), &'static str> {
    if !supported_version(envelope.schema_version, &envelope.reducer_version) {
        return Err("unsupported_envelope_version");
    }
    if envelope.schema_version == LEGACY_FORMAT_VERSION
        && matches!(
            envelope.operation,
            Operation::MediaControl { .. }
                | Operation::Lifecycle { .. }
                | Operation::ServerRestart { .. }
                | Operation::ControlOwnerTakeover { .. }
        )
    {
        return Err("unsupported_envelope_version");
    }
    validate_state(&envelope.before)?;
    validate_lifecycle(envelope.lifecycle_before)?;
    validate_lifecycle(envelope.lifecycle_after)?;
    match &envelope.operation {
        Operation::Control {
            command,
            server_time_ms,
        } => {
            validate_command(command)?;
            if !server_time_ms.is_finite() || *server_time_ms < 0.0 {
                return Err("invalid_event_time");
            }
        }
        Operation::MediaControl {
            command,
            server_time_ms,
            resolved_media,
        } => {
            validate_command(command)?;
            if !server_time_ms.is_finite() || *server_time_ms < 0.0 {
                return Err("invalid_event_time");
            }
            resolved_media.validate()?;
        }
        Operation::Lifecycle {
            server_time_ms: Some(time),
            ..
        } => {
            if !time.is_finite() || *time < 0.0 {
                return Err("invalid_event_time");
            }
        }
        Operation::Checkpoint {
            command: Some(command),
            ..
        } => validate_command(command)?,
        _ => {}
    }
    if serde_json::to_vec(envelope)
        .map_err(|_| "malformed_envelope")?
        .len()
        > MAX_ENVELOPE_BYTES
    {
        return Err("oversized_envelope");
    }
    Ok(())
}

fn envelope_error(reason: &'static str) -> IssueCode {
    match reason {
        "unsupported_envelope_version" | "unsupported_command_version" => {
            IssueCode::UnsupportedVersion
        }
        "oversized_envelope" | "oversized_state" => IssueCode::OversizedRow,
        "invalid_state" => IssueCode::InvalidState,
        "invalid_lifecycle" => IssueCode::InvalidLifecycle,
        "invalid_command" => IssueCode::InvalidCommand,
        "invalid_event_time" => IssueCode::InvalidEventTime,
        _ => IssueCode::MalformedEnvelope,
    }
}

fn checkpoint_valid(
    envelope: &Envelope,
    after: &RoomState,
    reason: CheckpointReason,
    command: &Option<SafeCommand>,
) -> bool {
    use CheckpointReason::*;
    let before = &envelope.before;
    let lifecycle_before = envelope.lifecycle_before;
    let lifecycle_after = envelope.lifecycle_after;
    let same_clock = before.clock_epoch == after.clock_epoch;
    let same_lifecycle = lifecycle_before == lifecycle_after;
    let next_epoch = lifecycle_before.epoch.checked_add(1);
    let transition = match reason {
        MediaChanged | MediaAdvanced => {
            same_clock && same_lifecycle && lifecycle_before.state == LifecycleState::Active
        }
        Closing => {
            same_clock
                && lifecycle_before.state == LifecycleState::Active
                && lifecycle_after.state == LifecycleState::Closing
                && next_epoch == Some(lifecycle_after.epoch)
                && after.playback_status == PlaybackStatus::Paused
        }
        Closed => {
            same_clock
                && lifecycle_before.state == LifecycleState::Closing
                && lifecycle_after.state == LifecycleState::Closed
                && lifecycle_before.epoch == lifecycle_after.epoch
                && after.playback_status == PlaybackStatus::Paused
        }
        Reopened => {
            same_clock
                && lifecycle_before.state == LifecycleState::Closed
                && lifecycle_after.state == LifecycleState::Active
                && next_epoch == Some(lifecycle_after.epoch)
                && after.playback_status == PlaybackStatus::Paused
        }
        Archived => {
            same_clock
                && lifecycle_before.state == LifecycleState::Closed
                && lifecycle_after.state == LifecycleState::Archived
                && lifecycle_before.epoch == lifecycle_after.epoch
        }
        ServerRestart => {
            !same_clock
                && same_lifecycle
                && after.playback_status == PlaybackStatus::Paused
                && after.anchor_server_time_ms == 0.0
        }
    };
    if !transition {
        return false;
    }
    if envelope.actor_id.is_none() && !matches!(reason, Closed | ServerRestart) {
        return false;
    }
    match (reason, command) {
        (MediaChanged, Some(command)) => {
            matches!(command.action, SafeAction::ChangeMedia { media_id } if after.media_id == Some(media_id))
                && command.expected_revision == before.revision
                && command.media_generation == before.media_generation
                && before.media_generation.checked_add(1) == Some(after.media_generation)
        }
        (MediaAdvanced, Some(command)) => {
            matches!(command.action, SafeAction::EndMedia { .. })
                && command.expected_revision == before.revision
                && command.media_generation == before.media_generation
                && before.media_generation.checked_add(1) == Some(after.media_generation)
        }
        (MediaChanged | MediaAdvanced, None) => false,
        (_, None) => true,
        (_, Some(_)) => false,
    }
}

#[derive(Clone, Copy)]
enum StepKind {
    Verified,
    Checkpoint,
}

fn verify_event(window: &Window, event: &Event) -> Result<StepKind, IssueCode> {
    if event.recorded_at_ms < 0 {
        return Err(IssueCode::InvalidMetadata);
    }
    if let Some(reason) = event.unavailable {
        return Err(match reason {
            UnavailableReason::Legacy => IssueCode::Legacy,
            UnavailableReason::UnsupportedVersion => IssueCode::UnsupportedVersion,
            UnavailableReason::MalformedEnvelope => IssueCode::MalformedEnvelope,
            UnavailableReason::InvalidState => IssueCode::InvalidState,
            UnavailableReason::OversizedRow => IssueCode::OversizedRow,
        });
    }
    let after = event.after.as_ref().ok_or(IssueCode::MissingAfterState)?;
    validate_state(after).map_err(envelope_error)?;
    let envelope = event.envelope.as_ref().ok_or(IssueCode::Legacy)?;
    validate_envelope(envelope).map_err(envelope_error)?;
    if envelope.schema_version > window.format_version {
        return Err(IssueCode::UnsupportedVersion);
    }
    if after.room_id != window.room_id || envelope.before.room_id != window.room_id {
        return Err(IssueCode::WrongRoom);
    }
    if event.revision != after.revision
        || envelope.before.revision.checked_add(1) != Some(event.revision)
    {
        return Err(IssueCode::RevisionGap);
    }
    match &envelope.operation {
        Operation::Control {
            command,
            server_time_ms,
        } => {
            let actor = envelope.actor_id.ok_or(IssueCode::ActorRequired)?;
            if matches!(
                command.action,
                SafeAction::ChangeMedia { .. } | SafeAction::EndMedia { .. }
            ) {
                return Err(IssueCode::CheckpointRequired);
            }
            if envelope.lifecycle_before != envelope.lifecycle_after
                || envelope.lifecycle_before.state != LifecycleState::Active
            {
                return Err(IssueCode::LifecycleMismatch);
            }
            if after.clock_epoch != envelope.before.clock_epoch {
                return Err(IssueCode::CheckpointRequired);
            }
            // Monotonic process time is compared only to the matching epoch's
            // room anchor, never to recorded_at_ms or captured_at_ms (UTC).
            if *server_time_ms < envelope.before.anchor_server_time_ms {
                return Err(IssueCode::InvalidEventTime);
            }
            let next = crate::reduce(
                &envelope.before,
                &command.to_command(window.room_id),
                actor,
                envelope.actor_is_admin,
                *server_time_ms,
            )
            .map_err(|_| IssueCode::ReducerRejected)?;
            if &next != after {
                return Err(IssueCode::CommittedStateMismatch);
            }
            Ok(StepKind::Verified)
        }
        Operation::Ownership {
            expected_revision,
            controller_user_id,
        } => {
            let actor = envelope.actor_id.ok_or(IssueCode::ActorRequired)?;
            if actor != envelope.before.controller_user_id && !envelope.actor_is_admin {
                return Err(IssueCode::ControllerRequired);
            }
            if envelope.lifecycle_before != envelope.lifecycle_after
                || envelope.lifecycle_before.state != LifecycleState::Active
            {
                return Err(IssueCode::LifecycleMismatch);
            }
            let next = crate::transfer_controller(
                &envelope.before,
                *expected_revision,
                *controller_user_id,
            )
            .map_err(|_| IssueCode::ReducerRejected)?;
            if &next != after {
                return Err(IssueCode::CommittedStateMismatch);
            }
            Ok(StepKind::Verified)
        }
        Operation::MediaControl { .. }
        | Operation::Lifecycle { .. }
        | Operation::ServerRestart { .. }
        | Operation::ControlOwnerTakeover { .. } => {
            let (next, lifecycle) = transitions::apply(envelope)?;
            if &next != after {
                return Err(IssueCode::CommittedStateMismatch);
            }
            if lifecycle != envelope.lifecycle_after {
                return Err(IssueCode::LifecycleMismatch);
            }
            Ok(StepKind::Verified)
        }
        Operation::Checkpoint { reason, command } => {
            if !checkpoint_valid(envelope, after, *reason, command) {
                return Err(IssueCode::InvalidCheckpoint);
            }
            Ok(StepKind::Checkpoint)
        }
    }
}

/// Verify only the supplied bounded slice. Invalid or missing history is never
/// replaced with a synthetic baseline. Later locally valid rows may be counted,
/// but cannot repair whole-window coverage after a gap or unavailable row.
pub fn verify(window: &Window) -> Report {
    let mut report = Report {
        room_id: window.room_id,
        verified_steps: 0,
        checkpoint_steps: 0,
        unverifiable_steps: 0,
        continuous: true,
        reaches_snapshot: false,
        all_transitions_verified: false,
        final_state_digest: None,
        issues: Vec::new(),
    };
    let issue = |report: &mut Report, index, revision, code| {
        if report.issues.len() < MAX_EVENTS + 4 {
            report.issues.push(Issue {
                index,
                revision,
                code,
            });
        }
        report.continuous = false;
    };
    let fatal = if !supported_version(window.format_version, &window.reducer_version) {
        Some(IssueCode::UnsupportedVersion)
    } else if window.events.len() > MAX_EVENTS {
        Some(IssueCode::OversizedWindow)
    } else if window.captured_at_ms < 0 {
        Some(IssueCode::InvalidMetadata)
    } else if validate_state(&window.snapshot).is_err() {
        Some(IssueCode::InvalidState)
    } else if window.snapshot.room_id != window.room_id {
        Some(IssueCode::WrongRoom)
    } else if validate_lifecycle(window.lifecycle).is_err() {
        Some(IssueCode::InvalidLifecycle)
    } else if !serde_json::to_vec(window).is_ok_and(|bytes| bytes.len() <= MAX_BUNDLE_BYTES) {
        Some(IssueCode::OversizedWindow)
    } else {
        None
    };
    if let Some(code) = fatal {
        issue(&mut report, None, None, code);
        report.unverifiable_steps = window.events.len();
        return report;
    }
    if window.truncated {
        issue(&mut report, None, None, IssueCode::TruncatedWindow);
    }
    if let Some(first) = window.events.first()
        && (window
            .retained_from_revision
            .is_none_or(|retained| retained > first.revision)
            || window.after_revision.checked_add(1) != Some(first.revision))
    {
        issue(
            &mut report,
            Some(0),
            Some(first.revision),
            IssueCode::RevisionGap,
        );
    }
    let mut prior_revision = window.after_revision;
    let mut prior_state: Option<&RoomState> = None;
    let mut prior_lifecycle: Option<Lifecycle> = None;
    for (index, event) in window.events.iter().enumerate() {
        let mut result = verify_event(window, event);
        if prior_revision.checked_add(1) != Some(event.revision) {
            result = Err(IssueCode::RevisionGap);
        } else if let Some(envelope) = &event.envelope {
            if let Some(before) = prior_state {
                if &envelope.before != before {
                    result = Err(IssueCode::BeforeStateMismatch);
                }
            } else if index == 0 && envelope.before.revision != window.after_revision {
                result = Err(IssueCode::RevisionGap);
            }
            if prior_lifecycle.is_some_and(|lifecycle| lifecycle != envelope.lifecycle_before) {
                result = Err(IssueCode::LifecycleMismatch);
            }
        }
        match result {
            Ok(StepKind::Verified) => report.verified_steps += 1,
            Ok(StepKind::Checkpoint) => report.checkpoint_steps += 1,
            Err(code) => {
                report.unverifiable_steps += 1;
                issue(&mut report, Some(index), Some(event.revision), code);
            }
        }
        prior_revision = event.revision;
        prior_state = event.after.as_ref().filter(|state| {
            validate_state(state).is_ok()
                && state.room_id == window.room_id
                && state.revision == event.revision
        });
        prior_lifecycle = event
            .envelope
            .as_ref()
            .filter(|envelope| validate_lifecycle(envelope.lifecycle_after).is_ok())
            .map(|envelope| envelope.lifecycle_after);
    }
    if let Some(last) = window.events.last() {
        let terminal_matches = last.after.as_ref() == Some(&window.snapshot)
            && last.revision == window.snapshot.revision
            && last
                .envelope
                .as_ref()
                .is_some_and(|envelope| envelope.lifecycle_after == window.lifecycle);
        report.reaches_snapshot = report.continuous && terminal_matches;
        if !terminal_matches {
            issue(
                &mut report,
                None,
                Some(window.snapshot.revision),
                IssueCode::SnapshotMismatch,
            );
        }
        if let Some(state) = prior_state {
            report.final_state_digest = state_digest(state).ok();
        }
    } else {
        report.reaches_snapshot =
            report.continuous && window.snapshot.revision == window.after_revision;
        if !report.reaches_snapshot {
            issue(
                &mut report,
                None,
                Some(window.snapshot.revision),
                IssueCode::RevisionGap,
            );
        }
        report.final_state_digest = state_digest(&window.snapshot).ok();
    }
    report.all_transitions_verified = report.continuous
        && report.reaches_snapshot
        && report.unverifiable_steps == 0
        && report.checkpoint_steps == 0
        && report.verified_steps > 0;
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> RoomState {
        RoomState {
            room_id: Uuid::from_u128(1),
            revision: 4,
            media_id: Some(Uuid::from_u128(2)),
            media_generation: 3,
            playback_status: PlaybackStatus::Playing,
            anchor_position_ms: 1000.25,
            anchor_server_time_ms: 100.5,
            playback_rate: 1.5,
            controller_user_id: Uuid::from_u128(3),
            duration_ms: Some(10_000.0),
            live: None,
            clock_epoch: Uuid::from_u128(4),
        }
    }

    fn lifecycle() -> Lifecycle {
        Lifecycle {
            state: LifecycleState::Active,
            epoch: 3,
        }
    }

    fn command(before: &RoomState, action: Action) -> Command {
        Command {
            protocol_version: protocol::VERSION,
            room_id: before.room_id,
            command_id: Uuid::from_u128(10 + u128::from(before.revision)),
            live_version: None,
            control_epoch: Some(Uuid::from_u128(999)),
            expected_revision: before.revision,
            media_generation: before.media_generation,
            action,
        }
    }

    fn control(before: &RoomState, action: Action, time: f64) -> Event {
        let command = command(before, action);
        let after =
            crate::reduce(before, &command, before.controller_user_id, false, time).unwrap();
        Event {
            revision: after.revision,
            recorded_at_ms: 1_800_000_000_000,
            after: Some(after),
            envelope: Some(Envelope {
                schema_version: FORMAT_VERSION,
                reducer_version: REDUCER_VERSION.into(),
                event_id: command.command_id,
                actor_id: Some(before.controller_user_id),
                actor_is_admin: false,
                before: before.clone(),
                lifecycle_before: lifecycle(),
                lifecycle_after: lifecycle(),
                operation: Operation::Control {
                    command: SafeCommand::from_command(&command),
                    server_time_ms: time,
                },
            }),
            unavailable: None,
        }
    }

    fn window(events: Vec<Event>) -> Window {
        let first = events.first().unwrap();
        let last = events.last().unwrap();
        Window {
            format_version: FORMAT_VERSION,
            reducer_version: REDUCER_VERSION.into(),
            room_id: state().room_id,
            captured_at_ms: 1_800_000_000_001,
            after_revision: first.revision - 1,
            retained_from_revision: Some(first.revision),
            snapshot: last.after.as_ref().unwrap().clone(),
            lifecycle: last.envelope.as_ref().unwrap().lifecycle_after,
            events,
            truncated: false,
        }
    }

    fn checkpoint(
        before: &RoomState,
        after: RoomState,
        reason: CheckpointReason,
        command: Option<SafeCommand>,
        before_lifecycle: Lifecycle,
        after_lifecycle: Lifecycle,
    ) -> Event {
        Event {
            revision: after.revision,
            recorded_at_ms: 1_800_000_000_000,
            after: Some(after),
            envelope: Some(Envelope {
                schema_version: FORMAT_VERSION,
                reducer_version: REDUCER_VERSION.into(),
                event_id: Uuid::from_u128(100 + u128::from(before.revision)),
                actor_id: (!matches!(
                    reason,
                    CheckpointReason::Closed | CheckpointReason::ServerRestart
                ))
                .then_some(before.controller_user_id),
                actor_is_admin: false,
                before: before.clone(),
                lifecycle_before: before_lifecycle,
                lifecycle_after: after_lifecycle,
                operation: Operation::Checkpoint { reason, command },
            }),
            unavailable: None,
        }
    }

    #[test]
    fn ordinary_controls_and_ownership_are_verified_without_credentials() {
        let first = control(&state(), Action::Pause, 300.75);
        let second = control(
            first.after.as_ref().unwrap(),
            Action::Seek {
                position_ms: 4300.5,
            },
            310.25,
        );
        let before = second.after.as_ref().unwrap();
        let owner = Uuid::from_u128(8);
        let after = crate::transfer_controller(before, before.revision, owner).unwrap();
        let third = Event {
            revision: after.revision,
            recorded_at_ms: 1_800_000_000_000,
            after: Some(after),
            envelope: Some(Envelope {
                schema_version: FORMAT_VERSION,
                reducer_version: REDUCER_VERSION.into(),
                event_id: Uuid::from_u128(16),
                actor_id: Some(before.controller_user_id),
                actor_is_admin: false,
                before: before.clone(),
                lifecycle_before: lifecycle(),
                lifecycle_after: lifecycle(),
                operation: Operation::Ownership {
                    expected_revision: before.revision,
                    controller_user_id: owner,
                },
            }),
            unavailable: None,
        };
        let bundle = window(vec![first, second, third]);
        let encoded = serde_json::to_vec(&bundle).unwrap();
        let text = String::from_utf8(encoded.clone()).unwrap();
        assert!(!text.contains("control_epoch"));
        assert!(!text.contains(&Uuid::from_u128(999).to_string()));
        let decoded = decode_window(&encoded).unwrap();
        assert_eq!(decoded, bundle);
        let report = verify(&decoded);
        assert_eq!(
            (
                report.verified_steps,
                report.checkpoint_steps,
                report.unverifiable_steps
            ),
            (3, 0, 0)
        );
        assert!(report.continuous && report.reaches_snapshot && report.all_transitions_verified);
        assert_eq!(
            report.final_state_digest,
            Some(state_digest(&bundle.snapshot).unwrap())
        );
    }

    #[test]
    fn external_media_is_explained_as_checkpoint_never_reducer_verified() {
        for action in [
            Action::ChangeMedia {
                media_id: Uuid::from_u128(6),
            },
            Action::EndMedia {
                position_ms: 10_000.0,
            },
        ] {
            let mut before = state();
            before.anchor_position_ms = 10_000.0;
            let command = command(&before, action);
            let mut after =
                crate::reduce(&before, &command, before.controller_user_id, false, 300.0).unwrap();
            let reason = if matches!(command.action, Action::ChangeMedia { .. }) {
                CheckpointReason::MediaChanged
            } else {
                CheckpointReason::MediaAdvanced
            };
            // Duration and playlist selection are external committed facts.
            after.duration_ms = Some(30_000.0);
            let event = checkpoint(
                &before,
                after,
                reason,
                Some(SafeCommand::from_command(&command)),
                lifecycle(),
                lifecycle(),
            );
            let report = verify(&window(vec![event.clone()]));
            assert_eq!(
                (
                    report.verified_steps,
                    report.checkpoint_steps,
                    report.unverifiable_steps
                ),
                (0, 1, 0)
            );
            assert!(report.continuous && report.reaches_snapshot);
            assert!(!report.all_transitions_verified);
            let mut wrong = event;
            wrong.envelope.as_mut().unwrap().operation = Operation::Control {
                command: SafeCommand::from_command(&command),
                server_time_ms: 300.0,
            };
            assert_eq!(
                verify(&window(vec![wrong])).issues[0].code,
                IssueCode::CheckpointRequired
            );
        }
    }

    #[test]
    fn restart_resets_only_the_monotonic_epoch_boundary() {
        let first = control(&state(), Action::Pause, 5000.0);
        let before = first.after.as_ref().unwrap();
        let mut after = before.clone();
        after.revision += 1;
        after.clock_epoch = Uuid::from_u128(50);
        after.anchor_server_time_ms = 0.0;
        let restart = checkpoint(
            before,
            after,
            CheckpointReason::ServerRestart,
            None,
            lifecycle(),
            lifecycle(),
        );
        let third = control(restart.after.as_ref().unwrap(), Action::Play, 5.0);
        let report = verify(&window(vec![first, restart, third]));
        assert_eq!(
            (
                report.verified_steps,
                report.checkpoint_steps,
                report.unverifiable_steps
            ),
            (2, 1, 0)
        );
        assert!(report.continuous && report.reaches_snapshot);
        assert!(!report.all_transitions_verified);
    }

    #[test]
    fn lifecycle_checkpoints_have_explicit_order_and_epoch() {
        let before = state();
        let mut paused = before.clone();
        paused.revision += 1;
        paused.playback_status = PlaybackStatus::Paused;
        let closing_lifecycle = Lifecycle {
            state: LifecycleState::Closing,
            epoch: 4,
        };
        let closing = checkpoint(
            &before,
            paused,
            CheckpointReason::Closing,
            None,
            lifecycle(),
            closing_lifecycle,
        );
        let before_closed = closing.after.as_ref().unwrap();
        let mut closed_state = before_closed.clone();
        closed_state.revision += 1;
        let closed_lifecycle = Lifecycle {
            state: LifecycleState::Closed,
            epoch: 4,
        };
        let closed = checkpoint(
            before_closed,
            closed_state,
            CheckpointReason::Closed,
            None,
            closing_lifecycle,
            closed_lifecycle,
        );
        let before_reopened = closed.after.as_ref().unwrap();
        let mut reopened_state = before_reopened.clone();
        reopened_state.revision += 1;
        let reopened = checkpoint(
            before_reopened,
            reopened_state,
            CheckpointReason::Reopened,
            None,
            closed_lifecycle,
            Lifecycle {
                state: LifecycleState::Active,
                epoch: 5,
            },
        );
        let bundle = window(vec![closing, closed, reopened]);
        let report = verify(&bundle);
        assert!(report.continuous && report.reaches_snapshot);
        assert_eq!(report.checkpoint_steps, 3);
        assert!(!report.all_transitions_verified);
        let mut mismatch = bundle;
        mismatch.events[1]
            .envelope
            .as_mut()
            .unwrap()
            .lifecycle_before
            .epoch += 1;
        let report = verify(&mismatch);
        assert!(!report.continuous && !report.all_transitions_verified);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == IssueCode::LifecycleMismatch)
        );
    }

    #[test]
    fn unavailable_null_and_revision_gaps_never_recover_full_coverage() {
        let first = control(&state(), Action::Pause, 200.0);
        let second = control(first.after.as_ref().unwrap(), Action::Play, 250.0);
        let third = control(second.after.as_ref().unwrap(), Action::Pause, 300.0);
        for reason in [
            UnavailableReason::Legacy,
            UnavailableReason::UnsupportedVersion,
            UnavailableReason::MalformedEnvelope,
            UnavailableReason::InvalidState,
            UnavailableReason::OversizedRow,
        ] {
            let mut bundle = window(vec![first.clone(), second.clone(), third.clone()]);
            bundle.events[1].unavailable = Some(reason);
            bundle.events[1].envelope = None;
            let report = verify(&bundle);
            assert_eq!(report.verified_steps, 2);
            assert_eq!(report.unverifiable_steps, 1);
            assert!(
                !report.continuous && !report.reaches_snapshot && !report.all_transitions_verified
            );
        }
        let mut null = window(vec![first.clone(), second.clone(), third.clone()]);
        null.events[1].after = None;
        null.events[1].envelope = None;
        assert!(!verify(&null).all_transitions_verified);
        let mut gap = window(vec![first.clone(), third]);
        gap.snapshot = gap.events.last().unwrap().after.as_ref().unwrap().clone();
        assert!(
            verify(&gap)
                .issues
                .iter()
                .any(|issue| issue.code == IssueCode::RevisionGap)
        );
        assert!(!verify(&gap).all_transitions_verified);
        let mut retention = window(vec![first]);
        retention.after_revision = 0;
        assert!(!verify(&retention).all_transitions_verified);
    }

    #[test]
    fn tampered_before_after_actor_clock_and_snapshot_fail_closed() {
        let first = control(&state(), Action::Pause, 200.0);
        let second = control(first.after.as_ref().unwrap(), Action::Play, 250.0);
        let original = window(vec![first, second]);
        for case in 0..7 {
            let mut bundle = original.clone();
            match case {
                0 => bundle.events[0].after.as_mut().unwrap().anchor_position_ms += 1.0,
                1 => {
                    bundle.events[1]
                        .envelope
                        .as_mut()
                        .unwrap()
                        .before
                        .playback_rate = 2.0
                }
                2 => bundle.events[0].envelope.as_mut().unwrap().actor_id = None,
                3 => {
                    bundle.events[0].envelope.as_mut().unwrap().actor_id = Some(Uuid::from_u128(90))
                }
                4 => bundle.events[0].after.as_mut().unwrap().clock_epoch = Uuid::from_u128(90),
                5 => bundle.snapshot.revision += 1,
                _ => {
                    bundle.events[0]
                        .envelope
                        .as_mut()
                        .unwrap()
                        .lifecycle_after
                        .epoch += 1
                }
            }
            let report = verify(&bundle);
            assert!(
                !report.continuous && !report.all_transitions_verified,
                "case {case}"
            );
        }
    }

    #[test]
    fn strict_decode_refuses_unknown_missing_and_duplicate_state_fields() {
        let event = control(&state(), Action::Pause, 200.0);
        let bundle = window(vec![event]);
        let original = serde_json::to_value(&bundle).unwrap();
        for path in ["snapshot", "after", "before"] {
            for field in ["media_id", "duration_ms", "control_epoch"] {
                let mut value = original.clone();
                let target = match path {
                    "snapshot" => &mut value["snapshot"],
                    "after" => &mut value["events"][0]["after"],
                    _ => &mut value["events"][0]["envelope"]["before"],
                };
                if field == "control_epoch" {
                    target[field] = serde_json::json!(Uuid::from_u128(90));
                } else {
                    target.as_object_mut().unwrap().remove(field);
                }
                assert!(decode_window(&serde_json::to_vec(&value).unwrap()).is_err());
            }
        }
        let encoded = String::from_utf8(serde_json::to_vec(&bundle).unwrap()).unwrap();
        let duplicate = encoded.replacen("\"revision\":4", "\"revision\":4,\"revision\":4", 1);
        assert!(decode_window(duplicate.as_bytes()).is_err());
        let mut envelope =
            serde_json::to_value(bundle.events[0].envelope.as_ref().unwrap()).unwrap();
        envelope["operation"]["command"]["control_epoch"] = serde_json::json!(Uuid::from_u128(90));
        assert!(decode_envelope(&serde_json::to_vec(&envelope).unwrap()).is_err());
        envelope["operation"]["command"]
            .as_object_mut()
            .unwrap()
            .remove("control_epoch");
        envelope["operation"]["command"]["action"]["unexpected"] = serde_json::json!(true);
        assert!(decode_envelope(&serde_json::to_vec(&envelope).unwrap()).is_err());
    }

    #[test]
    fn numbers_versions_and_byte_and_step_caps_are_checked() {
        let mut valid = state();
        valid.duration_ms = Some(protocol::UNKNOWN_DURATION_LIMIT_MS * 2.0);
        valid.anchor_position_ms = protocol::UNKNOWN_DURATION_LIMIT_MS * 1.5;
        assert!(validate_state(&valid).is_ok());
        valid.duration_ms = None;
        assert_eq!(validate_state(&valid), Err("invalid_state"));
        for invalid in [f64::NAN, f64::INFINITY, -1.0] {
            let mut state = state();
            state.anchor_server_time_ms = invalid;
            assert!(validate_state(&state).is_err());
            assert!(state_digest(&state).is_err());
        }
        let event = control(&state(), Action::Pause, 200.0);
        let bundle = window(vec![event.clone()]);
        let mut unsupported = bundle.clone();
        unsupported.reducer_version = "future".into();
        assert_eq!(
            decode_window(&serde_json::to_vec(&unsupported).unwrap()),
            Err("unsupported_window_version")
        );
        assert!(!verify(&unsupported).all_transitions_verified);
        let mut excessive = bundle.clone();
        excessive.events = vec![event; MAX_EVENTS + 1];
        assert_eq!(
            decode_window(&serde_json::to_vec(&excessive).unwrap()),
            Err("too_many_events")
        );
        assert_eq!(
            verify(&excessive).issues[0].code,
            IssueCode::OversizedWindow
        );
        assert_eq!(
            decode_window(&vec![b' '; MAX_BUNDLE_BYTES + 1]),
            Err("oversized_window")
        );
        assert_eq!(
            decode_envelope(&vec![b' '; MAX_ENVELOPE_BYTES + 1]),
            Err("oversized_envelope")
        );
        let mut unsafe_number = serde_json::to_value(&bundle).unwrap();
        unsafe_number["snapshot"]["revision"] = serde_json::json!(4294967296_u64);
        assert!(decode_window(&serde_json::to_vec(&unsafe_number).unwrap()).is_err());
        let overflowing_float = String::from_utf8(serde_json::to_vec(&bundle).unwrap())
            .unwrap()
            .replacen(
                "\"anchor_server_time_ms\":200.0",
                "\"anchor_server_time_ms\":1e999",
                1,
            );
        assert!(decode_window(overflowing_float.as_bytes()).is_err());
    }

    #[test]
    fn backwards_monotonic_time_and_unexplained_epoch_cannot_verify() {
        let mut bundle = window(vec![control(&state(), Action::Pause, 200.0)]);
        if let Operation::Control { server_time_ms, .. } =
            &mut bundle.events[0].envelope.as_mut().unwrap().operation
        {
            *server_time_ms = 10.0;
        }
        assert_eq!(verify(&bundle).issues[0].code, IssueCode::InvalidEventTime);
        let mut checkpoint = bundle.events[0].clone();
        checkpoint.envelope.as_mut().unwrap().operation = Operation::Checkpoint {
            reason: CheckpointReason::ServerRestart,
            command: None,
        };
        assert_eq!(
            verify(&window(vec![checkpoint])).issues[0].code,
            IssueCode::InvalidCheckpoint
        );
    }

    #[test]
    fn digest_uses_typed_field_order_and_exact_float_roundtrip() {
        let mut before = state();
        before.anchor_position_ms = 0.8455124082255701;
        let bytes = serde_json::to_vec(&before).unwrap();
        assert_eq!(
            state_digest(&before).unwrap(),
            hex::encode(Sha256::digest(&bytes))
        );
        let event = control(&before, Action::Pause, before.anchor_server_time_ms);
        let bundle = window(vec![event]);
        let encoded = serde_json::to_vec(&bundle).unwrap();
        let decoded = decode_window(&encoded).unwrap();
        assert_eq!(decoded, bundle);
        assert!(verify(&decoded).all_transitions_verified);
    }

    #[test]
    fn empty_or_truncated_windows_never_claim_verified_transitions() {
        let mut bundle = window(vec![control(&state(), Action::Pause, 200.0)]);
        bundle.truncated = true;
        assert!(!verify(&bundle).all_transitions_verified);
        assert!(!verify(&bundle).reaches_snapshot);
        bundle.truncated = false;
        bundle.events.clear();
        bundle.after_revision = bundle.snapshot.revision;
        let report = verify(&bundle);
        assert!(report.continuous && report.reaches_snapshot);
        assert!(!report.all_transitions_verified);
    }
}
