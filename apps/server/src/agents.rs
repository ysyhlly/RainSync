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
    Ok(upgrade.max_message_size(1024*1024).on_upgrade(move|socket|async move{
        let(mut out,mut input)=socket.split();let mut tick=tokio::time::interval(std::time::Duration::from_millis(250));
        loop{tokio::select!{
            _=tick.tick()=>{
                let valid=sqlx::query("UPDATE agents SET last_seen=now() WHERE id=$1 AND NOT revoked RETURNING id").bind(id).fetch_optional(&app.db).await;
                if !matches!(valid,Ok(Some(_))){break}
                let rows=sqlx::query("UPDATE agent_transfers SET claimed=true WHERE agent_id=$1 AND NOT claimed AND expires_at>now() RETURNING id,request").bind(id).fetch_all(&app.db).await.unwrap_or_default();
                for r in rows{let request:Value=r.get("request");if out.send(Message::Text(json!({"type":"TRANSFER","id":r.get::<Uuid,_>("id"),"request":request}).to_string().into())).await.is_err(){return}}
            }
            m=input.next()=>{
                let Some(Ok(Message::Text(text)))=m else{break};let Ok(v)=serde_json::from_str::<Value>(&text)else{continue};
                if v["type"]=="INDEX"{
                    let config=providers::SourceConfig{root:String::new(),url:String::new(),token:String::new(),user_id:String::new(),agent_id:id.to_string(),headers:Default::default()};
                    let Ok(encrypted)=app.encrypt(&serde_json::to_value(config).unwrap())else{break};
                    let _=sqlx::query("INSERT INTO sources VALUES($1,'NAS Agent','agent',$2) ON CONFLICT(id) DO NOTHING").bind(id).bind(encrypted).execute(&app.db).await;
                    if let Some(items)=v["items"].as_array(){for item in items.iter().take(10000){let Some(path)=item["resource"].as_str()else{continue};let title=item["title"].as_str().unwrap_or(path);let _=sqlx::query("INSERT INTO media_items(id,source_id,title,resource) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title").bind(Uuid::new_v4()).bind(id).bind(title).bind(path).execute(&app.db).await;}}
                }
            }
        }}
    }))
}
