//! Bounded ordered static-HLS retained-history cleanup. This module never
//! reconstructs physical owners or releases any resource reservation. The SQL
//! boundary requires original positive disposition receipts and exact tuples.
use anyhow::Result;
use sqlx::{Connection, PgPool, Row};
use uuid::Uuid;

pub const BATCH_LIMIT: i64 = 32;
pub const CANDIDATES: &str = "SELECT session_id,(static_hls_parent_capture_id IS NULL) AS parent FROM playback_requests WHERE static_hls_input_version=1 AND status IN('completed','failed') AND expires_at<clock_timestamp() AND static_hls_root_expires_at<clock_timestamp()-interval '48 hours' AND preparation_drained_at<clock_timestamp()-interval '48 hours' AND ($1::boolean IS NULL OR (static_hls_parent_capture_id IS NULL,session_id)>($1::boolean,$2::uuid)) ORDER BY (static_hls_parent_capture_id IS NULL),session_id LIMIT $3";

/// One receipt-ordered transaction for one session. Failure rolls everything
/// back; an unknown COMMIT reply is retried against the same immutable identity
/// in a later maintenance pass. It can never authorize physical cleanup.
pub async fn prune(pool: &PgPool, session: Uuid) -> Result<bool> {
    let mut connection = pool.acquire().await?;
    connection.close_on_drop();
    let mut tx = connection.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        .execute(&mut *tx)
        .await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='1500ms'")
        .execute(&mut *tx)
        .await?;
    let changed = sqlx::query_scalar("SELECT static_hls_prune_history($1)")
        .bind(session)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(changed)
}

