//! Complete lifetime of one existing authenticated control connection.
//! HELLO retries retain the socket, then original drain order remains intact.
use super::{
    IndexScan, drain, retry_or_shutdown, send_control, start_index, transfer_admission,
    uplink_reporter,
};
use futures_util::StreamExt;
use media_core::runtime_metrics::NasUplinkMetrics;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{Semaphore, watch};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};
pub(super) struct Context<'a> {
    pub root: &'a PathBuf,
    pub agent_data_origin: &'a str,
    pub slots: &'a Arc<Semaphore>,
    pub rejections: &'a Arc<Semaphore>,
    pub scans: &'a Arc<Semaphore>,
    pub index_interval: Duration,
    pub shutdown: &'a mut watch::Receiver<bool>,
    pub receipts: &'a mut drain::Receipts,
    pub uplink: &'a NasUplinkMetrics,
}
pub(super) enum Flow {
    Stop,
    Retried,
    Drained,
}
pub(super) async fn run(
    context: Context<'_>,
    mut socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
) -> Flow {
    let Context {
        root,
        agent_data_origin,
        slots,
        rejections,
        scans,
        index_interval,
        shutdown,
        receipts,
        uplink,
    } = context;

    let mut reporter = uplink_reporter::Reporter::new(uplink.snapshot());
    if send_control(&mut socket, reporter.hello(), shutdown)
        .await
        .is_err()
    {
        if retry_or_shutdown(shutdown).await {
            return Flow::Stop;
        }
        return Flow::Retried;
    }
    let mut transfers = tokio::task::JoinSet::new();
    let (cancel_transfers, cancelled_transfers) = tokio::sync::watch::channel(false);
    let mut scan: Option<IndexScan> = None;
    let mut refresh = tokio::time::interval(index_interval);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        tokio::select! {
            biased;
            _ = drain::cancelled(shutdown) => break,
            ended = transfers.join_next(), if !transfers.is_empty() => {
                if let Some(Ok(Some(id))) = ended && receipts.add(id).await.is_err() { tracing::warn!("drain receipt persistence failed"); }
            }
            _ = refresh.tick() => {
                if scan.is_none() { scan = start_index(root.clone(), scans.clone()); }
            }
            page = async { scan.as_mut().unwrap().incoming.recv().await }, if scan.as_ref().is_some_and(|s| !s.awaiting_ack) => {
                let current = scan.as_mut().unwrap();
                let message = match page {
                    Some(Ok((items, final_page))) => {
                        current.final_page = final_page;
                        json!({"type":"INDEX","snapshot":current.snapshot,"sequence":current.sequence,"final":final_page,"items":items})
                    }
                    _ => {
                        tracing::warn!("index scan incomplete; retaining previous snapshot");
                        current.aborting = true;
                        json!({"type":"INDEX_ABORT","snapshot":current.snapshot,"sequence":current.sequence})
                    }
                };
                if send_control(&mut socket, message, shutdown).await.is_err() { break }
                current.awaiting_ack = true;
                current.sent_at = tokio::time::Instant::now();
            }
            _=heartbeat.tick()=>{
                let mut receipt_failed=false;
                for id in receipts.batch() {
                    if send_control(&mut socket, json!({"type":"TRANSFER_DRAINED","id":id}), shutdown).await.is_err() { receipt_failed=true; break; }
                }
                if receipt_failed { break; }
                if scan.as_ref().is_some_and(|s| s.awaiting_ack && s.sent_at.elapsed().as_secs() > 60) { break }
                if send_control(&mut socket, reporter.heartbeat(uplink.snapshot()), shutdown).await.is_err() { break }
            }
            message=socket.next()=>{let text = match message { Some(Ok(Message::Text(text))) => text, Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue, _ => break };let Ok(v)=serde_json::from_str::<Value>(&text)else{continue};
                if v["type"] == "NAS_METRICS_READY" {
                    reporter.ready(&text);
                    continue;
                }
                if v["type"] == "TRANSFER_DRAINED_ACK" && (v["accepted"] == true || v["rejected_permanently"] == true) {
                    if let Some(id)=v["id"].as_str().and_then(|id|uuid::Uuid::parse_str(id).ok()) && receipts.acknowledged(id).await.is_err() { tracing::warn!("drain receipt acknowledgement persistence failed"); }
                    continue;
                }
                if v["type"] == "INDEX_ERROR" { break }
                if v["type"] == "SCAN" {

                    let Some(request_id) = v["snapshot"].as_str() else { continue };
                    if request_id.is_empty() || request_id.len() > 64 { continue; }
                    let requested = if scan.is_none() { start_index(root.clone(), scans.clone()) } else { None };
                    if let Some(mut requested) = requested {
                        requested.snapshot = request_id.to_owned();
                        scan = Some(requested);
                    } else if send_control(&mut socket, json!({"type":"SCAN_BUSY","snapshot":request_id}), shutdown).await.is_err() { break }
                    continue;
                }
                if v["type"] == "INDEX_ACK" || v["type"] == "INDEX_ABORT_ACK" {
                    let Some(current) = scan.as_mut() else { break };
                    if !current.awaiting_ack || v["sequence"].as_u64() != Some(current.sequence)
                        || (!v["snapshot"].is_null() && v["snapshot"] != current.snapshot)
                        || (v["type"] == "INDEX_ABORT_ACK") != current.aborting { break }
                    if current.aborting || current.final_page { scan = None; }
                    else { current.awaiting_ack = false; current.sequence += 1; }
                    continue
                }
                if v["type"]=="TRANSFER" {
                    let context = transfer_admission::Context {
                        root,
                        agent_data_origin,
                        slots,
                        rejections,
                        cancelled_transfers: &cancelled_transfers,
                        transfers: &mut transfers,
                        receipts: &mut *receipts,
                        uplink,
                        reporter_ready: reporter.is_ready(),
                    };
                    if transfer_admission::admit(context, &v).await == transfer_admission::Flow::Disconnect {
                        break;
                    }
                }}
        }
    }
    // End control admission before draining accepted work. Shutdown
    // must not leave a live socket accepting further dispatches while
    // this process is waiting for old file owners or receipt writes.
    drop(socket);
    drop(scan);
    // Control loss includes revoked credentials. No old transfer may
    // outlive that authorized connection or retain its admission slot.
    let _ = cancel_transfers.send(true);
    // Never abort a waiter that still owns a blocking file operation.
    while let Some(result) = transfers.join_next().await {
        if let Ok(Some(id)) = result
            && receipts.add(id).await.is_err()
        {
            tracing::warn!("drain receipt persistence failed");
        }
    }

    Flow::Drained
}
