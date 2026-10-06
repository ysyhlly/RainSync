//! Explicitly opt-in, fenced room control. Media state remains single-authority.
use crate::*;
use axum::body::{Body, to_bytes};
use axum::extract::{
    Request,
    ws::{Message, WebSocket},
};
use axum::middleware::Next;
use futures_util::{SinkExt, StreamExt};
use persistence::room_node_leases::{self as leases, Lease, Route};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

const PEER: &str = "x-rainsync-control-peer";
const SECRET: &str = "x-rainsync-control-secret";
const MAX_BODY: usize = 65536;
const MAX_RESPONSE: usize = 1048576;
const DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Settings {
    pub node: Uuid,
    pub instance: Uuid,
    media: bool,
    nodes: BTreeMap<Uuid, String>,
    secret: String,
}
impl Settings {
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        match std::env::var("RAINSYNC_CONTROL_CLUSTER").as_deref() {
            Err(_) | Ok("0") => return Ok(None),
            Ok("1") => (),
            _ => anyhow::bail!("RAINSYNC_CONTROL_CLUSTER must be 0 or 1"),
        }
        let node = Uuid::parse_str(&std::env::var("RAINSYNC_CONTROL_NODE_ID")?)?;
        anyhow::ensure!(!node.is_nil(), "invalid control node ID");
        let media = match std::env::var("RAINSYNC_CONTROL_ROLE").as_deref() {
            Ok("media") => true,
            Ok("control") => false,
            _ => anyhow::bail!("RAINSYNC_CONTROL_ROLE must be media or control"),
        };
        let raw: BTreeMap<Uuid, String> =
            serde_json::from_str(&std::env::var("RAINSYNC_CONTROL_NODES")?)?;
        anyhow::ensure!(
            !raw.is_empty() && raw.len() <= 32 && raw.contains_key(&node),
            "invalid control node allowlist"
        );
        let mut nodes = BTreeMap::new();
        for (id, origin) in raw {
            anyhow::ensure!(!id.is_nil(), "invalid control node ID");
            nodes.insert(id, normalize_origin(&origin)?);
        }
        let secret = std::env::var("RAINSYNC_CONTROL_PEER_TOKEN")?;
        anyhow::ensure!(
            (32..=256).contains(&secret.len()) && secret.bytes().all(|b| (33..=126).contains(&b)),
            "invalid control peer token"
        );
        Ok(Some(Self {
            node,
            instance: Uuid::new_v4(),
            media,
            nodes,
            secret,
        }))
    }
    pub fn media_authority(&self) -> bool {
        self.media
    }
    fn fingerprint(&self) -> String {
        hash(&json!([self.nodes, hash(&self.secret)]).to_string())
    }
}
fn normalize_origin(value: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(value)?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    anyhow::ensure!(
        value.len() <= 512
            && (url.scheme() == "https" || url.scheme() == "http" && local)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "invalid control node origin"
    );
    Ok(url.as_str().trim_end_matches('/').into())
}

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}
struct Inner {
    settings: Settings,
    db: PgPool,
    epoch: Uuid,
    start: Instant,
    live: AtomicBool,
    create_route: AtomicU64,
    owned: Mutex<HashMap<Uuid, Lease>>,
    fenced: Mutex<HashSet<Uuid>>,
    routes: Mutex<HashMap<Uuid, (Instant, Route)>>,
    http: reqwest::Client,
}
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
    fn now(&self) -> f64 {
        self.inner.start.elapsed().as_secs_f64() * 1000.0
    }
    pub fn node(&self) -> Uuid {
        self.inner.settings.node
    }
    pub fn close(&self) {
        self.inner.live.store(false, Ordering::Release);
    }
    pub fn healthy(&self) -> bool {
        self.inner.live.load(Ordering::Acquire)
    }
    pub fn media_authority(&self) -> bool {
        self.inner.settings.media
    }
    pub async fn owns(&self, lease: &Lease) -> bool {
        self.healthy()
            && self
                .inner
                .owned
                .lock()
                .await
                .get(&lease.room)
                .is_some_and(|current| current.fencing_token == lease.fencing_token)
    }
    pub async fn local_lease(&self, room: Uuid) -> anyhow::Result<Lease> {
        tokio::time::timeout(DEADLINE, self.local_lease_inner(room))
            .await
            .map_err(|_| anyhow::anyhow!("room_owner_unavailable"))?
    }
    async fn local_lease_inner(&self, room: Uuid) -> anyhow::Result<Lease> {
        anyhow::ensure!(self.healthy(), "control_node_unhealthy");
        anyhow::ensure!(
            !self.inner.fenced.lock().await.contains(&room),
            "room_owner_lost"
        );
        let mut owned = self.inner.owned.lock().await;
        if let Some(lease) = owned.get(&room) {
            return Ok(lease.clone());
        }
        let retired = self.inner.fenced.lock().await.len();
        anyhow::ensure!(owned.len() + retired < 1024, "control_room_budget_exceeded");
        let lease = tokio::time::timeout(
            Duration::from_secs(3),
            leases::claim(&self.inner.db, room, self.node()),
        )
        .await??
        .ok_or_else(|| anyhow::anyhow!("room_owner_changed"))?;
        anyhow::ensure!(
            lease.incarnation == self.inner.settings.instance,
            "control_node_incarnation_lost"
        );
        leases::prepare(&self.inner.db, &lease, self.inner.epoch, self.now()).await?;
        owned.insert(room, lease.clone());
        Ok(lease)
    }
    pub async fn invalidate(&self, room: Uuid) {
        self.inner.routes.lock().await.remove(&room);
    }
    fn trusted(&self, route: &Route) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.inner.settings.nodes.get(&route.node) == Some(&route.origin),
            "untrusted_control_route"
        );
        Ok(())
    }
    pub async fn resolve(&self, room: Uuid) -> anyhow::Result<Route> {
        anyhow::ensure!(self.healthy(), "control_node_unhealthy");
        if let Some((when, route)) = self.inner.routes.lock().await.get(&room).cloned()
            && when.elapsed() < Duration::from_millis(250)
        {
            self.trusted(&route)?;
            return Ok(route);
        }
        let mut route =
            tokio::time::timeout(Duration::from_secs(2), leases::route(&self.inner.db, room))
                .await??;
        if route.is_none() {
            match self.local_lease(room).await {
                Ok(_) => route = leases::route(&self.inner.db, room).await?,
                Err(error) if error.to_string() == "room_owner_changed" => {
                    route = leases::route(&self.inner.db, room).await?
                }
                Err(error) => return Err(error),
            }
        }
        let route = route.ok_or_else(|| anyhow::anyhow!("room_owner_unavailable"))?;
        self.trusted(&route)?;
        if route.node == self.node() {
            self.local_lease(room).await?;
        }
        let mut cache = self.inner.routes.lock().await;
        if cache.len() >= 1024 {
            cache.clear()
        }
        cache.insert(room, (Instant::now(), route.clone()));
        Ok(route)
    }
    async fn new_room_route(&self) -> anyhow::Result<Route> {
        let rows=tokio::time::timeout(Duration::from_secs(2),sqlx::query("SELECT id,route_origin FROM control_nodes WHERE heartbeat_at>clock_timestamp()-interval '10 seconds' ORDER BY id LIMIT 32").fetch_all(&self.inner.db)).await??;
        let mut nodes: Vec<Route> = rows
            .into_iter()
            .filter_map(|row| {
                let route = Route {
                    node: row.get("id"),
                    origin: row.get("route_origin"),
                    fencing_token: 0,
                    remaining_ms: 0,
                };
                self.trusted(&route).ok().map(|_| route)
            })
            .collect();
        anyhow::ensure!(!nodes.is_empty(), "room_owner_unavailable");
        let local = nodes
            .iter()
            .position(|node| node.node == self.node())
            .unwrap_or(0);
        let next = self.inner.create_route.fetch_add(1, Ordering::Relaxed) as usize;
        let index = (local + next) % nodes.len();
        Ok(nodes.swap_remove(index))
    }
    fn peer(&self, h: &HeaderMap) -> bool {
        let Some(node) = h
            .get(PEER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| Uuid::parse_str(v).ok())
        else {
            return false;
        };
        let Some(secret) = h.get(SECRET).and_then(|v| v.to_str().ok()) else {
            return false;
        };
        let lhs = Sha256::digest(secret.as_bytes());
        let rhs = Sha256::digest(self.inner.settings.secret.as_bytes());
        self.inner.settings.nodes.contains_key(&node)
            && lhs.iter().zip(rhs).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
    }
}

