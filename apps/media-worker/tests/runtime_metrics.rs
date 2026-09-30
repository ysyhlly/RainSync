//! Minimal App harness for owned production modules before controller wiring.
//! The shared source is included directly because media-core/lib.rs is owned by
//! integration. This does not claim real Worker routes or HTTP producers are wired.
extern crate self as media_core;
#[path = "../src/metric_stream.rs"]
mod metric_stream;
#[path = "../src/metrics.rs"]
mod metrics;
#[path = "../../../crates/media-core/src/runtime_metrics.rs"]
pub mod runtime_metrics;
use axum::{
    body::{Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use futures_util::{StreamExt, stream};
use runtime_metrics::{Cache, CacheDecision, Layer, Process, RuntimeMetrics};
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{io, time::Duration};

#[derive(Clone)]
pub struct App {
    db: PgPool,
    metrics: RuntimeMetrics,
}

fn count(output: &str, name: &str) -> u64 {
    output
        .lines()
        .find(|line| line.starts_with(name))
        .unwrap()
        .rsplit_once(' ')
        .unwrap()
        .1
        .parse()
        .unwrap()
}
#[tokio::test]
async fn worker_stream_reads_once_at_each_boundary_including_replayed_prefix() {
    let metrics = RuntimeMetrics::default();
    let upstream = stream::iter([
        Ok::<_, io::Error>(Bytes::from_static(b"prefix")),
        Ok(Bytes::from_static(b"body")),
    ]);
    let mut read = metric_stream::wrap(upstream, &metrics, Layer::UpstreamRead, Cache::NotHit);
    let sniffed = read.next().await.unwrap().unwrap();
    let combined = stream::iter([Ok::<_, io::Error>(sniffed)]).chain(read);
    let mut egress = metric_stream::wrap(combined, &metrics, Layer::WorkerEgress, Cache::NotHit);
    let mut delivered = Vec::new();
    while let Some(chunk) = egress.next().await {
        delivered.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(&delivered, b"prefixbody");
    let text = metrics.render_for(Process::Worker);
    assert_eq!(
        count(
            &text,
            "rainsync_transfer_body_bytes_total{layer=\"upstream_read\""
        ),
        10
    );
    assert_eq!(
        count(
            &text,
            "rainsync_transfer_body_bytes_total{layer=\"worker_egress\""
        ),
        10
    );
    assert_eq!(
        count(
            &text,
            "rainsync_transfer_bytes_total{layer=\"worker_egress\",outcome=\"complete\""
        ),
        10
    );
    assert!(egress.next().await.is_none());
    assert_eq!(text, metrics.render_for(Process::Worker));
}
#[tokio::test]
async fn worker_stream_error_is_terminal_and_drop_retains_partial_bytes() {
    let metrics = RuntimeMetrics::default();
    let input = stream::iter([
        Ok(Bytes::from_static(b"12")),
        Err(io::Error::other("fixture")),
        Ok(Bytes::from_static(b"unreachable")),
    ]);
    let mut measured = metric_stream::wrap(input, &metrics, Layer::WorkerEgress, Cache::Hit);
    assert!(measured.next().await.unwrap().is_ok());
    assert!(measured.next().await.unwrap().is_err());
    assert!(measured.next().await.is_none());
    drop(measured);
    let input =
        stream::iter([Ok::<_, io::Error>(Bytes::from_static(b"345"))]).chain(stream::pending());
    let mut measured = metric_stream::wrap(input, &metrics, Layer::WorkerEgress, Cache::Hit);
    measured.next().await.unwrap().unwrap();
    drop(measured);
    let text = metrics.render_for(Process::Worker);
    assert_eq!(
        count(
            &text,
            "rainsync_transfer_body_bytes_total{layer=\"worker_egress\""
        ),
        5
    );
    assert_eq!(count(&text, "rainsync_cache_served_bytes_total{"), 5);
    assert_eq!(
        count(
            &text,
            "rainsync_transfer_bytes_total{layer=\"worker_egress\",outcome=\"failed\""
        ),
        2
    );
    assert_eq!(
        count(
            &text,
            "rainsync_transfer_bytes_total{layer=\"worker_egress\",outcome=\"cancelled\""
        ),
        3
    );
    assert_eq!(count(&text, "rainsync_metric_active_transfers{"), 0);
}
#[tokio::test]
async fn worker_capacity_drop_does_not_fail_delivery_or_retain_unbounded_state() {
    let metrics = RuntimeMetrics::default();
    let handles: Vec<_> = (0..runtime_metrics::MAX_ACTIVE_TRANSFERS)
        .map(|_| {
            metrics
                .begin_transfer(Layer::WorkerEgress, Cache::NotHit)
                .unwrap()
        })
        .collect();
    let source = stream::once(async { Ok::<_, io::Error>(Bytes::from_static(b"still-delivered")) }); // !Unpin source
    let mut measured = metric_stream::wrap(source, &metrics, Layer::WorkerEgress, Cache::NotHit);
    assert_eq!(
        &measured.next().await.unwrap().unwrap()[..],
        b"still-delivered"
    );
    assert!(measured.next().await.is_none());
    assert_eq!(
        count(
            &metrics.render_for(Process::Worker),
            "rainsync_metric_transfer_dropped_total{"
        ),
        1
    );
    drop(handles);
    assert_eq!(
        count(
            &metrics.render_for(Process::Worker),
            "rainsync_metric_active_transfers{"
        ),
        0
    );
}
#[tokio::test]
async fn worker_no_session_or_bearer_returns_private_401_without_database_access() {
    let db = PgPoolOptions::new()
        .connect_lazy("postgres://fixture@127.0.0.1:9/fixture")
        .unwrap();
    let app = App {
        db,
        metrics: RuntimeMetrics::default(),
    };
    for headers in [
        HeaderMap::new(),
        HeaderMap::from_iter([(header::AUTHORIZATION, "Bearer ignored".parse().unwrap())]),
    ] {
        let response = metrics::endpoint(State(app.clone()), headers).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"login_required");
        assert_eq!(app.db.size(), 0);
    }
}
fn headers(token: char) -> HeaderMap {
    HeaderMap::from_iter([(
        header::COOKIE,
        format!("rainsync_session={}", token.to_string().repeat(64))
            .parse()
            .unwrap(),
    )])
}
fn hash(token: char) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.to_string().repeat(64).as_bytes()))
}
async fn status(app: &App, token: char) -> StatusCode {
    metrics::endpoint(State(app.clone()), headers(token))
        .await
        .status()
}
#[tokio::test]
#[ignore = "requires an isolated empty PostgreSQL database via RAINSYNC_METRICS_TEST_DATABASE_URL"]
async fn worker_real_session_authorization_deadlines_and_cancellation() {
    let url = std::env::var("RAINSYNC_METRICS_TEST_DATABASE_URL").expect("isolated fixture URL");
    let options: PgConnectOptions = url
        .parse::<PgConnectOptions>()
        .unwrap()
        .application_name("w08-metrics-fixture");
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options.clone())
        .await
        .unwrap();
    let observer = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options.application_name("w08-metrics-observer"))
        .await
        .unwrap();
    sqlx::query("CREATE TABLE users(id uuid PRIMARY KEY,admin boolean NOT NULL)")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE sessions(token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),csrf text NOT NULL,expires_at timestamptz NOT NULL)").execute(&db).await.unwrap();
    sqlx::query("INSERT INTO users VALUES('00000000-0000-0000-0000-000000000001',true),('00000000-0000-0000-0000-000000000002',false)").execute(&db).await.unwrap();
    for (token, admin, expired) in [
        ('a', true, false),
        ('b', false, false),
        ('c', true, true),
        ('d', true, false),
    ] {
        sqlx::query("INSERT INTO sessions VALUES($1,$2,'fixture-csrf',clock_timestamp()+make_interval(secs=>$3))")
            .bind(hash(token)).bind(uuid::Uuid::from_u128(if admin { 1 } else { 2 })).bind(if expired { -10.0 } else { 3600.0 }).execute(&db).await.unwrap();
    }
    let app = App {
        db: db.clone(),
        metrics: RuntimeMetrics::default(),
    };
    app.metrics.cache_lookup(CacheDecision::Hit);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new()
        .route("/metrics", axum::routing::get(metrics::endpoint))
        .with_state(app.clone());
    let (stop, stopping) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopping.await;
            })
            .await
            .unwrap();
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("http://{address}/metrics");
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let response = client.get(&url).headers(headers('a')).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(
        response
            .text()
            .await
            .unwrap()
            .contains("process=\"worker\"")
    );
    assert_eq!(
        client
            .get(&url)
            .headers(headers('b'))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let head = client
        .head(&url)
        .headers(headers('a'))
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert!(head.bytes().await.unwrap().is_empty());
    stop.send(()).unwrap();
    server.await.unwrap();
    let response = metrics::endpoint(State(app.clone()), headers('a')).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("version=0.0.4")
    );
    let body = to_bytes(response.into_body(), 32_768).await.unwrap();
    assert!(
        std::str::from_utf8(&body)
            .unwrap()
            .contains("result=\"hit\",process=\"worker\"} 1")
    );
    assert_eq!(status(&app, 'b').await, StatusCode::FORBIDDEN);
    assert_eq!(status(&app, 'c').await, StatusCode::UNAUTHORIZED);
    assert_eq!(status(&app, 'e').await, StatusCode::UNAUTHORIZED);
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(hash('d'))
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(status(&app, 'd').await, StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE users SET admin=false WHERE id='00000000-0000-0000-0000-000000000001'")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(status(&app, 'a').await, StatusCode::FORBIDDEN);
    sqlx::query("UPDATE users SET admin=true WHERE id='00000000-0000-0000-0000-000000000001'")
        .execute(&db)
        .await
        .unwrap();

    let mut held = db.begin().await.unwrap();
    sqlx::query("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *held)
        .await
        .unwrap();
    let began = std::time::Instant::now();
    assert_eq!(status(&app, 'a').await, StatusCode::SERVICE_UNAVAILABLE);
    assert!(began.elapsed() < Duration::from_secs(2));
    let request = tokio::spawn(metrics::endpoint(State(app.clone()), headers('a')));
    let mut observed_wait = false;
    for _ in 0..30 {
        let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE application_name='w08-metrics-fixture' AND wait_event_type='Lock' AND query LIKE 'SELECT u.admin%'").fetch_one(&observer).await.unwrap();
        if waiting > 0 {
            observed_wait = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(observed_wait, "actual auth query reached the database lock");
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    // Keep the table lock held: cancellation recovery must not require its release.
    let recovered = tokio::time::timeout(Duration::from_secs(2), db.acquire())
        .await
        .unwrap()
        .unwrap();
    drop(recovered);
    held.rollback().await.unwrap();
    assert_eq!(status(&app, 'a').await, StatusCode::OK);
    let mut first = db.acquire().await.unwrap();
    let mut second = db.acquire().await.unwrap();
    for conn in [&mut first, &mut second] {
        let setting: String = sqlx::query_scalar("SHOW statement_timeout")
            .fetch_one(&mut **conn)
            .await
            .unwrap();
        assert_eq!(setting, "0", "transaction-local timeout did not leak");
        let setting: String = sqlx::query_scalar("SHOW lock_timeout")
            .fetch_one(&mut **conn)
            .await
            .unwrap();
        assert_eq!(setting, "0");
    }
    drop(first);
    drop(second);
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(sessions, 3, "metrics reads do not mutate sessions");
    observer.close().await;
    db.close().await;
}
