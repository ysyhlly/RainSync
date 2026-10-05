//! Real production-function checks on the runner's explicitly owned database.
//! The default mode uses synthetic ciphertext/graphs and a NeverStarted proof.
//! Explicit Linux native mode adds real capture using production DB permits.
//! Neither mode enables public HLS or reconstructs an opaque ownership proof.
#[cfg(target_os = "linux")]
#[path = "verify_static_hls_pending/runtime_capture.rs"]
mod runtime_capture;
use anyhow::{Context, Result, anyhow, ensure};
use media_core::static_hls::contracts::{graph::RootGraphStatement, input::FrozenInput};
use persistence::static_hls_pending::{
    self as pending, Admission, CatalogSnapshot, Existing, Freeze, PreparedParentInput,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::time::{Instant, sleep, timeout};
use uuid::Uuid;

const INPUT: &str = include_str!("../../media-core/src/static_hls/contracts/golden_input_v1.json");
const ROOT: &str = include_str!("../../media-core/src/static_hls/contracts/golden_root_v1.json");
const SQL_FIXTURE: &str = include_str!("../../../tests/sql/static_hls_pending_custody.sql");
const CAPTURE_BYTES: u64 = 134_217_728;

struct DisabledActivation;
impl persistence::static_hls::ActivationCheck for DisabledActivation {
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async { anyhow::bail!("fixture activation stays disabled") })
    }
}
struct LostAck {
    inner: Arc<dyn media_core::static_hls::CapturePermit>,
    calls: AtomicUsize,
    proof: Mutex<Option<Arc<media_core::static_hls::DisposalProof>>>,
}
impl media_core::static_hls::CapturePermit for LostAck {
    fn identity(&self) -> media_core::static_hls::CaptureOwnerIdentity {
        self.inner.identity()
    }
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        self.inner.check()
    }
    fn acknowledge_disposal(
        &self,
        proof: Arc<media_core::static_hls::DisposalProof>,
    ) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async move {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            {
                let mut original = self.proof.lock().unwrap();
                if let Some(saved) = original.as_ref() {
                    ensure!(
                        Arc::ptr_eq(saved, &proof),
                        "retry replaced the original opaque proof"
                    );
                } else {
                    *original = Some(proof.clone());
                }
            }
            self.inner.acknowledge_disposal(proof).await?;
            if call == 0 {
                anyhow::bail!("fixture lost acknowledgment after actual DB commit");
            }
            Ok(())
        })
    }
}
struct NoTransport;
impl media_core::static_hls::CaptureTransport for NoTransport {
    fn get<'a>(
        &'a self,
        _: &'a str,
    ) -> media_core::static_hls::CaptureFuture<'a, Box<dyn media_core::static_hls::CaptureBody>>
    {
        Box::pin(async { anyhow::bail!("refused owner must perform no source read") })
    }
}

struct Checks {
    path: PathBuf,
    run: Uuid,
    current: &'static str,
    passed: Vec<&'static str>,
    scanner_started: bool,
    physical_disposal: bool,
}
impl Checks {
    fn begin(&mut self, name: &'static str) -> Result<()> {
        self.current = name;
        self.save(false, None)
    }
    fn pass(&mut self) -> Result<()> {
        self.passed.push(self.current);
        println!("PASS {}", self.current);
        self.save(false, None)
    }
    fn save(&self, complete: bool, error: Option<String>) -> Result<()> {
        std::fs::write(
            &self.path,
            serde_json::to_vec_pretty(&json!({
                "schemaVersion":1,"runId":self.run,"scope":if self.scanner_started {"production-pending-transactions-and-actual-native-capture"} else {"production-rust-database-functions"},
                "complete":complete,"current":self.current,"passed":self.passed,"error":error,
                "scannerOrProcessStarted":self.scanner_started,"physicalDisposalProven":self.physical_disposal,
                "publicHlsActivated":false
            }))?,
        )?;
        Ok(())
    }
}

