//! Complete existing room route resolution/cache operation; cache grants no writes.
use super::Runtime;
use persistence::room_node_leases::{self as leases, Route};
use std::time::{Duration, Instant};
use uuid::Uuid;

impl Runtime {
    pub async fn resolve(&self, room: Uuid) -> anyhow::Result<Route> {
        anyhow::ensure!(self.healthy(), "control_node_unhealthy");
        if let Some((when, route)) = self.inner.routes.lock().await.get(&room).cloned()
            && when.elapsed() < Duration::from_millis(250)
        {
            self.trusted(&route)?;
            return Ok(route);
        }
        let mut route =
            tokio::time::timeout(Duration::from_secs(2), leases::route(&self.inner.db, room))
                .await??;
        if route.is_none() {
            match self.local_lease(room).await {
                Ok(_) => route = leases::route(&self.inner.db, room).await?,
                Err(error) if error.to_string() == "room_owner_changed" => {
                    route = leases::route(&self.inner.db, room).await?
                }
                Err(error) => return Err(error),
            }
        }
        let route = route.ok_or_else(|| anyhow::anyhow!("room_owner_unavailable"))?;
        self.trusted(&route)?;
        if route.node == self.node() {
            self.local_lease(room).await?;
        }
        let mut cache = self.inner.routes.lock().await;
        if cache.len() >= 1024 {
            cache.clear()
        }
        cache.insert(room, (Instant::now(), route.clone()));
        Ok(route)
    }
}
