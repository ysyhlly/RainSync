use super::*;
use axum::extract::ws::Message;
use futures_util::{SinkExt, StreamExt};

pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&auth(&app, &h, false).await?)?;
    let rows = sqlx::query("SELECT id,name,revoked,last_seen::text FROM agents")
        .fetch_all(&app.db)
        .await?;
    Ok(Json(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"revoked":r.get::<bool,_>("revoked"),"last_seen":r.get::<Option<String>,_>("last_seen")})).collect())))
}
pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<rooms::Name>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    let id = Uuid::new_v4();
    let code = token();
    sqlx::query("INSERT INTO agents(id,name,pair_hash,pair_expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')").bind(id).bind(body.name).bind(hash(&code)).execute(&app.db).await?;
    Ok(Json(json!({"id":id,"pair_code":code})))
}
#[derive(Deserialize)]
pub struct Pair {
    code: String,
}
pub async fn pair(State(app): State<App>, Json(body): Json<Pair>) -> Result<Json<Value>> {
    let t = token();
    let id:Option<Uuid>=sqlx::query_scalar("UPDATE agents SET token_hash=$2,pair_hash=NULL WHERE pair_hash=$1 AND pair_expires_at>now() AND NOT revoked RETURNING id").bind(hash(&body.code)).bind(hash(&t)).fetch_optional(&app.db).await?;
    let id = id.ok_or_else(|| err(StatusCode::FORBIDDEN, "pair_code_invalid"))?;
    Ok(Json(json!({"agent_id":id,"token":t})))
}
pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    sqlx::query("UPDATE agents SET revoked=true,token_hash=NULL WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn connect(
    State(app): State<App>,
    h: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response> {
    let t = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "agent_token_required"))?;
    let id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM agents WHERE token_hash=$1 AND NOT revoked")
            .bind(hash(t))
            .fetch_optional(&app.db)
            .await?;
    let id = id.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_agent"))?;
    Ok(upgrade.max_message_size(1024 * 1024).max_frame_size(1024 * 1024).on_upgrade(move |socket| async move {
        let (mut out, mut input) = socket.split();
        let (pages, incoming) = tokio::sync::mpsc::channel(1);
        let (acks, mut completed) = tokio::sync::mpsc::channel(1);
        let ingest_app = app.clone();
        let ingest = tokio::spawn(async move {
            if ingest_index(ingest_app, id, incoming, acks.clone()).await.is_err() {
                let _ = acks.send(json!({"type":"INDEX_ERROR"})).await;
            }
        });
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        loop { tokio::select! {
            ack = completed.recv() => {
                let Some(ack) = ack else { break };
                let failed = ack["type"] == "INDEX_ERROR";
                if !matches!(tokio::time::timeout(std::time::Duration::from_secs(3), out.send(Message::Text(ack.to_string().into()))).await, Ok(Ok(()))) || failed { break }
            }
            _ = tick.tick() => {
                let valid = sqlx::query("UPDATE agents SET last_seen=now() WHERE id=$1 AND NOT revoked RETURNING id").bind(id).fetch_optional(&app.db).await;
                if !matches!(valid, Ok(Some(_))) { break }
                // Lock only the next transfer. Unsent rows never become claimed.
                let result: anyhow::Result<()> = async {
                    // One bounded send per select iteration keeps heartbeats,
                    // index acknowledgements and incoming frames responsive.
                        let mut tx = app.db.begin().await?;
                        let row = sqlx::query("SELECT id,request FROM agent_transfers WHERE agent_id=$1 AND NOT claimed AND expires_at>now() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 1").bind(id).fetch_optional(&mut *tx).await?;
                        let Some(row) = row else { return Ok(()) };
                        let transfer: Uuid = row.get("id");
                        let request: Value = row.get("request");
                        tokio::time::timeout(std::time::Duration::from_secs(3), out.send(Message::Text(json!({"type":"TRANSFER","id":transfer,"request":request}).to_string().into()))).await??;
                        sqlx::query("UPDATE agent_transfers SET claimed=true WHERE id=$1").bind(transfer).execute(&mut *tx).await?;
                        tx.commit().await?;
                    Ok(())
                }.await;
                if result.is_err() { break }
            }
            message = input.next() => {
                match message {
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                    Some(Ok(Message::Text(text))) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                        if value["type"] == "INDEX" && pages.try_send(value).is_err() { break }
                    }
                    Some(Ok(Message::Binary(_))) => {},
                    _ => break,
                }
            }
        }}
        // Dropping the uncommitted snapshot rolls back partial/disconnected indexing.
        ingest.abort();
        let _ = ingest.await;
    }))
}

