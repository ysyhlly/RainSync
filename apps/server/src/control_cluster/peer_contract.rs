//! Actual production proxy_socket via real Axum upgrade; remote is an owned wire witness, not authority.
use super::*;
use anyhow::{Result, ensure};
use axum::extract::ws::WebSocketUpgrade;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite;
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
struct HeaderRecorder {
    events: mpsc::UnboundedSender<Value>,
}
impl tungstenite::handshake::server::Callback for HeaderRecorder {
    fn on_request(
        self,
        request: &tungstenite::handshake::server::Request,
        response: tungstenite::handshake::server::Response,
    ) -> std::result::Result<
        tungstenite::handshake::server::Response,
        tungstenite::handshake::server::ErrorResponse,
    > {
        let h = request.headers();
        let field = |name: &str| h.get(name).and_then(|value| value.to_str().ok());
        let _ = self.events.send(json!({"kind":"headers","path":request.uri().path(),"peer":field(PEER),"user":field("x-rainsync-control-user"),"session_is_expected":field("x-rainsync-control-session")==Some("a".repeat(64).as_str()),"secret_is_expected":field(SECRET)==Some("owned-peer-secret")}));
        Ok(response)
    }
}
async fn observe(db: &PgPool) -> Result<Value> {
    let mut tables = serde_json::Map::new();
    for name in [
        "rooms",
        "room_leases",
        "control_nodes",
        "room_snapshots",
        "command_results",
        "room_events",
    ] {
        let rows:Value=sqlx::query_scalar(&format!("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {name} t")).fetch_one(db).await?;
        tables.insert(name.into(), rows);
    }
    Ok(Value::Object(tables))
}
async fn join_owned<T>(task: &mut tokio::task::JoinHandle<Result<T>>, label: &str) -> Result<T> {
    match tokio::time::timeout(Duration::from_secs(10), &mut *task).await {
        Ok(result) => result?,
        Err(error) => {
            task.abort();
            let reaped = task.await;
            anyhow::bail!(
                "{label} observation timeout: {error}; aborted task terminal={}",
                reaped.is_err()
            );
        }
    }
}
#[tokio::test]
#[ignore = "requires cluster-peer-lifetime-native.mjs owned full PG"]
async fn owned_peer_lifetime() -> Result<()> {
    ensure!(std::env::var_os("DATABASE_URL").is_none());
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST")? == "1");
    let url = std::env::var("RAINSYNC_CLUSTER_PEER_DATABASE_URL")?;
    ensure!(url == std::env::var("RAINSYNC_CLUSTER_PEER_EXPECTED_DATABASE_URL")?);
    ensure!(url.starts_with("postgres://rainsync:") && url.contains("@127.0.0.1:"));
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_CLUSTER_PEER_RUN_ID")?)?;
    let db = persistence::connect(&url).await?;
    let owner: Uuid = sqlx::query_scalar(
        "SELECT run_id FROM rainsync_cluster_peer_fixture_owner WHERE singleton",
    )
    .fetch_one(&db)
    .await?;
    ensure!(owner == run);
    persistence::migrate(&db).await?;
    let (local, remote, instance, remote_instance, room, user) =
        (id(301), id(302), id(303), id(304), id(305), id(306));
    sqlx::raw_sql(&format!("INSERT INTO users(id,username,password_hash,admin) VALUES('{user}','peer-owned','!',true);INSERT INTO rooms(id,name,owner_id) VALUES('{room}','peer-owned','{user}');")).execute(&db).await?;
    let remote_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let remote_address = remote_listener.local_addr()?;
    let origin = format!("http://{remote_address}");
    leases::register_instance(&db, local, instance, "http://127.0.0.1:41001").await?;
    leases::register_instance(&db, remote, remote_instance, &origin).await?;
    sqlx::query("UPDATE control_nodes SET heartbeat_at='2100-01-01'")
        .execute(&db)
        .await?;
    let initial = leases::claim(&db, room, remote)
        .await?
        .ok_or_else(|| anyhow::anyhow!("legal initial claim missing"))?;
    let runtime = Runtime {
        inner: Arc::new(Inner {
            settings: Settings {
                node: local,
                instance,
                media: false,
                nodes: BTreeMap::from([
                    (local, "http://127.0.0.1:41001".into()),
                    (remote, origin.clone()),
                ]),
                secret: "owned-peer-secret".into(),
            },
            db: db.clone(),
            epoch: id(307),
            start: Instant::now(),
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
    let route = runtime.resolve(room).await?;
    let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let local_address = local_listener.local_addr()?;
    let (events, mut received) = mpsc::unbounded_channel::<Value>();
    let (stop_remote, mut remote_stop) = tokio::sync::oneshot::channel();
    let mut remote_task = Some(tokio::spawn(async move {
        let (stream, _) = tokio::select! {accepted=remote_listener.accept()=>accepted?,_=&mut remote_stop=>return Ok::<_,anyhow::Error>(())};
        let header_events = events.clone();
        let handshake = tokio_tungstenite::accept_hdr_async(
            stream,
            HeaderRecorder {
                events: header_events,
            },
        );
        let mut ws = tokio::select! {result=tokio::time::timeout(Duration::from_secs(10),handshake)=>result??,_=&mut remote_stop=>return Ok(())};
        'wire: loop {
            tokio::select! {
             _=&mut remote_stop=>break,
             message=ws.next()=>{let Some(message)=message else{events.send(json!({"kind":"transport_terminal","category":"eof"}))?;break};let message=match message {Ok(message)=>message,Err(error)=>{events.send(json!({"kind":"transport_terminal","category":format!("{error}")}))?;break;}};match message {
              tungstenite::Message::Text(text)=>{events.send(json!({"kind":"text","value":text.to_string()}))?;tokio::select!{result=tokio::time::timeout(Duration::from_secs(10),ws.send(tungstenite::Message::Text("owned-response".into())))=>{result??;},_=&mut remote_stop=>break 'wire};},
              tungstenite::Message::Binary(bytes)=>{events.send(json!({"kind":"binary","bytes":bytes.to_vec()}))?;tokio::select!{result=tokio::time::timeout(Duration::from_secs(10),ws.send(tungstenite::Message::Binary(bytes)))=>{result??;},_=&mut remote_stop=>break 'wire};},
              tungstenite::Message::Close(_)=>{events.send(json!({"kind":"close"}))?;break;},_=>{}
             }}
            }
        }
        Ok::<_, anyhow::Error>(())
    }));
    let mut stop_remote = Some(stop_remote);
    let mut remote_closed_early = false;
    let (stop_local, local_stop) = tokio::sync::oneshot::channel();
    let relay = runtime.clone();
    let started = Arc::new(AtomicU64::new(0));
    let completed = Arc::new(AtomicU64::new(0));
    let handler_started = started.clone();
    let handler_completed = completed.clone();
    let (finished, mut done) = mpsc::unbounded_channel();
    let router = axum::Router::new().route(
        "/owned-peer",
        axum::routing::get(move |ws: WebSocketUpgrade| {
            let relay = relay.clone();
            let route = route.clone();
            let finished = finished.clone();
            let started = handler_started.clone();
            let completed = handler_completed.clone();
            async move {
                ws.on_upgrade(move |socket| async move {
                    started.fetch_add(1, Ordering::SeqCst);
                    let (out, input) = socket.split();
                    proxy_socket(
                        relay,
                        route,
                        user,
                        "a".repeat(64),
                        json!({"type":"JOIN","room_id":room}).to_string(),
                        out,
                        input,
                    )
                    .await;
                    completed.fetch_add(1, Ordering::SeqCst);
                    let _ = finished.send(());
                })
            }
        }),
    );
    let local_task = tokio::spawn(async move {
        axum::serve(local_listener, router)
            .with_graceful_shutdown(async {
                let _ = local_stop.await;
            })
            .await
            .map_err(anyhow::Error::from)
    });
    // Every spawned listener/task is awaited after the body even if an assertion fails.
    let outcome=tokio::time::timeout(Duration::from_secs(60),async {
  let before=observe(&db).await?;
  let(mut client,_)=tokio::time::timeout(Duration::from_secs(10),tokio_tungstenite::connect_async(format!("ws://{local_address}/owned-peer"))).await??;
  let headers=tokio::time::timeout(DEADLINE,received.recv()).await?.ok_or_else(||anyhow::anyhow!("missing headers"))?;
  ensure!(headers["peer"]==local.to_string()&&headers["user"]==user.to_string()&&headers["session_is_expected"]==true&&headers["secret_is_expected"]==true);
  let first=tokio::time::timeout(DEADLINE,received.recv()).await?.ok_or_else(||anyhow::anyhow!("missing owned wire event"))?;ensure!(first["kind"]=="text");
  let original:Value=serde_json::from_str(first["value"].as_str().ok_or_else(||anyhow::anyhow!("first message not text"))?)?;ensure!(original["room_id"]==room.to_string());
  let reply=tokio::time::timeout(DEADLINE,client.next()).await?.ok_or_else(||anyhow::anyhow!("missing owned wire event"))??;ensure!(reply.into_text()?=="owned-response");
  tokio::time::timeout(Duration::from_secs(10),client.send(tungstenite::Message::Binary(vec![0,1,255].into()))).await??;
  let binary=tokio::time::timeout(DEADLINE,received.recv()).await?.ok_or_else(||anyhow::anyhow!("missing owned wire event"))?;ensure!(binary==json!({"kind":"binary","bytes":[0,1,255]}));
  let echo=tokio::time::timeout(DEADLINE,client.next()).await?.ok_or_else(||anyhow::anyhow!("missing owned wire event"))??;ensure!(echo.into_data().to_vec()==vec![0,1,255]);
  ensure!(before==observe(&db).await?);
  println!("\nPASS: owned cluster peer exact_headers_first_and_bidirectional_frames");
  // Lawful expiry fixture only; replacement authority comes solely from original claim.
  sqlx::query("UPDATE room_leases SET lease_until='2000-01-01' WHERE room_id=$1").bind(room).execute(&db).await?;
  let replacement=leases::claim(&db,room,local).await?.ok_or_else(||anyhow::anyhow!("legal replacement claim missing"))?;
  ensure!(replacement.node==local&&replacement.fencing_token>initial.fencing_token);
  let closed=tokio::time::timeout(DEADLINE,client.next()).await?.ok_or_else(||anyhow::anyhow!("missing explicit close"))??;ensure!(matches!(closed,tungstenite::Message::Close(_)));
  tokio::time::timeout(DEADLINE,done.recv()).await?.ok_or_else(||anyhow::anyhow!("missing actual relay completion"))?;
  let remote_close=tokio::time::timeout(DEADLINE,received.recv()).await?.ok_or_else(||anyhow::anyhow!("missing remote close"))?;ensure!(remote_close["kind"]=="close"||remote_close["kind"]=="transport_terminal");
  println!("\nPASS: owned cluster peer legal_claim_changed_node_token_closes_both_live");
  if let Some(stop)=stop_remote.take(){let _=stop.send(());}
  if let Some(mut task)=remote_task.take(){join_owned(&mut task,"remote_stop").await?;remote_closed_early=true;}
  let(mut error_client,_)=tokio::time::timeout(Duration::from_secs(10),tokio_tungstenite::connect_async(format!("ws://{local_address}/owned-peer"))).await??;
  let error_message=tokio::time::timeout(DEADLINE,error_client.next()).await?.ok_or_else(||anyhow::anyhow!("missing owned wire event"))??;
  let error_value:Value=serde_json::from_str(error_message.into_text()?.as_str())?;
  ensure!(error_value["type"]=="ERROR"&&error_value["error"]["code"]=="SERVICE_UNAVAILABLE"&&error_value["error"]["retryable"]==true);
  let error_close=tokio::time::timeout(DEADLINE,error_client.next()).await?.ok_or_else(||anyhow::anyhow!("missing owned wire event"))??;ensure!(matches!(error_close,tungstenite::Message::Close(_)));
  tokio::time::timeout(DEADLINE,done.recv()).await?.ok_or_else(||anyhow::anyhow!("missing failed relay completion"))?;
  println!("\nPASS: owned cluster peer upstream_refused_error_and_close");
  let evidence=json!({"cases":[{"case":"exact_headers_first_and_bidirectional_frames","before":before,"headers":headers,"first":first,"binary":binary},{"case":"legal_claim_changed_node_token_closes_both_live","after":observe(&db).await?,"initial_token":initial.fencing_token,"replacement_token":replacement.fencing_token,"remote_close":remote_close},{"case":"upstream_refused_error_and_close","error":error_value}],"scope":"actual proxy_socket via test-only real Axum upgrade; remote owned wire witness is not production peer authorization; runtime background renewal intentionally not started"});
  std::fs::write(std::env::var("RAINSYNC_CLUSTER_PEER_OBSERVATION")?,serde_json::to_vec_pretty(&evidence)?)?;
  Ok::<_,anyhow::Error>(())
 }).await.map_err(anyhow::Error::from).and_then(|result|result);
    if let Some(stop) = stop_remote.take() {
        let _ = stop.send(());
    }
    let _ = stop_local.send(());
    let remote_result = if let Some(mut task) = remote_task.take() {
        join_owned(&mut task, "remote_cleanup").await
    } else if remote_closed_early {
        Ok(())
    } else {
        Err(anyhow::anyhow!("remote task earlier close unconfirmed"))
    };
    let mut local_task = local_task;
    let local_result = join_owned(&mut local_task, "local_cleanup").await;
    let relay_result = tokio::time::timeout(Duration::from_secs(10), async {
        while completed.load(Ordering::SeqCst) != started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let ports_closed = matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect(local_address)
        )
        .await,
        Ok(Err(_))
    ) && matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect(remote_address)
        )
        .await,
        Ok(Err(_))
    );
    let cleanup = json!({"local_port":local_address.port(),"remote_port":remote_address.port(),"ports_closed":ports_closed,"remote_task_closed":remote_result.is_ok(),"local_task_closed":local_result.is_ok(),"relay_started":started.load(Ordering::SeqCst),"relay_completed":completed.load(Ordering::SeqCst),"relay_completion_observed":relay_result.is_ok()});
    let cleanup_path = std::env::var("RAINSYNC_CLUSTER_PEER_CLEANUP");
    let cleanup_write = cleanup_path.map_err(anyhow::Error::from).and_then(|path| {
        std::fs::write(path, serde_json::to_vec_pretty(&cleanup)?).map_err(anyhow::Error::from)
    });
    db.close().await;
    let mut failures = Vec::new();
    if let Err(error) = outcome {
        failures.push(format!("body: {error:#}"));
    }
    if let Err(error) = remote_result {
        failures.push(format!("remote: {error:#}"));
    }
    if let Err(error) = local_result {
        failures.push(format!("local: {error:#}"));
    }
    if let Err(error) = relay_result {
        failures.push(format!("relay completion: {error}"));
    }
    if let Err(error) = cleanup_write {
        failures.push(format!("cleanup evidence: {error:#}"));
    }
    if !ports_closed {
        failures.push("ports not closed".into());
    }
    ensure!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}
