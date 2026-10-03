use super::*;

#[test]
fn nas_wrapper_has_exact_capacity_and_coherent_fixed_snapshots() {
    let metrics = NasUplinkMetrics::default();
    assert!(metrics.snapshot().valid());
    let mut bodies = (0..16)
        .map(|_| metrics.begin_transfer().unwrap())
        .collect::<Vec<_>>();
    assert!(metrics.begin_transfer().is_none());
    assert!(bodies[0].sample(1, 64));
    let active = metrics.snapshot();
    assert!(active.valid());
    assert_eq!(
        (
            active.active,
            active.admitted,
            active.dropped,
            active.body_bytes
        ),
        (16, 16, 1, 64)
    );
    bodies.remove(0).finish(Outcome::Complete);
    drop(bodies);
    let final_state = metrics.snapshot();
    assert!(final_state.valid());
    assert_eq!(final_state.complete.transfers, 1);
    assert_eq!(final_state.complete.bytes, 64);
    assert_eq!(final_state.cancelled.transfers, 15);
    assert_eq!(final_state.active, 0);
}

#[test]
fn reported_namespaces_do_not_impersonate_local_io_or_network_restoration() {
    let runtime = RuntimeMetrics::default();
    let agent = NasUplinkMetrics::default();
    let baseline = agent.snapshot();
    let mut transfer = agent.begin_transfer().unwrap();
    assert!(transfer.sample(1, 23));
    transfer.finish(Outcome::Failed);
    assert!(runtime.agent_nas_sample(&agent.snapshot().checked_delta(&baseline).unwrap()));
    assert!(
        runtime.client_control_recovery(&ControlRecoveryMetricsSample {
            kind: protocol::ControlRecoveryMessageType::ControlRecoveryMetrics,
            version: 1,
            socket_open_to_state_applied_ms: 5,
            disconnect_observed_to_state_applied_ms: None,
            background: false,
        })
    );
    let output = runtime.render_for(Process::Server);
    assert!(output.contains("rainsync_agent_reported_nas_body_bytes_total{process=\"server\"} 23"));
    assert!(output.contains("boundary=\"socket_open_to_state_applied\""));
    assert!(!output.contains("boundary=\"disconnect_observed_to_state_applied\""));
    assert!(!output.contains("rainsync_transfer_body_bytes_total{"));
    assert!(!output.contains("room_id") && !output.contains("agent_id"));
}

#[test]
fn received_counter_overflow_drops_whole_sample_without_partial_credit() {
    let runtime = RuntimeMetrics::default();
    lock(&runtime.inner).agent_nas.body_bytes = u64::MAX;
    let agent = NasUplinkMetrics::default();
    let baseline = agent.snapshot();
    let mut body = agent.begin_transfer().unwrap();
    assert!(body.sample(1, 1));
    body.finish(Outcome::Complete);
    assert!(!runtime.agent_nas_sample(&agent.snapshot().checked_delta(&baseline).unwrap()));
    let state = lock(&runtime.inner);
    assert_eq!(state.agent_nas.samples, 0);
    assert_eq!(state.agent_nas.outcomes[0].count, 0);
    assert_eq!(
        state.agent_nas_dropped[TransportMetricDrop::Overflow as usize],
        1
    );
}

