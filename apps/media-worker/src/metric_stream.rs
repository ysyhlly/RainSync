//! Wrap each actual I/O boundary once. UpstreamRead goes before prefix sniffing;
//! WorkerEgress goes after prefix replay and permission/read-lease checks.
//! Wrapping both inner and outer producers at the same layer double counts.
use axum::body::Bytes;
use futures_util::Stream;
use media_core::runtime_metrics::{Cache, Layer, Outcome, RuntimeMetrics, Transfer};
use std::{
    pin::Pin,
    task::{Context, Poll},
};

pub struct Measured<S> {
    source: Pin<Box<S>>,
    measurement: Option<Transfer>,
    sequence: u64,
    bytes: u64,
    done: bool,
}
/// Constant-size wrapper, one pinned source allocation. Capacity refusal only
/// omits measurement; it never changes delivery. Do not wrap HEAD/304 bodies.
pub fn wrap<S>(source: S, metrics: &RuntimeMetrics, layer: Layer, cache: Cache) -> Measured<S> {
    Measured {
        source: Box::pin(source),
        measurement: metrics.begin_transfer(layer, cache),
        sequence: 0,
        bytes: 0,
        done: false,
    }
}
impl<S, E> Stream for Measured<S>
where
    S: Stream<Item = Result<Bytes, E>>,
{
    type Item = Result<Bytes, E>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }
        match this.source.as_mut().poll_next(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(bytes))) => {
                // These are the bytes passed across THIS boundary, not a header
                // length, cached prefix counted again, or receiver ACK.
                if let Some(measurement) = this.measurement.as_mut() {
                    match (
                        this.sequence.checked_add(1),
                        this.bytes.checked_add(bytes.len() as u64),
                    ) {
                        (Some(sequence), Some(total)) => {
                            measurement.sample(sequence, total);
                            this.sequence = sequence;
                            this.bytes = total;
                        }
                        _ => {
                            drop(this.measurement.take());
                        }
                    }
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.done = true;
                if let Some(measurement) = this.measurement.take() {
                    measurement.finish(Outcome::Failed);
                }
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.done = true;
                if let Some(measurement) = this.measurement.take() {
                    measurement.finish(Outcome::Complete);
                }
                Poll::Ready(None)
            }
        }
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        if self.done {
            (0, Some(0))
        } else {
            self.source.size_hint()
        }
    }
}
// Dropping the wrapper drops the collector handle (Cancelled) and source.
// This accounts cancellation, not proof that external resources have drained.
