//! Initial Worker output-entry availability, not general cache hotness. The
//! compulsory delivery ledger owns first-request eligibility across restarts.
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

static WRITES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Availability {
    ColdWaiting,
    Warm,
    Unknown,
}
impl Availability {
    fn label(self) -> &'static str {
        match self {
            Self::ColdWaiting => "cold_waiting",
            Self::Warm => "warm",
            Self::Unknown => "unknown",
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Ready {
    availability: Availability,
    queue_ms: Option<u32>,
}
pub struct Entry {
    eligible: bool,
    initial: Option<(Availability, Option<i64>)>,
}
impl Entry {
    pub fn new(eligible: bool) -> Self {
        Self {
            eligible,
            initial: None,
        }
    }
    /// Called once at the first eligible actual job lookup. Later readiness
    /// cannot promote a cold lookup, or add queue from a replacement attempt.
    pub fn lookup(&mut self, status: &str, attempt: i64) -> bool {
        if !self.eligible || self.initial.is_some() {
            return false;
        }
        let (availability, expected) = match status {
            "queued" => (Availability::ColdWaiting, attempt.checked_add(1)),
            "running" => (Availability::ColdWaiting, Some(attempt)),
            "succeeded" => (Availability::Warm, Some(attempt)),
            _ => (Availability::Unknown, None),
        };
        self.initial = Some((availability, expected));
        availability == Availability::ColdWaiting
    }
    /// Owner calls only after output/manifest validation and an acquired healthy
    /// read lease. The response still passes the normal final authorization gate.
    pub fn ready(
        &self,
        attempt: i64,
        queue_ms: Option<i64>,
        complete: Option<bool>,
        accounted_attempt: Option<i64>,
    ) -> Option<Ready> {
        let (mut availability, expected) = self.initial?;
        if availability == Availability::Warm && expected != Some(attempt) {
            availability = Availability::Unknown;
        }
        let queue_ms = if expected == Some(attempt)
            && complete == Some(true)
            && accounted_attempt == Some(attempt)
        {
            queue_ms
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| *value <= 604_800_000)
        } else {
            None
        };
        Some(Ready {
            availability,
            queue_ms,
        })
    }
}

async fn update(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    ready: Option<Ready>,
) -> Result<(), sqlx::Error> {
    match ready {
        None => {
            sqlx::query("UPDATE playback_sessions SET metrics_output_entry_availability='cold_waiting' WHERE id=$1 AND playback_metrics_version=2 AND metrics_output_entry_availability IS NULL")
            .bind(session).execute(&mut **tx).await?;
        }
        Some(ready) => {
            sqlx::query("UPDATE playback_sessions SET metrics_output_entry_availability=COALESCE(metrics_output_entry_availability,$2),metrics_output_entry_queue_ms=$3,metrics_output_entry_completed=true WHERE id=$1 AND playback_metrics_version=2 AND NOT metrics_output_entry_completed AND (metrics_output_entry_availability IS NULL OR metrics_output_entry_availability='cold_waiting')")
            .bind(session).bind(ready.availability.label()).bind(ready.queue_ms.map(i64::from)).execute(&mut **tx).await?;
        }
    }
    Ok(())
}
fn record(pool: PgPool, session: Uuid, ready: Option<Ready>) {
    let Ok(permit) = WRITES.try_acquire() else {
        return;
    };
    tokio::spawn(async move {
        let _permit = permit;
        // Connection always closes on cancellation; optional blocked telemetry
        // never strands a transaction in the shared delivery pool.
        let _ = tokio::time::timeout(Duration::from_millis(250), async {
            use sqlx::Acquire;
            let mut connection = pool.acquire().await?;
            connection.close_on_drop();
            let mut tx = connection.begin().await?;
            sqlx::query("SET LOCAL statement_timeout='100ms'")
                .execute(&mut *tx)
                .await?;
            update(&mut tx, session, ready).await?;
            tx.commit().await
        })
        .await;
    });
}
pub fn record_cold(pool: PgPool, session: Uuid) {
    record(pool, session, None);
}
pub fn record_ready(pool: PgPool, session: Uuid, ready: Ready) {
    record(pool, session, Some(ready));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initial_waiting_never_becomes_warm_and_queue_is_attempt_pinned() {
        let mut entry = Entry::new(true);
        assert!(entry.lookup("queued", 0));
        assert!(!entry.lookup("succeeded", 1));
        let ready = entry.ready(1, Some(12), Some(true), Some(1)).unwrap();
        assert_eq!(ready.availability, Availability::ColdWaiting);
        assert_eq!(ready.queue_ms, Some(12));
        assert_eq!(
            entry
                .ready(2, Some(100), Some(true), Some(2))
                .unwrap()
                .queue_ms,
            None
        );
        assert_eq!(
            entry
                .ready(1, Some(0), Some(false), Some(1))
                .unwrap()
                .queue_ms,
            None
        );
    }
    #[test]
    fn only_first_eligible_validated_response_has_warm_evidence() {
        let mut skipped = Entry::new(false);
        assert!(!skipped.lookup("succeeded", 1));
        assert!(skipped.ready(1, None, None, None).is_none());
        let mut first = Entry::new(true);
        assert!(!first.lookup("succeeded", 1));
        let ready = first.ready(1, Some(0), Some(true), Some(1)).unwrap();
        assert_eq!(ready.availability, Availability::Warm);
        assert_eq!(ready.queue_ms, Some(0));
        assert_eq!(
            first
                .ready(2, Some(100), Some(true), Some(2))
                .unwrap()
                .availability,
            Availability::Unknown
        );
        assert_eq!(first.ready(1, None, None, None).unwrap().queue_ms, None);
    }
}