pub fn routes() -> Router<App> {
    Router::new().route("/_rainsync/control/ws/{room}", get(peer_socket))
}
async fn peer_socket(
    State(app): State<App>,
    Path(room): Path<Uuid>,
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let cluster = app
        .control_cluster
        .as_ref()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    if !cluster.peer(&h) {
        return Err(err(StatusCode::FORBIDDEN, "control_peer_rejected"));
    }
    let user_id = h
        .get("x-rainsync-control-user")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| err(StatusCode::FORBIDDEN, "control_peer_rejected"))?;
    let session = h
        .get("x-rainsync-control-session")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| err(StatusCode::FORBIDDEN, "control_peer_rejected"))?
        .to_string();
    let admin:Option<bool>=tokio::time::timeout(Duration::from_secs(2),sqlx::query_scalar("SELECT u.admin FROM sessions s JOIN users u ON u.id=s.user_id JOIN room_members m ON m.user_id=u.id AND m.room_id=$3 WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>clock_timestamp()")
        .bind(&session).bind(user_id).bind(room).fetch_optional(&app.db)).await
        .map_err(|_|err(StatusCode::SERVICE_UNAVAILABLE,"room_owner_unavailable"))??;
    let user = User {
        id: user_id,
        admin: admin.ok_or_else(|| err(StatusCode::FORBIDDEN, "session_expired"))?,
    };
    let route = cluster
        .resolve(room)
        .await
        .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "room_owner_changed"))?;
    if route.node != cluster.node() {
        return Err(err(StatusCode::CONFLICT, "room_owner_changed"));
    }
    Ok(ws
        .max_message_size(MAX_BODY)
        .max_frame_size(MAX_BODY)
        .on_upgrade(move |socket| rooms::socket_on_owner(app, user, socket, session)))
}

