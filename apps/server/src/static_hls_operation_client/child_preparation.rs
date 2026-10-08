//! The original Server-owned child preparation. The caller retains this task
//! independently of its HTTP waiter and has already committed the one-shot
//! claim. No public route or encoder capability is enabled by this module.
#![allow(dead_code)]
use super::{Action, Client, FrozenInput};
use anyhow::{Result, ensure};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement, input::OperationKind, operation::OperationResult,
};
use std::{future::Future, time::Duration};
use tokio::time::Instant;

impl Client {
    /// An immutable queued storage observation, never a playable output grant.
    /// Existing completed keys use exact retained replay instead of this path.
    pub(crate) async fn prepare_owned_child(
        &self,
        child: &FrozenInput,
        parent: &FrozenInput,
        root: &RootGraphStatement,
        cancelled: impl Future<Output = ()> + Send,
    ) -> Result<crate::static_hls_child_plan::ChildQueuedPlan> {
        ensure!(
            child.kind() == OperationKind::Child,
            "static_hls_child_input_required"
        );
        root.require_parent_input(parent)?;
        child.require_child_of(parent, root.root_digest(), root.selected_audio_statement())?;
        let began = Instant::now();
        let loaded = self.load(child).await?;
        ensure!(
            loaded.publication_pending,
            "static_hls_original_child_preparation_required"
        );
        let result = async {
            ensure!(loaded.current_authority_live, "static_hls_child_authority_revoked");
            let until = super::preparation::preparation_deadline(began, &loaded, Instant::now())?;
            tokio::pin!(cancelled);
            tokio::select! {
                biased;
                _ = &mut cancelled => Err(anyhow::anyhow!("static_hls_child_preparation_interrupted")),
                _ = tokio::time::sleep_until(until) => Err(anyhow::anyhow!("static_hls_child_preparation_expired")),
                result = self.drive_original_child(child, parent, root) => result,
            }
        }.await;
        // This future observes Server shutdown/interruption, not an explicit
        // user cancellation. A projection/query error or interrupted waiter may
        // follow a successful durable publication: preserve the original reply
        // and owners for same-key recovery. User stop/source revocation is
        // handled by its authenticated request and the independent Worker
        // authority/cleanup paths, never inferred from loss of this waiter.

        if let Err(error) = &result {
            tracing::warn!(error = %error, elapsed_ms = began.elapsed().as_millis(), "static_hls_child_preparation_failed");
        }
        result
    }

    async fn drive_original_child(
        &self,
        child: &FrozenInput,
        parent: &FrozenInput,
        root: &RootGraphStatement,
    ) -> Result<crate::static_hls_child_plan::ChildQueuedPlan> {
        let mut reply = match self.call(child, Action::Create).await {
            Ok(reply) => reply,
            Err(_) => self.call(child, Action::Query).await?,
        };
        let began = Instant::now();
        loop {
            let result_kind = match reply.result() {
                OperationResult::Pending { .. } => "pending",
                OperationResult::Verified { .. } => "verified",
                OperationResult::ChildQueued { .. } => "child_queued",
                OperationResult::Published { .. } => "published",
                OperationResult::Refused { .. } => "refused",
                OperationResult::Disposed { .. } => "disposed",
                OperationResult::Unknown { .. } => "unknown",
                OperationResult::CancelRequested { .. } => "cancel_requested",
            };
            tracing::info!(
                result_kind,
                elapsed_ms = began.elapsed().as_millis(),
                "static_hls_child_preparation_progress"
            );
            if let Some(queued) = reply.child_queued_result_statement() {
                ensure!(
                    queued.root_digest == root.root_digest()
                        && *queued.selected_audio == root.selected_audio_statement(),
                    "static_hls_child_root_changed"
                );
                return crate::static_hls_child_plan::from_committed_publication(
                    &self.db,
                    &self.key,
                    child,
                    parent,
                    root,
                    queued.reply_encrypted,
                )
                .await;
            }
            let action = match reply.result() {
                // A lost publication call may have ended before registration.
                // Retry only this exact frozen operation after a fresh positive
                // Verified response; Worker registration retains the one owner
                // and publication token even when calls overlap or replies race.
                OperationResult::Verified { .. } => Action::PublishChild,
                OperationResult::Pending { .. } => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    Action::Query
                }
                OperationResult::Published { .. } => {
                    anyhow::bail!("static_hls_unexpected_parent_response")
                }
                // A child refusal cannot fall back to the generic/native path
                // or mint another key after its parent claim has been consumed.
                OperationResult::Refused { .. } | OperationResult::Disposed { .. } => {
                    anyhow::bail!("static_hls_child_qualification_ended");
                }
                OperationResult::Unknown { .. } | OperationResult::CancelRequested { .. } => {
                    anyhow::bail!("static_hls_child_preparation_unknown");
                }
                OperationResult::ChildQueued { .. } => {
                    unreachable!("handled through typed accessor")
                }
            };
            reply = match self.call(child, action).await {
                Ok(reply) => reply,
                Err(error) if action == Action::PublishChild => {
                    tracing::warn!(error=%error,"static_hls_child_publication_reply_unconfirmed");
                    self.call(child, Action::Query).await?
                }
                Err(error) => return Err(error),
            };
        }
    }
}
