//! Bounded incremental checks for local output snapshots and file delivery.
use crate::outputs;
use anyhow::Result;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};
use tokio::sync::{Mutex, Semaphore};

type Entry = (Instant, Arc<std::sync::Mutex<outputs::Progress>>);

pub struct Checks {
    entries: Mutex<HashMap<PathBuf, Entry>>,
    slots: Arc<Semaphore>,
}

impl Default for Checks {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(4)),
        }
    }
}

impl Checks {
    pub async fn snapshot(&self, directory: PathBuf, text: String) -> Result<String> {
        let progress = {
            let mut entries = self.entries.lock().await;
            if !entries.contains_key(&directory) && entries.len() >= 128 {
                let oldest = entries
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .unwrap()
                    .0
                    .clone();
                entries.remove(&oldest);
            }
            let entry = entries.entry(directory.clone()).or_insert_with(|| {
                (
                    Instant::now(),
                    Arc::new(std::sync::Mutex::new(outputs::Progress::default())),
                )
            });
            entry.0 = Instant::now();
            entry.1.clone()
        };
        // The permit lives inside the blocking closure: cancelling the request
        // must not admit more scans while its disk work is still running.
        let permit = self.slots.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            progress
                .lock()
                .map_err(|_| anyhow::anyhow!("output_check_interrupted"))?
                .check(&directory, &text)?;
            Ok(text)
        })
        .await?
    }

    pub async fn open(
        &self,
        path: PathBuf,
        proof: Option<persistence::media_outputs::FileProof>,
    ) -> Result<tokio::fs::File> {
        let permit = self.slots.clone().acquire_owned().await?;
        let file = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            match proof {
                Some(proof) => outputs::open_verified(&path, &proof),
                None => outputs::open_media(&path),
            }
        })
        .await??;
        Ok(tokio::fs::File::from_std(file))
    }
}
