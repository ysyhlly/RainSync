//! Admit one complete control dispatch using the current connection's owners.
//! Receipt writes and error handling intentionally retain the original behavior.
use super::{data_transfer, drain};
use media_core::runtime_metrics::NasUplinkMetrics;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    sync::{Semaphore, watch},
    task::JoinSet,
};

pub(super) struct Context<'a> {
    pub root: &'a PathBuf,
    pub agent_data_origin: &'a str,
    pub slots: &'a Arc<Semaphore>,
    pub rejections: &'a Arc<Semaphore>,
    pub cancelled_transfers: &'a watch::Receiver<bool>,
    pub transfers: &'a mut JoinSet<Option<uuid::Uuid>>,
    pub receipts: &'a mut drain::Receipts,
    pub uplink: &'a NasUplinkMetrics,
    pub reporter_ready: bool,
}

#[derive(PartialEq)]
pub(super) enum Flow {
    Continue,
    Disconnect,
}

pub(super) async fn admit(context: Context<'_>, v: &Value) -> Flow {
    let Context {
        root,
        agent_data_origin,
        slots,
        rejections,
        cancelled_transfers,
        transfers,
        receipts,
        uplink,
        reporter_ready,
    } = context;
    let mut request = v["request"].clone();
    let receipt = if request["drain_receipt_required"] == true {
        v["id"]
            .as_str()
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
    } else {
        None
    };
    // Bound receipt persistence before opening more files. A
    // peer that never acknowledges causes conservative backpressure.
    if receipts.full() {
        // This dispatch is already durable at the Server,
        // but we have not opened any resource for it.
        if let Some(id) = receipt {
            let _ = receipts.add(id).await;
        }
        return Flow::Disconnect;
    }
    // Data ingress shares the configured service origin; localhost in server configuration is not the NAS host.
    if let Some(value) = request["data_url"].as_str() {
        let Ok(mut url) = reqwest::Url::parse(agent_data_origin) else {
            if let Some(id) = receipt {
                let _ = receipts.add(id).await;
            }
            return Flow::Continue;
        };
        let Ok(data) = reqwest::Url::parse(value) else {
            if let Some(id) = receipt {
                let _ = receipts.add(id).await;
            }
            return Flow::Continue;
        };
        url.set_path(data.path());
        url.set_query(data.query());
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        if url.set_scheme(scheme).is_err() {
            if let Some(id) = receipt {
                let _ = receipts.add(id).await;
            }
            return Flow::Continue;
        }
        request["data_url"] = json!(url.as_str());
    }
    let root = root.clone();
    let permit = match slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            let Ok(permit) = rejections.clone().try_acquire_owned() else {
                if let Some(id) = receipt {
                    let _ = receipts.add(id).await;
                }
                return Flow::Continue;
            };
            request["busy"] = json!(true);
            permit
        }
    };
    let cancel = cancelled_transfers.clone();
    let metrics = reporter_ready.then(|| uplink.clone());
    transfers.spawn(async move {
        let _permit = permit;
        let result = data_transfer::run(root, request, cancel, metrics).await;
        let confirmed = !result
            .as_ref()
            .is_err_and(|error| error.is::<drain::DrainUnconfirmed>());
        if result.is_err() {
            tracing::warn!("transfer ended with error")
        }
        receipt.filter(|_| confirmed)
    });
    Flow::Continue
}