#[test]
fn unwired_is_absent_not_zero() {
    assert_eq!(RuntimeMetrics::default().render_for(Process::Worker), "");
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
    assert!(
        metrics
            .begin_transfer(Layer::UpstreamRead, Cache::Hit)
            .is_none()
    );
    assert!(
        metrics
            .begin_transfer(Layer::NasUplink, Cache::Hit)
            .is_none()
    );
    assert_eq!(lock(&metrics.inner).dropped, 2);
    assert!(
        !metrics
            .render_for(Process::Worker)
            .contains("rainsync_cache_served_bytes_total")
    );
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
        assert!(
            metrics
                .begin_transfer(Layer::WorkerEgress, Cache::NotHit)
                .is_none()
        );
    }
    assert_eq!(lock(&metrics.inner).active, MAX_ACTIVE_TRANSFERS);
    assert_eq!(lock(&metrics.inner).dropped, 10_000);
    assert!(std::mem::size_of::<Snapshot>() < MAX_METRIC_SNAPSHOT_BYTES);
    assert!(std::mem::size_of::<Transfer>() <= 128);
    drop(handles);
    assert_eq!(lock(&metrics.inner).active, 0);
    assert!(
        metrics
            .begin_transfer(Layer::WorkerEgress, Cache::NotHit)
            .is_some()
    );
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
    let text = metrics.render_for(Process::Worker);
    let data: Vec<_> = text.lines().filter(|line| !line.starts_with('#')).collect();
    // 9 combinations * (bytes + 10 buckets + count + sum) + 3 admission + 3 live layer counters + 2 cache + 4 failure.
    assert_eq!(data.len(), 129);
    assert!(text.len() < 24_000);
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
                if lock(&metrics.inner).admitted.is_multiple_of(100) {
                    let output = metrics.render_for(Process::Worker);
                    let value = |prefix: &str| output.lines().find(|s| s.starts_with(prefix)).unwrap().rsplit_once(' ').unwrap().1.parse::<u64>().unwrap();
                    assert_eq!(value("rainsync_transfer_duration_seconds_bucket{layer=\"worker_egress\",outcome=\"complete\",le=\"+Inf\",process=\"worker\"}"), value("rainsync_transfer_duration_seconds_count{"));
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
    let output = metrics.render_for(Process::Worker);
    assert!(output.contains(
        "rainsync_transfer_body_bytes_total{layer=\"worker_egress\",process=\"worker\"} 100\n"
    ));
    assert!(output.contains("rainsync_cache_served_bytes_total{process=\"worker\"} 100\n"));
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
    assert!(worker.render_for(Process::Worker).contains(
        "rainsync_transfer_body_bytes_total{layer=\"upstream_read\",process=\"worker\"} 512\n"
    ));
    assert_eq!(server.render_for(Process::Worker), "");
    drop(transfer);
    assert_eq!(lock(&worker.inner).transfers[2][2].bytes, 512);
}

#[test]
fn process_labels_are_fixed_and_separate_instances_stay_independent() {
    let server = RuntimeMetrics::default();
    let worker = RuntimeMetrics::default();
    server.cache_lookup(CacheDecision::Hit);
    worker.cache_lookup(CacheDecision::Miss);
    let a = server.render_for(Process::Server);
    let b = worker.render_for(Process::Worker);
    assert!(a.contains("result=\"hit\",process=\"server\"} 1"));
    assert!(b.contains("result=\"miss\",process=\"worker\"} 1"));
    assert!(!a.contains("process=\"worker\""));
    assert!(!b.contains("process=\"server\""));
}

fn client_totals(values: [u32; 8]) -> PlaybackMetricsTotals {
    PlaybackMetricsTotals {
        startup_ms: values[0],
        autoplay_blocked_ms: values[1],
        background_ms: values[2],
        paused_ms: values[3],
        seeking_ms: values[4],
        rebuffer_ms: values[5],
        playing_ms: values[6],
        unobserved_ms: values[7],
    }
}

fn client_value(output: &str, name: &str, labels: &str) -> u64 {
    let prefix = format!("{name}{{{labels},process=\"server\"}} ");
    output
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .unwrap_or_else(|| panic!("missing series {prefix}"))
        .parse()
        .unwrap()
}

