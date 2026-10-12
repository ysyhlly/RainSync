//! A native CDN read survives its HTTP waiter until its actual response/future
//! is dropped and its exact durable execution receipt is acknowledged.
use super::*;
use futures_util::Stream;
use sqlx::Acquire;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};

const LIMIT: usize = 128;
const CHECK: Duration = Duration::from_secs(3);

pub(crate) struct Registry {
    slots: Arc<Semaphore>,
    closing: watch::Sender<bool>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(LIMIT)),
            closing: watch::channel(false).0,
        }
    }
}
impl Registry {
    pub(crate) fn close_admission(&self) {
        self.closing.send_replace(true);
        self.slots.close();
    }
    pub(crate) async fn drain(&self) -> anyhow::Result<()> {
        self.close_admission();
        tokio::time::timeout(Duration::from_secs(45), async {
            while self.slots.available_permits() != LIMIT {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("native_delivery_drain_unconfirmed"))
    }
}

type SourceFuture<'a, T> =
    Pin<Box<dyn Future<Output = std::result::Result<T, bilibili::Error>> + Send + 'a>>;

pub(super) trait Source: Send {
    fn status(&self) -> StatusCode;
    fn headers(&self) -> &HeaderMap;
    fn next<'a>(&'a mut self) -> SourceFuture<'a, Option<Vec<u8>>>;
}
impl Source for MediaResponse {
    fn status(&self) -> StatusCode {
        self.status()
    }
    fn headers(&self) -> &HeaderMap {
        self.headers()
    }
    fn next<'a>(&'a mut self) -> SourceFuture<'a, Option<Vec<u8>>> {
        Box::pin(self.next_chunk())
    }
}

pub(super) struct Request {
    pub provider: String,
    pub target: String,
    pub method: Method,
    pub range: Option<String>,
    pub deadline: Deadline,
}
pub(super) trait Transport: Send + Sync + 'static {
    fn open<'a>(&'a self, request: &'a Request) -> SourceFuture<'a, Box<dyn Source>>;
}
impl Transport for providers::platform::http::PlatformHttp {
    fn open<'a>(&'a self, request: &'a Request) -> SourceFuture<'a, Box<dyn Source>> {
        Box::pin(async move {
            self.media_request_for(
                &request.provider,
                &request.target,
                request.method.clone(),
                request.range.as_deref(),
                request.deadline,
            )
            .await
            .map(|response| Box::new(response) as Box<dyn Source>)
        })
    }
}

pub(super) struct Head {
    pub status: StatusCode,
    pub headers: HeaderMap,
}
pub(super) struct OwnedBody {
    receiver: mpsc::Receiver<std::result::Result<Bytes, std::io::Error>>,
    cancel: watch::Sender<bool>,
}
impl Stream for OwnedBody {
    type Item = std::result::Result<Bytes, std::io::Error>;
    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().receiver.poll_recv(context)
    }
}
impl Drop for OwnedBody {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}

async fn scoped_check(app: &App, authority: &Authority) -> Result<()> {
    if *app.native_delivery_owners.closing.borrow() {
        return Err(invalid());
    }
    tokio::time::timeout(CHECK, check(app, authority))
        .await
        .map_err(|_| invalid())?
}

async fn register(app: &App, authority: &Authority, room: Uuid, id: Uuid) -> Result<()> {
    let mut connection = app.db.acquire().await?;
    connection.close_on_drop();
    let mut tx = connection.begin().await?;
    sqlx::query("SELECT set_config('lock_timeout','1500ms',true),set_config('statement_timeout','2500ms',true)").execute(&mut *tx).await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let allowed:Option<Uuid>=sqlx::query_scalar(&format!("SELECT p.id FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE {GATE} AND p.room_id=$5 FOR SHARE OF p"))
        .bind(authority.session).bind(&authority.token_hash).bind(&authority.login_hash).bind(authority.user).bind(room).fetch_optional(&mut *tx).await?;
    if allowed.is_none() {
        return Err(invalid());
    }
    let inserted=sqlx::query("INSERT INTO media_executions(id,session_id,kind,owner_id,metrics_entry_candidate) VALUES($1,$2,'delivery',$3,false)")
        .bind(id).bind(authority.session).bind(app.epoch).execute(&mut *tx).await?.rows_affected();
    if inserted != 1 {
        return Err(invalid());
    }
    tx.commit().await?;
    connection.return_to_pool().await;
    Ok(())
}

// Lock the same room before the fresh receipt statement. This also serializes
// an uncertain original registration commit: absence is proved only after the
// transaction that could insert this exact UUID has released its room lock.
async fn acknowledge_absent_or_disposed(app: &App, room: Uuid, id: Uuid) -> anyhow::Result<()> {
    let mut connection = app.db.acquire().await?;
    connection.close_on_drop();
    let mut tx = connection.begin().await?;
    sqlx::query("SELECT set_config('lock_timeout','750ms',true),set_config('statement_timeout','1500ms',true)").execute(&mut *tx).await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let owner: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM media_executions WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(owner) = owner {
        anyhow::ensure!(owner == app.epoch, "native_delivery_owner_changed");
        let changed=sqlx::query("UPDATE media_executions SET reaped_at=COALESCE(reaped_at,clock_timestamp()) WHERE id=$1 AND owner_id=$2")
            .bind(id).bind(app.epoch).execute(&mut *tx).await?.rows_affected();
        anyhow::ensure!(changed == 1, "native_delivery_disposal_ack_unconfirmed");
    }
    tx.commit().await?;
    connection.return_to_pool().await;
    Ok(())
}

