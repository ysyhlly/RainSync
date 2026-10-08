//! Calls the production room-command transactions against an owned PostgreSQL
//! fixture. Synthetic media/identities are not playback or physical-drain proof.
use anyhow::{Result, ensure};
use persistence::{room_commands, room_node_leases};
use protocol::{Action, Command, PlaybackStatus, RoomState, VERSION};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
struct Fixture {
    state: RoomState,
    command: Command,
    user: Uuid,
    login: String,
    other_login: String,
}
impl Fixture {
    async fn commit(&self, db: &PgPool) -> Result<RoomState> {
        room_commands::commit(db, &self.command, self.user, &self.login, 1000.0, None).await
    }
}

async fn account(db: &PgPool) -> Result<Uuid> {
    let user = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,'owned-fixture',false)",
    )
    .bind(user)
    .bind(user.to_string())
    .execute(db)
    .await?;
    Ok(user)
}

async fn fixture(db: &PgPool, delegated: bool) -> Result<Fixture> {
    let owner = account(db).await?;
    let user = if delegated { account(db).await? } else { owner };
    let room = Uuid::new_v4();
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'owned room command',$2)")
        .bind(room)
        .bind(owner)
        .execute(db)
        .await?;
    for member in [owner, user] {
        sqlx::query(
            "INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(room)
        .bind(member)
        .execute(db)
        .await?;
    }
    let login = Uuid::new_v4().to_string();
    let other_login = Uuid::new_v4().to_string();
    for hash in [&login, &other_login] {
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'owned-fixture',clock_timestamp()+interval '1 hour')")
            .bind(hash).bind(user).execute(db).await?;
    }
    if delegated {
        sqlx::query("INSERT INTO room_member_permissions(room_id,user_id,role,permissions,granted_by) VALUES($1,$2,'moderator',ARRAY['set_rate'],$3)")
            .bind(room).bind(user).bind(owner).execute(db).await?;
    }
    let state = RoomState {
        room_id: room,
        revision: 1,
        // An explicit synthetic timeline supports non-selection controls.
        media_id: Some(Uuid::new_v4()),
        media_generation: 1,
        playback_status: PlaybackStatus::Playing,
        anchor_position_ms: 0.0,
        anchor_server_time_ms: 0.0,
        playback_rate: 1.0,
        controller_user_id: owner,
        duration_ms: Some(1000.0),
        live: None,
        clock_epoch: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO room_snapshots(room_id,state) VALUES($1,$2)")
        .bind(room)
        .bind(serde_json::to_value(&state)?)
        .execute(db)
        .await?;
    let epoch = persistence::issue_control_epoch(db, room, user).await?;
    let command = Command {
        protocol_version: VERSION,
        room_id: room,
        command_id: Uuid::new_v4(),
        live_version: None,
        control_epoch: Some(epoch.id),
        expected_revision: 1,
        media_generation: 1,
        action: Action::SetRate { rate: 1.25 },
    };
    Ok(Fixture {
        state,
        command,
        user,
        login,
        other_login,
    })
}

async fn durable(db: &PgPool, room: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_array((SELECT state FROM room_snapshots WHERE room_id=$1),(SELECT coalesce(jsonb_agg(jsonb_build_array(command_id,user_id,state,request_payload) ORDER BY command_id),'[]') FROM command_results WHERE room_id=$1),(SELECT coalesce(jsonb_agg(jsonb_build_array(revision,state,diagnostic) ORDER BY revision),'[]') FROM room_events WHERE room_id=$1),(SELECT coalesce(jsonb_agg(jsonb_build_array(id,media_id,sort_order) ORDER BY sort_order,id),'[]') FROM playlist_items WHERE room_id=$1))")
        .bind(room).fetch_one(db).await?)
}

