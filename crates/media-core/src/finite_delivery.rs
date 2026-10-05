//! Tracked finite Server deliveries. A producer, never the HTTP poller, owns
//! upstream bodies, large buffers and permits. Copied tail frames remain under
//! independent authority monitoring until consumed or positively discarded.
use anyhow::{Error, Result};
use axum::{
    body::{Body, Bytes},
    response::Response,
};
use futures_util::{StreamExt, future::BoxFuture, stream};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, oneshot, watch},
    time::Instant,
};
const CHUNK: usize = 16 * 1024;
const QUEUED: usize = 2;
const MAX_OWNERS: usize = 32;
const CHECK: Duration = Duration::from_millis(250);
const QUERY: Duration = Duration::from_secs(2);
fn unavailable() -> Error {
    anyhow::anyhow!("finite_delivery_ended")
}
#[derive(Clone, Copy)]
pub struct Evidence {
    pub grant_remaining: Duration,
    pub lease_remaining: Duration,
}
pub type Checker = Arc<dyn Fn() -> BoxFuture<'static, Result<Evidence>> + Send + Sync>;
#[derive(Clone, Copy)]
struct Receipt {
    source_disposed: bool,
    queue_disposed: bool,
}
struct Record {
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
#[derive(Default)]
struct State {
    closing: bool,
    next: u64,
    active: HashMap<u64, Record>,
    receipts: VecDeque<Receipt>,
    failed: bool,
}
pub struct Registry {
    state: Mutex<State>,
    count: watch::Sender<usize>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            state: Default::default(),
            count: watch::channel(0).0,
        }
    }
}
impl Registry {
    fn admit(self: &Arc<Self>) -> Result<Owner> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if state.closing || state.active.len() >= MAX_OWNERS {
            return Err(unavailable());
        }
        state.next = state.next.checked_add(1).ok_or_else(unavailable)?;
        let id = state.next;
        let (stop, receiver) = watch::channel(false);
        state.active.insert(id, Record { stop, task: None });
        self.count.send_replace(state.active.len());
        Ok(Owner {
            registry: self.clone(),
            id,
            stop: receiver,
            finished: false,
        })
    }
    fn track(&self, id: u64, task: tokio::task::JoinHandle<()>) {
        if let Ok(mut state) = self.state.lock()
            && let Some(record) = state.active.get_mut(&id)
        {
            record.task = Some(task);
        }
    }
    fn finish(&self, id: u64, receipt: Option<Receipt>) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(&id);
            if let Some(receipt) = receipt {
                state.receipts.push_back(receipt);
                while state.receipts.len() > 64 {
                    state.receipts.pop_front();
                }
            } else {
                state.failed = true;
            }
            self.count.send_replace(state.active.len());
        }
    }
    pub fn close_admission(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closing = true;
            for record in state.active.values() {
                record.stop.send_replace(true);
            }
        }
    }
    pub async fn drain(&self) -> anyhow::Result<()> {
        self.close_admission();
        let mut count = self.count.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            while *count.borrow_and_update() != 0 {
                count
                    .changed()
                    .await
                    .map_err(|_| anyhow::anyhow!("native_platform_delivery_drain_unconfirmed"))?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .map_err(|_| anyhow::anyhow!("native_platform_delivery_drain_unconfirmed"))??;
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("native_platform_delivery_drain_unconfirmed"))?;
        anyhow::ensure!(
            !state.failed
                && state.active.is_empty()
                && state
                    .receipts
                    .iter()
                    .all(|r| r.source_disposed && r.queue_disposed),
            "native_platform_delivery_disposal_unconfirmed"
        );
        Ok(())
    }
}
struct Owner {
    registry: Arc<Registry>,
    id: u64,
    stop: watch::Receiver<bool>,
    finished: bool,
}
impl Owner {
    async fn cancelled(&self) {
        let mut stop = self.stop.clone();
        while !*stop.borrow_and_update() {
            if stop.changed().await.is_err() {
                return;
            }
        }
    }
    fn complete(mut self) {
        self.finished = true;
        self.registry.finish(
            self.id,
            Some(Receipt {
                source_disposed: true,
                queue_disposed: true,
            }),
        );
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if !self.finished {
            self.registry.finish(self.id, None);
        }
    }
}
struct Confirmation {
    original_until: Option<Instant>,
    lease_until: Instant,
}
struct Authority {
    checker: Checker,
    confirmed: Mutex<Confirmation>,
}
impl Authority {
    fn new(checker: Checker) -> Self {
        Self {
            checker,
            confirmed: Mutex::new(Confirmation {
                original_until: None,
                lease_until: Instant::now() + QUERY,
            }),
        }
    }
    fn until(&self) -> Instant {
        let c = self.confirmed.lock().expect("native platform confirmation");
        c.original_until
            .map_or(c.lease_until, |until| until.min(c.lease_until))
    }
    async fn confirm(&self) -> Result<()> {
        let began = Instant::now();
        let prior = self.until();
        let evidence = tokio::select! {biased;_=tokio::time::sleep_until(prior)=>return Err(unavailable()),r=tokio::time::timeout(QUERY,(self.checker)())=>r.map_err(|_|unavailable())??};
        let now = Instant::now();
        let mut c = self.confirmed.lock().map_err(|_| unavailable())?;
        if now >= prior || evidence.grant_remaining.is_zero() || evidence.lease_remaining.is_zero()
        {
            return Err(unavailable());
        }
        let grant = began + evidence.grant_remaining;
        c.original_until = Some(c.original_until.map_or(grant, |old| old.min(grant)));
        c.lease_until = began + evidence.lease_remaining;
        if c.original_until.unwrap().min(c.lease_until) <= now {
            return Err(unavailable());
        }
        Ok(())
    }
}
#[derive(Default)]
struct QueueState {
    chunks: VecDeque<Bytes>,
    eof: bool,
    revoked: bool,
    alive: bool,
}
struct Queue {
    state: Mutex<QueueState>,
    changed: Notify,
}
impl Queue {
    fn new() -> Self {
        Self {
            state: Mutex::new(QueueState {
                alive: true,
                ..Default::default()
            }),
            changed: Notify::new(),
        }
    }
    fn discard(&self) {
        if let Ok(mut q) = self.state.lock() {
            q.chunks.clear();
            q.revoked = true;
            q.eof = true;
        }
        self.changed.notify_waiters();
    }
    fn source_done(&self) {
        if let Ok(mut q) = self.state.lock() {
            q.eof = true;
        }
        self.changed.notify_waiters();
    }
    fn tail_done(&self) -> bool {
        self.state.lock().map(|q| !q.alive).unwrap_or(true)
    }
    async fn closed(&self) {
        loop {
            let changed = self.changed.notified();
            if self
                .state
                .lock()
                .map(|q| !q.alive || q.revoked)
                .unwrap_or(true)
            {
                return;
            }
            changed.await;
        }
    }
    async fn push(&self, bytes: Bytes) -> Result<()> {
        loop {
            let changed = self.changed.notified();
            {
                let mut q = self.state.lock().map_err(|_| unavailable())?;
                if !q.alive || q.revoked {
                    return Err(unavailable());
                }
                if q.chunks.len() < QUEUED {
                    q.chunks.push_back(bytes);
                    drop(q);
                    self.changed.notify_waiters();
                    return Ok(());
                }
            }
            changed.await;
        }
    }
}
struct Receiver {
    queue: Arc<Queue>,
    authority: Arc<Authority>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        if let Ok(mut q) = self.queue.state.lock() {
            q.alive = false;
            q.chunks.clear();
        }
        self.queue.changed.notify_waiters();
    }
}
fn response_body(queue: Arc<Queue>, authority: Arc<Authority>) -> Body {
    let output = stream::try_unfold(Receiver { queue, authority }, |receiver| async move {
        loop {
            let queue = receiver.queue.clone();
            let notified = queue.changed.notified();
            if Instant::now() >= receiver.authority.until() {
                queue.discard();
                return Err(std::io::Error::other("native_platform_delivery_ended"));
            }
            let available = {
                let q = queue
                    .state
                    .lock()
                    .map_err(|_| std::io::Error::other("native_platform_delivery_ended"))?;
                if q.revoked {
                    return Err(std::io::Error::other("native_platform_delivery_ended"));
                }
                !q.chunks.is_empty() || q.eof
            };
            if available {
                // Authorize BEFORE removing a queued frame. A blocked read
                // check therefore retains no untracked in-flight payload; the
                // producer can discard all bytes synchronously on shutdown.
                let allowed = tokio::select! {biased;_=queue.closed()=>false,_=tokio::time::sleep_until(receiver.authority.until())=>false,result=receiver.authority.confirm()=>result.is_ok()};
                if !allowed {
                    queue.discard();
                    return Err(std::io::Error::other("native_platform_delivery_ended"));
                }
                let item = {
                    let mut q = queue
                        .state
                        .lock()
                        .map_err(|_| std::io::Error::other("native_platform_delivery_ended"))?;
                    if q.revoked {
                        return Err(std::io::Error::other("native_platform_delivery_ended"));
                    }
                    if let Some(bytes) = q.chunks.pop_front() {
                        Some(Some(bytes))
                    } else if q.eof {
                        Some(None)
                    } else {
                        None
                    }
                };
                if let Some(item) = item {
                    queue.changed.notify_waiters();
                    let Some(bytes) = item else { return Ok(None) };
                    return Ok(Some((bytes, receiver)));
                }
            }
            tokio::select! {biased;_=tokio::time::sleep_until(receiver.authority.until())=>{queue.discard();return Err(std::io::Error::other("native_platform_delivery_ended"));},_=notified=>{}}
        }
    });
    Body::from_stream(output)
}
async fn monitor(owner: &Owner, authority: &Authority, queue: Option<&Queue>) -> Result<()> {
    loop {
        tokio::select! {biased;_=owner.cancelled()=>return Err(unavailable()),_=async{if let Some(q)=queue{q.closed().await}else{futures_util::future::pending().await}}=>return Err(unavailable()),_=tokio::time::sleep_until(authority.until())=>return Err(unavailable()),_=tokio::time::sleep(CHECK)=>{}}
        tokio::select! {biased;_=owner.cancelled()=>return Err(unavailable()),_=tokio::time::sleep_until(authority.until())=>return Err(unavailable()),result=authority.confirm()=>result?}
    }
}
/// Admission happens before evaluating the prepare closure. A vanished HTTP
/// waiter cannot abandon a source/header future or a retained large buffer.
pub async fn serve<F, Fut, E>(
    registry: Arc<Registry>,
    checker: Checker,
    prepare: F,
    denied: Arc<dyn Fn() -> E + Send + Sync>,
) -> std::result::Result<Response, E>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = std::result::Result<Response, E>> + Send + 'static,
    E: Send + 'static,
{
    let owner = registry.admit().map_err(|_| denied())?;
    let id = owner.id;
    let authority = Arc::new(Authority::new(checker));
    let (sender, receiver) = oneshot::channel();
    let fallback = denied.clone();
    let task = tokio::spawn(async move {
        let mut sender = Some(sender);
        let mut prepare = Some(prepare);
        let prepared = {
            let initial = tokio::select! {biased;_=owner.cancelled()=>Err(unavailable()),_=sender.as_mut().unwrap().closed()=>Err(unavailable()),result=authority.confirm()=>result};
            match initial {
                Err(_) => Err(denied()),
                Ok(()) => {
                    let work = async {
                        let response = prepare.take().unwrap()().await?;
                        authority.confirm().await.map_err(|_| denied())?;
                        Ok::<_, E>(response)
                    };
                    tokio::pin!(work);
                    tokio::select! {biased;_=owner.cancelled()=>Err(denied()),_=sender.as_mut().unwrap().closed()=>Err(denied()),_=monitor(&owner,&authority,None)=>Err(denied()),result=&mut work=>result}
                }
            }
        };
        let response = match prepared {
            Ok(r) => r,
            Err(error) => {
                // The factory can own a preallocated payload/permit even if
                // initial authority failed before it was ever polled.
                drop(prepare.take());
                owner.complete();
                if let Some(sender) = sender.take() {
                    let _ = sender.send(Err(error));
                }
                return;
            }
        };
        let (parts, body) = response.into_parts();
        let queue = Arc::new(Queue::new());
        let output = response_body(queue.clone(), authority.clone());
        if sender
            .take()
            .unwrap()
            .send(Ok(Response::from_parts(parts, output)))
            .is_err()
        {
            drop(body);
            queue.discard();
            owner.complete();
            return;
        }
        let forwarded = {
            let work = async {
                let mut source = body.into_data_stream();
                while let Some(chunk) = source.next().await {
                    let bytes = chunk.map_err(|_| unavailable())?;
                    for part in bytes.chunks(CHUNK) {
                        authority.confirm().await?;
                        queue.push(Bytes::copy_from_slice(part)).await?;
                    }
                }
                Ok::<_, Error>(())
            };
            tokio::pin!(work);
            tokio::select! {biased;result=monitor(&owner,&authority,Some(&queue))=>result,result=&mut work=>result}
        };
        // The forwarding future/body/source has dropped before the tail phase.
        if forwarded.is_err() {
            queue.discard();
            owner.complete();
            return;
        }
        queue.source_done();
        // EOF is not response completion. Keep independent authority checks
        // until all copied tail frames are consumed, discarded or shut down.
        while !queue.tail_done() {
            tokio::select! {biased;_=owner.cancelled()=>{queue.discard();break;},_=tokio::time::sleep_until(authority.until())=>{queue.discard();break;},_=queue.changed.notified()=>{},_=tokio::time::sleep(CHECK)=>{let result=tokio::select!{biased;_=owner.cancelled()=>Err(unavailable()),_=tokio::time::sleep_until(authority.until())=>Err(unavailable()),r=authority.confirm()=>r};if result.is_err(){queue.discard();break;}}}
        }
        owner.complete();
    });
    registry.track(id, task);
    receiver.await.map_err(|_| fallback())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::{OwnedSemaphorePermit, Semaphore};
    struct Check {
        allowed: AtomicBool,
        blocked: AtomicBool,
        calls: AtomicUsize,
        ttl: Duration,
    }
    fn checker(state: Arc<Check>) -> Checker {
        Arc::new(move || {
            let state = state.clone();
            Box::pin(async move {
                state.calls.fetch_add(1, Ordering::SeqCst);
                if state.blocked.load(Ordering::SeqCst) {
                    futures_util::future::pending::<()>().await;
                }
                if !state.allowed.load(Ordering::SeqCst) {
                    return Err(unavailable());
                }
                Ok(Evidence {
                    grant_remaining: state.ttl,
                    lease_remaining: state.ttl,
                })
            })
        })
    }
    struct Source {
        bytes: Bytes,
        sent: bool,
        _permit: OwnedSemaphorePermit,
        dropped: Arc<AtomicBool>,
    }
    impl Drop for Source {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }
    fn source(value: Source) -> Body {
        Body::from_stream(stream::unfold(value, |mut value| async move {
            if value.sent {
                None
            } else {
                value.sent = true;
                Some((Ok::<_, std::io::Error>(value.bytes.clone()), value))
            }
        }))
    }
    async fn fixture(
        size: usize,
        ttl: Duration,
    ) -> (
        Arc<Registry>,
        Arc<Check>,
        Arc<Semaphore>,
        Arc<AtomicBool>,
        Response,
    ) {
        let registry = Arc::new(Registry::default());
        let check = Arc::new(Check {
            allowed: AtomicBool::new(true),
            blocked: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            ttl,
        });
        let semaphore = Arc::new(Semaphore::new(1));
        let dropped = Arc::new(AtomicBool::new(false));
        let payload = Source {
            bytes: Bytes::from(vec![7; size]),
            sent: false,
            _permit: semaphore.clone().acquire_owned().await.unwrap(),
            dropped: dropped.clone(),
        };
        let response = serve(
            registry.clone(),
            checker(check.clone()),
            move || async move { Ok::<_, Error>(Response::new(source(payload))) },
            Arc::new(unavailable),
        )
        .await
        .unwrap();
        (registry, check, semaphore, dropped, response)
    }
    async fn completed(registry: &Registry) {
        let mut count = registry.count.subscribe();
        tokio::time::timeout(Duration::from_secs(3), async {
            while *count.borrow_and_update() != 0 {
                count.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }
    async fn released(dropped: &AtomicBool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn unpolled_large_body_expires_and_positively_disposes_source_and_permit() {
        let (registry, _, semaphore, dropped, response) =
            fixture(8 * 1024 * 1024, Duration::from_millis(80)).await;
        completed(&registry).await;
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(semaphore.available_permits(), 1);
        assert!(
            axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .is_err()
        );
        registry.drain().await.unwrap();
    }
    #[tokio::test]
    async fn source_eof_keeps_copied_tail_under_independent_revocation() {
        let (registry, check, semaphore, dropped, response) =
            fixture(CHUNK * 2, Duration::from_secs(10)).await;
        released(&dropped).await;
        assert_eq!(semaphore.available_permits(), 1);
        assert_eq!(registry.state.lock().unwrap().active.len(), 1);
        check.allowed.store(false, Ordering::SeqCst);
        completed(&registry).await;
        assert!(
            axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .is_err()
        );
        registry.drain().await.unwrap();
    }
    #[tokio::test]
    async fn shutdown_discards_unpolled_body_and_closes_late_admission() {
        let (registry, check, semaphore, dropped, response) =
            fixture(8 * 1024 * 1024, Duration::from_secs(10)).await;
        check.blocked.store(true, Ordering::SeqCst);
        registry.drain().await.unwrap();
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(semaphore.available_permits(), 1);
        assert!(registry.admit().is_err());
        assert!(
            axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn header_waiter_drop_cancels_preparation_and_records_disposal() {
        let registry = Arc::new(Registry::default());
        let check = Arc::new(Check {
            allowed: AtomicBool::new(true),
            blocked: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            ttl: Duration::from_secs(10),
        });
        let semaphore = Arc::new(Semaphore::new(1));
        let dropped = Arc::new(AtomicBool::new(false));
        let payload = Source {
            bytes: Bytes::from(vec![3; 1024]),
            sent: false,
            _permit: semaphore.clone().acquire_owned().await.unwrap(),
            dropped: dropped.clone(),
        };
        let owned = registry.clone();
        let task = tokio::spawn(serve(
            owned,
            checker(check.clone()),
            move || async move {
                let _payload = payload;
                futures_util::future::pending::<Result<Response>>().await
            },
            Arc::new(unavailable),
        ));
        while check.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        task.abort();
        let _ = task.await;
        completed(&registry).await;
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(semaphore.available_permits(), 1);
        registry.drain().await.unwrap();
    }
    #[tokio::test]
    async fn a_missing_positive_disposal_receipt_is_not_a_successful_drain() {
        let registry = Arc::new(Registry::default());
        drop(registry.admit().unwrap());
        assert!(registry.drain().await.is_err());
    }
    #[tokio::test]
    async fn a_blocked_final_read_cannot_outlive_shutdown_disposal() {
        let (registry, check, semaphore, dropped, response) =
            fixture(CHUNK, Duration::from_secs(10)).await;
        released(&dropped).await;
        assert_eq!(semaphore.available_permits(), 1);
        check.blocked.store(true, Ordering::SeqCst);
        let before = check.calls.load(Ordering::SeqCst);
        let read = tokio::spawn(axum::body::to_bytes(response.into_body(), CHUNK));
        while check.calls.load(Ordering::SeqCst) == before {
            tokio::task::yield_now().await;
        }
        registry.drain().await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), read)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
    #[tokio::test]
    async fn rejected_initial_authority_drops_unstarted_factory_before_receipt() {
        let registry = Arc::new(Registry::default());
        let check = Arc::new(Check {
            allowed: AtomicBool::new(false),
            blocked: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            ttl: Duration::from_secs(10),
        });
        let semaphore = Arc::new(Semaphore::new(1));
        let dropped = Arc::new(AtomicBool::new(false));
        let payload = Source {
            bytes: Bytes::from(vec![3; 1024]),
            sent: false,
            _permit: semaphore.clone().acquire_owned().await.unwrap(),
            dropped: dropped.clone(),
        };
        assert!(
            serve(
                registry.clone(),
                checker(check),
                move || async move { Ok::<_, Error>(Response::new(source(payload))) },
                Arc::new(unavailable)
            )
            .await
            .is_err()
        );
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(semaphore.available_permits(), 1);
        registry.drain().await.unwrap();
    }
}
