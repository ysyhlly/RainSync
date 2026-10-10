//! Complete original startup, advisory owner and heartbeat/renewal lifetime.
use super::{DEADLINE, Inner, Runtime, Settings};
use futures_util::StreamExt;
use persistence::room_node_leases::{self as leases, Lease};
use sqlx::PgPool;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;
impl Runtime {
    pub async fn start(
        db: PgPool,
        settings: Settings,
        epoch: Uuid,
        start: Instant,
    ) -> anyhow::Result<Self> {
        let mut lock = db.acquire().await?;
        let key = i32::from_be_bytes(settings.node.as_bytes()[..4].try_into().unwrap());
        let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(72614932,$1)")
            .bind(key)
            .fetch_one(&mut *lock)
            .await?;
        anyhow::ensure!(acquired, "another process owns this control node ID");
        let fingerprint = settings.fingerprint();
        sqlx::query("INSERT INTO control_cluster_activation(singleton,configuration_hash) VALUES(true,$1) ON CONFLICT DO NOTHING").bind(&fingerprint).execute(&db).await?;
        let current: String = sqlx::query_scalar(
            "SELECT configuration_hash FROM control_cluster_activation WHERE singleton",
        )
        .fetch_one(&db)
        .await?;
        anyhow::ensure!(
            current == fingerprint,
            "control cluster configuration mismatch"
        );
        leases::register_instance(
            &db,
            settings.node,
            settings.instance,
            &settings.nodes[&settings.node],
        )
        .await?;
        let runtime = Self {
            inner: Arc::new(Inner {
                settings,
                db,
                epoch,
                start,
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
        let heartbeat = runtime.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                if !heartbeat.healthy() {
                    std::future::pending::<()>().await;
                }
                let healthy = tokio::time::timeout(Duration::from_millis(1500), async {
                    sqlx::query("SELECT 1").execute(&mut *lock).await?;
                    leases::heartbeat_instance(
                        &heartbeat.inner.db,
                        heartbeat.node(),
                        heartbeat.inner.settings.instance,
                    )
                    .await
                })
                .await;
                if !matches!(healthy, Ok(Ok(()))) {
                    heartbeat.inner.live.store(false, Ordering::Release);
                    break;
                }
            }
            // No reacquisition within this process after connection/identity loss.
            heartbeat.inner.owned.lock().await.clear();
            std::future::pending::<()>().await;
        });
        let renewal = runtime.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                if !renewal.healthy() {
                    break;
                }
                let owned: Vec<Lease> =
                    renewal.inner.owned.lock().await.values().cloned().collect();
                futures_util::stream::iter(owned)
                    .for_each_concurrent(8, |lease| {
                        let renewal = renewal.clone();
                        async move {
                            let renewed = tokio::time::timeout(
                                Duration::from_millis(1800),
                                leases::renew_checkpoint(
                                    &renewal.inner.db,
                                    &lease,
                                    renewal.inner.epoch,
                                    renewal.now(),
                                ),
                            )
                            .await;
                            if !matches!(renewed, Ok(Ok(true))) {
                                renewal.inner.owned.lock().await.remove(&lease.room);
                                renewal.inner.fenced.lock().await.insert(lease.room);
                                renewal.inner.routes.lock().await.remove(&lease.room);
                            }
                        }
                    })
                    .await;
            }
        });
        Ok(runtime)
    }
}