#[test]
fn client_reports_are_absent_until_observed_and_do_not_invent_a_first_frame() {
    let metrics = RuntimeMetrics::default();
    assert_eq!(metrics.render_for(Process::Server), "");
    assert!(metrics.client_playback_sample(
        PlaybackMetricsOrigin::UserIntent,
        &client_totals([7, 0, 0, 0, 0, 0, 0, 0]),
        None,
    ));
    let output = metrics.render_for(Process::Server);
    assert!(output.contains("rainsync_client_reported_playback_samples_total{origin=\"user_intent\",process=\"server\"} 1\n"));
    assert!(!output.contains("automatic_load"));
    assert!(!output.contains("first_frame"));
    assert!(!output.contains("rainsync_transfer_"));
    assert!(!output.contains("rainsync_client_reported_playback_dropped_total"));
    let first = PlaybackMetricsFirstFrame {
        elapsed_ms: 0,
        confirmed_elapsed_ms: 0,
        evidence: PlaybackMetricsFrameEvidence::VideoFrameCallback,
    };
    assert!(metrics.client_playback_sample(
        PlaybackMetricsOrigin::UserIntent,
        &client_totals([0; 8]),
        Some(&first),
    ));
    let output = metrics.render_for(Process::Server);
    let labels = "origin=\"user_intent\",evidence=\"video_frame_callback\"";
    assert_eq!(
        client_value(
            &output,
            "rainsync_client_reported_playback_first_frame_elapsed_milliseconds_count",
            labels
        ),
        1
    );
    assert_eq!(
        client_value(
            &output,
            "rainsync_client_reported_playback_first_frame_elapsed_milliseconds_sum",
            labels
        ),
        0
    );
    assert_eq!(
        client_value(
            &output,
            "rainsync_client_reported_playback_first_frame_confirmation_lag_milliseconds_count",
            labels
        ),
        1
    );
    assert_eq!(
        client_value(
            &output,
            "rainsync_client_reported_playback_first_frame_confirmation_lag_milliseconds_sum",
            labels
        ),
        0
    );
    assert!(!output.contains("evidence=\"playing_time_advance\""));
}

#[test]
fn client_delta_durations_conserve_cumulative_time_and_frames_are_owner_supplied() {
    let metrics = RuntimeMetrics::default();
    let initial = client_totals([20, 30, 40, 50, 60, 70, 80, 90]);
    let later = client_totals([21, 32, 43, 54, 65, 76, 87, 98]);
    assert!(metrics.client_playback_sample(PlaybackMetricsOrigin::UserIntent, &initial, None));
    // A delayed first-frame receipt may refer to an earlier point than this delta.
    let first = PlaybackMetricsFirstFrame {
        elapsed_ms: 100,
        confirmed_elapsed_ms: 150,
        evidence: PlaybackMetricsFrameEvidence::VideoFrameCallback,
    };
    let delta = later.checked_delta(&initial).unwrap();
    assert!(metrics.client_playback_sample(
        PlaybackMetricsOrigin::UserIntent,
        &delta,
        Some(&first)
    ));
    assert!(metrics.client_playback_sample(
        PlaybackMetricsOrigin::UserIntent,
        &client_totals([0; 8]),
        None
    ));
    let state = lock(&metrics.inner);
    let aggregate = state.client_playback[0];
    assert_eq!(aggregate.samples, 3);
    assert_eq!(aggregate.duration_ms, later.values().map(u64::from));
    assert_eq!(aggregate.elapsed_ms, later.sum());
    assert_eq!(
        aggregate.duration_ms.iter().sum::<u64>(),
        aggregate.elapsed_ms
    );
    assert_eq!(aggregate.first_frames[0].elapsed.count, 1);
    assert_eq!(aggregate.first_frames[0].elapsed.milliseconds, 100);
    assert_eq!(aggregate.first_frames[0].confirmation_lag.milliseconds, 50);
    assert_eq!(aggregate.first_frames[1].elapsed.count, 0);
    assert_eq!(state.client_playback[1], ClientPlaybackAggregate::default());
}