async fn assert_transition(db: &PgPool, f: &Fixture, state: &RoomState) -> Result<()> {
    ensure!(persistence::snapshot(db, state.room_id).await? == *state);
    let row = sqlx::query("SELECT r.state AS result,e.state AS event,r.request_payload,e.diagnostic FROM command_results r JOIN room_events e ON e.room_id=r.room_id AND e.revision=$3 WHERE r.room_id=$1 AND r.command_id=$2")
        .bind(state.room_id).bind(f.command.command_id).bind(i64::from(state.revision))
        .fetch_one(db).await?;
    let expected = serde_json::to_value(state)?;
    ensure!(row.get::<Value, _>("result") == expected);
    ensure!(row.get::<Value, _>("event") == expected);
    ensure!(row.get::<Value, _>("request_payload") == serde_json::to_value(&f.command)?);
    let diagnostic: Value = row.get("diagnostic");
    ensure!(diagnostic["actor_id"] == serde_json::to_value(f.user)?);
    ensure!(
        diagnostic["operation"]["command"]["command_id"]
            == serde_json::to_value(f.command.command_id)?
    );
    Ok(())
}

async fn wait_blocked(db: &PgPool, fragment: &str) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let found: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0)")
                .bind(fragment).fetch_one(db).await?;
            if found { return Ok::<(), anyhow::Error>(()); }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await??;
    Ok(())
}

async fn atomic_commit_and_compatibility_replay(db: &PgPool) -> Result<()> {
    let f = fixture(db, false).await?;
    ensure!(
        room_commands::previous(db, f.state.room_id, &f.command, f.user)
            .await?
            .is_none()
    );
    let state = f.commit(db).await?;
    ensure!(state.revision == 2 && state.playback_rate == 1.25);
    assert_transition(db, &f, &state).await?;
    let before = durable(db, f.state.room_id).await?;
    ensure!(
        room_commands::previous(db, f.state.room_id, &f.command, f.user).await?
            == Some(state.clone())
    );
    ensure!(persistence::previous(db, f.state.room_id, &f.command, f.user).await? == Some(state));
    ensure!(durable(db, f.state.room_id).await? == before);
    // A root compatibility write still executes the same production unit.
    let legacy = fixture(db, false).await?;
    let state = persistence::commit(
        db,
        &legacy.command,
        legacy.user,
        &legacy.login,
        1000.0,
        None,
    )
    .await?;
    assert_transition(db, &legacy, &state).await?;
    Ok(())
}

async fn normalized_payload_and_replay_denials(db: &PgPool) -> Result<()> {
    let f = fixture(db, false).await?;
    let state = f.commit(db).await?;
    // Omitted and explicit optional fields decode to the same normalized DTO.
    let mut wire = serde_json::to_value(&f.command)?;
    wire["live_version"] = Value::Null;
    let normalized: Command = serde_json::from_value(wire)?;
    ensure!(
        room_commands::previous(db, f.state.room_id, &normalized, f.user).await? == Some(state)
    );
    let before = durable(db, f.state.room_id).await?;
    let mut changed = f.command.clone();
    changed.action = Action::SetRate { rate: 1.5 };
    ensure!(
        room_commands::previous(db, f.state.room_id, &changed, f.user)
            .await
            .unwrap_err()
            .to_string()
            == "command_payload_conflict"
    );
    let other = account(db).await?;
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
        .bind(f.state.room_id)
        .bind(other)
        .execute(db)
        .await?;
    let epoch = persistence::issue_control_epoch(db, f.state.room_id, other).await?;
    let mut other_command = f.command.clone();
    other_command.control_epoch = Some(epoch.id);
    ensure!(
        room_commands::previous(db, f.state.room_id, &other_command, other)
            .await
            .unwrap_err()
            .to_string()
            == "command_owned_by_another_user"
    );
    sqlx::query(
        "UPDATE command_results SET request_payload=NULL WHERE room_id=$1 AND command_id=$2",
    )
    .bind(f.state.room_id)
    .bind(f.command.command_id)
    .execute(db)
    .await?;
    ensure!(
        room_commands::previous(db, f.state.room_id, &f.command, f.user)
            .await
            .unwrap_err()
            .to_string()
            == "command_replay_unverifiable"
    );
    sqlx::query("UPDATE command_results SET request_payload=$3 WHERE room_id=$1 AND command_id=$2")
        .bind(f.state.room_id)
        .bind(f.command.command_id)
        .bind(serde_json::to_value(&f.command)?)
        .execute(db)
        .await?;
    ensure!(durable(db, f.state.room_id).await? == before);
    Ok(())
}

