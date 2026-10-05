use super::*;
use axum::body::Body;
use media_core::static_hls::contracts::input::FrozenInput;
use sha2::{Digest, Sha256};

#[derive(Default)]
pub(super) struct ReadFixtures {
    pub armed: std::sync::atomic::AtomicBool,
    pub seen: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
    pub closed: tokio::sync::Notify,
}

struct Tail {
    bytes: Vec<u8>,
    state: u8,
    gate: Arc<ReadFixtures>,
}
impl Drop for Tail {
    fn drop(&mut self) {
        self.gate.closed.notify_one();
    }
}

pub(super) fn paused_body(bytes: Vec<u8>, gate: Arc<ReadFixtures>) -> Body {
    Body::from_stream(futures_util::stream::unfold(
        Tail {
            bytes,
            state: 0,
            gate,
        },
        |mut tail| async move {
            let bytes = match tail.state {
                0 => {
                    tail.gate.seen.notify_one();
                    tail.bytes[..32.min(tail.bytes.len())].to_vec()
                }
                1 => {
                    tail.gate.release.notified().await;
                    tail.bytes[32.min(tail.bytes.len())..].to_vec()
                }
                _ => return None,
            };
            tail.state += 1;
            Some((Ok::<_, std::io::Error>(bytes), tail))
        },
    ))
}

struct Release(Arc<ReadFixtures>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release.notify_one();
    }
}