#[test]
fn client_origin_evidence_and_loss_labels_have_a_fixed_series_limit() {
    let metrics = RuntimeMetrics::default();
    for origin in [
        PlaybackMetricsOrigin::UserIntent,
        PlaybackMetricsOrigin::AutomaticLoad,
    ] {
        for evidence in [
            PlaybackMetricsFrameEvidence::VideoFrameCallback,
            PlaybackMetricsFrameEvidence::PlayingTimeAdvance,
        ] {
            let first = PlaybackMetricsFirstFrame {
                elapsed_ms: 3,
                confirmed_elapsed_ms: 5,
                evidence,
            };
            assert!(metrics.client_playback_sample(
                origin,
                &client_totals([1, 2, 3, 4, 5, 6, 7, 8]),
                Some(&first)
            ));
        }
    }
    for reason in [
        ClientMetricsDrop::RateLimited,
        ClientMetricsDrop::Capacity,
        ClientMetricsDrop::Invalid,
        ClientMetricsDrop::Unavailable,
        ClientMetricsDrop::Overflow,
    ] {
        metrics.client_playback_dropped(reason);
    }
    let output = metrics.render_for(Process::Server);
    let data: Vec<_> = output
        .lines()
        .filter(|line| !line.starts_with('#'))
        .collect();
    // Two origins * (sample + elapsed + 8 states + 2 evidence * 2 histograms * 12 series), plus 5 loss reasons.
    assert_eq!(data.len(), 121);
    assert!(output.len() < 32_000);
    assert!(std::mem::size_of::<Snapshot>() < MAX_METRIC_SNAPSHOT_BYTES);
    for line in data {
        assert!(line.starts_with("rainsync_client_reported_playback_"));
        assert!(line.contains("process=\"server\""));
        line.rsplit_once(' ').unwrap().1.parse::<u64>().unwrap();
        for forbidden in [
            "user_id",
            "viewer_id",
            "room_id",
            "session_id",
            "token",
            "url",
            "path",
            "mode=",
            "source=",
        ] {
            assert!(!line.contains(forbidden));
        }
    }
    for _ in 0..1000 {
        assert!(metrics.client_playback_sample(
            PlaybackMetricsOrigin::AutomaticLoad,
            &client_totals([0; 8]),
            None
        ));
    }
    assert_eq!(
        metrics
            .render_for(Process::Server)
            .lines()
            .filter(|line| !line.starts_with('#'))
            .count(),
        121
    );
}

#[test]
fn client_input_ranges_and_total_prefix_bound_reject_whole_samples() {
    let metrics = RuntimeMetrics::default();
    let maximum = PLAYBACK_METRICS_MAX_ELAPSED_MS;
    let frame = PlaybackMetricsFirstFrame {
        elapsed_ms: maximum,
        confirmed_elapsed_ms: maximum,
        evidence: PlaybackMetricsFrameEvidence::PlayingTimeAdvance,
    };
    assert!(metrics.client_playback_sample(
        PlaybackMetricsOrigin::AutomaticLoad,
        &client_totals([maximum, 0, 0, 0, 0, 0, 0, 0]),
        Some(&frame)
    ));
    let baseline = lock(&metrics.inner).client_playback;
    assert!(!metrics.client_playback_sample(
        PlaybackMetricsOrigin::AutomaticLoad,
        &client_totals([maximum + 1, 0, 0, 0, 0, 0, 0, 0]),
        None
    ));
    assert!(!metrics.client_playback_sample(
        PlaybackMetricsOrigin::AutomaticLoad,
        &client_totals([maximum, 1, 0, 0, 0, 0, 0, 0]),
        None
    ));
    let beyond = PlaybackMetricsFirstFrame {
        confirmed_elapsed_ms: maximum + 1,
        ..frame.clone()
    };
    assert!(!metrics.client_playback_sample(
        PlaybackMetricsOrigin::AutomaticLoad,
        &client_totals([0; 8]),
        Some(&beyond)
    ));
    let reversed = PlaybackMetricsFirstFrame {
        elapsed_ms: 10,
        confirmed_elapsed_ms: 9,
        ..frame
    };
    assert!(!metrics.client_playback_sample(
        PlaybackMetricsOrigin::AutomaticLoad,
        &client_totals([0; 8]),
        Some(&reversed)
    ));
    let state = lock(&metrics.inner);
    assert_eq!(state.client_playback, baseline);
    assert_eq!(state.client_dropped[ClientMetricsDrop::Invalid as usize], 4);
    assert_eq!(
        state.client_dropped[ClientMetricsDrop::Overflow as usize],
        0
    );
}

