//! Direct production retention fixture. Only the owned Node coordinator runs this test.
use super::*;
use anyhow::{Result, ensure};

async fn app(db: PgPool) -> Result<App> {
    Ok(App {
        control_cluster: None,
        platform_http: providers::platform::http::PlatformHttp::new(),
        bilibili_signing_keys: Arc::new(Default::default()),
        native_delivery_owners: Arc::new(Default::default()),
        live_playback: crate::native_live::LiveStore::default(),
        other_live_playback: crate::native_other_live::LiveStore::default(),
        other_live_enabled: false,
        platform_oauth: Arc::new(providers::platform::oauth::Registry::disabled()),
        platform_oauth_exchanges: Arc::new(platform_accounts::exchanges::Registry::new()),
        native_transcode_delivery: Arc::new(Default::default()),
        youtube: providers::platform::youtube::YoutubeResolver::new(
            providers::platform::youtube::Config::disabled(),
        ),
        presence_sequence: Default::default(),
        account_security: account_security::Security::configured()?,
        avatar_settings: avatar_image::Settings::configured()?,
        session_limit: 8,
        queue_limit: 8,
        preview_settings: persistence::media_previews::Settings::configured()?,
        metrics: Default::default(),
        readiness: Default::default(),
        db,
        origin: "http://localhost".into(),
        secure: false,
        key: Arc::new(Aes256Gcm::new_from_slice(&[0; 32]).unwrap()),
        epoch: Uuid::new_v4(),
        start: Instant::now(),
        rooms: Default::default(),
        agent_controls: Default::default(),
        upstream: Default::default(),
        upstream_policy: Default::default(),
        preparations: Default::default(),
    })
}

fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
async fn sql(db: &PgPool, text: &str) -> Result<()> {
    sqlx::raw_sql(text).execute(db).await?;
    Ok(())
}

