//! One attempt's pre-write file-byte budget, including both metadata files.
//! Filesystem inode/directory/block-rounding overhead remains under the cache's
//! separately measured headroom floor; this counter never claims physical RSS.
use anyhow::{Result, ensure};

pub(super) struct StorageBudget {
    used: usize,
    owner: usize,
    local_manifest: usize,
}
impl StorageBudget {
    pub(super) fn new(owner: usize) -> Result<Self> {
        let used = owner
            .checked_add(super::MANIFEST_BYTES)
            .ok_or_else(|| anyhow::anyhow!("static_hls_disk_reservation_bound"))?;
        ensure!(
            used <= super::TOTAL_BYTES,
            "static_hls_disk_reservation_bound"
        );
        Ok(Self {
            used,
            owner,
            local_manifest: super::MANIFEST_BYTES,
        })
    }
    pub(super) fn reserve_local_manifest(&mut self, bytes: usize) -> Result<()> {
        ensure!(
            bytes > 0 && bytes <= super::MANIFEST_BYTES,
            "static_hls_local_manifest_bound"
        );
        let used = self
            .used
            .checked_sub(self.local_manifest)
            .and_then(|n| n.checked_add(bytes))
            .ok_or_else(|| anyhow::anyhow!("static_hls_disk_reservation_bound"))?;
        ensure!(
            used <= super::TOTAL_BYTES,
            "static_hls_disk_reservation_bound"
        );
        self.used = used;
        self.local_manifest = bytes;
        Ok(())
    }
    pub(super) fn before_write(&mut self, name: &str, bytes: usize) -> Result<()> {
        // Owner/index bytes were reserved before any attempt file was created.
        if name == "owner" {
            ensure!(bytes == self.owner, "static_hls_owner_byte_accounting");
            return Ok(());
        }
        if name == "index.m3u8" {
            ensure!(
                bytes == self.local_manifest,
                "static_hls_manifest_byte_accounting"
            );
            return Ok(());
        }
        let used = self
            .used
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("static_hls_disk_reservation_bound"))?;
        ensure!(
            used <= super::TOTAL_BYTES,
            "static_hls_disk_reservation_bound"
        );
        self.used = used;
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn remaining(&self) -> usize {
        super::TOTAL_BYTES - self.used
    }
}
