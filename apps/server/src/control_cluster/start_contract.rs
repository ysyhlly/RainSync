//! Full original Runtime::start, real isolated SQL faults and advisory backend loss.
use super::*;
use anyhow::{Result, ensure};
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
async fn observe(db: &PgPool) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for table in [
        "control_cluster_activation",
        "control_nodes",
        "rooms",
        "room_leases",
        "room_snapshots",
        "room_events",
    ] {
        let rows:Value=sqlx::query_scalar(&format!("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {table} t")).fetch_one(db).await?;
        out.insert(table.into(), rows);
    }
    let locks:Value=sqlx::query_scalar("SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',l.pid,'classid',l.classid,'objid',l.objid,'objsubid',l.objsubid,'granted',l.granted) ORDER BY l.pid),'[]'::jsonb) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid=72614932 AND a.datname=current_database()").fetch_one(db).await?;
    out.insert("advisory_locks".into(), locks);
    Ok(Value::Object(out))
}
async fn ownership(runtime: &Runtime) -> Value {
    let owned = runtime.inner.owned.lock().await;
    let rows=owned.values().map(|l|json!({"room":l.room,"node":l.node,"incarnation":l.incarnation,"fencing_token":l.fencing_token,"remaining_ms":l.remaining_ms})).collect::<Vec<_>>();
    let mut fenced = runtime
        .inner
        .fenced
        .lock()
        .await
        .iter()
        .copied()
        .collect::<Vec<_>>();
    fenced.sort();
    let mut routes = runtime
        .inner
        .routes
        .lock()
        .await
        .keys()
        .copied()
        .collect::<Vec<_>>();
    routes.sort();
    json!({"healthy":runtime.healthy(),"owned":rows,"fenced":fenced,"routes":routes})
}
#[tokio::test]
#[ignore = "requires cluster-start-lifecycle-native.mjs owned PG"]
async fn owned_start_lifecycle() -> Result<()> {
    ensure!(std::env::var_os("DATABASE_URL").is_none());
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST")? == "1");
    let url = std::env::var("RAINSYNC_CLUSTER_START_DATABASE_URL")?;
    ensure!(url == std::env::var("RAINSYNC_CLUSTER_START_EXPECTED_DATABASE_URL")?);
    ensure!(url.starts_with("postgres://rainsync:") && url.contains("@127.0.0.1:"));
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_CLUSTER_START_RUN_ID")?)?;
    let db = persistence::connect(&url).await?;
    let marker: Uuid = sqlx::query_scalar(
        "SELECT run_id FROM rainsync_cluster_start_fixture_owner WHERE singleton",
    )
    .fetch_one(&db)
    .await?;
    ensure!(marker == run);
    persistence::migrate(&db).await?;
    let node = Uuid::from_bytes([1; 16]);
    let other = Uuid::from_bytes([2; 16]);
    let instance = id(3);
    let epoch = id(4);
    sqlx::query(
        "INSERT INTO users(id,username,password_hash,admin) VALUES($1,'start-owned','!',true)",
    )
    .bind(id(20))
    .execute(&db)
    .await?;
    for n in [30, 31] {
        let room = id(n);
        sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'start-owned',$2)")
            .bind(room)
            .bind(id(20))
            .execute(&db)
            .await?;
        let state = protocol::RoomState {
            live: None,
            room_id: room,
            revision: 0,
            media_id: None,
            media_generation: 0,
            playback_status: protocol::PlaybackStatus::Paused,
            anchor_position_ms: 0.0,
            anchor_server_time_ms: 0.0,
            playback_rate: 1.0,
            controller_user_id: id(20),
            duration_ms: None,
            clock_epoch: epoch,
        };
        sqlx::query("INSERT INTO room_snapshots(room_id,state) VALUES($1,$2)")
            .bind(room)
            .bind(serde_json::to_value(state)?)
            .execute(&db)
            .await?;
    }
    let settings = Settings {
        node,
        instance,
        media: false,
        nodes: BTreeMap::from([
            (node, "http://127.0.0.1:41001".into()),
            (other, "http://127.0.0.1:41002".into()),
        ]),
        secret: "owned-start-secret".into(),
    };
    let before = observe(&db).await?;
    let startup_db =
        persistence::connect_with_control_instance(&url, Some(node), Some(instance)).await?;
    let runtime = Runtime::start(startup_db, settings.clone(), epoch, Instant::now()).await?;
    ensure!(runtime.healthy());
    let registration: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM control_nodes WHERE id=$1 AND incarnation=$2 AND route_origin=$3) AND (SELECT configuration_hash=$4 FROM control_cluster_activation WHERE singleton)")
        .bind(node).bind(instance).bind(&settings.nodes[&node]).bind(settings.fingerprint()).fetch_one(&db).await?;
    ensure!(registration, "exact startup registration absent");
    let key = i32::from_be_bytes(node.as_bytes()[..4].try_into()?);
    let backend:i32=sqlx::query_scalar("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid=72614932 AND l.objid=$1::bigint::oid AND l.objsubid=2 AND l.granted AND a.datname=current_database()").bind(i64::from(key)).fetch_one(&db).await?;
    let mut cases = vec![
        json!({"case":"startup_registered","before":before,"after":observe(&db).await?,"advisory_backend":backend}),
    ];
    println!("\nPASS: owned cluster start startup_registered");
    let duplicate_db = persistence::connect(&url).await?;
    let before = observe(&db).await?;
    let duplicate = match Runtime::start(
        duplicate_db.clone(),
        settings.clone(),
        id(8),
        Instant::now(),
    )
    .await
    {
        Ok(_) => anyhow::bail!("duplicate stable node unexpectedly started"),
        Err(e) => e,
    };
    ensure!(duplicate.to_string() == "another process owns this control node ID");
    cases.push(json!({"case":"duplicate_stable_node","before":before,"after":observe(&db).await?,"error":duplicate.to_string()}));
    duplicate_db.close().await;
    println!("\nPASS: owned cluster start duplicate_stable_node");
    let mismatch_db = persistence::connect(&url).await?;
    let mut mismatch = settings.clone();
    mismatch.node = other;
    mismatch.instance = id(9);
    mismatch.secret = "different-owned-secret".into();
    let before = observe(&db).await?;
    let error = match Runtime::start(mismatch_db.clone(), mismatch, id(10), Instant::now()).await {
        Ok(_) => anyhow::bail!("mismatch unexpectedly started"),
        Err(e) => e,
    };
    ensure!(error.to_string() == "control cluster configuration mismatch");
    // Failed start may leave its acquired advisory lock on a returned pool session.
    cases.push(json!({"case":"fingerprint_mismatch","before":before,"after_failed_start":observe(&db).await?,"error":error.to_string()}));
    mismatch_db.close().await;
    println!("\nPASS: owned cluster start fingerprint_mismatch");
    for n in [30, 31] {
        runtime.resolve(id(n)).await?;
    }
    let before = observe(&db).await?;
    let owners_before = ownership(&runtime).await;
    {
        let owned = runtime.inner.owned.lock().await;
        for room in [id(30), id(31)] {
            let lease = owned
                .get(&room)
                .ok_or_else(|| anyhow::anyhow!("original owned lease absent"))?;
            ensure!(lease.node == node && lease.incarnation == instance);
        }
    }
    sqlx::raw_sql(
        "CREATE SEQUENCE fixture_renew_null_witness;CREATE SEQUENCE fixture_renew_raise_witness",
    )
    .execute(&db)
    .await?;
    // Controlled real SQL: RETURN NULL yields UPDATE rows_affected=0 while final
    // production guard still reads a live lease. RAISE exercises the error branch.
    sqlx::raw_sql(&format!("CREATE FUNCTION fixture_renew_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.room_id='{}'::uuid THEN PERFORM nextval('fixture_renew_null_witness'); RETURN NULL; ELSE PERFORM nextval('fixture_renew_raise_witness'); RAISE EXCEPTION 'owned renewal SQL fault'; END IF; END $$;CREATE TRIGGER fixture_renew_fault BEFORE UPDATE OF lease_until ON room_leases FOR EACH ROW EXECUTE FUNCTION fixture_renew_fault();",id(30))).execute(&db).await?;
    let end = Instant::now() + Duration::from_secs(6);
    loop {
        let fenced = runtime.inner.fenced.lock().await;
        let ready = fenced.contains(&id(30)) && fenced.contains(&id(31));
        drop(fenced);
        if ready {
            break;
        }
        ensure!(Instant::now() < end, "renewal fencing absent");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    {
        let owned = runtime.inner.owned.lock().await;
        ensure!(!owned.contains_key(&id(30)) && !owned.contains_key(&id(31)));
    }
    {
        let routes = runtime.inner.routes.lock().await;
        ensure!(!routes.contains_key(&id(30)) && !routes.contains_key(&id(31)));
    }
    ensure!(runtime.healthy());
    let branch_witness: bool=sqlx::query_scalar("SELECT (SELECT is_called FROM fixture_renew_null_witness) AND (SELECT is_called FROM fixture_renew_raise_witness)").fetch_one(&db).await?;
    ensure!(
        branch_witness,
        "both real renewal fault branches must execute"
    );
    cases.push(json!({"case":"renewal_false_and_error_fence","before":before,"owners_before":owners_before,"after":observe(&db).await?,"owners_after":ownership(&runtime).await,"both_fault_branches_witnessed":branch_witness}));
    println!("\nPASS: owned cluster start renewal_false_and_error_fence");
    sqlx::raw_sql(
        "DROP TRIGGER fixture_renew_fault ON room_leases;DROP FUNCTION fixture_renew_fault();DROP SEQUENCE fixture_renew_null_witness;DROP SEQUENCE fixture_renew_raise_witness",
    )
    .execute(&db)
    .await?;
    let before = observe(&db).await?;
    let terminated: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
        .bind(backend)
        .fetch_one(&db)
        .await?;
    ensure!(terminated);
    let terminated_at = Instant::now();
    // Original cadence is 2s plus per-call 1500ms, not a 1500ms wall-clock promise.
    let end = Instant::now() + Duration::from_secs(5);
    while runtime.healthy() {
        ensure!(Instant::now() < end, "backend loss did not fence runtime");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let latency = terminated_at.elapsed().as_millis();
    tokio::time::sleep(Duration::from_millis(2200)).await;
    ensure!(!runtime.healthy());
    let held:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid=72614932 AND l.objid=$1::bigint::oid AND l.objsubid=2 AND l.granted AND a.datname=current_database())").bind(i64::from(key)).fetch_one(&db).await?;
    ensure!(!held);
    ensure!(std::process::id() > 0);
    cases.push(json!({"case":"backend_loss_permanent_unhealthy","before":before,"after":observe(&db).await?,"owners":ownership(&runtime).await,"unhealthy_latency_ms":latency,"test_process_alive":true,"no_reacquired_advisory_lock":true}));
    println!("\nPASS: owned cluster start backend_loss_permanent_unhealthy");
    std::fs::write(
        std::env::var("RAINSYNC_CLUSTER_START_OBSERVATION")?,
        serde_json::to_vec_pretty(
            &json!({"cases":cases,"final":observe(&db).await?,"scope":"Original start spawns its actual tasks; pending heartbeat task is cancelled only at test Tokio-runtime shutdown, then coordinator owns process/PG positive cleanup"}),
        )?,
    )?;
    // Do not close Runtime pool: original pending heartbeat still owns it.
    db.close().await;
    Ok(())
}
