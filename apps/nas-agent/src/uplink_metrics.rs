//! Only a successfully finished Binary send crosses the NAS byte boundary.
//! Observation termination never says whether resources have drained.
use anyhow::Result;
use media_core::runtime_metrics::{NasUplinkMetrics, Outcome, Transfer};
use std::future::Future;

#[derive(Default)]
pub struct BodyMeasurement {
    transfer: Option<Transfer>,
    length: u64,
    sequence: u64,
    bytes: u64,
}

impl BodyMeasurement {
    /// Call only after successful 200/206 metadata, excluding HEAD/rejections.
    pub fn begin(metrics: Option<&NasUplinkMetrics>, length: u64) -> Self {
        let mut observation = Self {
            transfer: metrics.and_then(NasUplinkMetrics::begin_transfer),
            length,
            ..Default::default()
        };
        if length == 0 {
            observation.sent(0);
        }
        observation
    }

    /// Pending, failed and cancelled send futures do not credit their frame.
    /// The original send error remains unchanged for the transfer owner.
    pub async fn send_frame<F>(&mut self, bytes: usize, send: F) -> Result<()>
    where
        F: Future<Output = Result<()>>,
    {
        send.await?;
        self.sent(bytes as u64);
        Ok(())
    }

    fn sent(&mut self, bytes: u64) {
        let Some(transfer) = self.transfer.as_mut() else {
            return;
        };
        let (Some(sequence), Some(total)) =
            (self.sequence.checked_add(1), self.bytes.checked_add(bytes))
        else {
            // Dropping observation never changes delivery or resource cleanup.
            drop(self.transfer.take());
            return;
        };
        if !transfer.sample(sequence, total) {
            drop(self.transfer.take());
            return;
        }
        self.sequence = sequence;
        self.bytes = total;
        if total >= self.length {
            self.finish(if total == self.length {
                Outcome::Complete
            } else {
                Outcome::Failed
            });
        }
    }

    pub fn finish(&mut self, outcome: Outcome) {
        if let Some(transfer) = self.transfer.take() {
            transfer.finish(outcome);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::future::{pending, ready};

    #[tokio::test]
    async fn failed_and_cancelled_frames_never_credit_attempted_bytes() {
        let metrics = NasUplinkMetrics::default();
        let mut measured = BodyMeasurement::begin(Some(&metrics), 10);
        measured.send_frame(3, ready(Ok(()))).await.unwrap();
        assert!(
            measured
                .send_frame(7, ready(Err(anyhow::anyhow!("write failed"))))
                .await
                .is_err()
        );
        measured.finish(Outcome::Failed);
        let totals = metrics.snapshot();
        assert_eq!(totals.body_bytes, 3);
        assert_eq!(totals.failed.bytes, 3);
        assert_eq!(totals.failed.transfers, 1);
        assert_eq!(totals.complete.transfers, 0);
        assert_eq!(totals.active, 0);

        let mut measured = BodyMeasurement::begin(Some(&metrics), 20);
        measured.send_frame(5, ready(Ok(()))).await.unwrap();
        assert!(measured.send_frame(15, pending()).now_or_never().is_none());
        measured.finish(Outcome::Cancelled);
        let totals = metrics.snapshot();
        assert_eq!(totals.body_bytes, 8);
        assert_eq!(totals.cancelled.bytes, 5);
        assert_eq!(totals.cancelled.transfers, 1);
        assert_eq!(totals.active, 0);
        assert!(totals.valid());
    }

    #[tokio::test]
    async fn exact_length_completes_before_later_close_or_drain_outcomes() {
        let metrics = NasUplinkMetrics::default();
        let mut measured = BodyMeasurement::begin(Some(&metrics), 10);
        measured.send_frame(4, ready(Ok(()))).await.unwrap();
        assert_eq!(metrics.snapshot().active, 1);
        measured.send_frame(6, ready(Ok(()))).await.unwrap();
        let complete = metrics.snapshot();
        assert_eq!(complete.active, 0);
        assert_eq!(complete.complete.bytes, 10);
        assert_eq!(complete.complete.transfers, 1);
        measured.finish(Outcome::Cancelled);
        measured.finish(Outcome::Failed);
        drop(measured);
        assert_eq!(metrics.snapshot(), complete);
    }

    #[test]
    fn empty_body_and_abandoned_partial_body_have_distinct_outcomes() {
        let metrics = NasUplinkMetrics::default();
        drop(BodyMeasurement::begin(Some(&metrics), 0));
        let empty = metrics.snapshot();
        assert!(empty.body_seen);
        assert_eq!(empty.complete.transfers, 1);
        assert_eq!(empty.body_bytes, 0);
        assert_eq!(empty.active, 0);
        {
            let mut measured = BodyMeasurement::begin(Some(&metrics), 20);
            measured.sent(7);
        }
        let partial = metrics.snapshot();
        assert_eq!(partial.cancelled.transfers, 1);
        assert_eq!(partial.cancelled.bytes, 7);
        assert_eq!(partial.active, 0);
        assert!(partial.valid());
    }

    #[tokio::test]
    async fn absent_measurement_preserves_send_success_and_error() {
        let mut measured = BodyMeasurement::begin(None, 10);
        measured.send_frame(10, ready(Ok(()))).await.unwrap();
        let failure = measured
            .send_frame(10, ready(Err(anyhow::anyhow!("unchanged"))))
            .await
            .unwrap_err();
        assert_eq!(failure.to_string(), "unchanged");
        measured.finish(Outcome::Cancelled);
    }

    #[tokio::test]
    async fn collector_capacity_refusal_preserves_the_transfer_result() {
        let metrics = NasUplinkMetrics::default();
        let owners: Vec<_> = (0..protocol::NAS_METRIC_MAX_ACTIVE)
            .map(|_| metrics.begin_transfer().unwrap())
            .collect();
        let mut omitted = BodyMeasurement::begin(Some(&metrics), 10);
        omitted.send_frame(10, ready(Ok(()))).await.unwrap();
        omitted.finish(Outcome::Complete);
        let at_capacity = metrics.snapshot();
        assert_eq!(at_capacity.admitted, 16);
        assert_eq!(at_capacity.dropped, 1);
        assert_eq!(at_capacity.body_bytes, 0);
        assert_eq!(at_capacity.complete.transfers, 0);
        drop(owners);
        assert_eq!(metrics.snapshot().active, 0);
        assert!(metrics.snapshot().valid());
    }
}