async fn seed(db: &PgPool) -> Result<()> {
    let user = id(1);
    let agent = id(2);
    let media = id(3);
    let room = id(4);
    let membership = id(5);
    let login = "a".repeat(64);
    let digest = "b".repeat(64);
    sql(db, &format!(r#"
      INSERT INTO users(id,username,password_hash,admin) VALUES('{user}','retention-owned','!',true);
      INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES('{login}','{user}','owned','2100-01-01');
      INSERT INTO agents(id,name) VALUES('{agent}','owned');
      INSERT INTO sources(id,name,kind,config_encrypted) VALUES('{agent}','owned','agent','owned-unused');
      INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('{media}','{agent}','owned','owned.mp4','stat-v1:{digest}');
      INSERT INTO rooms(id,name,owner_id) VALUES('{room}','owned','{user}');
      INSERT INTO room_members(room_id,user_id,membership_epoch) VALUES('{room}','{user}','{membership}');
      INSERT INTO room_snapshots(room_id,state) VALUES('{room}','{{"media_id":"{media}","media_generation":1}}');
    "#)).await?;
    // Synthetic pending-cleanup predicate on an active room; this is not a real close flow.
    let pending_room = id(6);
    sql(db,&format!(r#"INSERT INTO rooms(id,name,owner_id) VALUES('{pending_room}','pending','{user}');
      INSERT INTO room_members(room_id,user_id,membership_epoch) VALUES('{pending_room}','{user}','{membership}');
      INSERT INTO room_snapshots(room_id,state) VALUES('{pending_room}','{{"media_id":"{media}","media_generation":1}}');
      INSERT INTO room_cleanup_tasks(room_id,lifecycle_epoch,next_attempt_at) VALUES('{pending_room}',0,'2000-01-01');"#)).await?;
    // Production stamp trigger derives library fields. No authorization function is replaced.
    for n in 10..=17 {
        let job = id(n);
        let generation = id(n + 100);
        let room = if n == 14 { pending_room } else { room };
        let fresh = n == 10 || n == 17;
        let expiry = if fresh { "2100-01-01" } else { "2000-01-01" };
        let status = if fresh { "ready" } else { "running" };
        sql(db, &format!(r#"
          INSERT INTO distributed_compute_jobs(id,room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,status,attempt,output_generation,owner_agent,owner_connection,qualification,qualification_sha256,expires_at)
          SELECT '{job}','{room}','{user}','{login}','{membership}','{media}',1,0,'stat-v1:{digest}',access_policy_revision,'{digest}',1024,'remux_hls_v1','{status}',1,'{generation}','{agent}','{membership}','{{"schema_version":1,"full_decode":true}}','{digest}','{expiry}' FROM sources WHERE id='{agent}';
          INSERT INTO distributed_compute_files(job_id,output_generation,name,sha256,size_bytes) VALUES('{job}','{generation}','index.m3u8','{digest}',5);
        "#)).await?;
        if (12..=16).contains(&n) {
            let reaped = n != 12;
            let receipt = if reaped {
                "'reaped','2000-01-01','2000-01-01'"
            } else {
                "NULL,NULL,NULL"
            };
            sql(db,&format!(r#"INSERT INTO distributed_compute_attempts(job_id,room_id,attempt,output_generation,owner_agent,owner_connection,owner_token_hash,process_disposition,process_reaped_at,files_removed_at,created_at)
              VALUES('{job}','{room}',1,'{generation}','{agent}','{membership}','{login}',{receipt},'2000-01-01');"#)).await?;
            if n == 13 || n == 16 {
                let verified = if n == 16 { "'2000-01-01'" } else { "NULL" };
                sql(db,&format!("UPDATE distributed_compute_attempts SET server_verification_id='{generation}',server_verification_owner_epoch='{membership}',server_verification_started_at='2000-01-01',server_verification_reaped_at={verified} WHERE job_id='{job}'")).await?;
            }
        }
    }
    // Legal fresh immutable binding. Past expiry cannot be immediately seeded through this trigger.
    let job = id(17);
    let generation = id(117);
    let session = id(30);
    let viewer = id(31);
    sql(db,&format!(r#"
      INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash)
      VALUES('{user}','{room}','{viewer}',1,'{login}');
      INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,auth_login_hash,auth_membership_epoch)
      VALUES('{user}','{session}','owned','{session}','{membership}','pending','2099-01-01','2099-01-01','{room}','{login}','{membership}');
      INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,viewer_id,plan_generation)
      VALUES('{session}','{user}','{room}','{media}',1,'owned-delivery','{{"distributed_compute_version":1,"distributed_session_id":"{session}","distributed_job_id":"{job}","distributed_attempt":1,"distributed_output_generation":"{generation}","distributed_qualification_sha256":"{digest}"}}','2099-01-01','{viewer}',1);
      INSERT INTO distributed_playback_bindings(session_id,job_id,attempt,output_generation,manifest_sha256,qualification_sha256,duration_ms)
      VALUES('{session}','{job}',1,'{generation}','{digest}','{digest}',1000);
    "#)).await?;
    ensure!(
        sqlx::query_scalar::<_, bool>("SELECT distributed_compute_authorized($1)")
            .bind(job)
            .fetch_one(db)
            .await?,
        "bound fresh job must pass production authorization"
    );
    ensure!(
        sqlx::query_scalar::<_, bool>("SELECT distributed_playback_session_authorized($1)")
            .bind(session)
            .fetch_one(db)
            .await?,
        "fresh bound session must pass production authorization after binding insertion"
    );
    for n in 40..=42 {
        let peer = id(n);
        let job = id(10);
        let generation = id(110);
        let expiry = if n == 42 { "2000-01-01" } else { "2100-01-01" };
        sql(db,&format!(r#"INSERT INTO room_p2p_peers(id,room_id,user_id,job_id,output_generation,login_hash,membership_epoch,expires_at)
           VALUES('{peer}','{room}','{user}','{job}','{generation}','{login}','{membership}','{expiry}');"#)).await?;
    }
    sql(db,&format!(r#"
      INSERT INTO room_p2p_signals(sender,recipient,kind,payload,expires_at) VALUES
      ('{}','{}','offer','{{}}','2000-01-01'),('{}','{}','ice','{{}}','2100-01-01'),('{}','{}','answer','{{}}','2100-01-01');
    "#,id(40),id(41),id(40),id(41),id(42),id(41))).await?;
    ensure!(
        sqlx::query_scalar::<_, bool>("SELECT distributed_compute_authorized($1)")
            .bind(id(10))
            .fetch_one(db)
            .await?,
        "fresh fixture must pass actual authorization"
    );
    Ok(())
}

fn tree(root: &std::path::Path) -> Result<Value> {
    fn visit(root: &std::path::Path, path: &std::path::Path, rows: &mut Vec<Value>) -> Result<()> {
        let meta = std::fs::symlink_metadata(path)?;
        let name = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        if meta.is_dir() {
            rows.push(json!({"path":name,"kind":"directory"}));
            let mut entries = std::fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                visit(root, &entry.path(), rows)?;
            }
        } else {
            rows.push(json!({"path":name,"kind":"file","bytes":std::fs::read(path)?}));
        }
        Ok(())
    }
    if !root.exists() {
        return Ok(json!([]));
    }
    let mut rows = Vec::new();
    visit(root, root, &mut rows)?;
    Ok(json!(rows))
}

async fn observe(db: &PgPool, root: &std::path::Path, outcome: &str) -> Result<Value> {
    let mut tables = serde_json::Map::new();
    for table in [
        "distributed_compute_jobs",
        "distributed_compute_attempts",
        "distributed_compute_files",
        "distributed_playback_bindings",
        "playback_sessions",
        "playback_viewer_plans",
        "room_cleanup_tasks",
        "room_p2p_peers",
        "room_p2p_signals",
    ] {
        // Every column is preserved in the raw observation; the coordinator writes a second
        // comparison artifact normalizing only runtime timestamp values.
        let text = format!(
            "SELECT COALESCE(jsonb_agg(payload ORDER BY payload::text),'[]'::jsonb) FROM (SELECT to_jsonb(t) AS payload FROM {table} t) q"
        );
        let rows: Value = sqlx::query_scalar(&text).fetch_one(db).await?;
        tables.insert(table.into(), rows);
    }
    let job_authorized = sqlx::query_scalar::<_, bool>("SELECT distributed_compute_authorized($1)")
        .bind(id(17))
        .fetch_one(db)
        .await?;
    let session_authorized =
        sqlx::query_scalar::<_, bool>("SELECT distributed_playback_session_authorized($1)")
            .bind(id(30))
            .fetch_one(db)
            .await?;
    ensure!(
        job_authorized && session_authorized,
        "fresh bound output must remain authorized after cleanup"
    );
    // Complete columns/rows for the listed tables and complete synthetic file tree only.
    // This does not observe every database table or prove real NAS process release.
    Ok(
        json!({"outcome":outcome,"tables":tables,"files":tree(root)?,
        "authorization":{"job17":job_authorized,"session30":session_authorized}}),
    )
}

#[tokio::test]
#[ignore = "requires tests/distributed-compute-retention-native.mjs owned isolated PostgreSQL coordinator"]
async fn owned_retention_sweep() -> Result<()> {
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST")? == "1");
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_RETENTION_RUN_ID")?)?;
    let url = std::env::var("RAINSYNC_RETENTION_DATABASE_URL")?;
    ensure!(
        url == std::env::var("RAINSYNC_RETENTION_EXPECTED_DATABASE_URL")?,
        "owned URL mismatch"
    );
    ensure!(url.starts_with("postgres://rainsync:") && url.contains("@127.0.0.1:"));
    let db = persistence::connect(&url).await?;
    let owner: Uuid =
        sqlx::query_scalar("SELECT run_id FROM rainsync_retention_fixture_owner WHERE singleton")
            .fetch_one(&db)
            .await?;
    ensure!(owner == run);
    persistence::migrate(&db).await?;
    seed(&db).await?;
    let app = app(db.clone()).await?;
    let root = PathBuf::from(std::env::var("RAINSYNC_COMPUTE_OUTPUT_ROOT")?);
    ensure!(root.is_absolute() && !root.exists());
    let case = std::env::var("RAINSYNC_RETENTION_CASE")?;
    let recovery = case == "sql_after_files_retry" || case == "sql_after_attempts";
    let file_failure = case == "sql_after_files" || case == "sql_after_files_retry";
    let observation_path = PathBuf::from(std::env::var("RAINSYNC_RETENTION_OBSERVATION")?);
    if case == "not_directory" {
        std::fs::write(&root, b"owned root file")?;
    } else if case != "missing" {
        std::fs::create_dir(&root)?;
        for n in 10..=17 {
            if (file_failure && n != 12) || case == "sql_after_attempts" {
                continue;
            }
            let path = root.join(id(n).to_string()).join(id(n + 100).to_string());
            std::fs::create_dir_all(&path)?;
            std::fs::write(path.join("index.m3u8"), b"owned")?;
        }
        if case == "success" {
            let stale = root.join(id(10).to_string()).join(id(210).to_string());
            std::fs::create_dir_all(&stale)?;
            std::fs::write(stale.join("old"), b"old")?;
        }
        std::fs::write(root.join("unrelated"), b"untouched")?;
        if file_failure {
            sql(&db,"CREATE FUNCTION rainsync_retention_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned_file_delete_failure'; END $$; CREATE TRIGGER rainsync_retention_delete_failure BEFORE DELETE ON distributed_compute_files FOR EACH ROW EXECUTE FUNCTION rainsync_retention_delete_failure()").await?;
        }
    }
    if case == "sql_after_attempts" {
        // Only this owned fixture's final job DELETE is made to fail. Any preceding
        // attempt DELETE remains its original independent production statement.
        sql(&db, &format!("CREATE FUNCTION rainsync_retention_job_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='{}'::uuid THEN RAISE EXCEPTION 'owned_job_delete_failure'; END IF; RETURN OLD; END $$; CREATE TRIGGER rainsync_retention_job_delete_failure BEFORE DELETE ON distributed_compute_jobs FOR EACH ROW EXECUTE FUNCTION rainsync_retention_job_delete_failure()", id(11))).await?;
    }
    // A separate pool observes committed effects. It never wraps the production
    // sweep in a transaction, supplies receipts, or repairs missing metadata.
    let witness = if recovery {
        let witness = persistence::connect(&url).await?;
        let mut held_writer = db.acquire().await?;
        let writer_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *held_writer)
            .await?;
        let reader_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&witness)
            .await?;
        ensure!(
            writer_pid != reader_pid,
            "independent pool must use another backend"
        );
        println!("OWNED retention witness backend {reader_pid}; held writer {writer_pid}");
        drop(held_writer);
        Some(witness)
    } else {
        None
    };
    let before = if let Some(witness) = &witness {
        let before = observe(witness, &root, "before").await?;
        std::fs::write(
            observation_path.with_extension("before.json"),
            serde_json::to_vec_pretty(&before)?,
        )?;
        Some(before)
    } else {
        None
    };
    let result = super::cleanup(&app).await;
    let outcome = match &result {
        Ok(()) => "ok",
        Err(e) if case == "not_directory" => {
            ensure!(
                e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotADirectory)
            );
            "not_directory"
        }
        Err(e) if file_failure => {
            ensure!(e.to_string().contains("owned_file_delete_failure"));
            case.as_str()
        }
        Err(e) if case == "sql_after_attempts" => {
            ensure!(e.to_string().contains("owned_job_delete_failure"));
            "sql_after_attempts"
        }
        Err(e) => return Err(anyhow::anyhow!("unexpected cleanup: {e}")),
    };
    if recovery {
        let database_error = result
            .as_ref()
            .err()
            .and_then(|error| error.downcast_ref::<sqlx::Error>())
            .and_then(|error| error.as_database_error())
            .ok_or_else(|| {
                anyhow::anyhow!("recovery fault must be an actual SQLx database error")
            })?;
        ensure!(database_error.code().as_deref() == Some("P0001"));
    }
    ensure!((case == "missing" || case == "success") == result.is_ok());
    let jobs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM distributed_compute_jobs ORDER BY id")
        .fetch_all(&db)
        .await?;
    let expected = if case == "success" {
        vec![10, 12, 13, 14, 17]
    } else {
        (10..=17).collect()
    };
    ensure!(
        jobs == expected.into_iter().map(id).collect::<Vec<_>>(),
        "job retention mismatch: {jobs:?}"
    );
    let attempts: Vec<Uuid> =
        sqlx::query_scalar("SELECT job_id FROM distributed_compute_attempts ORDER BY job_id")
            .fetch_all(&db)
            .await?;
    let expected = if case == "success" || case == "sql_after_attempts" {
        vec![12, 13, 14]
    } else {
        vec![12, 13, 14, 15, 16]
    };
    ensure!(attempts == expected.into_iter().map(id).collect::<Vec<_>>());
    ensure!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM distributed_playback_bindings")
            .fetch_one(&db)
            .await?
            == 1
    );
    ensure!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM room_p2p_signals")
            .fetch_one(&db)
            .await?
            == 1
    );
    ensure!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM room_p2p_peers")
            .fetch_one(&db)
            .await?
            == 2
    );
    ensure!(
        !sqlx::query_scalar::<_, bool>("SELECT distributed_compute_room_drained($1)")
            .bind(id(4))
            .fetch_one(&db)
            .await?
    );
    if case == "success" {
        ensure!(
            root.join(id(10).to_string())
                .join(id(110).to_string())
                .join("index.m3u8")
                .exists()
        );
        ensure!(
            !root.join(id(12).to_string()).exists(),
            "unreaped ledger must not imply files were preserved"
        );
        ensure!(sqlx::query_scalar::<_,bool>("SELECT process_reaped_at IS NULL AND files_removed_at IS NULL FROM distributed_compute_attempts WHERE job_id=$1").bind(id(12)).fetch_one(&db).await?);
    }
    ensure!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM distributed_compute_jobs WHERE id BETWEEN $1 AND $2 AND status='cancelled' AND error='compute_authority_lost'").bind(id(11)).bind(id(16)).fetch_one(&db).await? == if case=="success" { 3 } else { 6 });
    let file_count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM distributed_compute_files")
        .fetch_one(&db)
        .await?;
    ensure!(
        file_count == if case == "success" { 2 } else { 8 },
        "metadata count: {file_count}"
    );
    if file_failure {
        ensure!(
            !root
                .join(id(12).to_string())
                .join(id(112).to_string())
                .exists()
        );
        ensure!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM distributed_compute_files WHERE job_id=$1"
            )
            .bind(id(12))
            .fetch_one(&db)
            .await?
                == 1,
            "filesystem delete must precede failing metadata statement"
        );
    }
    let first = observe(&db, &root, outcome).await?;
    if case == "success" || case == "missing" {
        super::cleanup(&app).await?;
        ensure!(
            first == observe(&db, &root, outcome).await?,
            "repeat changed settled sweep"
        );
    }
    let recorded = if let Some(witness) = witness {
        let before = before.expect("recovery observation prepared before sweep");
        let committed_first = observe(&witness, &root, outcome).await?;
        ensure!(
            first == committed_first,
            "failure effects must be visible to independent pool"
        );
        std::fs::write(
            observation_path.with_extension("first.json"),
            serde_json::to_vec_pretty(&committed_first)?,
        )?;
        let first_budget: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum(size_bytes),0)::bigint FROM distributed_compute_files",
        )
        .fetch_one(&witness)
        .await?;
        ensure!(
            first_budget == 40,
            "first failure must retain all eight metadata rows"
        );
        if file_failure {
            // The real directory and bytes existed before the first sweep. That
            // successful filesystem delete survives the metadata statement error.
            ensure!(
                !root
                    .join(id(12).to_string())
                    .join(id(112).to_string())
                    .exists()
            );
            ensure!(sqlx::query_scalar::<_, bool>("SELECT process_reaped_at IS NULL AND files_removed_at IS NULL FROM distributed_compute_attempts WHERE job_id=$1")
                .bind(id(12)).fetch_one(&witness).await?);
            sql(&db, "DROP TRIGGER rainsync_retention_delete_failure ON distributed_compute_files; DROP FUNCTION rainsync_retention_delete_failure()").await?;
        } else {
            // The failing jobs statement rolls back its own rows; successful
            // attempt pruning has already committed and must remain visible.
            ensure!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM distributed_compute_attempts WHERE job_id IN($1,$2)"
                )
                .bind(id(15))
                .bind(id(16))
                .fetch_one(&witness)
                .await?
                    == 0
            );
            ensure!(before["files"] == committed_first["files"]);
            sql(&db, "DROP TRIGGER rainsync_retention_job_delete_failure ON distributed_compute_jobs; DROP FUNCTION rainsync_retention_job_delete_failure()").await?;
        }
        // Remove only the fixture failure injection. Do not recreate generation
        // directories, adjust expiry, change authorization, or clear receipts.
        super::cleanup(&app).await?;
        let retry = observe(&witness, &root, "ok").await?;
        std::fs::write(
            observation_path.with_extension("retry.json"),
            serde_json::to_vec_pretty(&retry)?,
        )?;
        let jobs: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM distributed_compute_jobs ORDER BY id")
                .fetch_all(&witness)
                .await?;
        ensure!(
            jobs == vec![10, 12, 13, 14, 17]
                .into_iter()
                .map(id)
                .collect::<Vec<_>>()
        );
        let attempts: Vec<Uuid> =
            sqlx::query_scalar("SELECT job_id FROM distributed_compute_attempts ORDER BY job_id")
                .fetch_all(&witness)
                .await?;
        ensure!(attempts == vec![12, 13, 14].into_iter().map(id).collect::<Vec<_>>());
        let metadata_jobs: Vec<Uuid> =
            sqlx::query_scalar("SELECT job_id FROM distributed_compute_files ORDER BY job_id")
                .fetch_all(&witness)
                .await?;
        ensure!(
            metadata_jobs == jobs,
            "only final job deletion cascades the three removed metadata rows"
        );
        let retry_budget: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum(size_bytes),0)::bigint FROM distributed_compute_files",
        )
        .fetch_one(&witness)
        .await?;
        let retained_job12_bytes: i64 = sqlx::query_scalar("SELECT COALESCE(sum(size_bytes),0)::bigint FROM distributed_compute_files WHERE job_id=$1")
            .bind(id(12)).fetch_one(&witness).await?;
        ensure!(retry_budget == 25 && retained_job12_bytes == 5);
        ensure!(sqlx::query_scalar::<_, bool>("SELECT process_reaped_at IS NULL AND files_removed_at IS NULL FROM distributed_compute_attempts WHERE job_id=$1")
            .bind(id(12)).fetch_one(&witness).await?);
        ensure!(
            !sqlx::query_scalar::<_, bool>("SELECT distributed_compute_room_drained($1)")
                .bind(id(4))
                .fetch_one(&witness)
                .await?
        );
        ensure!(!root.join(id(12).to_string()).exists());
        ensure!(std::fs::read(root.join("unrelated"))?.as_slice() == b"untouched");
        if !file_failure {
            ensure!(committed_first["files"] == retry["files"]);
        }
        super::cleanup(&app).await?;
        let repeat = observe(&witness, &root, "ok").await?;
        std::fs::write(
            observation_path.with_extension("repeat.json"),
            serde_json::to_vec_pretty(&repeat)?,
        )?;
        ensure!(
            retry == repeat,
            "retry must settle without repairing the retained row"
        );
        witness.close().await;
        json!({"before":before,"first":committed_first,"retry":retry,"repeat":repeat,
            "metadata_budget":{"first_failure_bytes":first_budget,"retry_bytes":retry_budget,
                "retained_job12_bytes":retained_job12_bytes},
            "fault":case,"scope":"existing full production sweep; synthetic owner receipts; no physical drain proof"})
    } else {
        first
    };
    std::fs::write(&observation_path, serde_json::to_vec_pretty(&recorded)?)?;
    db.close().await;
    println!("\nPASS: owned retention {case}");
    Ok(())
}