#[test]
fn client_overflow_rejects_every_partial_duration_and_histogram_update() {
    let first = PlaybackMetricsFirstFrame {
        elapsed_ms: 10,
        confirmed_elapsed_ms: 15,
        evidence: PlaybackMetricsFrameEvidence::VideoFrameCallback,
    };
    for field in 0..9 {
        let metrics = RuntimeMetrics::default();
        let baseline = {
            let mut state = lock(&metrics.inner);
            let aggregate = &mut state.client_playback[0];
            match field {
                0 => aggregate.samples = u64::MAX,
                1 => aggregate.elapsed_ms = u64::MAX,
                2 => aggregate.duration_ms[0] = u64::MAX,
                3 => aggregate.first_frames[0].elapsed.count = u64::MAX,
                4 => aggregate.first_frames[0].elapsed.milliseconds = u64::MAX,
                5 => aggregate.first_frames[0].elapsed.buckets[0] = u64::MAX,
                6 => aggregate.first_frames[0].confirmation_lag.count = u64::MAX,
                7 => aggregate.first_frames[0].confirmation_lag.milliseconds = u64::MAX,
                8 => aggregate.first_frames[0].confirmation_lag.buckets[0] = u64::MAX,
                _ => unreachable!(),
            }
            state.client_playback
        };
        assert!(!metrics.client_playback_sample(
            PlaybackMetricsOrigin::UserIntent,
            &client_totals([1; 8]),
            Some(&first)
        ));
        let state = lock(&metrics.inner);
        assert_eq!(
            state.client_playback, baseline,
            "partial credit for overflow field {field}"
        );
        assert_eq!(
            state.client_dropped[ClientMetricsDrop::Overflow as usize],
            1
        );
    }
    let metrics = RuntimeMetrics::default();
    lock(&metrics.inner).client_dropped[ClientMetricsDrop::Overflow as usize] = u64::MAX;
    metrics.client_playback_dropped(ClientMetricsDrop::Overflow);
    assert_eq!(
        lock(&metrics.inner).client_dropped[ClientMetricsDrop::Overflow as usize],
        u64::MAX
    );
    assert!(
        metrics
            .render_for(Process::Server)
            .lines()
            .filter(|line| !line.starts_with('#'))
            .all(|line| line.rsplit_once(' ').unwrap().1.parse::<u64>().is_ok())
    );
}

#[test]
fn client_histogram_bounds_are_cumulative_integer_milliseconds() {
    let mut histogram = ClientHistogram::default();
    for duration in [10, 11, 600_001, u64::from(PLAYBACK_METRICS_MAX_ELAPSED_MS)] {
        assert!(histogram.checked_observe(duration).is_some());
    }
    assert_eq!(histogram.count, 4);
    assert_eq!(histogram.buckets[0], 1);
    assert!(histogram.buckets[1..].iter().all(|count| *count == 2));
    assert_eq!(histogram.milliseconds, 604_800_000 + 600_022);
}

#[test]
fn client_collectors_share_clones_but_keep_independent_instances_and_io_separate() {
    let server = RuntimeMetrics::default();
    let independent = RuntimeMetrics::default();
    let cloned = server.clone();
    assert!(cloned.client_playback_sample(
        PlaybackMetricsOrigin::UserIntent,
        &client_totals([2; 8]),
        None
    ));
    let output = server.render_for(Process::Server);
    assert_eq!(
        client_value(
            &output,
            "rainsync_client_reported_playback_elapsed_milliseconds_total",
            "origin=\"user_intent\""
        ),
        16
    );
    assert_eq!(independent.render_for(Process::Server), "");
    assert!(!output.contains("rainsync_transfer_"));
    let mut transfer = server
        .begin_transfer(Layer::WorkerEgress, Cache::Hit)
        .unwrap();
    transfer.sample(1, 99);
    transfer.finish(Outcome::Complete);
    let output = server.render_for(Process::Server);
    assert_eq!(
        client_value(
            &output,
            "rainsync_client_reported_playback_samples_total",
            "origin=\"user_intent\""
        ),
        1
    );
    assert_eq!(lock(&server.inner).transfers[0][0].bytes, 99);
}

