//! Direct production settlement on a full migrated owned PostgreSQL database.
//! Synthetic NULL-principal/NULL-room playback rows; no playback authorization or publication claim.
use super::settlement::OriginalAttempt;
use crate::{child_process::Scope, output_decode::Gate, readiness};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);
impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("capture lock"))?
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn logs(capture: &Capture) -> String {
    String::from_utf8(capture.0.lock().unwrap().clone()).unwrap()
}
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
async fn sql(db: &PgPool, statement: &str) -> Result<()> {
    sqlx::raw_sql(statement).execute(db).await?;
    Ok(())
}
async fn seed(db: &PgPool, n: u128) -> Result<persistence::media_jobs::Claim> {
    let claim = persistence::media_jobs::Claim {
        id: id(n),
        owner: id(n + 1),
        attempt: 1,
        spec: json!({}),
    };
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}','2100-01-01')").bind(claim.id).bind(claim.id.to_string()).execute(db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,owner_id,attempt,lease_until,available_at) VALUES($1,$1,'running','{}',$2,1,'2100-01-01','2000-01-01')").bind(claim.id).bind(claim.owner).execute(db).await?;
    sqlx::query("INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir,validation_version,cleanup_after) VALUES($1,1,$2,'writing',$3,3,'2000-01-01')").bind(claim.id).bind(claim.owner).bind(claim.id.to_string()).execute(db).await?;
    sqlx::query("INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id) VALUES($1,$2,'job',$2,1,$3)").bind(id(n+2)).bind(claim.id).bind(claim.owner).execute(db).await?;
    let ticket = persistence::cache_budget::snapshot(db).await?;
    ensure!(
        persistence::cache_budget::reserve(db, &claim, ticket, 60, 1024).await?
            == persistence::cache_budget::Admission::Reserved
    );
    Ok(claim)
}
async fn observe(db: &PgPool, runtime: &readiness::Runtime) -> Result<Value> {
    let mut tables = serde_json::Map::new();
    for table in [
        "playback_sessions",
        "media_jobs",
        "media_outputs",
        "media_executions",
        "cache_write_reservations",
        "cache_budget",
    ] {
        let query = format!(
            "SELECT COALESCE(jsonb_agg(payload ORDER BY payload::text),'[]'::jsonb) FROM (SELECT to_jsonb(t) AS payload FROM {table} t) q"
        );
        tables.insert(
            table.into(),
            sqlx::query_scalar::<_, Value>(&query).fetch_one(db).await?,
        );
    }
    Ok(json!({"tables":tables,"readiness":runtime.snapshot()}))
}
async fn retained(db: &PgPool, job: Uuid) -> Result<(bool, i64)> {
    let reaped: bool =
        sqlx::query_scalar("SELECT reaped_at IS NOT NULL FROM media_executions WHERE job_id=$1")
            .bind(job)
            .fetch_one(db)
            .await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cache_write_reservations WHERE job_id=$1")
            .bind(job)
            .fetch_one(db)
            .await?;
    Ok((reaped, count))
}

#[tokio::test]
#[ignore = "requires tests/worker-settlement-native.mjs full-migration owned PostgreSQL coordinator"]
async fn owned_settlement_contract() -> Result<()> {
    let result = contract_inner().await;
    let cleanup =
        tokio::time::timeout(Duration::from_secs(10), crate::child_process::shutdown()).await;
    match (result, cleanup) {
        (Ok(()), Ok(Ok(()))) => {
            println!("\nPASS: owned settlement registry shutdown");
            Ok(())
        }
        (Err(error), Ok(Ok(()))) => Err(error),
        (result, cleanup) => Err(anyhow::anyhow!(
            "owned settlement failed or managed cleanup unconfirmed: result={result:?}, cleanup={cleanup:?}"
        )),
    }
}

