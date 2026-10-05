//! Replay only receipts already persisted by a previous resource owner.
use super::{drain, send_control};
use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

#[derive(Default)]
pub struct RootCheck {
    // A timed-out mount check retains its one blocking owner. Repeated reconnects
    // cannot accumulate filesystem operations against an unresponsive mount.
    pending: Option<tokio::task::JoinHandle<std::io::Result<PathBuf>>>,
}
impl RootCheck {
    pub async fn validated(
        &mut self,
        root: &Path,
        shutdown: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<Option<PathBuf>> {
        if self.pending.is_none() {
            let root = root.to_owned();
            self.pending = Some(tokio::task::spawn_blocking(move || {
                let root = root.canonicalize()?;
                if !root.is_dir() {
                    return Err(std::io::Error::other("media_root_not_directory"));
                }
                Ok(root)
            }));
        }
        let result = tokio::select! {
            biased;
            _ = drain::cancelled(shutdown) => return Ok(None),
            result = tokio::time::timeout(Duration::from_secs(1), self.pending.as_mut().unwrap()) => result,
        };
        match result {
            Ok(result) => {
                self.pending = None;
                Ok(result.context("media_root_check_owner_lost")?.ok())
            }
            Err(_) => Ok(None),
        }
    }
}

pub async fn existing_token(credential: &Path) -> Result<Option<String>> {
    use tokio::io::AsyncReadExt;
    if let Ok(token) = std::env::var("AGENT_TOKEN") {
        return Ok(Some(token));
    }
    match tokio::fs::File::open(credential).await {
        Ok(file) => {
            let metadata = file.metadata().await?;
            anyhow::ensure!(
                metadata.is_file() && metadata.len() <= 64 * 1024,
                "invalid_agent_credential_file"
            );
            let mut bytes = Vec::new();
            file.take(64 * 1024 + 1).read_to_end(&mut bytes).await?;
            anyhow::ensure!(bytes.len() <= 64 * 1024, "invalid_agent_credential_file");
            let value: Value = serde_json::from_slice(&bytes)?;
            Ok(Some(value["token"].as_str().context("token")?.to_owned()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub async fn replay(
    server: &str,
    token: &str,
    receipts: &mut drain::Receipts,
    root_check: &mut RootCheck,
    root: &Path,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let url = format!(
        "{}/api/v1/agents/drain-ws",
        server
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    );
    let mut request = url.into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse()?);
    let config = WebSocketConfig::default()
        .max_message_size(Some(4096))
        .max_frame_size(Some(4096));
    let connected = tokio::select! {
        biased;
        _ = drain::cancelled(shutdown) => return Ok(()),
        connected = tokio::time::timeout(Duration::from_secs(10), connect_async_with_config(request, Some(config), false)) => connected,
    };
    let Ok(Ok((mut socket, _))) = connected else {
        return Ok(());
    };
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let deadline = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            _ = drain::cancelled(shutdown) => break,
            _ = &mut deadline => break,
            _ = heartbeat.tick() => {
                // Returning ends the receipt socket. Ordinary mode subsequently
                // performs another fresh root check and opens a new connection.
                if root_check.validated(root, shutdown).await?.is_some() { break; }
                for id in receipts.batch() {
                    send_control(&mut socket, json!({"type":"TRANSFER_DRAINED","id":id}), shutdown).await?;
                }
                send_control(&mut socket, json!({"type":"HEARTBEAT"}), shutdown).await?;
            }
            message = socket.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    _ => break,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { break };
                // Never act on index/scan/transfer messages from this endpoint.
                if value["type"] != "TRANSFER_DRAINED_ACK" { break; }
                if (value["accepted"] == true || value["rejected_permanently"] == true)
                    && let Some(id) = value["id"].as_str().and_then(|id| uuid::Uuid::parse_str(id).ok())
                    && receipts.acknowledged(id).await.is_err()
                {
                    tracing::warn!("drain receipt acknowledgement persistence failed");
                }
            }
        }
    }
    Ok(())
}
