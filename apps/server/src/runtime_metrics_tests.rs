use super::*;

#[test]
fn unwired_is_absent_not_zero() {
    assert_eq!(RuntimeMetrics::default().render(), "");
}
#[test]
fn cumulative_samples_reject_replays_conflicts_regressions_and_zero_sequence() {
    let metrics = RuntimeMetrics::default();
    let mut transfer = metrics
        .begin_transfer(Layer::WorkerEgress, Cache::Hit)
        .unwrap();
    assert!(!transfer.sample(0, 4));
    assert!(transfer.sample(1, 100));
    assert!(transfer.sample(1, 100));
    assert!(!transfer.sample(1, 101));
    assert!(!transfer.sample(2, 99));
    assert!(transfer.sample(3, 200));
    assert!(!transfer.sample(2, 200));
    transfer.finish(Outcome::Complete);
    let state = lock(&metrics.inner);
    assert_eq!(state.transfers[0][0].bytes, 200);
    assert_eq!(state.transfers[0][0].count, 1);
    assert_eq!(state.transfers[0][2].count, 0); // consuming finish plus Drop
    assert_eq!(state.cached_bytes, 200);
    assert_eq!(state.active, 0);
}
#[test]
fn abandoned_transfer_accounts_partial_bytes_and_releases_capacity() {
    let metrics = RuntimeMetrics::default();
    {
        let mut transfer = metrics
            .begin_transfer(Layer::NasUplink, Cache::NotHit)
            .unwrap();
        assert!(transfer.sample(1, 37));
    }
    let state = lock(&metrics.inner);
    assert_eq!(state.transfers[1][2].bytes, 37);
    assert_eq!(state.transfers[1][2].count, 1);
    assert_eq!(state.active, 0);
}
#[test]
fn cache_hit_cannot_be_attached_to_another_layer() {
    let metrics = RuntimeMetrics::default();
    assert!(metrics
        .begin_transfer(Layer::UpstreamRead, Cache::Hit)
        .is_none());
    assert!(metrics
        .begin_transfer(Layer::NasUplink, Cache::Hit)
        .is_none());
    assert_eq!(lock(&metrics.inner).dropped, 2);
    assert!(!metrics
        .render()
        .contains("rainsync_cache_served_bytes_total"));
}
#[test]
fn admission_and_memory_are_bounded_and_reusable() {
    let metrics = RuntimeMetrics::default();
    let handles: Vec<_> = (0..MAX_ACTIVE_TRANSFERS)
        .map(|_| {
            metrics
                .begin_transfer(Layer::WorkerEgress, Cache::NotHit)
                .unwrap()
        })
        .collect();
    for _ in 0..10_000 {
        assert!(metrics
            .begin_transfer(Layer::WorkerEgress, Cache::NotHit)
            .is_none());
    }
    assert_eq!(lock(&metrics.inner).active, MAX_ACTIVE_TRANSFERS);
    assert_eq!(lock(&metrics.inner).dropped, 10_000);
    assert!(std::mem::size_of::<Snapshot>() < 2048);
    assert!(std::mem::size_of::<Transfer>() <= 128);
    drop(handles);
    assert_eq!(lock(&metrics.inner).active, 0);
    assert!(metrics
        .begin_transfer(Layer::WorkerEgress, Cache::NotHit)
        .is_some());
}
#[test]
fn counter_overflow_saturates_instead_of_wrapping() {
    let mut aggregate = Aggregate::default();
    aggregate.observe(u64::MAX, u64::MAX);
    aggregate.observe(100, 10);
    assert_eq!(aggregate.bytes, u64::MAX);
    assert_eq!(aggregate.micros, u64::MAX);
    assert_eq!(aggregate.count, 2);
    assert_eq!(aggregate.buckets[0], 1);
    aggregate.count = u64::MAX;
    aggregate.buckets[0] = u64::MAX;
    aggregate.observe(1, 0);
    assert_eq!(aggregate.count, u64::MAX);
    assert_eq!(aggregate.buckets[0], u64::MAX);
}
#[test]
fn histogram_boundaries_are_cumulative() {
    let mut aggregate = Aggregate::default();
    aggregate.observe(0, 10_000);
    aggregate.observe(0, 10_001);
    aggregate.observe(0, 600_000_001);
    assert_eq!(aggregate.buckets[0], 1);
    assert!(aggregate.buckets[1..].iter().all(|&n| n == 2));
    assert_eq!(aggregate.count, 3);
}
#[test]
fn independent_layers_and_outcomes_have_a_fixed_series_limit() {
    let metrics = RuntimeMetrics::default();
    for layer in [Layer::WorkerEgress, Layer::NasUplink, Layer::UpstreamRead] {
        for outcome in [Outcome::Complete, Outcome::Failed, Outcome::Cancelled] {
            let mut transfer = metrics.begin_transfer(layer, Cache::NotHit).unwrap();
            assert!(transfer.sample(1, 12));
            transfer.finish(outcome);
        }
    }
    metrics.cache_lookup(CacheDecision::Hit);
    metrics.cache_lookup(CacheDecision::Miss);
    for failure in [
        Failure::Prepare,
        Failure::Upstream,
        Failure::Capacity,
        Failure::Other,
    ] {
        metrics.playback_failure(failure);
    }
    let text = metrics.render();
    let data: Vec<_> = text.lines().filter(|line| !line.starts_with('#')).collect();
    // 9 combinations * (bytes + 10 buckets + count + sum) + 3 admission + 3 live layer counters + 2 cache + 4 failure.
    assert_eq!(data.len(), 129);
    assert!(text.len() < 20_000);
    for line in data {
        let number: f64 = line.rsplit_once(' ').unwrap().1.parse().unwrap();
        assert!(number.is_finite() && number >= 0.0);
        for forbidden in ["user_id", "room_id", "session_id", "token", "url", "path"] {
            assert!(!line.contains(forbidden));
        }
    }
    for aggregates in lock(&metrics.inner).transfers {
        for aggregate in aggregates {
            assert_eq!(aggregate.bytes, 12);
        }
    }
}
#[test]
fn concurrent_updates_and_scrapes_preserve_totals_and_histogram_consistency() {
    let metrics = RuntimeMetrics::default();
    let threads: Vec<_> = (0..8).map(|_| {
        let metrics = metrics.clone();
        std::thread::spawn(move || {
            for _ in 0..2000 {
                let mut transfer = metrics.begin_transfer(Layer::WorkerEgress, Cache::Hit).unwrap();
                transfer.sample(1, 100);
                transfer.finish(Outcome::Complete);
                metrics.cache_lookup(CacheDecision::Hit);
                if lock(&metrics.inner).admitted % 100 == 0 {
                    let output = metrics.render();
                    let value = |prefix: &str| output.lines().find(|s| s.starts_with(prefix)).unwrap().rsplit_once(' ').unwrap().1.parse::<u64>().unwrap();
                    assert_eq!(value("rainsync_transfer_duration_seconds_bucket{layer=\"worker_egress\",outcome=\"complete\",le=\"+Inf\"}"), value("rainsync_transfer_duration_seconds_count{"));
                }
            }
        })
    }).collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let state = lock(&metrics.inner);
    assert_eq!(state.active, 0);
    assert_eq!(state.transfers[0][0].count, 16_000);
    assert_eq!(state.transfers[0][0].bytes, 1_600_000);
    assert_eq!(state.body_bytes[0], 1_600_000);
    assert_eq!(state.cached_bytes, 1_600_000);
    assert_eq!(state.cache[0], 16_000);
    assert_eq!(state.dropped, 0);
}

