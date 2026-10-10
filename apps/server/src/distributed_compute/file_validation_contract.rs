//! Owned full-schema baseline of the original validation operation, not publication.
use super::*;
use anyhow::{Result, ensure};

const CASES: &[&str] = &[
    "valid",
    "bad_header",
    "no_endlist",
    "invalid_utf8",
    "invalid_duration",
    "nonfinite_duration",
    "zero_duration",
    "negative_duration",
    "long_duration",
    "missing_duration",
    "unsafe_name",
    "manifest_reference",
    "duplicate_segment",
    "uri_tag",
    "key_tag",
    "master_tag",
    "empty_manifest",
    "dangling_duration",
    "missing_manifest",
    "incomplete",
    "unreferenced",
    "missing_segment",
    "size_changed",
    "hash_changed",
    "generation_isolation",
    "directory_read_error",
    "same_transaction_visibility",
];
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
async fn seed(db: &PgPool) -> Result<()> {
    let (user, agent, media, room, member) = (id(1), id(2), id(3), id(4), id(5));
    let digest = "b".repeat(64);
    sqlx::raw_sql(&format!(r#"
      INSERT INTO users(id,username,password_hash,admin) VALUES('{user}','file-validation-owned','!',true);
      INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES('{}','{user}','owned','2100-01-01');
      INSERT INTO agents(id,name) VALUES('{agent}','owned');
      INSERT INTO sources(id,name,kind,config_encrypted) VALUES('{agent}','owned','agent','owned-unused');
      INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('{media}','{agent}','owned','owned.mp4','stat-v1:{digest}');
      INSERT INTO rooms(id,name,owner_id) VALUES('{room}','owned','{user}');
      INSERT INTO room_members(room_id,user_id,membership_epoch) VALUES('{room}','{user}','{member}');
      INSERT INTO room_snapshots(room_id,state) VALUES('{room}','{{"media_id":"{media}","media_generation":1}}');
      INSERT INTO distributed_compute_jobs(id,room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,status,created_at,expires_at)
      SELECT '{}','{room}','{user}','{}','{member}','{media}',1,0,'stat-v1:{digest}',access_policy_revision,'{digest}',1024,'remux_hls_v1','queued','2000-01-01','2100-01-01' FROM sources WHERE id='{agent}';
    "#, "a".repeat(64), id(10), "a".repeat(64))).execute(db).await?;
    ensure!(
        sqlx::query_scalar::<_, bool>("SELECT distributed_compute_authorized($1)")
            .bind(id(10))
            .fetch_one(db)
            .await?
    );
    Ok(())
}
async fn tables(db: &PgPool) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for table in ["distributed_compute_files", "distributed_compute_jobs"] {
        let rows: Value = sqlx::query_scalar(&format!("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {table} t")).fetch_one(db).await?;
        out.insert(table.into(), rows);
    }
    Ok(Value::Object(out))
}
fn tree(root: &FsPath) -> Result<Value> {
    fn walk(root: &FsPath, path: &FsPath, out: &mut Vec<Value>) -> Result<()> {
        let mut children = std::fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                walk(root, &path, out)?;
            } else {
                out.push(json!({"path":path.strip_prefix(root)?.to_str().ok_or_else(||anyhow::anyhow!("nonutf8 owned path"))?,"bytes":std::fs::read(&path)?}));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    Ok(json!(files))
}
fn manifest(name: &str) -> Vec<u8> {
    let valid = "#EXTM3U\n#EXTINF:1,\nsegment00001.ts\n#EXT-X-ENDLIST\n";
    match name {
        "bad_header" => valid.replacen("#EXTM3U", "BAD", 1).into_bytes(),
        "no_endlist" => valid.replace("#EXT-X-ENDLIST\n", "").into_bytes(),
        "invalid_utf8" => vec![255],
        "invalid_duration" => valid.replace("#EXTINF:1,", "#EXTINF:bad,").into_bytes(),
        "nonfinite_duration" => valid.replace("#EXTINF:1,", "#EXTINF:NaN,").into_bytes(),
        "zero_duration" => valid.replace("#EXTINF:1,", "#EXTINF:0,").into_bytes(),
        "negative_duration" => valid.replace("#EXTINF:1,", "#EXTINF:-1,").into_bytes(),
        "long_duration" => valid.replace("#EXTINF:1,", "#EXTINF:31,").into_bytes(),
        "missing_duration" => valid.replace("#EXTINF:1,\n", "").into_bytes(),
        "unsafe_name" => valid
            .replace("segment00001.ts", "../segment00001.ts")
            .into_bytes(),
        "manifest_reference" => valid.replace("segment00001.ts", "index.m3u8").into_bytes(),
        "duplicate_segment" => valid
            .replace(
                "#EXT-X-ENDLIST",
                "#EXTINF:1,\nsegment00001.ts\n#EXT-X-ENDLIST",
            )
            .into_bytes(),
        "uri_tag" => valid
            .replace("#EXT-X-ENDLIST", "#EXT-X-MAP:URI=\"x\"\n#EXT-X-ENDLIST")
            .into_bytes(),
        "key_tag" => valid
            .replace("#EXT-X-ENDLIST", "#EXT-X-KEY:METHOD=NONE\n#EXT-X-ENDLIST")
            .into_bytes(),
        "master_tag" => valid
            .replace(
                "#EXT-X-ENDLIST",
                "#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-ENDLIST",
            )
            .into_bytes(),
        "empty_manifest" => b"#EXTM3U\n#EXT-X-ENDLIST\n".to_vec(),
        "dangling_duration" => valid
            .replace("#EXT-X-ENDLIST", "#EXTINF:1,\n#EXT-X-ENDLIST")
            .into_bytes(),
        _ => valid.as_bytes().to_vec(),
    }
}
#[tokio::test]
#[ignore = "requires distributed-compute-file-validation-native.mjs owned PostgreSQL"]
async fn owned_file_validation() -> Result<()> {
    ensure!(
        std::env::var_os("DATABASE_URL").is_none(),
        "external DATABASE_URL forbidden"
    );
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST")? == "1");
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_FILE_VALIDATION_RUN_ID")?)?;
    let url = std::env::var("RAINSYNC_FILE_VALIDATION_DATABASE_URL")?;
    ensure!(url == std::env::var("RAINSYNC_FILE_VALIDATION_EXPECTED_DATABASE_URL")?);
    ensure!(url.starts_with("postgres://rainsync:") && url.contains("@127.0.0.1:"));
    let db = persistence::connect(&url).await?;
    let owner: Uuid = sqlx::query_scalar(
        "SELECT run_id FROM rainsync_file_validation_fixture_owner WHERE singleton",
    )
    .fetch_one(&db)
    .await?;
    ensure!(owner == run);
    persistence::migrate(&db).await?;
    seed(&db).await?;
    let root = PathBuf::from(std::env::var("RAINSYNC_COMPUTE_OUTPUT_ROOT")?);
    ensure!(root.is_absolute() && !root.exists());
    std::fs::create_dir(&root)?;
    let initial = tables(&db).await?;
    let mut observations = Vec::new();
    for (index, name) in CASES.iter().enumerate() {
        let generation = id(100 + index as u128);
        let directory = file_path(&root, id(10), generation, "index.m3u8")
            .parent()
            .unwrap()
            .to_owned();
        std::fs::create_dir_all(&directory)?;
        let bytes = manifest(name);
        let parser = match file_validation::playlist_segments(&bytes) {
            Ok(files) => json!({"ok":files}),
            Err(error) => json!({"error":error.to_string()}),
        };
        let segment = b"owned-segment";
        if *name == "directory_read_error" {
            std::fs::create_dir(directory.join("index.m3u8"))?;
        } else if *name != "missing_manifest" {
            std::fs::write(directory.join("index.m3u8"), &bytes)?;
        }
        if *name != "missing_segment" {
            std::fs::write(directory.join("segment00001.ts"), segment)?;
        }
        let mut tx = db.begin().await?;
        // Writes are intentionally uncommitted: validation must read this exact transaction.
        let row_generation = if *name == "generation_isolation" {
            id(999)
        } else {
            generation
        };
        for (file, content) in [
            ("index.m3u8", bytes.as_slice()),
            ("segment00001.ts", segment.as_slice()),
        ] {
            if *name == "incomplete" && file == "segment00001.ts" {
                continue;
            }
            let file = if *name == "unreferenced" && file == "segment00001.ts" {
                "segment00002.ts"
            } else {
                file
            };
            let size = content.len() as i64
                + i64::from(*name == "size_changed" && file == "segment00001.ts");
            let digest = if *name == "hash_changed" && file == "segment00001.ts" {
                "c".repeat(64)
            } else {
                hex::encode(Sha256::digest(content))
            };
            sqlx::query("INSERT INTO distributed_compute_files(job_id,output_generation,name,sha256,size_bytes) VALUES($1,$2,$3,$4,$5)").bind(id(10)).bind(row_generation).bind(file).bind(digest).bind(size).execute(&mut *tx).await?;
        }
        ensure!(
            tables(&db).await? == initial,
            "uncommitted files escaped transaction"
        );
        let before: Value = sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM distributed_compute_files t").fetch_one(&mut *tx).await?;
        let jobs_before: Value = sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM distributed_compute_jobs t").fetch_one(&mut *tx).await?;
        let files_before = tree(&root)?;
        let result = file_validation::verify_files(&root, id(10), generation, &mut tx).await;
        let expected = match *name {
            "valid" | "same_transaction_visibility" => None,
            "missing_manifest" | "missing_segment" | "directory_read_error" => {
                Some((500, "operation_failed"))
            }
            "incomplete" | "generation_isolation" => Some((409, "incomplete_compute_artifact")),
            "unreferenced" => Some((409, "unreferenced_compute_artifact")),
            "size_changed" | "hash_changed" => Some((409, "compute_artifact_changed")),
            _ => Some((400, "invalid_compute_manifest")),
        };
        let outcome = match result {
            Ok(()) => {
                ensure!(expected.is_none(), "unexpected success: {name}");
                json!({"status":200,"code":"ok"})
            }
            Err(error) => {
                ensure!(
                    Some((error.0.as_u16(), error.1.as_str())) == expected,
                    "unexpected error {name}: {error:?}"
                );
                json!({"status":error.0.as_u16(),"code":error.1,"retry_after":error.2})
            }
        };
        let after: Value = sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM distributed_compute_files t").fetch_one(&mut *tx).await?;
        let jobs_after: Value = sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM distributed_compute_jobs t").fetch_one(&mut *tx).await?;
        ensure!(
            before == after && jobs_before == jobs_after && files_before == tree(&root)?,
            "validation mutated state"
        );
        tx.rollback().await?;
        ensure!(
            tables(&db).await? == initial,
            "rollback changed durable state"
        );
        observations.push(json!({"case":name,"parser":parser,"outcome":outcome,"transaction_files_before":before,"transaction_files_after":after,"transaction_jobs_before":jobs_before,"transaction_jobs_after":jobs_after,"durable_after_rollback":tables(&db).await?,"files_before":files_before,"files_after":tree(&root)?}));
        println!("\nPASS: owned file validation {name}");
    }
    std::fs::write(
        std::env::var("RAINSYNC_FILE_VALIDATION_OBSERVATION")?,
        serde_json::to_vec_pretty(
            &json!({"initial":initial,"cases":observations,"final":tables(&db).await?,"files":tree(&root)?}),
        )?,
    )?;
    db.close().await;
    Ok(())
}
