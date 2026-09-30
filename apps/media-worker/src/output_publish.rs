//! The encoder's private playlist is never the version-2 delivery authority.
use crate::{outputs, process};
use anyhow::{Result, ensure};
use persistence::{
    media_jobs::Claim,
    media_outputs::{FileProof, Snapshot},
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
pub struct Builder {
    files: Vec<FileProof>,
    committed: usize,
}

impl Builder {
    pub fn prepare(&mut self, directory: &Path, text: String, complete: bool) -> Result<Snapshot> {
        ensure!(outputs::readable_manifest(&text), "output_not_ready");
        if complete {
            let proof = outputs::validate(directory)?;
            ensure!(
                proof.manifest_sha256 == crate::hash(&text),
                "output_manifest_changed"
            );
        }
        let names: Vec<_> = std::iter::once("init.mp4")
            .chain(
                text.lines()
                    .filter(|line| !line.is_empty() && !line.starts_with('#')),
            )
            .collect();
        ensure!(names.len() >= self.files.len(), "output_snapshot_regressed");
        for (position, name) in names.iter().enumerate().skip(self.files.len()) {
            let mut file = outputs::open_media(&directory.join(name))?;
            let (size_bytes, sha256) = outputs::hash_file(&mut file)?;
            self.files.push(FileProof {
                index: i32::try_from(position)? - 1,
                size_bytes,
                sha256,
            });
        }
        let segment_count = i32::try_from(names.len() - 1)?;
        let manifest = if complete {
            text
        } else {
            text.lines()
                .filter(|line| *line != "#EXT-X-ENDLIST")
                .map(|line| format!("{line}\n"))
                .collect()
        };
        Ok(Snapshot {
            manifest,
            segment_count,
            files: self.files[self.committed..].to_vec(),
        })
    }

    fn acknowledge(&mut self, count: i32) {
        self.committed = count as usize + 1;
    }
}

pub type Shared = Arc<Mutex<Builder>>;

pub async fn prepare(
    builder: Shared,
    directory: PathBuf,
    complete: bool,
    decoder: &crate::output_decode::Gate,
) -> Result<Snapshot> {
    let text = outputs::read_manifest(&directory.join("index.m3u8")).await?;
    let decode_directory = directory.clone();
    let (snapshot, proofs) = tokio::task::spawn_blocking(move || {
        let mut builder = builder
            .lock()
            .map_err(|_| anyhow::anyhow!("output_check_interrupted"))?;
        let snapshot = builder.prepare(&directory, text, complete)?;
        Ok::<_, anyhow::Error>((
            snapshot,
            [builder.files[0].clone(), builder.files[1].clone()],
        ))
    })
    .await??;
    decoder.verify(decode_directory, proofs).await?;
    Ok(snapshot)
}

/// Some is a confirmed database outcome. Unknown transport/deadline results
/// must never acknowledge a snapshot, including an ambiguous commit reply.
pub(crate) async fn publish_confirmed(
    db: &sqlx::PgPool,
    claim: &Claim,
    snapshot: &Snapshot,
) -> Result<Option<bool>> {
    match tokio::time::timeout(
        Duration::from_secs(3),
        persistence::media_outputs::publish(db, claim, snapshot, false),
    )
    .await
    {
        Ok(Ok(published)) => Ok(Some(published)),
        Ok(Err(error)) if error.downcast_ref::<sqlx::Error>().is_none() => Err(error),
        _ => Ok(None),
    }
}

pub async fn monitor(
    db: &sqlx::PgPool,
    claim: &Claim,
    directory: PathBuf,
    builder: Shared,
    decoder: &crate::output_decode::Gate,
) -> anyhow::Error {
    let mut previous = String::new();
    loop {
        // Missing/torn files can occur before the next atomic rename. Keep the
        // last committed snapshot visible; final validation decides completion.
        let snapshot = match prepare(builder.clone(), directory.clone(), false, decoder).await {
            Ok(snapshot) => Some(snapshot),
            Err(error)
                if error.is::<crate::output_decode::Rejected>()
                    || error.is::<process::LeaseInterrupted>() =>
            {
                return error;
            }
            Err(_) => None,
        };
        if let Some(snapshot) = snapshot
            && snapshot.manifest != previous
        {
            match publish_confirmed(db, claim, &snapshot).await {
                Ok(Some(true)) => {
                    if let Ok(mut builder) = builder.lock() {
                        builder.acknowledge(snapshot.segment_count);
                    }
                    previous = snapshot.manifest;
                }
                // A confirmed failed fence stops the writer immediately.
                Ok(Some(false)) => return process::LeaseInterrupted.into(),
                Err(error) => return error,
                // A timeout/transport error may have committed or rolled back.
                // Do not acknowledge it or advance the known visible prefix;
                // retry the full fenced proof transaction. Process supervision
                // independently stops all work at the last confirmed lease.
                _ => {
                    tracing::warn!("output publication unknown; retaining confirmed snapshot");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn atom(kind: &[u8; 4]) -> Vec<u8> {
        [9u32.to_be_bytes().as_slice(), kind, &[0]].concat()
    }

    #[test]
    fn hashes_new_segments_and_detects_equal_length_payload_changes() {
        let root =
            std::env::temp_dir().join(format!("rainsync-publication-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let manifest =
            "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nindex0.m4s\n#EXT-X-ENDLIST\n";
        std::fs::write(root.join("index.m3u8"), manifest).unwrap();
        std::fs::write(
            root.join("init.mp4"),
            [atom(b"ftyp"), atom(b"moov")].concat(),
        )
        .unwrap();
        let segment = [atom(b"moof"), atom(b"mdat")].concat();
        std::fs::write(root.join("index0.m4s"), &segment).unwrap();
        let mut builder = Builder::default();
        let first = builder.prepare(&root, manifest.into(), false).unwrap();
        assert_eq!(first.files.len(), 2);
        assert!(!first.manifest.contains("ENDLIST"));
        assert_eq!(
            first.files[1].sha256,
            crate::hash(std::str::from_utf8(&segment).unwrap())
        );
        // Until the database acknowledges, retries keep the required proofs.
        assert_eq!(
            builder
                .prepare(&root, manifest.into(), false)
                .unwrap()
                .files
                .len(),
            2
        );
        builder.acknowledge(1);
        let completed = builder.prepare(&root, manifest.into(), true).unwrap();
        assert!(completed.files.is_empty());
        assert!(completed.manifest.ends_with("#EXT-X-ENDLIST\n"));
        drop(outputs::open_verified(&root.join("index0.m4s"), &first.files[1]).unwrap());
        let mut damaged = segment.clone();
        *damaged.last_mut().unwrap() = 1;
        std::fs::write(root.join("index0.m4s"), &damaged).unwrap();
        drop(outputs::open_media(&root.join("index0.m4s")).unwrap());
        assert!(outputs::open_verified(&root.join("index0.m4s"), &first.files[1]).is_err());
        let path = root.canonicalize().unwrap();
        assert_eq!(
            path.parent(),
            Some(std::env::temp_dir().canonicalize().unwrap().as_path())
        );
        assert_eq!(path.file_name(), root.file_name());
        std::fs::remove_dir_all(path).unwrap();
    }
}
