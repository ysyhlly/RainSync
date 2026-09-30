//! Receipts describe completed resource disposal, never merely cancelled futures.
use anyhow::{Context, Result};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

#[derive(Debug)]
pub struct DrainUnconfirmed;
impl std::fmt::Display for DrainUnconfirmed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blocking file drain unconfirmed")
    }
}
impl std::error::Error for DrainUnconfirmed {}

#[derive(Clone, Default)]
pub struct FileOps(Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>);
impl FileOps {
    pub async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (send, result) = oneshot::channel();
        let task = tokio::task::spawn_blocking(move || {
            // When cancellation drops the waiter, this drops any returned file
            // inside the blocking owner before the JoinHandle becomes finished.
            let _ = send.send(work());
        });
        {
            let mut tasks = self.0.lock().expect("file operation registry");
            tasks.retain(|task| !task.is_finished());
            tasks.push(task);
        }
        result.await.context("file operation owner disappeared")?
    }
    pub async fn drain(&self) -> Result<()> {
        let tasks = std::mem::take(&mut *self.0.lock().expect("file operation registry"));
        for task in tasks {
            task.await.map_err(|_| DrainUnconfirmed)?;
        }
        Ok(())
    }
}

pub async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

// Only already-drained UUIDs are persisted. A process restart cannot invent
// positive receipts for unfinished work owned by a previous process.
pub struct Receipts {
    path: PathBuf,
    pending: BTreeSet<Uuid>,
    dirty: bool,
}
impl Receipts {
    pub async fn load(credential: &std::path::Path) -> Result<Self> {
        let mut name = credential.as_os_str().to_owned();
        name.push(".drained.json");
        let path = PathBuf::from(name);
        let pending = match tokio::fs::metadata(&path).await {
            Ok(metadata) => {
                anyhow::ensure!(
                    metadata.len() <= 1024 * 1024,
                    "drain receipt file too large"
                );
                serde_json::from_slice(&tokio::fs::read(&path).await?)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            path,
            pending,
            dirty: false,
        })
    }
    pub fn batch(&self) -> Vec<Uuid> {
        self.pending.iter().take(32).copied().collect()
    }
    pub fn full(&self) -> bool {
        self.pending.len() >= 4096
    }
    pub async fn add(&mut self, id: Uuid) -> Result<()> {
        self.pending.insert(id);
        self.dirty = true;
        self.save().await
    }
    pub async fn acknowledged(&mut self, id: Uuid) -> Result<()> {
        if self.pending.remove(&id) {
            self.dirty = true;
            self.save().await?;
        }
        Ok(())
    }
    pub async fn flush(&mut self) -> Result<()> {
        if self.dirty {
            self.save().await?;
        }
        Ok(())
    }
    async fn save(&mut self) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let mut temp = self.path.as_os_str().to_owned();
        temp.push(format!(".{}.tmp", Uuid::new_v4()));
        let temp = PathBuf::from(temp);
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let result = async {
            let mut file = options.open(&temp).await?;
            file.write_all(&serde_json::to_vec(&self.pending)?).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temp, &self.path).await?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        } else {
            self.dirty = false;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn cancelled_waiter_does_not_acknowledge_before_blocking_file_owner_returns() {
        let scope = FileOps::default();
        let dropped = Arc::new(AtomicBool::new(false));
        let (entered, began) = oneshot::channel();
        let waiting = scope.clone();
        let marker = dropped.clone();
        let task = tokio::spawn(async move {
            waiting
                .run(move || {
                    let _ = entered.send(());
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    Ok(Dropped(marker))
                })
                .await
        });
        began.await.unwrap();
        task.abort();
        let _ = task.await;
        assert!(!dropped.load(Ordering::SeqCst));
        scope.drain().await.unwrap();
        assert!(dropped.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn completed_receipts_survive_restart_and_duplicate_acknowledgement() {
        let dir = std::env::temp_dir().join(format!("rainsync-drain-{}", Uuid::new_v4()));
        tokio::fs::create_dir(&dir).await.unwrap();
        let path = dir.join("credential.json");
        let id = Uuid::new_v4();
        let mut receipts = Receipts::load(&path).await.unwrap();
        receipts.add(id).await.unwrap();
        drop(receipts);
        let mut receipts = Receipts::load(&path).await.unwrap();
        assert_eq!(receipts.batch(), vec![id]);
        receipts.acknowledged(id).await.unwrap();
        receipts.acknowledged(id).await.unwrap();
        assert!(Receipts::load(&path).await.unwrap().batch().is_empty());
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn failed_receipt_save_remains_dirty_until_shutdown_flush_succeeds() {
        let dir = std::env::temp_dir().join(format!("rainsync-drain-flush-{}", Uuid::new_v4()));
        let path = dir.join("credential.json");
        let id = Uuid::new_v4();
        let mut receipts = Receipts::load(&path).await.unwrap();
        // Loading an empty backlog needs no write, even when its parent is absent.
        receipts.flush().await.unwrap();
        assert!(receipts.add(id).await.is_err());
        assert_eq!(receipts.batch(), vec![id]);
        tokio::fs::create_dir(&dir).await.unwrap();
        receipts.flush().await.unwrap();
        assert_eq!(Receipts::load(&path).await.unwrap().batch(), vec![id]);
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn receipt_temporary_file_does_not_follow_a_precreated_symlink() {
        let dir = std::env::temp_dir().join(format!("rainsync-drain-symlink-{}", Uuid::new_v4()));
        tokio::fs::create_dir(&dir).await.unwrap();
        let victim = dir.join("victim");
        tokio::fs::write(&victim, b"keep me").await.unwrap();
        let credential = dir.join("credential.json");
        std::os::unix::fs::symlink(&victim, dir.join("credential.json.drained.json.tmp")).unwrap();
        let mut receipts = Receipts::load(&credential).await.unwrap();
        receipts.add(Uuid::new_v4()).await.unwrap();
        assert_eq!(tokio::fs::read(&victim).await.unwrap(), b"keep me");
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