#[test]
fn live_bytes_are_visible_before_eof_and_never_credited_twice() {
    let metrics = RuntimeMetrics::default();
    let mut transfer = metrics
        .begin_transfer(Layer::WorkerEgress, Cache::Hit)
        .unwrap();
    assert!(transfer.sample(1, 100));
    let output = metrics.render();
    assert!(output.contains("rainsync_transfer_body_bytes_total{layer=\"worker_egress\"} 100\n"));
    assert!(output.contains("rainsync_cache_served_bytes_total 100\n"));
    assert!(!output.contains("rainsync_transfer_bytes_total{layer="));
    assert!(transfer.sample(1, 100));
    assert!(!transfer.sample(1, 200));
    assert!(!transfer.sample(0, 0));
    assert!(!transfer.sample(2, 99));
    assert_eq!(lock(&metrics.inner).body_bytes[0], 100);
    assert!(transfer.sample(3, 250));
    transfer.finish(Outcome::Failed);
    let state = lock(&metrics.inner);
    assert_eq!(state.body_bytes[0], 250);
    assert_eq!(state.cached_bytes, 250);
    assert_eq!(state.transfers[0][1].bytes, 250);
    assert_eq!(state.transfers[0][2].count, 0);
}

#[test]
fn live_bytes_saturate_across_transfers_and_cancel_keeps_observed_bytes() {
    let metrics = RuntimeMetrics::default();
    let mut first = metrics
        .begin_transfer(Layer::WorkerEgress, Cache::Hit)
        .unwrap();
    let mut second = metrics
        .begin_transfer(Layer::WorkerEgress, Cache::Hit)
        .unwrap();
    assert!(first.sample(1, u64::MAX));
    assert!(second.sample(1, 1));
    drop(first);
    drop(second);
    let state = lock(&metrics.inner);
    assert_eq!(state.body_bytes[0], u64::MAX);
    assert_eq!(state.cached_bytes, u64::MAX);
    assert_eq!(state.transfers[0][2].bytes, u64::MAX);
    assert_eq!(state.active, 0);
}

#[test]
fn cloned_handles_share_one_process_collector_and_new_instances_are_independent() {
    let server = RuntimeMetrics::default();
    let worker = RuntimeMetrics::default();
    let cloned_worker = worker.clone();
    let mut transfer = cloned_worker
        .begin_transfer(Layer::UpstreamRead, Cache::NotHit)
        .unwrap();
    transfer.sample(1, 512);
    assert!(worker
        .render()
        .contains("rainsync_transfer_body_bytes_total{layer=\"upstream_read\"} 512\n"));
    assert_eq!(server.render(), "");
    drop(transfer);
    assert_eq!(lock(&worker.inner).transfers[2][2].bytes, 512);
}
