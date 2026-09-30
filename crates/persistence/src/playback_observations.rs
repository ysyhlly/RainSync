//! Fixed grant time axes and actual viewer samples. Never infer them from the
//! room clock, mutable media metadata, or a successful preparation response.
use anyhow::Result;
use protocol::{PlaybackObservation, PlaybackObservationReceipt, PlaybackPlan};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
pub const MAX_POSITION_MS: f64 = 900_719_925_474.0;
pub const END_TOLERANCE_MS: f64 = 1_000.0;
pub const MIN_ACTUAL_RATE: f64 = 0.2375;
pub const MAX_ACTUAL_RATE: f64 = 4.2;

pub fn original_position(
    sample: &PlaybackObservation,
    origin: f64,
    duration: Option<f64>,
) -> std::result::Result<f64, &'static str> {
    if sample.seq == 0 || sample.seq > MAX_SEQUENCE {
        return Err("invalid_observation_sequence");
    }
    // The sync corrector applies up to +/-5% to the legal room rate [0.25, 4].
    // Keep the actual element rate, including those correction boundaries.
    if !sample.playback_rate.is_finite()
        || !(MIN_ACTUAL_RATE..=MAX_ACTUAL_RATE).contains(&sample.playback_rate)
    {
        return Err("invalid_observation_rate");
    }
    if !origin.is_finite()
        || origin < 0.0
        || !sample.media_time_ms.is_finite()
        || sample.media_time_ms < 0.0
    {
        return Err("invalid_observation_position");
    }
    let limit = match duration {
        Some(duration)
            if duration.is_finite()
                && (0.0..=MAX_POSITION_MS - END_TOLERANCE_MS).contains(&duration) =>
        {
            duration + END_TOLERANCE_MS
        }
        Some(_) => return Err("invalid_observation_position"),
        None => protocol::UNKNOWN_DURATION_LIMIT_MS,
    };
    let position = origin + sample.media_time_ms;
    if !position.is_finite() || position > limit || position > MAX_POSITION_MS {
        return Err("invalid_observation_position");
    }
    Ok(position)
}

pub async fn create(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    room: Uuid,
    plan: &PlaybackPlan,
) -> Result<()> {
    sqlx::query("INSERT INTO playback_observations(session_id,user_id,room_id,media_id,generation,timeline_origin_ms,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(plan.session_id).bind(user).bind(room).bind(plan.media_id)
        .bind(i64::from(plan.media_generation)).bind(plan.timeline_origin_ms)
        .bind(plan.duration_ms).execute(&mut **tx).await?;
    Ok(())
}

/// The caller holds room, grant and observation locks in that order.
pub async fn receipt(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<PlaybackObservationReceipt>> {
    Ok(
        sqlx::query("SELECT seq,has_played FROM playback_observations WHERE session_id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .map(|row| PlaybackObservationReceipt {
                session_id: id,
                observation_seq: row.get::<i64, _>("seq") as u64,
                has_played: row.get("has_played"),
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::PlaybackObservationEvent;

    fn sample() -> PlaybackObservation {
        PlaybackObservation {
            media_generation: 1,
            seq: 1,
            event: PlaybackObservationEvent::Progress,
            media_time_ms: 500.0,
            paused: false,
            seeking: false,
            buffering: false,
            playback_rate: 1.0,
            has_played: true,
        }
    }

    #[test]
    fn fixed_original_axis_allows_seeks_but_never_clamps_bad_samples() {
        let mut s = sample();
        assert_eq!(
            original_position(&s, 30_000.0, Some(40_000.0)),
            Ok(30_500.0)
        );
        s.media_time_ms = 10_500.0;
        assert_eq!(
            original_position(&s, 30_000.0, Some(40_000.0)),
            Ok(40_500.0)
        );
        s.media_time_ms = 11_001.0;
        assert!(original_position(&s, 30_000.0, Some(40_000.0)).is_err());
        s.media_time_ms = 0.0;
        assert_eq!(
            original_position(&s, 30_000.0, Some(40_000.0)),
            Ok(30_000.0)
        );
    }

    #[test]
    fn rejects_unsafe_sequences_nonfinite_positions_and_invalid_rates() {
        let mut s = sample();
        for seq in [0, MAX_SEQUENCE + 1] {
            s.seq = seq;
            assert!(original_position(&s, 0.0, None).is_err());
        }
        s.seq = MAX_SEQUENCE;
        for position in [
            -1.0,
            f64::NAN,
            f64::INFINITY,
            protocol::UNKNOWN_DURATION_LIMIT_MS + 1.0,
        ] {
            s.media_time_ms = position;
            assert!(original_position(&s, 0.0, None).is_err());
        }
        s.media_time_ms = 0.0;
        for rate in [0.0, 0.23749, 4.20001, f64::NAN] {
            s.playback_rate = rate;
            assert!(original_position(&s, 0.0, None).is_err());
        }
        for rate in [0.2375, 4.2] {
            s.playback_rate = rate;
            assert_eq!(original_position(&s, 0.0, None), Ok(0.0));
        }
    }
}