/// Prefer children so a retained claim cannot leave its disposed parent
/// permanently blocked. Never loop to exhaustion or ignore uncertain receipts.
pub async fn prune_batch(pool: &PgPool) -> Result<usize> {
    // Carry the keyset cursor between maintenance passes so an old unresolved
    // receipt cannot monopolize the first 32 candidates and starve later rows.
    static CURSOR: tokio::sync::Mutex<Option<(bool, Uuid)>> = tokio::sync::Mutex::const_new(None);
    let mut cursor = CURSOR.lock().await;
    let mut rows = sqlx::query(CANDIDATES)
        .bind(cursor.map(|value| value.0))
        .bind(cursor.map(|value| value.1))
        .bind(BATCH_LIMIT)
        .fetch_all(pool)
        .await?;
    if rows.is_empty() && cursor.is_some() {
        *cursor = None;
        rows = sqlx::query(CANDIDATES)
            .bind(None::<bool>)
            .bind(None::<Uuid>)
            .bind(BATCH_LIMIT)
            .fetch_all(pool)
            .await?;
    }
    let mut count = 0;
    for row in rows {
        let session: Uuid = row.get("session_id");
        *cursor = Some((row.get("parent"), session));
        // A bad/contended history must not stop independent eligible histories.
        if prune(pool, session).await.unwrap_or(false) {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    const MIGRATION: &str = include_str!("../../../migrations/0061_static_hls_history_pruning.sql");
    #[test]
    fn batch_is_bounded_child_first_and_retention_filtered() {
        assert_eq!(BATCH_LIMIT, 32);
        for text in [
            "static_hls_input_version=1",
            "status IN('completed','failed')",
            "expires_at<clock_timestamp()",
            "interval '48 hours'",
            "ORDER BY (static_hls_parent_capture_id IS NULL)",
            "LIMIT $3",
        ] {
            assert!(CANDIDATES.contains(text));
        }
    }
    #[test]
    fn original_identity_and_positive_disposition_are_required() {
        for text in [
            "prep.owner_epoch IS DISTINCT FROM r.owner_epoch",
            "c.request_owner_epoch IS DISTINCT FROM r.owner_epoch",
            "c.input_sha256 IS DISTINCT FROM r.static_hls_input_sha256",
            "c.worker_instance IS DISTINCT FROM r.static_hls_worker_instance",
            "c.database_id IS DISTINCT FROM r.static_hls_database_id",
            "c.state<>'disposed'",
            "c.streams_closed_at IS NULL",
            "c.process_closed_at IS NULL",
            "c.files_removed_at IS NULL",
            "c.disposed_at IS NULL",
            "c.process_disposition NOT IN('never_started','reaped')",
            "reaped_at IS NULL",
            "d.execution_id=e.id",
            "d.owner_id=e.owner_id",
        ] {
            assert!(MIGRATION.contains(text), "missing {text}");
        }
    }
    #[test]
    fn every_live_or_unresolved_dependency_is_preserved() {
        for table in [
            "cache_write_reservations",
            "cache_entries",
            "cache_read_leases",
            "media_outputs",
            "media_output_files",
            "upstream_reservations",
            "playback_observations",
            "playback_http_representations",
            "agent_transfer_runs",
            "room_cleanup_tasks",
        ] {
            assert!(
                MIGRATION.contains(&format!("OR EXISTS(SELECT 1 FROM {table}")),
                "missing {table}"
            );
        }
        assert!(MIGRATION.contains("child.static_hls_parent_capture_id=r.static_hls_operation_id"));
        assert!(MIGRATION.contains("c.publication_phase='stage_a'"));
    }
    #[test]
    fn pruning_ticket_is_transaction_table_and_exact_owner_bound() {
        for text in [
            "issued.transaction_id=txid_current()",
            "history_stage',true)=$1",
            "issued.identities->$1 @> jsonb_build_array(static_hls_history_identity($1,$2))",
            "TG_OP=''DELETE''",
            "count_rows<>expected",
            "NEW.identities IS DISTINCT FROM expected->'rows'",
            "DEFERRABLE INITIALLY DEFERRED",
            "static_hls_history_ticket_not_consumed",
        ] {
            assert!(MIGRATION.contains(text), "missing {text}");
        }
        assert!(!MIGRATION.contains("set_config('rainsync.static_hls_history_ticket'"));
        assert!(!MIGRATION.contains("DISABLE TRIGGER"));
        assert!(!MIGRATION.contains("DELETE CASCADE"));
    }
    #[test]
    fn certificate_and_guard_lookups_are_bound_to_the_migration_schema() {
        let hardening = MIGRATION
            .split("-- Bind every new certificate/authorization entry point")
            .nth(1)
            .expect("trusted schema hardening block");
        for text in [
            "namespace.nspname INTO STRICT trusted_schema",
            "relation.oid='static_hls_history_prune_tickets'::regclass",
            "trusted_schema LIKE 'pg_temp_%'",
            "to_regclass(format('%I.%I',trusted_schema,relation_name))",
            "to_regprocedure(format('%I.%s',trusted_schema,signature))",
            "definition=replace(definition,'static_hls_history_prune_tickets'",
            "format('%I.static_hls_history_prune_tickets',trusted_schema)",
            "SET search_path TO pg_catalog, %I, pg_temp",
            "static_hls_history_trusted_relation_required",
            "static_hls_history_trusted_function_required",
        ] {
            assert!(hardening.contains(text), "missing {text}");
        }
        for signature in [
            "static_hls_history_identity(text,jsonb)",
            "static_hls_history_prune_row_allowed(text,jsonb)",
            "static_hls_history_prepare_ticket(uuid)",
            "protect_static_hls_history_ticket()",
            "check_static_hls_history_ticket_consumed()",
            "static_hls_prune_history(uuid)",
            "protect_static_hls_capture()",
            "protect_static_hls_request()",
            "protect_static_hls_session()",
            "protect_static_hls_job()",
            "protect_static_hls_job_artifact()",
            "protect_static_hls_child_claim()",
            "protect_static_hls_child_capture_phase()",
            "protect_static_hls_child_session()",
            "protect_static_hls_child_job()",
            "protect_static_hls_child_job_execution()",
            "protect_static_hls_child_artifact()",
            "protect_static_hls_pending_preparation()",
            "protect_static_hls_child_output_publication()",
            "protect_static_hls_child_output_disposal()",
        ] {
            assert!(hardening.contains(signature), "unpinned {signature}");
        }
        assert!(
            MIGRATION
                .find("-- Bind every new certificate/authorization entry point")
                .unwrap()
                > MIGRATION
                    .find("CREATE FUNCTION static_hls_prune_history")
                    .unwrap()
        );
        assert!(!hardening.contains("SECURITY DEFINER"));
        assert!(!hardening.contains("SET search_path TO public"));
    }
    #[test]
    fn foreign_key_deletion_order_is_closed_and_atomic() {
        let order = "ARRAY['static_hls_child_output_publications','static_hls_child_output_disposals',\n        'media_executions','media_jobs','playback_sessions','static_hls_captures','playback_preparations','playback_requests']";
        assert!(MIGRATION.contains(order));
        assert!(
            MIGRATION.find("cutoff=clock_timestamp()").unwrap()
                > MIGRATION
                    .find("FOR UPDATE;\n    -- Fresh DB clock")
                    .unwrap()
        );
    }
    #[test]
    fn never_admitted_is_only_positive_original_closed_preparation() {
        assert!(MIGRATION.contains("IF c.id IS NULL THEN"));
        assert!(
            MIGRATION.contains("IF j.id IS NOT NULL OR (r.status='completed' AND p.id IS NULL)")
        );
        assert!(MIGRATION.contains("r.static_hls_parent_capture_id IS NOT NULL AND"));
        assert!(MIGRATION.contains("j.attempt=1 AND NOT EXISTS(SELECT 1 FROM media_executions e"));
        assert!(
            MIGRATION.contains("JOIN static_hls_child_output_disposals d ON d.execution_id=e.id")
        );
    }
}