struct Fixture {
    user: Uuid,
    room: Uuid,
    source: Uuid,
    media: Uuid,
    membership: Uuid,
    viewer: Uuid,
    worker: Uuid,
    database: Uuid,
    login: String,
}
impl Fixture {
    async fn create(pool: &PgPool) -> Result<Self> {
        let mut f = Self {
            user: Uuid::new_v4(),
            room: Uuid::new_v4(),
            source: Uuid::new_v4(),
            media: Uuid::new_v4(),
            membership: Uuid::nil(),
            viewer: Uuid::new_v4(),
            worker: Uuid::new_v4(),
            database: Uuid::nil(),
            login: hex::encode(Sha256::digest(Uuid::new_v4().as_bytes())),
        };
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO users(id,username,password_hash) VALUES($1,$2,'synthetic-no-auth')",
        )
        .bind(f.user)
        .bind(format!("pending_rust_{}", f.user))
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')")
            .bind(&f.login).bind(f.user).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'pending Rust fixture',$2)")
            .bind(f.room)
            .bind(f.user)
            .execute(&mut *tx)
            .await?;
        f.membership = sqlx::query_scalar(
            "INSERT INTO room_members(room_id,user_id) VALUES($1,$2) RETURNING membership_epoch",
        )
        .bind(f.room)
        .bind(f.user)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision) VALUES($1,'synthetic','http','synthetic-source',1)")
            .bind(f.source).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES($1,$2,'synthetic','https://source.example/vod.m3u8?a=1&b=2','version-1')")
            .bind(f.media).bind(f.source).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO room_snapshots(room_id,state) VALUES($1,$2)")
            .bind(f.room)
            .bind(json!({"media_id":f.media,"media_generation":0}))
            .execute(&mut *tx)
            .await?;
        f.database =
            sqlx::query_scalar("SELECT id FROM static_hls_database_binding WHERE singleton")
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        Ok(f)
    }
    async fn catalog(&self, pool: &PgPool) -> Result<CatalogSnapshot> {
        let row = sqlx::query("SELECT m.id AS media_id,m.source_id,m.resource,m.source_version,m.preview_generation,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1")
            .bind(self.media).fetch_one(pool).await?;
        Ok(CatalogSnapshot::from_row(&row))
    }
    async fn value(
        &self,
        pool: &PgPool,
        viewer: Uuid,
        generation: i64,
        prepare_ms: i64,
    ) -> Result<Value> {
        let admitted = database_ms(pool).await?;
        let mut value: Value = serde_json::from_str(INPUT)?;
        for (field, id) in [
            ("operation_id", Uuid::new_v4()),
            ("session_id", Uuid::new_v4()),
            ("request_owner_epoch", Uuid::new_v4()),
            ("user_id", self.user),
            ("room_id", self.room),
            ("auth_membership_epoch", self.membership),
            ("media_id", self.media),
            ("viewer_id", viewer),
            ("worker_instance", self.worker),
            ("database", self.database),
        ] {
            value[field] = json!(id);
        }
        value["auth_login_hash"] = json!(self.login);
        value["request_sha256"] = json!(hex::encode(Sha256::digest(Uuid::new_v4().as_bytes())));
        value["plan_generation"] = json!(generation);
        value["root_admitted_at_ms"] = json!(admitted);
        value["prepare_started_at_ms"] = json!(admitted);
        value["root_hard_expires_at_ms"] = json!(admitted + 1_800_000);
        value["prepare_expires_at_ms"] = json!(admitted + prepare_ms);
        value["source"]["source_id"] = json!(self.source);
        Ok(value)
    }
    async fn prepared(&self, pool: &PgPool, value: &Value) -> Result<PreparedParentInput> {
        PreparedParentInput::seal(
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(value)?)?,
            self.catalog(pool).await?,
            |_| Ok(format!("synthetic-cipher-{}", Uuid::new_v4())),
        )
    }
    async fn state(&self, pool: &PgPool) -> Result<Value> {
        Ok(sqlx::query_scalar("SELECT jsonb_build_object(\
            'requests',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY session_id),'[]') FROM playback_requests r WHERE user_id=$1),\
            'preparations',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY session_id),'[]') FROM playback_preparations p WHERE user_id=$1),\
            'viewers',(SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY viewer_id),'[]') FROM playback_viewer_plans v WHERE user_id=$1),\
            'sessions',(SELECT count(*) FROM playback_sessions WHERE user_id=$1),\
            'captures',(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM static_hls_captures c WHERE user_id=$1),\
            'budget',(SELECT revision FROM cache_budget WHERE singleton),\
            'reservations',(SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY job_id),'[]') FROM cache_write_reservations w))")
            .bind(self.user).fetch_one(pool).await?)
    }
}
async fn database_ms(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(pool)
            .await?,
    )
}
fn id(value: &Value, field: &str) -> Result<Uuid> {
    Ok(Uuid::parse_str(
        value[field].as_str().context("fixture ID")?,
    )?)
}
fn expected_error<T>(value: Result<T>, code: &str) -> Result<()> {
    let error = value
        .err()
        .ok_or_else(|| anyhow!("expected rejection {code}"))?;
    ensure!(
        format!("{error:#}").contains(code),
        "expected {code}, received {error:#}"
    );
    Ok(())
}
async fn fresh(pool: &PgPool) -> Result<(Fixture, Value, PreparedParentInput)> {
    let f = Fixture::create(pool).await?;
    let value = f.value(pool, f.viewer, 1, 45_000).await?;
    let prepared = f.prepared(pool, &value).await?;
    Ok((f, value, prepared))
}
async fn freeze(pool: &PgPool, key: Uuid, input: &PreparedParentInput) -> Result<()> {
    ensure!(
        matches!(pending::freeze(pool, key, input, 16).await?, Freeze::Frozen),
        "new input was not frozen"
    );
    Ok(())
}
async fn revision(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton")
            .fetch_one(pool)
            .await?,
    )
}
async fn wait_for_room_lock(pool: &PgPool, holder_pid: i32) -> Result<()> {
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND a.application_name=current_setting('application_name') AND a.wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(a.pid)))")
            .bind(holder_pid).fetch_one(pool).await?;
        if waiting {
            return Ok(());
        }
        ensure!(
            Instant::now() < end,
            "freeze never reached the original room lock"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

async fn run(pool: &PgPool, checks: &mut Checks) -> Result<()> {
    checks.begin("fresh_freeze_is_one_bound_request_and_preparation_without_grant")?;
    let (f, v, p) = fresh(pool).await?;
    let key = Uuid::new_v4();
    freeze(pool, key, &p).await?;
    let state = f.state(pool).await?;
    ensure!(
        state["requests"].as_array().unwrap().len() == 1
            && state["preparations"].as_array().unwrap().len() == 1
            && state["sessions"] == 0
    );
    ensure!(state["requests"][0]["static_hls_input_sha256"] == p.input_sha256());
    checks.pass()?;

    checks.begin("duplicate_key_preserves_original_ciphertext_owner_deadlines_and_viewer")?;
    let resealed = f.prepared(pool, &v).await?;
    ensure!(matches!(
        pending::freeze(pool, key, &resealed, 16).await?,
        Freeze::Existing(Existing::InProgress)
    ));
    ensure!(
        f.state(pool).await? == state,
        "duplicate input replaced immutable state"
    );
    checks.pass()?;

    checks.begin("request_hash_collision_rejects_before_side_effects")?;
    let mut conflict = v.clone();
    conflict["request_sha256"] = json!("d".repeat(64));
    let prepared = f.prepared(pool, &conflict).await?;
    expected_error(
        pending::freeze(pool, key, &prepared, 16).await,
        "playback_request_conflict",
    )?;
    ensure!(f.state(pool).await? == state);
    checks.pass()?;

    checks.begin("same_key_cross_login_rejects_before_side_effects")?;
    let other_login = "e".repeat(64);
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')")
        .bind(&other_login).bind(f.user).execute(pool).await?;
    let mut other = v.clone();
    other["auth_login_hash"] = json!(other_login);
    let other_prepared = f.prepared(pool, &other).await?;
    expected_error(
        pending::freeze(pool, key, &other_prepared, 16).await,
        "static_hls_exact_login_required",
    )?;
    ensure!(f.state(pool).await? == state);
    checks.pass()?;

    checks.begin("retryable_terminal_error_is_stable_without_reowning")?;
    let mut tx = pool.begin().await?;
    ensure!(
        pending::terminalize_locked(&mut tx, id(&v, "session_id")?, 502, "upstream_failed").await?
    );
    tx.commit().await?;
    let failed = f.state(pool).await?;
    ensure!(
        matches!(pending::freeze(pool,key,&resealed,16).await?,Freeze::Existing(Existing::Failed {status:502,code}) if code=="upstream_failed")
    );
    ensure!(f.state(pool).await? == failed);
    checks.pass()?;

    checks.begin("same_login_newer_generation_retires_old_pending_intent_atomically")?;
    let (f, v, p) = fresh(pool).await?;
    freeze(pool, Uuid::new_v4(), &p).await?;
    let newer = f.value(pool, f.viewer, 2, 45_000).await?;
    let new_input = f.prepared(pool, &newer).await?;
    freeze(pool, Uuid::new_v4(), &new_input).await?;
    let state = f.state(pool).await?;
    ensure!(
        state["viewers"][0]["plan_generation"] == 2
            && state["requests"].as_array().unwrap().len() == 2
    );
    let old_status: String =
        sqlx::query_scalar("SELECT status FROM playback_requests WHERE session_id=$1")
            .bind(id(&v, "session_id")?)
            .fetch_one(pool)
            .await?;
    ensure!(old_status == "failed");
    checks.pass()?;

    checks.begin("new_key_cross_login_cannot_advance_existing_viewer")?;
    let other_login = "f".repeat(64);
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')")
        .bind(&other_login).bind(f.user).execute(pool).await?;
    let mut value = f.value(pool, f.viewer, 3, 45_000).await?;
    value["auth_login_hash"] = json!(other_login);
    let input = f.prepared(pool, &value).await?;
    expected_error(
        pending::freeze(pool, Uuid::new_v4(), &input, 16).await,
        "stale_playback_plan",
    )?;
    ensure!(f.state(pool).await? == state);
    checks.pass()?;

    checks.begin("viewer_limit_1024_rejects_without_request_or_preparation")?;
    let (f, _, p) = fresh(pool).await?;
    sqlx::query("INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash) SELECT $1,$2,gen_random_uuid(),1,$3 FROM generate_series(1,1024)")
        .bind(f.user).bind(f.room).bind(&f.login).execute(pool).await?;
    let before = f.state(pool).await?;
    expected_error(
        pending::freeze(pool, Uuid::new_v4(), &p, 16).await,
        "playback_viewer_limit_exceeded",
    )?;
    ensure!(f.state(pool).await? == before);
    checks.pass()?;

    checks.begin("session_quota_rolls_back_viewer_request_and_preparation")?;
    let (f, _, p) = fresh(pool).await?;
    ensure!(matches!(
        pending::freeze(pool, Uuid::new_v4(), &p, 1).await?,
        Freeze::Frozen
    ));
    let v = f.value(pool, Uuid::new_v4(), 1, 45_000).await?;
    let p = f.prepared(pool, &v).await?;
    let before = f.state(pool).await?;
    expected_error(
        pending::freeze(pool, Uuid::new_v4(), &p, 1).await,
        "too_many_playback_sessions",
    )?;
    ensure!(f.state(pool).await? == before);
    checks.pass()?;

    for (label, statement, error) in [
        (
            "freeze_source_ciphertext_revision_change",
            "UPDATE sources SET config_encrypted='changed' WHERE id=$1",
            "static_hls_pending_authority_required",
        ),
        (
            "freeze_source_kind_change",
            "UPDATE sources SET kind='local' WHERE id=$1",
            "static_hls_pending_authority_required",
        ),
        (
            "freeze_media_resource_change",
            "UPDATE media_items SET resource='https://source.example/changed.m3u8' WHERE id=$1",
            "static_hls_pending_authority_required",
        ),
        (
            "freeze_media_version_change",
            "UPDATE media_items SET source_version='version-2' WHERE id=$1",
            "static_hls_pending_authority_required",
        ),
        (
            "freeze_media_generation_change",
            "UPDATE media_items SET preview_generation=preview_generation+1 WHERE id=$1",
            "static_hls_pending_authority_required",
        ),
    ] {
        checks.begin(label)?;
        let (f, _, p) = fresh(pool).await?;
        let before = f.state(pool).await?;
        sqlx::query(statement)
            .bind(if statement.contains("UPDATE sources") {
                f.source
            } else {
                f.media
            })
            .execute(pool)
            .await?;
        expected_error(pending::freeze(pool, Uuid::new_v4(), &p, 16).await, error)?;
        ensure!(f.state(pool).await? == before);
        checks.pass()?;
    }

    checks.begin("shortened_original_login_rejects_and_rolls_back_all_freeze_writes")?;
    let (f, _, p) = fresh(pool).await?;
    let before = f.state(pool).await?;
    sqlx::query(
        "UPDATE sessions SET expires_at=clock_timestamp()+interval '5 minutes' WHERE token_hash=$1",
    )
    .bind(&f.login)
    .execute(pool)
    .await?;
    expected_error(
        pending::freeze(pool, Uuid::new_v4(), &p, 16).await,
        "static_hls_pending_authority_required",
    )?;
    ensure!(f.state(pool).await? == before);
    checks.pass()?;

    checks.begin("contended_room_lock_consumes_original_preparation_deadline")?;
    let f = Fixture::create(pool).await?;
    let v = f.value(pool, f.viewer, 1, 1_200).await?;
    let p = f.prepared(pool, &v).await?;
    let before = f.state(pool).await?;
    let mut lock = pool.begin().await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(f.room)
        .fetch_one(&mut *lock)
        .await?;
    let holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *lock)
        .await?;
    let other_pool = pool.clone();
    let waiter =
        tokio::spawn(async move { pending::freeze(&other_pool, Uuid::new_v4(), &p, 16).await });
    wait_for_room_lock(pool, holder_pid).await?;
    while database_ms(pool).await? < v["prepare_expires_at_ms"].as_i64().unwrap() {
        sleep(Duration::from_millis(20)).await;
    }
    lock.rollback().await?;
    expected_error(
        timeout(Duration::from_secs(3), waiter).await??,
        "static_hls_pending_freeze_unconfirmed",
    )?;
    ensure!(f.state(pool).await? == before);
    checks.pass()?;

    checks.begin("source_change_during_room_wait_is_rechecked_before_any_freeze_write")?;
    let (f, _, p) = fresh(pool).await?;
    let before = f.state(pool).await?;
    let mut lock = pool.begin().await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(f.room)
        .fetch_one(&mut *lock)
        .await?;
    let holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *lock)
        .await?;
    let other_pool = pool.clone();
    let waiter =
        tokio::spawn(async move { pending::freeze(&other_pool, Uuid::new_v4(), &p, 16).await });
    wait_for_room_lock(pool, holder_pid).await?;
    sqlx::query("UPDATE media_items SET resource='https://source.example/new.m3u8' WHERE id=$1")
        .bind(f.media)
        .execute(pool)
        .await?;
    lock.rollback().await?;
    expected_error(
        timeout(Duration::from_secs(3), waiter).await??,
        "static_hls_pending_authority_required",
    )?;
    ensure!(f.state(pool).await? == before);
    checks.pass()?;

    checks.begin("real_pruner_retains_dependency_then_deletes_never_admitted_terminal_history")?;
    // Historical SQL-only positive preparation metadata; no runtime closure is
    // claimed. All deletions below invoke the actual Rust pruner.
    let end = SQL_FIXTURE
        .rfind("DO $$ DECLARE changed bigint; BEGIN")
        .context("fixture prune boundary")?;
    sqlx::raw_sql(&format!("{}COMMIT;", &SQL_FIXTURE[..end]))
        .execute(pool)
        .await?;
    let historical = Uuid::parse_str("f1000000-0000-0000-0000-000000000062")?;
    sqlx::query("INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES($1,$2,0,1,'media_job')")
        .bind(historical).bind(Uuid::new_v4()).execute(pool).await?;
    ensure!(!pending::prune(pool, historical).await?);
    sqlx::query("DELETE FROM cache_write_reservations WHERE job_id=$1 AND purpose='media_job'")
        .bind(historical)
        .execute(pool)
        .await?;
    ensure!(pending::prune(pool, historical).await?);
    ensure!(!pending::prune(pool, historical).await?);
    checks.pass()?;

    checks.begin("admission_revision_headroom_and_injected_fault_do_not_mint_or_commit")?;
    let (f, v, p) = fresh(pool).await?;
    freeze(pool, Uuid::new_v4(), &p).await?;
    let before = f.state(pool).await?;
    let rev = revision(pool).await?;
    ensure!(matches!(
        pending::admit(pool, &p, Uuid::new_v4(), rev - 1, u64::MAX).await?,
        Admission::Changed
    ));
    ensure!(matches!(
        pending::admit(pool, &p, Uuid::new_v4(), rev, CAPTURE_BYTES - 1).await?,
        Admission::Full
    ));
    ensure!(f.state(pool).await? == before);
    sqlx::raw_sql("CREATE FUNCTION pending_fixture_reservation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.purpose='static_hls_capture' THEN RAISE EXCEPTION 'pending_fixture_reservation_fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER pending_fixture_fault BEFORE INSERT ON cache_write_reservations FOR EACH ROW EXECUTE FUNCTION pending_fixture_reservation_fault();")
        .execute(pool).await?;
    let failure = pending::admit(pool, &p, Uuid::new_v4(), rev, u64::MAX).await;
    sqlx::raw_sql("DROP TRIGGER pending_fixture_fault ON cache_write_reservations; DROP FUNCTION pending_fixture_reservation_fault();").execute(pool).await?;
    expected_error(failure, "pending_fixture_reservation_fault")?;
    ensure!(
        f.state(pool).await? == before,
        "partial capture or budget write survived rollback"
    );
    checks.pass()?;

    checks.begin("real_admission_commits_exact_capture_reservation_and_budget")?;
    let owner = Uuid::new_v4();
    let Admission::Acquired(permit) = pending::admit(pool, &p, owner, rev, u64::MAX).await? else {
        return Err(anyhow!("capture was not acquired"));
    };
    ensure!(
        permit.identity().capture_id == id(&v, "operation_id")?.to_string()
            && permit.identity().owner_id == owner.to_string()
    );
    ensure!(revision(pool).await? == rev + 1);
    let bytes: i64 = sqlx::query_scalar("SELECT bytes FROM cache_write_reservations WHERE job_id=$1 AND owner_id=$2 AND purpose='static_hls_capture'")
        .bind(id(&v,"operation_id")?).bind(owner).fetch_one(pool).await?;
    ensure!(bytes == CAPTURE_BYTES as i64);
    ensure!(matches!(
        pending::admit(pool, &p, Uuid::new_v4(), rev + 1, u64::MAX).await?,
        Admission::Full
    ));
    checks.pass()?;

    checks
        .begin("verification_consumes_parent_binding_then_commits_inventory_once_without_budget")?;
    let mut graph: Value = serde_json::from_str(ROOT)?;
    let wrong = RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&graph)?)?;
    ensure!(
        pending::verify(pool, &permit, &wrong, |_| Ok("synthetic-root".into()))
            .await
            .is_err()
    );
    graph["parent_input_sha256"] = json!(p.input_sha256());
    let root = RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&graph)?)?;
    let mut budget = pool.begin().await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .fetch_one(&mut *budget)
        .await?;
    let verified = timeout(
        Duration::from_secs(2),
        pending::verify(pool, &permit, &root, |_| Ok("synthetic-root".into())),
    )
    .await;
    budget.rollback().await?;
    ensure!(verified??, "verification did not commit");
    ensure!(!pending::verify(pool, &permit, &root, |_| Ok("replacement-root".into())).await?);
    checks.pass()?;

    checks.begin("cancel_is_budget_free_stable_and_retains_unknown_custody_and_capacity")?;
    let mut budget = pool.begin().await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .fetch_one(&mut *budget)
        .await?;
    let cancelled = timeout(
        Duration::from_secs(2),
        pending::cancel(pool, &permit, 502, "upstream_failed"),
    )
    .await;
    budget.rollback().await?;
    cancelled??;
    pending::cancel(pool, &permit, 410, "playback_request_cancelled").await?;
    ensure!(matches!(
        pending::existing(
            pool,
            f.user,
            key_for(pool, id(&v, "session_id")?).await?,
            v["request_sha256"].as_str().unwrap(),
            &f.login
        )
        .await?,
        Some(Existing::RetainedCustody)
    ));
    let code: String =
        sqlx::query_scalar("SELECT error_code FROM playback_requests WHERE session_id=$1")
            .bind(id(&v, "session_id")?)
            .fetch_one(pool)
            .await?;
    ensure!(code == "upstream_failed");
    ensure!(!pending::prune(pool, id(&v, "session_id")?).await?);
    ensure!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM cache_write_reservations WHERE job_id=$1"
        )
        .bind(id(&v, "operation_id")?)
        .fetch_one(pool)
        .await?
            == 1
    );
    checks.pass()?;

    checks.begin("revoked_login_cannot_admit_new_capture")?;
    let (f, _, p) = fresh(pool).await?;
    freeze(pool, Uuid::new_v4(), &p).await?;
    let before = f.state(pool).await?;
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(&f.login)
        .execute(pool)
        .await?;
    ensure!(matches!(
        pending::admit(pool, &p, Uuid::new_v4(), revision(pool).await?, u64::MAX).await?,
        Admission::Stale
    ));
    ensure!(f.state(pool).await? == before);
    checks.pass()?;
    checks.begin("original_runtime_proof_survives_lost_db_ack_and_retry_does_not_release_twice")?;
    use media_core::static_hls::DisposalState;
    let capture_id = Uuid::parse_str(&permit.identity().capture_id)?;
    let durable = Arc::new(pending::PersistedPendingCapturePermit::new(
        pool.clone(),
        permit,
        Arc::new(DisabledActivation),
    ));
    let losing = Arc::new(LostAck {
        inner: durable,
        calls: AtomicUsize::new(0),
        proof: Mutex::new(None),
    });
    let handle = media_core::static_hls::start_capture(
        losing.clone(),
        Arc::new(NoTransport),
        media_core::static_hls::CaptureOptions {
            cache_root: PathBuf::from("must-not-create-fixture-files"),
            manifest_url: "https://fixture.invalid/not-read.m3u8".into(),
            selected_audio: None,
            expected_inventory: None,
        },
    )?;
    let control = handle.control()?;
    let duplicate = media_core::static_hls::start_capture(
        losing.clone(),
        Arc::new(NoTransport),
        media_core::static_hls::CaptureOptions {
            cache_root: PathBuf::from("must-not-create-fixture-files"),
            manifest_url: "https://fixture.invalid/not-read.m3u8".into(),
            selected_audio: None,
            expected_inventory: None,
        },
    )
    .err()
    .ok_or_else(|| anyhow!("cloned admission started a second owner"))?;
    ensure!(duplicate.to_string() == "static_hls_owner_already_exists");
    ensure!(handle.wait().await.is_err());
    ensure!(
        control.disposal_state() == DisposalState::Unresolved && control.disposal_retry_available()
    );
    let committed_revision = revision(pool).await?;
    let retained: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cache_write_reservations WHERE job_id=$1")
            .bind(capture_id)
            .fetch_one(pool)
            .await?;
    ensure!(
        retained == 0,
        "first acknowledgment did not actually commit"
    );
    ensure!(control.retry_disposal().await? == DisposalState::Disposed);
    ensure!(control.retry_disposal().await? == DisposalState::Disposed);
    ensure!(
        revision(pool).await? == committed_revision,
        "idempotent acknowledgment advanced budget again"
    );
    ensure!(losing.calls.load(Ordering::SeqCst) == 2);
    checks.pass()?;
    #[cfg(target_os = "linux")]
    if std::env::var("RAINSYNC_OWNED_TEST_NATIVE").as_deref() == Ok("1") {
        runtime_capture::run(pool, checks).await?;
    }
    Ok(())
}
async fn key_for(pool: &PgPool, session: Uuid) -> Result<Uuid> {
    Ok(
        sqlx::query_scalar("SELECT idempotency_key FROM playback_requests WHERE session_id=$1")
            .bind(session)
            .fetch_one(pool)
            .await?,
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    let run_id = Uuid::parse_str(&std::env::var("RAINSYNC_OWNED_TEST_RUN_ID")?)?;
    let url = std::env::var("RAINSYNC_OWNED_TEST_DATABASE_URL")?;
    ensure!(
        url.starts_with("postgresql://postgres@127.0.0.1:"),
        "owned loopback PostgreSQL required"
    );
    let mut checks = Checks {
        path: std::env::var("RAINSYNC_OWNED_TEST_REPORT")?.into(),
        run: run_id,
        current: "owned_database_binding",
        passed: vec![],
        scanner_started: false,
        physical_disposal: false,
    };
    let application = format!("rs_pending_rust_{}", run_id.simple());
    let pool = PgPoolOptions::new().max_connections(8).acquire_timeout(Duration::from_secs(3))
        .after_connect(move |connection,_| { let application=application.clone(); Box::pin(async move {
            sqlx::query("SELECT set_config('application_name',$1,false),set_config('rainsync.static_hls_reader','1',false)")
                .bind(application).execute(connection).await?; Ok(())
        }) }).connect(&url).await?;
    let name: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&pool)
        .await?;
    ensure!(
        name == format!("rainsync_pending_{}", run_id.simple()),
        "owned database name mismatch"
    );
    let binding: Uuid =
        sqlx::query_scalar("SELECT run_id FROM rainsync_owned_test_binding WHERE singleton")
            .fetch_one(&pool)
            .await?;
    ensure!(binding == run_id, "owned database run binding mismatch");
    let result = match timeout(Duration::from_secs(90), run(&pool, &mut checks)).await {
        Ok(result) => result,
        Err(error) => Err(error.into()),
    };
    let process_result = media_core::child_process::shutdown().await;
    let result = match (result, process_result) {
        (Err(error), Err(drain)) => Err(anyhow!("{error:#}; process shutdown: {drain}")),
        (result, drain) => result.and(drain.map_err(Into::into)),
    };
    pool.close().await;
    checks.save(
        result.is_ok(),
        result.as_ref().err().map(|e| format!("{e:#}")),
    )?;
    result
}
