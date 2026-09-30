use persistence::cache::{self, ReadLease};
use sqlx::PgPool;
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub struct ReadGuard {
    pool: PgPool,
    lease: ReadLease,
    task: tokio::task::JoinHandle<()>,
    health: watch::Receiver<Option<Instant>>,
}

impl ReadGuard {
    pub async fn acquire(pool: &PgPool, id: uuid::Uuid, attempt: i64) -> anyhow::Result<Self> {
        let began = Instant::now();
        let lease = tokio::time::timeout(
            Duration::from_secs(3),
            cache::acquire_attempt(pool, id, attempt),
        )
        .await??
        .ok_or_else(|| anyhow::anyhow!("cache_read_unavailable"))?;
        let (health, receiver) = watch::channel(Some(began));
        let db = pool.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let began = Instant::now();
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(3), cache::renew(&db, lease)).await,
                    Ok(Ok(true))
                ) {
                    let _ = health.send(None);
                    break;
                }
                if health.send(Some(began)).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            pool: pool.clone(),
            lease,
            task,
            health: receiver,
        })
    }

    pub fn healthy(&self) -> bool {
        self.health
            .borrow()
            .is_some_and(|at| at.elapsed() < Duration::from_secs(25))
    }

    pub fn body<S>(self, stream: S) -> axum::body::Body
    where
        S: futures_util::Stream<Item = std::io::Result<axum::body::Bytes>> + Send + 'static,
    {
        use futures_util::StreamExt;
        let stream = Box::pin(stream);
        axum::body::Body::from_stream(futures_util::stream::try_unfold(
            (stream, self),
            |(mut stream, mut guard)| async move {
                loop {
                    if !guard.healthy() {
                        return Err(std::io::Error::other("cache_read_lease_lost"));
                    }
                    tokio::select! {
                        changed = guard.health.changed() => {
                            if changed.is_err() { return Err(std::io::Error::other("cache_read_lease_lost")); }
                        },
                        chunk = stream.next() => {
                            // A suspended process may resume after its lease expired.
                            if !guard.healthy() { return Err(std::io::Error::other("cache_read_lease_lost")); }
                            return chunk.transpose().map(|chunk| chunk.map(|bytes| (bytes, (stream, guard))));
                        }
                    }
                }
            },
        ))
    }
}

impl Drop for ReadGuard {
    fn drop(&mut self) {
        self.task.abort();
        let pool = self.pool.clone();
        let lease = self.lease;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(3), cache::release(&pool, lease))
                    .await;
            });
        }
        // A crashed runtime cannot release; the database lease expires instead.
    }
}
