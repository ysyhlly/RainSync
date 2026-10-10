//! Complete existing peer connection lifetime; original deadlines and lease checks.
use super::{DEADLINE, MAX_BODY, MAX_RESPONSE, PEER, Route, Runtime, SECRET, leases};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use uuid::Uuid;

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