async fn latest_snapshot_lock_wait(db: &PgPool) -> Result<()> {
    let f = fixture(db, false).await?;
    let mut blocker = db.begin().await?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(f.state.room_id)
        .fetch_one(&mut *blocker)
        .await?;
    let mut latest = f.state.clone();
    latest.revision += 1;
    latest.playback_rate = 1.75;
    sqlx::query("UPDATE room_snapshots SET state=$2 WHERE room_id=$1")
        .bind(latest.room_id)
        .bind(serde_json::to_value(&latest)?)
        .execute(&mut *blocker)
        .await?;
    let task_db = db.clone();
    let queued = f.clone();
    let task = tokio::spawn(async move { queued.commit(&task_db).await });
    wait_blocked(db, "SELECT state FROM room_snapshots").await?;
    blocker.commit().await?;
    let before = durable(db, f.state.room_id).await?;
    let result = tokio::time::timeout(Duration::from_secs(5), task).await??;
    ensure!(result.unwrap_err().to_string() == "revision_conflict");
    ensure!(persistence::snapshot(db, f.state.room_id).await? == latest);
    ensure!(durable(db, f.state.room_id).await? == before);
    Ok(())
}

async fn end_media_latest_queue(db: &PgPool) -> Result<()> {
    let mut f = fixture(db, false).await?;
    let source = Uuid::new_v4();
    let current = f.state.media_id.unwrap();
    let originally_next = Uuid::new_v4();
    let newly_next = Uuid::new_v4();
    sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted) VALUES($1,'owned room command','local','never-read-fixture')")
        .bind(source).execute(db).await?;
    for (index, media) in [current, originally_next, newly_next]
        .into_iter()
        .enumerate()
    {
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,duration_ms) VALUES($1,$2,'owned room command',$3,1000)")
            .bind(media).bind(source).bind(media.to_string()).execute(db).await?;
        sqlx::query(
            "INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES($1,$2,$3,$4)",
        )
        .bind(Uuid::new_v4())
        .bind(f.state.room_id)
        .bind(media)
        .bind(index as i64)
        .execute(db)
        .await?;
    }
    f.command.action = Action::EndMedia {
        position_ms: 1000.0,
    };
    let mut blocker = db.begin().await?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(f.state.room_id)
        .fetch_one(&mut *blocker)
        .await?;
    let task_db = db.clone();
    let queued = f.clone();
    let task = tokio::spawn(async move { queued.commit(&task_db).await });
    wait_blocked(db, "SELECT state FROM room_snapshots").await?;
    sqlx::query("UPDATE playlist_items SET sort_order=CASE WHEN media_id=$2 THEN 2 ELSE 1 END WHERE room_id=$1 AND media_id<>$3")
        .bind(f.state.room_id).bind(originally_next).bind(current).execute(&mut *blocker).await?;
    blocker.commit().await?;
    let state = tokio::time::timeout(Duration::from_secs(5), task).await???;
    ensure!(state.media_id == Some(newly_next));
    ensure!(state.media_generation == f.state.media_generation + 1);
    ensure!(state.anchor_position_ms == 0.0 && state.duration_ms == Some(1000.0));
    assert_transition(db, &f, &state).await?;
    Ok(())
}

async fn failure_rollback(db: &PgPool, deferred: bool) -> Result<()> {
    let f = fixture(db, false).await?;
    let before = durable(db, f.state.room_id).await?;
    sqlx::query("CREATE FUNCTION room_commands_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned_room_command_failure'; END $$")
        .execute(db).await?;
    let trigger = if deferred {
        "CREATE CONSTRAINT TRIGGER room_commands_fixture_failure AFTER INSERT ON command_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION room_commands_fixture_fail()"
    } else {
        "CREATE TRIGGER room_commands_fixture_failure BEFORE INSERT ON command_results FOR EACH ROW EXECUTE FUNCTION room_commands_fixture_fail()"
    };
    sqlx::query(trigger).execute(db).await?;
    let result = f.commit(db).await;
    sqlx::query("DROP FUNCTION room_commands_fixture_fail() CASCADE")
        .execute(db)
        .await?;
    ensure!(
        result
            .unwrap_err()
            .to_string()
            .contains("owned_room_command_failure")
    );
    ensure!(
        durable(db, f.state.room_id).await? == before,
        "failed write/COMMIT leaked a snapshot, result or event"
    );
    Ok(())
}