async fn contract_inner() -> Result<()> {
    ensure!(cfg!(target_os = "linux"));
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST")? == "1");
    ensure!(std::env::var_os("DATABASE_URL").is_none());
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_SETTLEMENT_RUN_ID")?)?;
    let url = std::env::var("RAINSYNC_SETTLEMENT_DATABASE_URL")?;
    ensure!(
        url == std::env::var("RAINSYNC_SETTLEMENT_EXPECTED_DATABASE_URL")?
            && url.starts_with("postgres://rainsync:")
            && url.contains("@127.0.0.1:")
    );
    let db = persistence::connect(&url).await?;
    let owner: Uuid =
        sqlx::query_scalar("SELECT run_id FROM rainsync_settlement_fixture_owner WHERE singleton")
            .fetch_one(&db)
            .await?;
    ensure!(owner == run);
    let name: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&db)
        .await?;
    ensure!(name == format!("rainsync_{}", run.simple()));
    persistence::migrate(&db).await?;
    let capture = Capture(Arc::new(Mutex::new(Vec::new())));
    let writer = capture.clone();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || writer.clone())
            .finish(),
    )?;
    let root = PathBuf::from(std::env::var("RAINSYNC_SETTLEMENT_FILES")?);
    ensure!(root.is_absolute() && !root.exists());
    std::fs::create_dir(&root)?;
    let mut cases = Vec::new();
    for (offset, case) in [
        (100, "ack_raise_recover"),
        (200, "ack_zero_rows"),
        (300, "release_failure_ignored"),
    ] {
        let claim = seed(&db, offset).await?;
        let scope = Scope::new();
        let decoder = Gate::default();
        let runtime = readiness::Runtime::default();
        let mut writer_stopped = true;
        let before = observe(&db, &runtime).await?;
        let warning_before = logs(&capture)
            .matches("media execution drain acknowledgement retry")
            .count();
        let fault = if case == "ack_raise_recover" {
            "RAISE EXCEPTION 'owned_settlement_ack_fault';"
        } else {
            "RETURN NULL;"
        };
        if case != "release_failure_ignored" {
            sql(&db,&format!("CREATE FUNCTION owned_settlement_ack_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id='{}' AND NEW.reaped_at IS NOT NULL THEN {fault} END IF; RETURN NEW; END $$; CREATE TRIGGER owned_settlement_ack_fault BEFORE UPDATE ON media_executions FOR EACH ROW EXECUTE FUNCTION owned_settlement_ack_fault()",claim.id)).await?;
        } else {
            sql(&db,&format!("CREATE FUNCTION owned_settlement_release_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.job_id='{}' THEN RAISE EXCEPTION 'owned_settlement_release_fault'; END IF; RETURN OLD; END $$; CREATE TRIGGER owned_settlement_release_fault BEFORE DELETE ON cache_write_reservations FOR EACH ROW EXECUTE FUNCTION owned_settlement_release_fault()",claim.id)).await?;
        }
        let mut child = None;
        let mut child_pid = None;
        if case == "ack_raise_recover" {
            let pid_file = root.join("managed-child.pid");
            let spawned = scope
                .run(async {
                    let mut command = tokio::process::Command::new("/bin/sh");
                    command
                        .args([
                            "-c",
                            "printf '%s\\n' \"$$\" > \"$1\"; exec /bin/sleep 120",
                            "owned-settlement",
                        ])
                        .arg(&pid_file)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null());
                    crate::child_process::spawn(command)
                })
                .await?;
            child = Some(spawned);
            child_pid = Some(
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                            break pid.trim().parse::<u32>();
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await??,
            );
        }
        let mut blocked = None;
        if case == "ack_raise_recover" {
            let settling = OriginalAttempt::from_parts(
                &scope,
                &decoder,
                Some((claim.id, claim.owner, claim.attempt)),
                &mut writer_stopped,
            )
            .settle(&db, &runtime);
            let unblocking = async {
                tokio::time::timeout(Duration::from_secs(10), async {
                    while logs(&capture)
                        .matches("media execution drain acknowledgement retry")
                        .count()
                        == warning_before
                    {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await?;
                ensure!(retained(&db, claim.id).await? == (false, 1));
                ensure!(runtime.snapshot().checks["resource_drain"] == readiness::Outcome::Failed);
                ensure!(child.as_mut().unwrap().try_wait()?.is_some());
                ensure!(!PathBuf::from(format!("/proc/{}", child_pid.unwrap())).exists());
                blocked = Some(observe(&db, &runtime).await?);
                sql(&db,"DROP TRIGGER owned_settlement_ack_fault ON media_executions; DROP FUNCTION owned_settlement_ack_fault()").await?;
                Ok::<_, anyhow::Error>(())
            };
            let ((), result) = tokio::time::timeout(Duration::from_secs(20), async {
                tokio::join!(settling, unblocking)
            })
            .await?;
            result?;
            ensure!(retained(&db, claim.id).await? == (true, 0));
        } else {
            tokio::time::timeout(
                Duration::from_secs(10),
                OriginalAttempt::from_parts(
                    &scope,
                    &decoder,
                    Some((claim.id, claim.owner, claim.attempt)),
                    &mut writer_stopped,
                )
                .settle(&db, &runtime),
            )
            .await?;
            let expected = if case == "ack_zero_rows" {
                (false, 1)
            } else {
                (true, 1)
            };
            ensure!(retained(&db, claim.id).await? == expected);
            ensure!(
                logs(&capture)
                    .matches("media execution drain acknowledgement retry")
                    .count()
                    == warning_before
            );
            let drop_sql = if case == "ack_zero_rows" {
                "DROP TRIGGER owned_settlement_ack_fault ON media_executions; DROP FUNCTION owned_settlement_ack_fault()"
            } else {
                "DROP TRIGGER owned_settlement_release_fault ON cache_write_reservations; DROP FUNCTION owned_settlement_release_fault()"
            };
            sql(&db, drop_sql).await?;
        }
        ensure!(
            writer_stopped
                && runtime.snapshot().checks["resource_drain"] == readiness::Outcome::Ready
        );
        let child_receipt = if let Some(child) = &mut child {
            use std::os::unix::process::ExitStatusExt;
            let status = child
                .try_wait()?
                .ok_or_else(|| anyhow::anyhow!("child reaping unconfirmed"))?;
            json!({"pid":child_pid,"close_observed":true,"pid_absent":!PathBuf::from(format!("/proc/{}",child_pid.unwrap())).exists(),"exit_code":status.code(),"signal":status.signal()})
        } else {
            json!({"process_started":false,"scope":"empty","decoder":"empty"})
        };
        cases.push(json!({"case":case,"before":before,"blocked":blocked,"after":observe(&db,&runtime).await?,"writer_stopped":writer_stopped,"child":child_receipt,"warning_count":logs(&capture).matches("media execution drain acknowledgement retry").count()-warning_before}));
        println!("\nPASS: owned settlement {case}");
    }
    std::fs::write(
        std::env::var("RAINSYNC_SETTLEMENT_OBSERVATION")?,
        serde_json::to_vec_pretty(
            &json!({"cases":cases,"tracing":logs(&capture),"scope":"complete rows/columns of listed tables; NULL-principal/room synthetic sessions, managed shell child only; no decoder media, publication, full namespace or authorization acceptance"}),
        )?,
    )?;
    db.close().await;
    Ok(())
}