async fn ingest_index(
    app: App,
    id: Uuid,
    mut pages: tokio::sync::mpsc::Receiver<Value>,
    acks: tokio::sync::mpsc::Sender<Value>,
) -> anyhow::Result<()> {
    let config = providers::SourceConfig {
        root: String::new(),
        url: String::new(),
        token: String::new(),
        user_id: String::new(),
        agent_id: id.to_string(),
        headers: Default::default(),
    };
    let encrypted = app.encrypt(&serde_json::to_value(config)?)?;
    sqlx::query("INSERT INTO sources VALUES($1,'NAS Agent','agent',$2) ON CONFLICT(id) DO NOTHING")
        .bind(id)
        .bind(encrypted)
        .execute(&app.db)
        .await?;
    loop {
        let Some(first) = pages.recv().await else {
            return Ok(());
        };
        let snapshot = first["snapshot"].clone();
        let mut page = first;
        let mut sequence = 0u64;
        let mut tx = app.db.begin().await?;
        sqlx::query("SELECT id FROM sources WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query("CREATE TEMP TABLE agent_index_page (resource text PRIMARY KEY, title text NOT NULL, source_version text) ON COMMIT DROP").execute(&mut *tx).await?;
        loop {
            anyhow::ensure!(
                page["snapshot"] == snapshot && page["sequence"].as_u64().unwrap_or(0) == sequence,
                "invalid_index_sequence"
            );
            let items = page["items"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("invalid_index"))?;
            anyhow::ensure!(items.len() <= 256, "index_page_too_large");
            for item in items {
                let path = item["resource"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid_resource"))?;
                let title = item["title"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid_title"))?;
                anyhow::ensure!(
                    !path.is_empty()
                        && path.chars().count() <= 16384
                        && title.chars().count() <= 1024,
                    "index_string_too_large"
                );
                if !item["source_version"].is_null() {
                    anyhow::ensure!(
                        item["source_version"]
                            .as_str()
                            .is_some_and(media_core::file_version::valid_file_version),
                        "invalid_source_version"
                    );
                }
            }
            sqlx::query("INSERT INTO agent_index_page SELECT resource,title,source_version FROM jsonb_to_recordset($1) AS x(resource text,title text,source_version text) ON CONFLICT(resource) DO UPDATE SET title=EXCLUDED.title,source_version=EXCLUDED.source_version").bind(&page["items"]).execute(&mut *tx).await?;
            let final_page = page["final"].as_bool().unwrap_or(snapshot.is_null());
            if final_page {
                sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1 AND NOT EXISTS(SELECT 1 FROM agent_index_page i WHERE i.resource=media_items.resource)").bind(id).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO media_items(id,source_id,title,resource,source_version) SELECT gen_random_uuid(),$1,title,resource,source_version FROM agent_index_page ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,available=true,source_version=EXCLUDED.source_version,metadata=CASE WHEN media_items.source_version IS DISTINCT FROM EXCLUDED.source_version THEN '{}'::jsonb ELSE media_items.metadata END,duration_ms=CASE WHEN media_items.source_version IS DISTINCT FROM EXCLUDED.source_version THEN NULL ELSE media_items.duration_ms END").bind(id).execute(&mut *tx).await?;
                tx.commit().await?;
                acks.send(json!({"type":"INDEX_ACK","sequence":sequence,"final":true}))
                    .await?;
                break;
            }
            acks.send(json!({"type":"INDEX_ACK","sequence":sequence,"final":false}))
                .await?;
            sequence += 1;
            page = tokio::time::timeout(std::time::Duration::from_secs(60), pages.recv())
                .await?
                .ok_or_else(|| anyhow::anyhow!("index_disconnected"))?;
        }
    }
}