async fn final_expiry_after_cleanup_wait(db: &PgPool, delegated: bool) -> Result<()> {
    let f = fixture(db, delegated).await?;
    let before = durable(db, f.state.room_id).await?;
    if delegated {
        sqlx::query("UPDATE room_member_permissions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE room_id=$1 AND user_id=$2")
            .bind(f.state.room_id).bind(f.user).execute(db).await?;
    } else {
        sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1")
            .bind(&f.login).execute(db).await?;
    }
    let mut blocker = db.begin().await?;
    sqlx::query("LOCK TABLE playback_sessions IN SHARE MODE")
        .execute(&mut *blocker)
        .await?;
    let task_db = db.clone();
    let queued = f.clone();
    let task = tokio::spawn(async move { queued.commit(&task_db).await });
    wait_blocked(db, "UPDATE playback_sessions SET stopped=true").await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let expired: bool = if delegated {
                sqlx::query_scalar("SELECT expires_at<=clock_timestamp() FROM room_member_permissions WHERE room_id=$1 AND user_id=$2")
                    .bind(f.state.room_id).bind(f.user).fetch_one(db).await?
            } else {
                sqlx::query_scalar("SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=$1")
                    .bind(&f.login).fetch_one(db).await?
            };
            if expired { return Ok::<(), anyhow::Error>(()); }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await??;
    // Row locks cannot prevent natural expiry. A second valid login must not
    // substitute for the exact originating session on the queued command.
    let other_valid: bool =
        sqlx::query_scalar("SELECT expires_at>clock_timestamp() FROM sessions WHERE token_hash=$1")
            .bind(&f.other_login)
            .fetch_one(db)
            .await?;
    ensure!(other_valid);
    blocker.commit().await?;
    let result = tokio::time::timeout(Duration::from_secs(5), task).await??;
    ensure!(
        result.unwrap_err().to_string()
            == if delegated {
                "controller_required"
            } else {
                "session_expired"
            }
    );
    ensure!(durable(db, f.state.room_id).await? == before);
    Ok(())
}

async fn lease(db: &PgPool, room: Uuid) -> Result<room_node_leases::Lease> {
    let node = Uuid::new_v4();
    room_node_leases::heartbeat(db, node, "http://127.0.0.1:1").await?;
    Ok(room_node_leases::claim(db, room, node).await?.unwrap())
}

