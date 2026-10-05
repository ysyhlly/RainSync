//! Bounded private parent lookup for a new child intent. A lookup is not a
//! claim or an owner proof. Existing child keys must be replayed before using
//! this live-parent path; the eventual claim repeats authority under locks.
use anyhow::{Result, ensure};
use media_core::static_hls::contracts::{graph::RootGraphStatement, input::FrozenInput};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(crate) struct RetainedParent {
    pub input: FrozenInput,
    pub root: RootGraphStatement,
}

pub(crate) struct ParentLookup<'a> {
    pub parent_session: Uuid,
    pub user: Uuid,
    pub login_hash: &'a str,
    pub room: Uuid,
    pub viewer: Uuid,
}

#[allow(dead_code)]
pub(crate) async fn load_for_new_child(
    pool: &PgPool,
    lookup: ParentLookup<'_>,
    open_input: impl FnOnce(&str) -> Result<Vec<u8>>,
    open_root: impl FnOnce(&str) -> Result<Vec<u8>>,
) -> Result<Option<RetainedParent>> {
    let ParentLookup {
        parent_session,
        user,
        login_hash,
        room,
        viewer,
    } = lookup;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true)")
        .execute(&mut *tx).await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    // Do not take a source action or expose ciphertext until the exact caller
    // and nonrecursive, still-live published parent have been established.
    let row = sqlx::query(
        "SELECT c.id,c.root_digest,c.inventory_encrypted \
         FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id \
         JOIN static_hls_captures c ON c.id=p.static_hls_capture_id AND c.session_id=p.id \
         WHERE r.session_id=$1 AND r.user_id=$2 AND r.auth_login_hash=$3 \
         AND r.room_id=$4 AND r.viewer_id=$5 AND r.static_hls_parent_capture_id IS NULL \
         AND r.static_hls_operation_id=c.id AND c.publication_phase='published_parent' \
         AND static_hls_pending_reader_supported() \
         AND static_hls_published_parent_authority_allowed(c.id)",
    )
    .bind(parent_session)
    .bind(user)
    .bind(login_hash)
    .bind(room)
    .bind(viewer)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    let Some(row) = row else { return Ok(None) };
    let capture: Uuid = row.try_get("id")?;
    let digest: String = row.try_get("root_digest")?;
    let inventory: String = row.try_get("inventory_encrypted")?;
    ensure!(
        !inventory.is_empty() && inventory.len() <= 262_144,
        "static_hls_parent_inventory_bounds"
    );
    let Some(loaded) =
        persistence::static_hls_pending::load_operation(pool, capture, parent_session, open_input)
            .await?
    else {
        return Ok(None);
    };
    if !loaded.publication_authority_live || loaded.publication_pending {
        return Ok(None);
    }
    let identity = loaded.input.identity_statement();
    ensure!(
        identity.user_id == user.to_string()
            && identity.auth_login_hash == login_hash
            && identity.room_id == room.to_string()
            && identity.viewer_id == viewer.to_string(),
        "static_hls_parent_identity_changed"
    );
    let bytes = open_root(&inventory)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= 262_144,
        "static_hls_parent_inventory_bounds"
    );
    let root = RootGraphStatement::parse_private_plaintext(&bytes)?;
    root.require_parent_input(&loaded.input)?;
    ensure!(
        root.root_digest() == digest,
        "static_hls_parent_root_changed"
    );
    // Decryption work happens without locks. The child claim must still fence
    // current authority and this exact immutable parent before any mutation.
    Ok(Some(RetainedParent {
        input: loaded.input,
        root,
    }))
}