/// Only room-control routes are peer-forwarded. Media/account/OAuth/agent state
/// must stay on the sole media authority; unknown control-node routes fail closed.
fn room_path(path: &str) -> Option<Uuid> {
    let mut parts = path.strip_prefix("/api/v1/rooms/")?.split('/');
    let room = Uuid::parse_str(parts.next()?).ok()?;
    let tail = parts.collect::<Vec<_>>().join("/");
    let control = tail.is_empty()
        || matches!(
            tail.as_str(),
            "join"
                | "invites"
                | "playlist"
                | "messages"
                | "members"
                | "permissions"
                | "ownership"
                | "owner"
                | "lifecycle"
                | "close"
                | "reopen"
                | "archive"
        )
        || tail.starts_with("permissions/")
        || tail.starts_with("members/")
        || tail.starts_with("invites/")
        || tail.starts_with("playlist/")
        || tail.starts_with("timeline/");
    control.then_some(room)
}
fn node_route(path: &str) -> bool {
    matches!(
        path,
        "/ready"
            | "/api/v1/deployment/ready"
            | "/api/v1/ws"
            | "/api/v1/rooms"
            | "/api/v1/auth/me"
            | "/health"
            | "/api/v1/deployment/health"
            | "/api/v1/metrics"
    )
}
pub async fn middleware(State(app): State<App>, request: Request, next: Next) -> Response {
    let Some(cluster) = app.control_cluster.as_ref() else {
        return next.run(request).await;
    };
    if !cluster.healthy() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "control_node_unhealthy").into_response();
    }
    let path = request.uri().path();
    let peer = cluster.peer(request.headers());
    if (request.headers().contains_key(PEER) || request.headers().contains_key(SECRET)) && !peer {
        return err(StatusCode::FORBIDDEN, "control_peer_rejected").into_response();
    }
    if path.starts_with("/_rainsync/control/") {
        return if peer {
            next.run(request).await
        } else {
            err(StatusCode::FORBIDDEN, "control_peer_rejected").into_response()
        };
    }
    let room = room_path(path);
    let route = if path == "/api/v1/rooms" && request.method() == axum::http::Method::POST && !peer
    {
        match cluster.new_room_route().await {
            Ok(route) => route,
            Err(_) => {
                return err(StatusCode::SERVICE_UNAVAILABLE, "room_owner_unavailable")
                    .into_response();
            }
        }
    } else if let Some(room) = room {
        match cluster.resolve(room).await {
            Ok(route) => route,
            Err(_) => {
                return err(StatusCode::SERVICE_UNAVAILABLE, "room_owner_unavailable")
                    .into_response();
            }
        }
    } else {
        return if cluster.media_authority() || node_route(path) {
            next.run(request).await
        } else {
            err(StatusCode::SERVICE_UNAVAILABLE, "media_authority_required").into_response()
        };
    };
    if route.node == cluster.node() {
        return next.run(request).await;
    }
    if peer {
        return err(StatusCode::CONFLICT, "room_owner_changed").into_response();
    }
    let (parts, body) = request.into_parts();
    let body = match tokio::time::timeout(DEADLINE, to_bytes(body, MAX_BODY)).await {
        Ok(Ok(body)) => body,
        _ => {
            return err(StatusCode::PAYLOAD_TOO_LARGE, "control_request_too_large").into_response();
        }
    };
    let uri = format!(
        "{}{}",
        route.origin,
        parts.uri.path_and_query().map_or("", |p| p.as_str())
    );
    let mut outgoing = cluster
        .inner
        .http
        .request(parts.method, uri)
        .header(PEER, cluster.node().to_string())
        .header(SECRET, &cluster.inner.settings.secret)
        .body(body);
    for name in [
        header::COOKIE,
        header::ORIGIN,
        header::CONTENT_TYPE,
        header::ACCEPT,
    ] {
        if let Some(value) = parts.headers.get(&name) {
            outgoing = outgoing.header(name, value)
        }
    }
    if let Some(value) = parts.headers.get("x-csrf-token") {
        outgoing = outgoing.header("x-csrf-token", value)
    }
    for value in parts.headers.get_all("idempotency-key").iter() {
        outgoing = outgoing.header("idempotency-key", value.clone())
    }
    let result = tokio::time::timeout(DEADLINE, async {
        let response = outgoing.send().await?;
        let status = response.status();
        let headers = response.headers().clone();
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            anyhow::ensure!(
                body.len() + chunk.len() <= MAX_RESPONSE,
                "control_response_too_large"
            );
            body.extend_from_slice(&chunk)
        }
        let mut response = Response::builder().status(status).body(Body::from(body))?;
        for name in [
            header::CONTENT_TYPE,
            header::CACHE_CONTROL,
            header::RETRY_AFTER,
            header::VARY,
        ] {
            if let Some(value) = headers.get(&name) {
                response.headers_mut().insert(name, value.clone());
            }
        }
        Ok::<_, anyhow::Error>(response)
    })
    .await;
    match result {
        Ok(Ok(response)) => response,
        _ => {
            if let Some(room) = room {
                cluster.invalidate(room).await;
            }
            err(StatusCode::SERVICE_UNAVAILABLE, "room_owner_unavailable").into_response()
        }
    }
}