#[test]
fn client_concurrent_updates_and_scrapes_preserve_one_coherent_aggregate() {
    let metrics = RuntimeMetrics::default();
    let threads: Vec<_> = (0..4).map(|_| {
        let metrics = metrics.clone();
        std::thread::spawn(move || {
            let first = PlaybackMetricsFirstFrame {
                elapsed_ms: 10,
                confirmed_elapsed_ms: 15,
                evidence: PlaybackMetricsFrameEvidence::VideoFrameCallback,
            };
            for i in 0..250 {
                assert!(metrics.client_playback_sample(PlaybackMetricsOrigin::UserIntent, &client_totals([1; 8]), Some(&first)));
                if i % 25 == 0 {
                    let output = metrics.render_for(Process::Server);
                    let samples = client_value(&output, "rainsync_client_reported_playback_samples_total", "origin=\"user_intent\"");
                    assert_eq!(client_value(&output, "rainsync_client_reported_playback_elapsed_milliseconds_total", "origin=\"user_intent\""), samples * 8);
                    for state in CLIENT_STATES {
                        assert_eq!(client_value(&output, "rainsync_client_reported_playback_state_duration_milliseconds_total", &format!("origin=\"user_intent\",state=\"{state}\"")), samples);
                    }
                    let labels = "origin=\"user_intent\",evidence=\"video_frame_callback\"";
                    for name in ["rainsync_client_reported_playback_first_frame_elapsed_milliseconds", "rainsync_client_reported_playback_first_frame_confirmation_lag_milliseconds"] {
                        assert_eq!(client_value(&output, &format!("{name}_count"), labels), samples);
                        assert_eq!(client_value(&output, &format!("{name}_bucket"), &format!("{labels},le=\"+Inf\"")), samples);
                        assert_eq!(client_value(&output, &format!("{name}_bucket"), &format!("{labels},le=\"10\"")), samples);
                    }
                    assert_eq!(client_value(&output, "rainsync_client_reported_playback_first_frame_elapsed_milliseconds_sum", labels), samples * 10);
                    assert_eq!(client_value(&output, "rainsync_client_reported_playback_first_frame_confirmation_lag_milliseconds_sum", labels), samples * 5);
                }
            }
        })
    }).collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let state = lock(&metrics.inner);
    assert_eq!(state.client_playback[0].samples, 1000);
    assert_eq!(state.client_playback[0].elapsed_ms, 8000);
    assert_eq!(state.client_playback[0].duration_ms, [1000; 8]);
    assert_eq!(state.client_playback[0].first_frames[0].elapsed.count, 1000);
    assert_eq!(state.client_dropped, [0; 5]);
}

#[test]
fn v2_startup_has_exact_bounded_series_without_expanding_playback_states() {
    let metrics = RuntimeMetrics::default();
    let totals = PlaybackMetricsTotals {
        startup_ms: 1,
        autoplay_blocked_ms: 0,
        background_ms: 0,
        paused_ms: 0,
        seeking_ms: 0,
        rebuffer_ms: 0,
        playing_ms: 0,
        unobserved_ms: 0,
    };
    let phases = PlaybackMetricsStartupPhases {
        preparation_ms: 1,
        loading_ms: 0,
        unobserved_ms: 0,
    };
    for source in [
        PlaybackSource::Local,
        PlaybackSource::Http,
        PlaybackSource::Agent,
        PlaybackSource::Jellyfin,
        PlaybackSource::Emby,
        PlaybackSource::Unknown,
    ] {
        for mode in [
            PlaybackMode::Direct,
            PlaybackMode::Remux,
            PlaybackMode::Transcode,
            PlaybackMode::Unknown,
        ] {
            for evidence in [
                PlaybackMetricsFrameEvidence::VideoFrameCallback,
                PlaybackMetricsFrameEvidence::PlayingTimeAdvance,
            ] {
                let frame = PlaybackMetricsFirstFrame {
                    elapsed_ms: 1,
                    confirmed_elapsed_ms: 1,
                    evidence,
                };
                assert!(metrics.client_playback_sample_with_startup(
                    PlaybackMetricsOrigin::UserIntent,
                    &totals,
                    Some(&frame),
                    Some(&phases),
                    Some(PlaybackAttribution { source, mode })
                ));
            }
        }
    }
    assert!(metrics.client_playback_sample_with_startup(
        PlaybackMetricsOrigin::AutomaticLoad,
        &totals,
        None,
        Some(&phases),
        None
    ));
    let output = metrics.render_for(Process::Server);
    let new_series = output
        .lines()
        .filter(|line| {
            line.starts_with("rainsync_client_reported_playback_startup_phase_")
                || line.starts_with("rainsync_client_reported_playback_first_frame_attributed_")
        })
        .count();
    assert_eq!(new_series, PLAYBACK_V2_MAX_ADDITIONAL_SERIES);
    assert_eq!(new_series, 582);
    assert_eq!(
        output
            .lines()
            .filter(|line| line.starts_with("rainsync_client_reported_playback_state_duration_"))
            .count(),
        16
    );
    assert!(std::mem::size_of::<Snapshot>() <= MAX_METRIC_SNAPSHOT_BYTES);
    assert!(!output.contains("plan_generation"));
}
#[test]
fn v2_phase_overflow_cannot_partially_credit_existing_state_counters() {
    let metrics = RuntimeMetrics::default();
    lock(&metrics.inner).client_startup.phase_ms[0][0] = u64::MAX;
    let totals = PlaybackMetricsTotals {
        startup_ms: 1,
        autoplay_blocked_ms: 0,
        background_ms: 0,
        paused_ms: 0,
        seeking_ms: 0,
        rebuffer_ms: 0,
        playing_ms: 0,
        unobserved_ms: 0,
    };
    let phases = PlaybackMetricsStartupPhases {
        preparation_ms: 1,
        loading_ms: 0,
        unobserved_ms: 0,
    };
    assert!(!metrics.client_playback_sample_with_startup(
        PlaybackMetricsOrigin::UserIntent,
        &totals,
        None,
        Some(&phases),
        None
    ));
    assert_eq!(lock(&metrics.inner).client_playback[0].samples, 0);
    assert_eq!(
        lock(&metrics.inner).client_dropped[ClientMetricsDrop::Overflow as usize],
        1
    );
}

