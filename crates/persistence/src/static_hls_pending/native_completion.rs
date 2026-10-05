//! Complete an ordinary direct grant from the exact frozen parent request.
//! Observing disposal never reconstructs a permit or releases any resource.
use super::*;

pub async fn guard_unmarked_parent(
    tx: &mut Transaction<'_, Postgres>,
    input: &FrozenInput,
) -> Result<()> {
    ensure!(
        input.kind() == OperationKind::Parent,
        "static_hls_parent_input_required"
    );
    fence(tx).await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut **tx)
        .await?;
    let i = input.identity_statement();
    ensure!(
        lock_authority(tx, &i, None, false).await? && exact_request(tx, input).await?,
        "static_hls_native_authority_ended"
    );
    let session = uuid(&i.session_id)?;
    // The locked original request serializes any late admission. An admitted
    // capture must have all positive original-owner receipts and no reservation.
    sqlx::query("SELECT id FROM static_hls_captures WHERE session_id=$1 ORDER BY id FOR UPDATE")
        .bind(session)
        .fetch_all(&mut **tx)
        .await?;
    let valid: bool = sqlx::query_scalar("SELECT static_hls_pending_request_authority_allowed($1) AND NOT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.session_id=$1 AND (c.id<>$2 OR c.publication_phase<>'pending_parent' OR c.state<>'disposed' OR c.streams_closed_at IS NULL OR c.process_closed_at IS NULL OR c.process_disposition IS NULL OR c.process_disposition NOT IN ('never_started','reaped') OR c.files_removed_at IS NULL OR c.disposed_at IS NULL)) AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id IN ($1,$2)) AND NOT EXISTS(SELECT 1 FROM media_jobs WHERE session_id=$1)")
        .bind(session).bind(uuid(&i.operation_id)?).fetch_one(&mut **tx).await?;
    ensure!(valid, "static_hls_native_disposal_or_authority_unknown");
    Ok(())
}