pub(super) async fn exercise(
    app: &App,
    worker: &str,
    input: &FrozenInput,
    reply: &Value,
    reads: &std::sync::atomic::AtomicUsize,
    gate: Arc<ReadFixtures>,
) -> Result<Value> {
    let _release = Release(gate.clone());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()?;
    let token = reply["delivery_token"]
        .as_str()
        .context("delivery token missing")?;
    let session = Uuid::parse_str(&input.identity_statement().session_id)?;
    let root = format!("{worker}/media-delivery/{session}/static-hls/{token}");
    let manifest = client.get(format!("{root}/index.m3u8")).send().await?;
    if manifest.status() != StatusCode::OK {
        let status = manifest.status();
        let mut tx = app.db.begin().await?;
        persistence::media_executions::DeliveryReader::StaticHlsParent
            .configure(&mut tx)
            .await?;
        let facts: Value = sqlx::query_scalar("SELECT jsonb_build_object('token_matches',p.delivery_token_hash=$2,'source_allowed',playback_source_allowed(p.media_id,p.resource,p.id),'published_authority',static_hls_published_parent_authority_allowed(c.id),'capture_state',c.state,'capture_phase',c.publication_phase,'disposed',c.disposed_at IS NOT NULL,'stopped',p.stopped,'root_remaining',extract(epoch FROM(c.expires_at-clock_timestamp())),'request_status',r.status,'reader',current_setting('rainsync.static_hls_reader',true),'recipe',current_setting('rainsync.static_hls_pending_recipe',true),'deliveries',(SELECT count(*) FROM media_executions WHERE session_id=p.id)) FROM playback_sessions p JOIN static_hls_captures c ON c.id=p.static_hls_capture_id JOIN playback_requests r ON r.session_id=p.id WHERE p.id=$1")
            .bind(session).bind(crate::hash(token)).fetch_one(&mut *tx).await?;
        let origin = persistence::source_account_policy::lock_session(&mut tx, session).await?;
        tx.rollback().await?;
        std::fs::write(
            app.cache.join("public-read-failure.json"),
            serde_json::to_vec_pretty(
                &json!({"status":status.as_u16(),"facts":facts,"locked_origin_allowed":origin}),
            )?,
        )?;
        anyhow::bail!("published manifest refused; exact fixture facts retained");
    }
    ensure!(manifest.status() == StatusCode::OK);
    ensure!(manifest.headers()[header::CACHE_CONTROL] == "private, no-store");
    let manifest_length: usize = manifest.headers()[header::CONTENT_LENGTH]
        .to_str()?
        .parse()?;
    let manifest_etag = manifest.headers()[header::ETAG].to_str()?.to_owned();
    let bytes = manifest.bytes().await?;
    ensure!(
        bytes.len() == manifest_length
            && manifest_etag == format!("\"sha256-{}\"", hex::encode(Sha256::digest(&bytes)))
    );
    let manifest = std::str::from_utf8(&bytes)?;
    ensure!(manifest.starts_with("#EXTM3U") && manifest.contains("#EXT-X-ENDLIST"));
    ensure!(
        manifest.contains("init.mp4")
            && manifest.contains("s000.m4s")
            && !manifest.contains("http://")
    );

    let segment_url = format!("{root}/s000.m4s");
    let whole = client.get(&segment_url).send().await?;
    ensure!(whole.status() == StatusCode::OK && whole.headers()[header::ACCEPT_RANGES] == "bytes");
    let total: usize = whole.headers()[header::CONTENT_LENGTH].to_str()?.parse()?;
    let etag = whole.headers()[header::ETAG].to_str()?.to_owned();
    let whole = whole.bytes().await?;
    ensure!(whole.len() == total && total > 32);
    let head = client
        .head(&segment_url)
        .header(header::RANGE, "bytes=malformed")
        .send()
        .await?;
    ensure!(
        head.status() == StatusCode::OK
            && head.headers()[header::CONTENT_LENGTH]
                .to_str()?
                .parse::<usize>()?
                == total
    );
    ensure!(head.headers()[header::ETAG] == etag && head.bytes().await?.is_empty());
    let init = client.get(format!("{root}/init.mp4")).send().await?;
    let init_status = init.status();
    ensure!(
        init_status == StatusCode::OK,
        "init read refused with status {init_status}"
    );
    ensure!(
        !init.bytes().await?.is_empty(),
        "init read returned empty bytes"
    );
    for (range, first, length) in [
        ("bytes=0-31".to_owned(), 0, 32),
        (format!("bytes={}-", total - 32), total - 32, 32),
        ("bytes=-32".to_owned(), total - 32, 32),
        (format!("bytes=0-{}", usize::MAX), 0, total),
    ] {
        let response = client
            .get(&segment_url)
            .header(header::RANGE, &range)
            .send()
            .await?;
        ensure!(response.status() == StatusCode::PARTIAL_CONTENT);
        ensure!(
            response.headers()[header::CONTENT_RANGE].to_str()?
                == format!("bytes {first}-{}/{total}", first + length - 1)
        );
        ensure!(
            response.headers()[header::CONTENT_LENGTH]
                .to_str()?
                .parse::<usize>()?
                == length
        );
        ensure!(response.bytes().await?.as_ref() == &whole[first..first + length]);
    }
    for (validator, expected) in [
        (etag.clone(), StatusCode::PARTIAL_CONTENT),
        ("\"foreign\"".into(), StatusCode::OK),
        (format!("W/{etag}"), StatusCode::OK),
    ] {
        let response = client
            .get(&segment_url)
            .header(header::RANGE, "bytes=0-31")
            .header(header::IF_RANGE, validator)
            .send()
            .await?;
        ensure!(response.status() == expected);
        let data = response.bytes().await?;
        ensure!(
            data.as_ref()
                == if expected == StatusCode::PARTIAL_CONTENT {
                    &whole[..32]
                } else {
                    whole.as_ref()
                }
        );
    }
    for range in [format!("bytes={total}-"), "bytes=-0".into()] {
        let before = reads.load(Ordering::SeqCst);
        let response = client
            .get(&segment_url)
            .header(header::RANGE, range)
            .send()
            .await?;
        ensure!(
            response.status() == StatusCode::RANGE_NOT_SATISFIABLE
                && response.headers()[header::CONTENT_RANGE].to_str()?
                    == format!("bytes */{total}")
        );
        ensure!(response.bytes().await?.is_empty() && reads.load(Ordering::SeqCst) == before + 1);
    }
    let before_rejections = reads.load(Ordering::SeqCst);
    for range in [
        "bytes=0-1,4-5",
        "bytes=8-3",
        "bytes=",
        "bytes=999999999999999999999999999-",
        "items=0-1",
    ] {
        ensure!(
            client
                .get(&segment_url)
                .header(header::RANGE, range)
                .send()
                .await?
                .status()
                == StatusCode::BAD_REQUEST
        );
    }
    ensure!(
        client
            .get(&segment_url)
            .header(header::RANGE, "bytes=0-1")
            .header(header::RANGE, "bytes=4-5")
            .send()
            .await?
            .status()
            == StatusCode::BAD_REQUEST
    );
    let wrong = format!("{}0", &token[..63]);
    let wrong = if wrong == token {
        format!("{}1", &token[..63])
    } else {
        wrong
    };
    ensure!(
        client
            .get(segment_url.replace(token, &wrong))
            .send()
            .await?
            .status()
            == StatusCode::UNAUTHORIZED
    );
    ensure!(
        client
            .get(format!("{root}/s063.m4s"))
            .send()
            .await?
            .status()
            == StatusCode::NOT_FOUND
    );
    ensure!(
        client
            .get(format!("{root}/source.bin"))
            .send()
            .await?
            .status()
            == StatusCode::BAD_REQUEST
    );
    ensure!(
        client
            .get(format!(
                "{worker}/media-delivery/{session}/index.m3u8?token={token}"
            ))
            .send()
            .await?
            .status()
            == StatusCode::UNAUTHORIZED
    );
    ensure!(
        client
            .get(format!(
                "{worker}/missing-read/media-delivery/{session}/static-hls/{token}/s000.m4s"
            ))
            .send()
            .await?
            .status()
            == StatusCode::SERVICE_UNAVAILABLE
    );
    ensure!(
        reads.load(Ordering::SeqCst) == before_rejections,
        "refusal performed source IO"
    );
    let held: i64 =
        sqlx::query_scalar("SELECT bytes FROM cache_write_reservations WHERE job_id=$1")
            .bind(Uuid::parse_str(&input.identity_statement().operation_id)?)
            .fetch_one(&app.db)
            .await?;
    ensure!(held == 134217728, "HTTP reads released capture reservation");
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let active: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM media_executions WHERE session_id=$1 AND reaped_at IS NULL",
        )
        .bind(session)
        .fetch_one(&app.db)
        .await?;
        if active == 0 {
            break;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "HTTP delivery receipt missing"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let receipt = sqlx::query("SELECT id,owner_id,reaped_at::text AS reaped FROM media_executions WHERE session_id=$1 ORDER BY created_at,id LIMIT 1")
        .bind(session).fetch_one(&app.db).await?;
    let execution = receipt.get::<Uuid, _>("id");
    let owner = receipt.get::<Uuid, _>("owner_id");
    use persistence::media_executions::{DeliveryReader, acknowledge, acknowledge_with_reader};
    ensure!(
        acknowledge(&app.db, execution, owner).await.is_err(),
        "old reader acknowledged new parent"
    );
    ensure!(
        acknowledge_with_reader(
            &app.db,
            execution,
            Uuid::new_v4(),
            DeliveryReader::StaticHlsParent
        )
        .await
        .is_err(),
        "foreign owner acknowledged delivery"
    );
    acknowledge_with_reader(&app.db, execution, owner, DeliveryReader::StaticHlsParent).await?;
    let reaped: String =
        sqlx::query_scalar("SELECT reaped_at::text FROM media_executions WHERE id=$1")
            .bind(execution)
            .fetch_one(&app.db)
            .await?;
    ensure!(
        reaped == receipt.get::<String, _>("reaped"),
        "retry changed original receipt"
    );

    // Hold the actual upstream body before public headers, then revoke only this
    // synthetic login. No local media bytes may escape before complete validation.
    gate.armed.store(true, Ordering::SeqCst);
    let waiting = tokio::spawn(async move { client.get(segment_url).send().await });
    tokio::time::timeout(Duration::from_secs(2), gate.seen.notified()).await?;
    sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=(SELECT auth_login_hash FROM playback_requests WHERE session_id=$1)")
        .bind(session).execute(&app.db).await?;
    let denied = tokio::time::timeout(Duration::from_secs(5), waiting).await???;
    ensure!(
        !denied.status().is_success(),
        "revoked read served media headers"
    );
    tokio::time::timeout(Duration::from_secs(3), gate.closed.notified()).await?;
    let before = reads.load(Ordering::SeqCst);
    let status = reqwest::get(format!("{root}/index.m3u8")).await?.status();
    ensure!(status == StatusCode::UNAUTHORIZED && reads.load(Ordering::SeqCst) == before);
    Ok(
        json!({"public_read_route_exercised":true,"actual_user_playback":false,
        "manifest_bytes":manifest_length,"segment_bytes":total,"reservation_bytes":held,
        "malformed_or_unauthorized_source_reads":0,"revoked_upstream_body_closed":true}),
    )
}
