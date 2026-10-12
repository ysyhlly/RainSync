//! Original Runtime::resolve on real full-schema PG; no listener or replacement authority.
use super::*;
use anyhow::{Result, ensure};
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
async fn observe(db: &PgPool) -> Result<Value> {
    let mut tables = serde_json::Map::new();
    for name in [
        "rooms",
        "room_leases",
        "control_nodes",
        "room_snapshots",
        "command_results",
        "room_events",
    ] {
        let rows:Value=sqlx::query_scalar(&format!("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {name} t")).fetch_one(db).await?;
        tables.insert(name.into(), rows);
    }
    Ok(Value::Object(tables))
}
#[tokio::test]
#[ignore = "requires cluster-route-resolution-native.mjs owned PG"]
async fn owned_route_resolution() -> Result<()> {
    ensure!(std::env::var_os("DATABASE_URL").is_none());
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST")? == "1");
    let url = std::env::var("RAINSYNC_CLUSTER_ROUTE_DATABASE_URL")?;
    ensure!(url == std::env::var("RAINSYNC_CLUSTER_ROUTE_EXPECTED_DATABASE_URL")?);
    ensure!(url.starts_with("postgres://rainsync:") && url.contains("@127.0.0.1:"));
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_CLUSTER_ROUTE_RUN_ID")?)?;
    let db = persistence::connect(&url).await?;
    let owner: Uuid = sqlx::query_scalar(
        "SELECT run_id FROM rainsync_cluster_route_fixture_owner WHERE singleton",
    )
    .fetch_one(&db)
    .await?;
    ensure!(owner == run);
    persistence::migrate(&db).await?;
    let (local, remote, instance, remote_instance, room) = (id(1), id(2), id(3), id(4), id(5));
    sqlx::raw_sql(&format!("INSERT INTO users(id,username,password_hash,admin) VALUES('{}','route-owned','!',true);INSERT INTO rooms(id,name,owner_id) VALUES('{room}','route-owned','{}');",id(6),id(6))).execute(&db).await?;
    leases::register_instance(&db, local, instance, "http://127.0.0.1:41001").await?;
    leases::register_instance(&db, remote, remote_instance, "http://127.0.0.1:41002").await?;
    sqlx::query("UPDATE control_nodes SET heartbeat_at='2100-01-01'")
        .execute(&db)
        .await?;
    sqlx::query("INSERT INTO room_leases(room_id,owner_node,owner_incarnation,lease_until) VALUES($1,$2,$3,'2100-01-01')").bind(room).bind(remote).bind(remote_instance).execute(&db).await?;
    // Construct the exact production Runtime storage without starting background heartbeat tasks.
    // This tests resolve, not Runtime::start or network transport; unchanged two-Server gate covers those.
    let runtime = Runtime {
        inner: Arc::new(Inner {
            settings: Settings {
                node: local,
                instance,
                media: false,
                nodes: BTreeMap::from([
                    (local, "http://127.0.0.1:41001".into()),
                    (remote, "http://127.0.0.1:41002".into()),
                ]),
                secret: "owned-unused".into(),
            },
            db: db.clone(),
            epoch: id(7),
            start: Instant::now(),
            live: AtomicBool::new(true),
            create_route: AtomicU64::new(0),
            owned: Mutex::new(HashMap::new()),
            fenced: Mutex::new(HashSet::new()),
            routes: Mutex::new(HashMap::new()),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(DEADLINE)
                .build()?,
        }),
    };
    let mut cases = Vec::new();
    let before = observe(&db).await?;
    let route = runtime.resolve(room).await?;
    ensure!(route.node == remote);
    ensure!(before == observe(&db).await?);
    cases.push(json!({"case":"remote_miss","before":before,"after":observe(&db).await?}));
    println!("\nPASS: owned cluster route remote_miss");
    let mut lock = db.begin().await?;
    sqlx::query("LOCK TABLE room_leases IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await?;
    // Explicit cache age is test-only setup; hit still invokes complete original operation.
    runtime
        .inner
        .routes
        .lock()
        .await
        .insert(room, (Instant::now(), route.clone()));
    let hit = tokio::time::timeout(Duration::from_millis(200), runtime.resolve(room)).await??;
    ensure!(hit.node == remote);
    lock.rollback().await?;
    cases.push(json!({"case":"fresh_hit_without_db_read","tables":observe(&db).await?}));
    println!("\nPASS: owned cluster route fresh_hit_without_db_read");
    // A fresh cached routing hint may be stale; the actual production write guard rejects it.
    sqlx::query("UPDATE room_leases SET lease_until='2000-01-01' WHERE room_id=$1")
        .bind(room)
        .execute(&db)
        .await?;
    runtime
        .inner
        .routes
        .lock()
        .await
        .insert(room, (Instant::now(), route.clone()));
    let stale = runtime.resolve(room).await?;
    ensure!(stale.node == remote);
    let lease = Lease {
        room,
        node: remote,
        incarnation: remote_instance,
        fencing_token: stale.fencing_token,
        remaining_ms: stale.remaining_ms,
    };
    let mut tx = db.begin().await?;
    ensure!(
        leases::guard(&mut tx, &lease)
            .await
            .unwrap_err()
            .to_string()
            == "room_owner_lost"
    );
    tx.rollback().await?;
    cases.push(json!({"case":"stale_hint_not_authority","tables":observe(&db).await?}));
    println!("\nPASS: owned cluster route stale_hint_not_authority");
    // Deterministic >=250ms branch plus real expired authority. Local node is fenced, so claim cannot mint new state.
    runtime.inner.fenced.lock().await.insert(room);
    runtime.inner.routes.lock().await.insert(
        room,
        (Instant::now() - Duration::from_millis(250), route.clone()),
    );
    ensure!(runtime.resolve(room).await.unwrap_err().to_string() == "room_owner_lost");
    cases.push(json!({"case":"aged_hit_rechecks_db","tables":observe(&db).await?}));
    println!("\nPASS: owned cluster route aged_hit_rechecks_db");
    sqlx::query("UPDATE room_leases SET lease_until='2100-01-01' WHERE room_id=$1")
        .bind(room)
        .execute(&db)
        .await?;
    let rooms = (100..1124)
        .map(|n| format!("('{}','capacity-owned','{}')", id(n), id(6)))
        .collect::<Vec<_>>()
        .join(",");
    sqlx::raw_sql(&format!(
        "INSERT INTO rooms(id,name,owner_id) VALUES {rooms}"
    ))
    .execute(&db)
    .await?;
    {
        let mut cache = runtime.inner.routes.lock().await;
        cache.clear();
        for n in 100..1124 {
            cache.insert(id(n), (Instant::now(), route.clone()));
        }
        ensure!(cache.len() == 1024);
    }
    runtime.resolve(room).await?;
    let cache = runtime.inner.routes.lock().await;
    ensure!(cache.len() == 1 && cache.contains_key(&room));
    drop(cache);
    cases.push(
        json!({"case":"capacity_clear_then_insert","tables":observe(&db).await?,"cache_len":1}),
    );
    println!("\nPASS: owned cluster route capacity_clear_then_insert");
    // Original local claim+prepare with a complete protocol snapshot and real lease row.
    let local_room = id(2000);
    let state = protocol::RoomState {
        live: None,
        room_id: local_room,
        revision: 0,
        media_id: None,
        media_generation: 0,
        playback_status: protocol::PlaybackStatus::Playing,
        anchor_position_ms: 17.0,
        anchor_server_time_ms: 0.0,
        playback_rate: 1.0,
        controller_user_id: id(6),
        duration_ms: None,
        clock_epoch: id(2001),
    };
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'local-owned',$2)")
        .bind(local_room)
        .bind(id(6))
        .execute(&db)
        .await?;
    sqlx::query("INSERT INTO room_snapshots(room_id,state) VALUES($1,$2)")
        .bind(local_room)
        .bind(serde_json::to_value(&state)?)
        .execute(&db)
        .await?;
    let local_before = observe(&db).await?;
    let local_route = runtime.resolve(local_room).await?;
    ensure!(local_route.node == local);
    let stored: protocol::RoomState = serde_json::from_value(
        sqlx::query_scalar::<_, Value>("SELECT state FROM room_snapshots WHERE room_id=$1")
            .bind(local_room)
            .fetch_one(&db)
            .await?,
    )?;
    ensure!(
        stored.revision == 1
            && stored.clock_epoch == runtime.inner.epoch
            && stored.playback_status == protocol::PlaybackStatus::Paused
            && stored.anchor_position_ms == 17.0
    );
    let prepared:bool=sqlx::query_scalar("SELECT owner_node=$2 AND owner_incarnation=$3 AND prepared_fencing_token=fencing_token AND prepared_clock_epoch=$4 AND checkpoint_revision=1 AND checkpoint_generation=0 AND checkpoint_clock_epoch=$4 AND lease_until>clock_timestamp() FROM room_leases WHERE room_id=$1").bind(local_room).bind(local).bind(instance).bind(runtime.inner.epoch).fetch_one(&db).await?;
    ensure!(prepared);
    let event_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM room_events WHERE room_id=$1 AND revision=1")
            .bind(local_room)
            .fetch_one(&db)
            .await?;
    ensure!(event_count == 1);
    let original_owned = runtime
        .inner
        .owned
        .lock()
        .await
        .get(&local_room)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("local claim not retained"))?;
    let mut guarded = db.begin().await?;
    leases::guard(&mut guarded, &original_owned).await?;
    guarded.rollback().await?;
    runtime.invalidate(local_room).await;
    runtime.resolve(local_room).await?;
    let repeated: Value = sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1")
        .bind(local_room)
        .fetch_one(&db)
        .await?;
    ensure!(repeated == serde_json::to_value(&stored)?);
    cases.push(json!({"case":"local_claim_prepare","before":local_before,"after":observe(&db).await?,"snapshot":repeated}));
    println!("\nPASS: owned cluster route local_claim_prepare");
    // Real race: route SELECT sees no lease; claim then waits on original room row lock.
    let race_room = id(2010);
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'race-owned',$2)")
        .bind(race_room)
        .bind(id(6))
        .execute(&db)
        .await?;
    let race_before = observe(&db).await?;
    let mut blocker = db.begin().await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(race_room)
        .fetch_one(&mut *blocker)
        .await?;
    let runner = runtime.clone();
    let task = tokio::spawn(async move { runner.resolve(race_room).await });
    let witness=async {
  for _ in 0..100 {
   let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE')").fetch_one(&db).await?;
   if waiting{return Ok::<_,anyhow::Error>(true)}tokio::time::sleep(Duration::from_millis(10)).await;
  }Ok(false)
 }.await;
    // Regardless of witness failure, release blocker and await exact original task to terminal.
    let insertion = if matches!(witness, Ok(true)) {
        sqlx::query("INSERT INTO room_leases(room_id,owner_node,owner_incarnation,lease_until) VALUES($1,$2,$3,'2100-01-01')").bind(race_room).bind(remote).bind(remote_instance).execute(&mut *blocker).await.map(|_|())
    } else {
        Ok(())
    };
    let released = blocker.commit().await;
    let outcome = task.await;
    ensure!(witness?, "claim lock witness absent");
    insertion?;
    released?;
    let raced = outcome??;
    ensure!(raced.node == remote);
    ensure!(!runtime.inner.owned.lock().await.contains_key(&race_room));
    let owner: Uuid = sqlx::query_scalar("SELECT owner_node FROM room_leases WHERE room_id=$1")
        .bind(race_room)
        .fetch_one(&db)
        .await?;
    ensure!(owner == remote);
    cases.push(json!({"case":"room_owner_changed_reread","before":race_before,"after":observe(&db).await?,"claim_lock_observed":true}));
    println!("\nPASS: owned cluster route room_owner_changed_reread");
    // Remove only the additional cases' cache hints before the original empty-cache assertion.
    runtime.invalidate(local_room).await;
    runtime.invalidate(race_room).await;
    runtime.invalidate(room).await;
    ensure!(runtime.inner.routes.lock().await.is_empty());
    runtime.resolve(room).await?;
    runtime.close();
    ensure!(runtime.resolve(room).await.unwrap_err().to_string() == "control_node_unhealthy");
    cases.push(json!({"case":"invalidate_and_closed_runtime","tables":observe(&db).await?}));
    println!("\nPASS: owned cluster route invalidate_and_closed_runtime");
    std::fs::write(
        std::env::var("RAINSYNC_CLUSTER_ROUTE_OBSERVATION")?,
        serde_json::to_vec_pretty(&json!({"cases":cases,"final":observe(&db).await?}))?,
    )?;
    db.close().await;
    Ok(())
}
