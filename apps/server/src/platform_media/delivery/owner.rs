//! A native CDN read survives its HTTP waiter until its actual response/future
//! is dropped and its exact durable execution receipt is acknowledged.
use super::*;
use futures_util::Stream;
use sqlx::Acquire;
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};

const LIMIT: usize = 128;
const CHECK: Duration = Duration::from_secs(3);
const AUTH_INTERVAL: Duration = Duration::from_secs(1);

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

type SourceNext<'a> =
    futures_util::future::BoxFuture<'a, std::result::Result<Option<Vec<u8>>, bilibili::Error>>;
type OpenedSource<'a> =
    futures_util::future::BoxFuture<'a, std::result::Result<Box<dyn Source>, bilibili::Error>>;

pub(super) trait Source: Send {
    fn status(&self) -> StatusCode;
    fn headers(&self) -> &HeaderMap;
    fn next<'a>(&'a mut self) -> SourceNext<'a>;
}
impl Source for MediaResponse {
    fn status(&self) -> StatusCode {
        self.status()
    }
    fn headers(&self) -> &HeaderMap {
        self.headers()
    }
    fn next<'a>(&'a mut self) -> SourceNext<'a> {
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
    fn open<'a>(&'a self, request: &'a Request) -> OpenedSource<'a>;
}
impl Transport for providers::platform::http::PlatformHttp {
    fn open<'a>(&'a self, request: &'a Request) -> OpenedSource<'a> {
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
    interrupted: Arc<AtomicBool>,
}
fn stream_interrupted() -> std::io::Error {
    std::io::Error::other("native_platform_stream_interrupted")
}
impl Stream for OwnedBody {
    type Item = std::result::Result<Bytes, std::io::Error>;
    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let body = self.get_mut();
        match body.receiver.poll_recv(context) {
            Poll::Ready(Some(item)) => Poll::Ready(Some(item)),
            // A queued chunk is delivered first. Closing the sender after a
            // failed authorization is one error, including when the channel was
            // already full and the error item itself could not be queued.
            // Later polls end the stream so a consumer cannot spin on the flag.
            Poll::Ready(None) if body.interrupted.swap(false, Ordering::AcqRel) => {
                Poll::Ready(Some(Err(stream_interrupted())))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
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

/// One in-flight authorization wait. Cancel and shutdown win. Work that is
/// already ready returns immediately while the last successful check is still
/// inside `AUTH_INTERVAL`. The first wait, and any later wait whose check is
/// due, authorizes before yielding more data, so a fast source cannot skip the
/// interval. A pending read or send also wakes the same check when the second
/// elapses.
async fn wait_with_auth<T, Work, Authorize, Check, Now, Sleep, Slept>(
    cancel: &mut watch::Receiver<bool>,
    stopped: &mut watch::Receiver<bool>,
    work: Work,
    last_check: &mut Option<tokio::time::Instant>,
    authorize: &Authorize,
    now: &Now,
    sleep_for: &Sleep,
) -> Result<T>
where
    Work: Future<Output = Result<T>>,
    Authorize: Fn() -> Check,
    Check: Future<Output = Result<()>>,
    Now: Fn() -> tokio::time::Instant,
    Sleep: Fn(Duration) -> Slept,
    Slept: Future<Output = ()>,
{
    tokio::pin!(work);
    loop {
        if *cancel.borrow() || *stopped.borrow() {
            return Err(invalid());
        }
        let due = match *last_check {
            None => true,
            Some(at) => now().saturating_duration_since(at) >= AUTH_INTERVAL,
        };
        if due {
            tokio::select! {
                biased;
                _ = cancel.changed() => return Err(invalid()),
                _ = stopped.changed() => return Err(invalid()),
                result = authorize() => {
                    result?;
                    *last_check = Some(now());
                }
            }
            continue;
        }
        let remaining = AUTH_INTERVAL.saturating_sub(now().saturating_duration_since(
            last_check.expect("a fresh check is recorded before the timed wait"),
        ));
        tokio::select! {
            biased;
            _ = cancel.changed() => return Err(invalid()),
            _ = stopped.changed() => return Err(invalid()),
            result = &mut work => return result,
            _ = sleep_for(remaining) => {}
        }
    }
}

fn realtime() -> tokio::time::Instant {
    tokio::time::Instant::now()
}

fn real_sleep(duration: Duration) -> tokio::time::Sleep {
    tokio::time::sleep(duration)
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
    loop {
        if matches!(
            tokio::time::timeout(CHECK, acknowledge_absent_or_disposed(app, room, id)).await,
            Ok(Ok(()))
        ) {
            return;
        }
        // Keep the admitted owner and retry the same positive local-disposal
        // result. Unknown database state never becomes a manufactured receipt.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn open_scoped<T, Authorize, Check>(
    app: &App,
    transport: &T,
    request: &Request,
    cancel: &mut watch::Receiver<bool>,
    last_check: &mut Option<tokio::time::Instant>,
    authorize: &Authorize,
) -> Result<Box<dyn Source>>
where
    T: Transport,
    Authorize: Fn() -> Check,
    Check: Future<Output = Result<()>>,
{
    let mut stopped = app.native_delivery_owners.closing.subscribe();
    let pending = transport.open(request);
    wait_with_auth(
        cancel,
        &mut stopped,
        async move { pending.await.map_err(provider_error) },
        last_check,
        authorize,
        &realtime,
        &real_sleep,
    )
    .await
}

async fn pump<Authorize, Check>(
    app: &App,
    source: &mut dyn Source,
    sender: &mpsc::Sender<std::result::Result<Bytes, std::io::Error>>,
    cancel: &mut watch::Receiver<bool>,
    last_check: &mut Option<tokio::time::Instant>,
    authorize: &Authorize,
) -> Result<()>
where
    Authorize: Fn() -> Check,
    Check: Future<Output = Result<()>>,
{
    let mut stopped = app.native_delivery_owners.closing.subscribe();
    loop {
        let chunk = wait_with_auth(
            cancel,
            &mut stopped,
            async { source.next().await.map_err(provider_error) },
            last_check,
            authorize,
            &realtime,
            &real_sleep,
        )
        .await?;
        let Some(chunk) = chunk else {
            return Ok(());
        };
        if chunk.len() > 1024 * 1024 {
            return Err(upstream_invalid());
        }
        let send = sender.send(Ok(Bytes::from(chunk)));
        wait_with_auth(
            cancel,
            &mut stopped,
            async move { send.await.map_err(|_| invalid()) },
            last_check,
            authorize,
            &realtime,
            &real_sleep,
        )
        .await?;
    }
}

fn interrupt_body(
    sender: &mpsc::Sender<std::result::Result<Bytes, std::io::Error>>,
    interrupted: &AtomicBool,
) {
    // Do not wait for capacity. A held body is the backpressure case, and the
    // disposal receipt must still be written. The flag turns the later close
    // into an error instead of a clean EOF.
    interrupted.store(true, Ordering::Release);
    let _ = sender.try_send(Err(stream_interrupted()));
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
    let interrupted = Arc::new(AtomicBool::new(false));
    let body = OwnedBody {
        receiver,
        cancel: cancel_tx,
        interrupted: interrupted.clone(),
    };
    tokio::spawn(async move {
        let mut headers_tx = Some(headers_tx);
        let registration =
            tokio::time::timeout(Duration::from_secs(5), register(&app, &authority, room, id))
                .await
                .unwrap_or_else(|_| Err(invalid()));
        let result = async {
            registration?;
            // Admission, not the transfer poll. Later waits reuse this instant
            // and do not query again until AUTH_INTERVAL has elapsed.
            scoped_check(&app, &authority).await?;
            let mut last_check = Some(tokio::time::Instant::now());
            let authorize = || scoped_check(&app, &authority);
            let mut source = open_scoped(
                &app,
                &transport,
                &request,
                &mut cancel,
                &mut last_check,
                &authorize,
            )
            .await?;
            let result = async {
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
                pump(
                    &app,
                    source.as_mut(),
                    &sender,
                    &mut cancel,
                    &mut last_check,
                    &authorize,
                )
                .await
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
            interrupt_body(&sender, &interrupted);
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