async fn finish(app: &App, room: Uuid, id: Uuid, _permit: OwnedSemaphorePermit) {
    let started = std::time::Instant::now();
    let mut failed_calls = 0_u64;
    loop {
        let failure = match tokio::time::timeout(
            CHECK,
            acknowledge_absent_or_disposed(app, room, id),
        )
        .await
        {
            Ok(Ok(())) => {
                if failed_calls != 0 {
                    tracing::info!(
                        target: "native_delivery_ack",
                        room_id = %room,
                        execution_id = %id,
                        ack_age_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                        failed_calls,
                        outcome = "recovered",
                        "native delivery acknowledgement call recovered"
                    );
                }
                return;
            }
            Ok(Err(_)) => "ack_error",
            Err(_) => "timeout",
        };
        failed_calls = failed_calls.saturating_add(1);
        if failed_calls.is_power_of_two() {
            tracing::warn!(
                target: "native_delivery_ack",
                room_id = %room,
                execution_id = %id,
                ack_age_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                failed_calls,
                failure,
                "native delivery acknowledgement remains unconfirmed"
            );
        }
        // Keep the admitted owner and retry the same positive local-disposal
        // result. Unknown database state never becomes a manufactured receipt.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn open_scoped<T: Transport>(
    app: &App,
    authority: &Authority,
    transport: &T,
    request: &Request,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Box<dyn Source>> {
    let mut stopped = app.native_delivery_owners.closing.subscribe();
    if *cancel.borrow() || *stopped.borrow() {
        return Err(invalid());
    }
    let pending = transport.open(request);
    tokio::pin!(pending);
    loop {
        tokio::select! {
            biased;
            _=cancel.changed()=>return Err(invalid()),
            _=stopped.changed()=>return Err(invalid()),
            result=&mut pending=>return result.map_err(provider_error),
            _=tokio::time::sleep(Duration::from_secs(1))=>scoped_check(app,authority).await?,
        }
    }
}

async fn pump(
    app: &App,
    authority: &Authority,
    source: &mut dyn Source,
    sender: &mpsc::Sender<std::result::Result<Bytes, std::io::Error>>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<()> {
    let mut stopped = app.native_delivery_owners.closing.subscribe();
    loop {
        if *cancel.borrow() || *stopped.borrow() {
            return Err(invalid());
        }
        let chunk = {
            let pending = source.next();
            tokio::pin!(pending);
            loop {
                tokio::select! {
                    biased;
                    _=cancel.changed()=>return Err(invalid()),
                    _=stopped.changed()=>return Err(invalid()),
                    result=&mut pending=>break result.map_err(provider_error)?,
                    _=tokio::time::sleep(Duration::from_secs(1))=>scoped_check(app,authority).await?,
                }
            }
        };
        let Some(chunk) = chunk else {
            return Ok(());
        };
        if chunk.len() > 1024 * 1024 {
            return Err(upstream_invalid());
        }
        scoped_check(app, authority).await?;
        let pending = sender.send(Ok(Bytes::from(chunk)));
        tokio::pin!(pending);
        loop {
            tokio::select! {
                biased;
                _=cancel.changed()=>return Err(invalid()),
                _=stopped.changed()=>return Err(invalid()),
                result=&mut pending=>{result.map_err(|_|invalid())?;break;},
                _=tokio::time::sleep(Duration::from_secs(1))=>scoped_check(app,authority).await?,
            }
        }
    }
}

pub(super) async fn start<T: Transport>(
    app: &App,
    authority: &Authority,
    room: Uuid,
    transport: T,
    request: Request,
) -> Result<(Head, OwnedBody)> {
    let permit = app
        .native_delivery_owners
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "native_platform_delivery_busy",
            )
        })?;
    let app = app.clone();
    let authority = authority.clone();
    let id = Uuid::new_v4();
    let (headers_tx, headers_rx) = oneshot::channel();
    let (sender, receiver) = mpsc::channel(1);
    let (cancel_tx, mut cancel) = watch::channel(false);
    let body = OwnedBody {
        receiver,
        cancel: cancel_tx,
    };
    tokio::spawn(async move {
        let mut headers_tx = Some(headers_tx);
        let registration =
            tokio::time::timeout(Duration::from_secs(5), register(&app, &authority, room, id))
                .await
                .unwrap_or_else(|_| Err(invalid()));
        let result = async {
            registration?;
            scoped_check(&app, &authority).await?;
            let mut source =
                open_scoped(&app, &authority, &transport, &request, &mut cancel).await?;
            let result = async {
                scoped_check(&app, &authority).await?;
                headers_tx
                    .take()
                    .ok_or_else(invalid)?
                    .send(Ok(Head {
                        status: source.status(),
                        headers: source.headers().clone(),
                    }))
                    .map_err(|_| invalid())?;
                if request.method == Method::HEAD {
                    return Ok(());
                }
                pump(&app, &authority, source.as_mut(), &sender, &mut cancel).await
            }
            .await;
            // No SQL ACK until both the raw request future above and every
            // actual response/body owner are positively dropped here.
            drop(source);
            result
        }
        .await;
        if let Err(error) = result {
            if let Some(headers) = headers_tx.take() {
                let _ = headers.send(Err(error));
            }
            let _ = sender.try_send(Err(std::io::Error::other(
                "native_platform_stream_interrupted",
            )));
        }
        drop(sender);
        finish(&app, room, id, permit).await;
    });
    let head = headers_rx.await.map_err(|_| invalid())??;
    Ok((head, body))
}

#[cfg(test)]
#[path = "owner_tests.rs"]
mod tests;
