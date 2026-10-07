use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transfer {
    owner_id: Uuid,
    expected_revision: u32,
}

pub async fn members(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let user = auth_viewer(&app, &h, false).await?;
    if !user.admin {
        member(&app, &user, id).await?;
    }
    let rows = sqlx::query("SELECT u.id,u.username,COALESCE(g.display_name,p.display_name,u.username) AS display_name,u.principal_kind FROM room_members m JOIN users u ON u.id=m.user_id LEFT JOIN guest_principals g ON g.user_id=u.id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE m.room_id=$1 AND account_active(u.id) ORDER BY u.username,u.id")
        .bind(id).fetch_all(&app.db).await?;
    Ok(media_titles::private_json(Value::Array(
        rows.iter()
            .map(|row| {
                json!({
                    "id": row.get::<Uuid,_>("id"),
                    "username": row.get::<String,_>("username"),
                    "display_name": row.get::<String,_>("display_name"),
                    "guest": row.get::<String,_>("principal_kind")=="guest",
                })
            })
            .collect(),
    )))
}

pub async fn transfer(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Transfer>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
    // All room management uses room -> snapshot -> membership lock order.
    // Ownership never changes the room primary key. NO KEY UPDATE serializes
    // management while allowing media/epoch inserts to check their room FK.
    let owner: Uuid =
        sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let lifecycle_row = sqlx::query("SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let lifecycle_epoch: i64 = lifecycle_row.get("lifecycle_epoch");
    let lifecycle_state: String = lifecycle_row.get("lifecycle");
    let value: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let membership: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    // Lock the selected membership so a concurrent removal cannot commit
    // between target validation and the ownership update.
    let target: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 AND account_active(user_id) FOR KEY SHARE",
    )
    .bind(id)
    .bind(body.owner_id)
    .fetch_optional(&mut *tx)
    .await?;
    // Preserve room -> snapshot -> all memberships -> user -> exact login.
    // Validate the target only after checking the actor's current authority.
    let authority = room_lifecycle::management_authority::Authority::admit(
        &mut tx,
        &h,
        user.id,
        owner,
        membership.is_some(),
    )
    .await?;
    // The room lock fences close against transfer. Keep the owner stable while
    // cleanup is draining; settled closed/archived rooms remain transferable.
    if lifecycle_state == "closing" {
        return Err(err(StatusCode::CONFLICT, "room_not_active"));
    }
    if target.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    if owner == body.owner_id {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let state: protocol::RoomState = serde_json::from_value(value).map_err(anyhow::Error::from)?;
    let next = room_core::transfer_controller(&state, body.expected_revision, body.owner_id)
        .map_err(|reason| err(StatusCode::CONFLICT, reason))?;
    let value = serde_json::to_value(&next).map_err(anyhow::Error::from)?;
    sqlx::query("UPDATE rooms SET owner_id=$2 WHERE id=$1")
        .bind(id)
        .bind(body.owner_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE room_snapshots SET state=$2 WHERE room_id=$1")
        .bind(id)
        .bind(&value)
        .execute(&mut *tx)
        .await?;
    let event_id = Uuid::new_v4();
    let lifecycle = persistence::room_diagnostics::lifecycle(&lifecycle_state, lifecycle_epoch)?;
    let diagnostic = persistence::room_diagnostics::envelope(
        event_id,
        state,
        Some((user.id, authority.actor_is_admin())),
        lifecycle,
        lifecycle,
        room_core::diagnostics::Operation::Ownership {
            expected_revision: body.expected_revision,
            controller_user_id: body.owner_id,
        },
    );
    persistence::room_diagnostics::append(&mut tx, &next, diagnostic).await?;
    sqlx::query("INSERT INTO room_ownership_events(id,room_id,actor_id,previous_owner_id,owner_id,revision) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(event_id).bind(id).bind(user.id).bind(owner).bind(body.owner_id).bind(i64::from(next.revision)).execute(&mut *tx).await?;
    // All devices must use a fresh command identity and credential after transfer.
    // Existing media grants and source ownership are deliberately unchanged.
    sqlx::query("DELETE FROM control_epochs WHERE room_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // The new owner decides future delegation. A former owner's outstanding
    // moderator invitations cannot restore authority after the transfer.
    sqlx::query("UPDATE room_member_permissions SET revoked=true,updated_at=clock_timestamp() WHERE room_id=$1")
        .bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE invites SET revoked=true WHERE room_id=$1 AND granted_role='moderator'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    authority.commit(tx).await?;
    rooms::ownership_changed(&app, &next, body.owner_id, event_id).await;
    Ok(media_titles::private_json(
        json!({"owner_id":body.owner_id,"state":next,"event_id":event_id}),
    ))
}
