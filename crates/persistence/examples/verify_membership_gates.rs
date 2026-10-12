//! Owned PostgreSQL transaction races; no playback resources or drain evidence.
use anyhow::{Result, ensure};
use protocol::{Action, Command, PlaybackStatus, RoomState, VERSION};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum Gate {
    Commit,
    Replay,
    Epoch,
}
impl Gate {
    fn table(self) -> &'static str {
        match self {
            Self::Commit => "room_events",
            Self::Replay => "command_results",
            Self::Epoch => "control_epochs",
        }
    }
    async fn run(self, db: PgPool, state: RoomState, command: Command, user: Uuid) -> Result<()> {
        match self {
            Self::Commit => {
                let now = state.anchor_server_time_ms;
                persistence::room_commands::commit(
                    &db,
                    &command,
                    user,
                    &user.to_string(),
                    now,
                    None,
                )
                .await?;
            }
            Self::Replay => {
                ensure!(
                    persistence::room_commands::previous(&db, state.room_id, &command, user)
                        .await?
                        == Some(state)
                );
            }
            Self::Epoch => {
                persistence::issue_control_epoch(&db, state.room_id, user).await?;
            }
        }
        Ok(())
    }
}
async fn wait_blocked(db: &PgPool, fragment: &str) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0)").bind(fragment).fetch_one(db).await?;
            if found { return Ok::<(),anyhow::Error>(()); }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await??;
    Ok(())
}
async fn fixture(db: &PgPool) -> Result<(RoomState, Command, Uuid)> {
    let user = Uuid::new_v4();
    let room = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,'owned-fixture',false)",
    )
    .bind(user)
    .bind(user.to_string())
    .execute(db)
    .await?;
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'owned transaction race',$2)")
        .bind(room)
        .bind(user)
        .execute(db)
        .await?;
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
        .bind(room)
        .bind(user)
        .execute(db)
        .await?;
    // This fixture owns a distinct login for each disposable account.
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'owned-fixture',clock_timestamp()+interval '1 hour')")
        .bind(user.to_string()).bind(user).execute(db).await?;
    let state = RoomState {
        room_id: room,
        revision: 1,
        // An explicit owned timeline fixture makes Pause a legal reducer input.
        media_id: Some(Uuid::new_v4()),
        media_generation: 0,
        playback_status: PlaybackStatus::Paused,
        anchor_position_ms: 0.0,
        anchor_server_time_ms: 0.0,
        playback_rate: 1.0,
        controller_user_id: user,
        duration_ms: None,
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
        media_generation: 0,
        action: Action::Pause,
    };
    Ok((state, command, user))
}
async fn delete(db: PgPool, room: Uuid, user: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(user)
        .execute(&db)
        .await?;
    Ok(())
}
async fn counts(db: &PgPool, room: Uuid) -> Result<(i64, i64, i64)> {
    Ok(sqlx::query_as("SELECT (SELECT count(*) FROM control_epochs WHERE room_id=$1),(SELECT count(*) FROM command_results WHERE room_id=$1),(SELECT (state->>'revision')::bigint FROM room_snapshots WHERE room_id=$1)").bind(room).fetch_one(db).await?)
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("RAINSYNC_FIXTURE_DATABASE")?).await?;
    let name: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&db)
        .await?;
    ensure!(name.starts_with("rainsync_"));
    for gate in [Gate::Commit, Gate::Replay, Gate::Epoch] {
        for deletion_first in [true, false] {
            let (state, command, user) = fixture(&db).await?;
            let room = state.room_id;
            if matches!(gate, Gate::Replay) {
                sqlx::query("INSERT INTO command_results(room_id,command_id,user_id,state,request_payload) VALUES($1,$2,$3,$4,$5)").bind(room).bind(command.command_id).bind(user).bind(serde_json::to_value(&state)?).bind(serde_json::to_value(&command)?).execute(&db).await?;
            }
            let before = counts(&db, room).await?;
            if deletion_first {
                let mut removal = db.begin().await?;
                sqlx::query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2")
                    .bind(room)
                    .bind(user)
                    .execute(&mut *removal)
                    .await?;
                let task = tokio::spawn(gate.run(db.clone(), state, command, user));
                wait_blocked(&db, "SELECT user_id FROM room_members").await?;
                removal.commit().await?;
                let result = tokio::time::timeout(Duration::from_secs(5), task).await??;
                ensure!(result.unwrap_err().to_string() == "not_a_member");
                ensure!(
                    counts(&db, room).await? == before,
                    "rejection made durable side effects"
                );
            } else {
                let mut blocker = db.begin().await?;
                sqlx::query(&format!(
                    "LOCK TABLE {} IN ACCESS EXCLUSIVE MODE",
                    gate.table()
                ))
                .execute(&mut *blocker)
                .await?;
                let task = tokio::spawn(gate.run(db.clone(), state, command, user));
                let fragment = match gate {
                    Gate::Commit => "INSERT INTO room_events",
                    Gate::Replay => "SELECT state,user_id,request_payload FROM command_results",
                    Gate::Epoch => "INSERT INTO control_epochs",
                };
                wait_blocked(&db, fragment).await?;
                let removal = tokio::spawn(delete(db.clone(), room, user));
                wait_blocked(&db, "DELETE FROM room_members").await?;
                ensure!(
                    !removal.is_finished(),
                    "DELETE passed an admitted transaction"
                );
                blocker.commit().await?;
                tokio::time::timeout(Duration::from_secs(5), task).await???;
                tokio::time::timeout(Duration::from_secs(5), removal).await???;
                let after = counts(&db, room).await?;
                match gate {
                    Gate::Commit => ensure!(after == (before.0, before.1 + 1, before.2 + 1)),
                    Gate::Replay => ensure!(after == before),
                    Gate::Epoch => ensure!(after == (before.0 + 1, before.1, before.2)),
                }
            }
            println!(
                "PASS: {gate:?} {} observed lock race and durable outcome",
                if deletion_first {
                    "DELETE-first rejects"
                } else {
                    "admission-first holds membership through completion"
                }
            );
        }
    }
    // Preserve the final commit's own expiry gate independently of the earlier
    // replay gate now taking its snapshot/member locks.
    let (state, command, user) = fixture(&db).await?;
    let room = state.room_id;
    let before = counts(&db, room).await?;
    let epoch = command.control_epoch.unwrap();
    let mut blocker = db.begin().await?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(room)
        .fetch_one(&mut *blocker)
        .await?;
    let task = tokio::spawn(Gate::Commit.run(db.clone(), state, command, user));
    wait_blocked(&db, "SELECT state FROM room_snapshots").await?;
    sqlx::query(
        "UPDATE control_epochs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(epoch)
    .execute(&db)
    .await?;
    blocker.commit().await?;
    let result = tokio::time::timeout(Duration::from_secs(5), task).await??;
    ensure!(result.unwrap_err().to_string() == "control_epoch_expired");
    ensure!(counts(&db, room).await? == before);
    println!("PASS: final commit independently rejects epoch expired while snapshot lock was held");
    ensure!(db.size() <= 12);
    db.close().await;
    Ok(())
}