async fn fenced_commit_and_replay(db: &PgPool) -> Result<()> {
    let f = fixture(db, false).await?;
    let lease = lease(db, f.state.room_id).await?;
    let state =
        room_commands::commit_fenced(db, &f.command, f.user, &f.login, 1000.0, None, &lease)
            .await?;
    assert_transition(db, &f, &state).await?;
    let checkpoint: (i64, i64, Uuid) = sqlx::query_as("SELECT checkpoint_revision,checkpoint_generation,checkpoint_clock_epoch FROM room_leases WHERE room_id=$1")
        .bind(f.state.room_id).fetch_one(db).await?;
    ensure!(
        checkpoint
            == (
                i64::from(state.revision),
                i64::from(state.media_generation),
                state.clock_epoch
            )
    );
    let before = durable(db, f.state.room_id).await?;
    ensure!(
        room_commands::previous_fenced(db, f.state.room_id, &f.command, f.user, &f.login, &lease)
            .await?
            == Some(state.clone())
    );
    ensure!(
        persistence::previous_fenced(db, f.state.room_id, &f.command, f.user, &f.login, &lease)
            .await?
            == Some(state)
    );
    sqlx::query(
        "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    )
    .bind(&f.login)
    .execute(db)
    .await?;
    ensure!(
        room_commands::previous_fenced(db, f.state.room_id, &f.command, f.user, &f.login, &lease)
            .await
            .unwrap_err()
            .to_string()
            == "session_expired"
    );
    ensure!(durable(db, f.state.room_id).await? == before);
    // Exercise the old fenced write entrypoint as well as the new namespace.
    let legacy = fixture(db, false).await?;
    let legacy_lease = self::lease(db, legacy.state.room_id).await?;
    let state = persistence::commit_fenced(
        db,
        &legacy.command,
        legacy.user,
        &legacy.login,
        1000.0,
        None,
        &legacy_lease,
    )
    .await?;
    assert_transition(db, &legacy, &state).await?;
    Ok(())
}

async fn final_node_fence_after_checkpoint(db: &PgPool) -> Result<()> {
    let f = fixture(db, false).await?;
    let lease = lease(db, f.state.room_id).await?;
    let before = durable(db, f.state.room_id).await?;
    // A fixture-only checkpoint trigger expires the lease inside that write.
    // Only a guard after checkpoint can detect this before the atomic commit.
    sqlx::query("CREATE FUNCTION room_commands_fixture_expire_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.lease_until=clock_timestamp()-interval '1 second'; RETURN NEW; END $$")
        .execute(db).await?;
    sqlx::query("CREATE TRIGGER room_commands_fixture_checkpoint BEFORE UPDATE OF checkpoint_revision ON room_leases FOR EACH ROW EXECUTE FUNCTION room_commands_fixture_expire_lease()")
        .execute(db).await?;
    let result =
        room_commands::commit_fenced(db, &f.command, f.user, &f.login, 1000.0, None, &lease).await;
    sqlx::query("DROP FUNCTION room_commands_fixture_expire_lease() CASCADE")
        .execute(db)
        .await?;
    ensure!(result.unwrap_err().to_string() == "room_owner_lost");
    ensure!(durable(db, f.state.room_id).await? == before);
    let checkpoint: Option<i64> =
        sqlx::query_scalar("SELECT checkpoint_revision FROM room_leases WHERE room_id=$1")
            .bind(f.state.room_id)
            .fetch_one(db)
            .await?;
    ensure!(checkpoint.is_none(), "failed final fence leaked checkpoint");
    Ok(())
}

async fn activated_cluster_rejects_unfenced(db: &PgPool) -> Result<()> {
    let f = fixture(db, false).await?;
    let before = durable(db, f.state.room_id).await?;
    sqlx::query(
        "INSERT INTO control_cluster_activation(configuration_hash) VALUES(repeat('a',64))",
    )
    .execute(db)
    .await?;
    let write = f.commit(db).await;
    let replay = room_commands::previous(db, f.state.room_id, &f.command, f.user).await;
    sqlx::query("DELETE FROM control_cluster_activation")
        .execute(db)
        .await?;
    ensure!(write.unwrap_err().to_string() == "room_owner_lost");
    ensure!(replay.unwrap_err().to_string() == "room_owner_lost");
    ensure!(durable(db, f.state.room_id).await? == before);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("RAINSYNC_FIXTURE_DATABASE")?).await?;
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&db)
        .await?;
    ensure!(database.starts_with("rainsync_"));
    atomic_commit_and_compatibility_replay(&db).await?;
    println!("PASS: atomic_commit_and_compatibility_replay");
    normalized_payload_and_replay_denials(&db).await?;
    println!("PASS: normalized_payload_and_replay_denials");
    latest_snapshot_lock_wait(&db).await?;
    println!("PASS: latest_snapshot_lock_wait");
    end_media_latest_queue(&db).await?;
    println!("PASS: end_media_latest_queue");
    failure_rollback(&db, false).await?;
    println!("PASS: precommit_write_failure_rollback");
    failure_rollback(&db, true).await?;
    println!("PASS: deferred_commit_failure_rollback");
    final_expiry_after_cleanup_wait(&db, false).await?;
    println!("PASS: exact_login_expiry_after_cleanup_wait");
    final_expiry_after_cleanup_wait(&db, true).await?;
    println!("PASS: delegated_permission_expiry_after_cleanup_wait");
    fenced_commit_and_replay(&db).await?;
    println!("PASS: fenced_commit_and_replay");
    final_node_fence_after_checkpoint(&db).await?;
    println!("PASS: final_node_fence_after_checkpoint");
    activated_cluster_rejects_unfenced(&db).await?;
    println!("PASS: activated_cluster_rejects_unfenced");
    ensure!(db.size() <= 12);
    db.close().await;
    Ok(())
}