pub async fn proxy_socket(
    cluster: Runtime,
    route: Route,
    user: Uuid,
    session: String,
    first: String,
    mut out: futures_util::stream::SplitSink<WebSocket, Message>,
    mut input: futures_util::stream::SplitStream<WebSocket>,
) {
    let result=async {
        cluster.trusted(&route)?;
        let origin=route.origin.replacen("https://","wss://",1).replacen("http://","ws://",1);
        let initial:Value=serde_json::from_str(&first)?;
        let room=Uuid::parse_str(initial["room_id"].as_str().ok_or_else(||anyhow::anyhow!("invalid room"))?)?;
        let mut request=format!("{origin}/_rainsync/control/ws/{room}").into_client_request()?;
        request.headers_mut().insert(PEER,cluster.node().to_string().parse()?);
        request.headers_mut().insert(SECRET,cluster.inner.settings.secret.parse()?);
        request.headers_mut().insert("x-rainsync-control-user",user.to_string().parse()?);
        request.headers_mut().insert("x-rainsync-control-session",session.parse()?);
        let mut config=tungstenite::protocol::WebSocketConfig::default();
        config.max_message_size=Some(MAX_BODY);config.max_frame_size=Some(MAX_BODY);config.max_write_buffer_size=MAX_RESPONSE;
        let (upstream,_)=tokio::time::timeout(DEADLINE,tokio_tungstenite::connect_async_with_config(request,Some(config),false)).await??;
        let (mut peer_out,mut peer_in)=upstream.split();
        tokio::time::timeout(DEADLINE,peer_out.send(tungstenite::Message::Text(first.into()))).await??;
        let mut ownership=tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                _=ownership.tick()=>{
                    let current=tokio::time::timeout(Duration::from_secs(2),leases::route(&cluster.inner.db,room)).await;
                    if !matches!(current,Ok(Ok(Some(ref current))) if current.node==route.node && current.fencing_token==route.fencing_token) {break}
                }
                message=input.next()=>{
                    let Some(Ok(message))=message else {break};
                    let close=matches!(message,Message::Close(_));
                    let message=match message {Message::Text(t)=>tungstenite::Message::Text(t.to_string().into()),Message::Binary(b)=>tungstenite::Message::Binary(b),Message::Ping(b)=>tungstenite::Message::Ping(b),Message::Pong(b)=>tungstenite::Message::Pong(b),Message::Close(_)=>tungstenite::Message::Close(None)};
                    tokio::time::timeout(DEADLINE,peer_out.send(message)).await??;
                    if close {break}
                }
                message=peer_in.next()=>{
                    let Some(Ok(message))=message else {break};
                    let close=matches!(message,tungstenite::Message::Close(_));
                    let message=match message {tungstenite::Message::Text(t)=>Message::Text(t.to_string().into()),tungstenite::Message::Binary(b)=>Message::Binary(b),tungstenite::Message::Ping(b)=>Message::Ping(b),tungstenite::Message::Pong(b)=>Message::Pong(b),tungstenite::Message::Close(_)=>Message::Close(None),tungstenite::Message::Frame(_)=>continue};
                    tokio::time::timeout(DEADLINE,out.send(message)).await??;
                    if close {break}
                }
            }
        }
        Ok::<_,anyhow::Error>(())
    }.await;
    if result.is_err() {
        let _ = tokio::time::timeout(
            DEADLINE,
            out.send(Message::Text(
                json!({"type":"ERROR","error":{"code":"SERVICE_UNAVAILABLE","retryable":true}})
                    .to_string()
                    .into(),
            )),
        )
        .await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), out.send(Message::Close(None))).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_never_accept_credentials_paths_or_remote_plaintext() {
        for origin in [
            "http://example.com",
            "https://node.example/path",
            "https://x@y.example",
            "https://node.example/?x=1",
            "https://node.example/#x",
        ] {
            assert!(normalize_origin(origin).is_err(), "{origin}")
        }
        assert_eq!(
            normalize_origin("http://127.0.0.1:8201/").unwrap(),
            "http://127.0.0.1:8201"
        );
    }
    #[test]
    fn media_routes_never_enter_the_room_control_proxy() {
        let room = Uuid::new_v4();
        assert_eq!(
            room_path(&format!("/api/v1/rooms/{room}/timeline/current")),
            Some(room)
        );
        for tail in ["permissions", "permissions/user", "members/user"] {
            assert_eq!(
                room_path(&format!("/api/v1/rooms/{room}/{tail}")),
                Some(room)
            );
        }
        for tail in [
            "playback-plan",
            "compute/jobs",
            "platform-media",
            "sources",
            "p2p",
        ] {
            assert!(room_path(&format!("/api/v1/rooms/{room}/{tail}")).is_none())
        }
    }
}