#[test]
fn output_entry_series_are_separate_bounded_and_unknown_queue_is_not_zero() {
    let metrics = RuntimeMetrics::default();
    let totals = PlaybackMetricsTotals {
        startup_ms: 1,
        autoplay_blocked_ms: 0,
        background_ms: 0,
        paused_ms: 0,
        seeking_ms: 0,
        rebuffer_ms: 0,
        playing_ms: 0,
        unobserved_ms: 0,
    };
    let phases = PlaybackMetricsStartupPhases {
        preparation_ms: 1,
        loading_ms: 0,
        unobserved_ms: 0,
    };
    for availability in [
        WorkerOutputEntryAvailability::ColdWaiting,
        WorkerOutputEntryAvailability::Warm,
        WorkerOutputEntryAvailability::NotApplicable,
        WorkerOutputEntryAvailability::Unknown,
    ] {
        for evidence in [
            PlaybackMetricsFrameEvidence::VideoFrameCallback,
            PlaybackMetricsFrameEvidence::PlayingTimeAdvance,
        ] {
            let first = PlaybackMetricsFirstFrame {
                elapsed_ms: 1,
                confirmed_elapsed_ms: 1,
                evidence,
            };
            let queue_ms = matches!(
                availability,
                WorkerOutputEntryAvailability::ColdWaiting | WorkerOutputEntryAvailability::Warm
            )
            .then_some(0);
            assert!(metrics.client_playback_sample_with_output(
                PlaybackMetricsOrigin::UserIntent,
                &totals,
                Some(&first),
                Some(&phases),
                Some(PlaybackAttribution {
                    source: PlaybackSource::Local,
                    mode: PlaybackMode::Remux
                }),
                Some(WorkerOutputEntry {
                    availability,
                    queue_ms
                })
            ));
        }
    }
    let rendered = metrics.render_for(Process::Server);
    let count = rendered
        .lines()
        .filter(|line| {
            line.starts_with("rainsync_client_reported_playback_first_frame_worker_output_entry_")
                || line.starts_with("rainsync_worker_observed_playback_entry_queue_")
        })
        .count();
    assert_eq!(count, PLAYBACK_ENTRY_MAX_ADDITIONAL_SERIES);
    assert_eq!(count, 111);
    assert_eq!(lock(&metrics.inner).client_startup.queue_prefix.count, 4);
    assert_eq!(
        lock(&metrics.inner).client_startup.queue_coverage,
        [4, 2, 2]
    );
    assert!(std::mem::size_of::<Snapshot>() < MAX_METRIC_SNAPSHOT_BYTES);
    for line in rendered.lines().filter(|line| {
        line.starts_with("rainsync_client_reported_playback_first_frame_worker_output_entry_")
    }) {
        assert!(!line.contains("source="));
        assert!(!line.contains("mode="));
    }
}
